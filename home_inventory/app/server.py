#!/usr/bin/env python3
"""Home Inventory - catalog a house's equipment. Runs as a Home Assistant add-on
(behind Ingress) or standalone for local development:

    DATA_DIR=./data python3 server.py
"""
import csv
import io
import json
import mimetypes
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "inventory.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
ICON_DIR = os.path.join(DATA_DIR, "icons")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8099"))
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
INGRESS_IP = "172.30.32.2"  # Home Assistant's ingress proxy

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(ICON_DIR, exist_ok=True)


def load_options():
    try:
        with open(os.path.join(DATA_DIR, "options.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


OPTIONS = load_options()

# Where to publish sensors:
#  - as an HA OS add-on: through the Supervisor proxy (token provided automatically)
#  - standalone (HA Container/Core): HA_URL + a long-lived access token in HA_TOKEN
if SUPERVISOR_TOKEN:
    HA_API, HA_AUTH = "http://supervisor/core/api", SUPERVISOR_TOKEN
elif os.environ.get("HA_TOKEN", "").strip():
    HA_API = os.environ.get("HA_URL", "http://localhost:8123").strip().rstrip("/") + "/api"
    HA_AUTH = os.environ["HA_TOKEN"].strip()
else:
    HA_API, HA_AUTH = None, None
PUBLISH_SENSORS = bool(HA_AUTH) and OPTIONS.get("publish_sensors", True)
WARRANTY_DAYS = int(OPTIONS.get("warranty_warning_days", os.environ.get("WARRANTY_WARNING_DAYS", 60)))

# Plain text columns on an item. Add a name here and it is created on next start.
ITEM_FIELDS = [
    "name", "category", "location",
    "manufacturer", "model", "serial_number",
    "purchased_from", "installer", "purchase_date", "purchase_price", "warranty_expires",
    "website_url", "manual_url", "support_url", "support_phone", "support_email",
    "operating_notes", "notes",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    extra_fields TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    interval_days INTEGER NOT NULL,
    last_done TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    icon TEXT
);
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    icon TEXT
);
CREATE TABLE IF NOT EXISTS icons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

# Columns added after v1 (table -> [(column, type)]); created automatically on start.
LATER_COLUMNS = {
    "items": [("icon", "TEXT"), ("cover_id", "INTEGER")],
    "attachments": [("kind", "TEXT"), ("title", "TEXT")],
}

DEFAULT_CATEGORIES = {
    "Appliances": "🔌", "HVAC": "🌡️", "Water Heater": "♨️", "Plumbing": "🚰", "Electrical": "⚡",
    "Lighting": "💡", "Pool & Spa": "🏊", "Outdoor": "🌳", "Irrigation": "💧", "Garage": "🚗",
    "Doors & Windows": "🚪", "Roof & Exterior": "🏠", "Flooring & Finishes": "🪵",
    "Security": "🔒", "Smart Home & Network": "📡", "Entertainment": "📺", "Furniture": "🛋️", "Other": "📦",
}

ATTACHMENT_KINDS = ["Photo", "Manual", "Receipt", "Invoice", "Contract", "Warranty", "Permit",
                    "Plans & drawings", "Other"]

# Category & location lists share the same code; this maps the URL name to the
# table and the matching items column (never taken from user input directly).
TERM_TABLES = {"categories": ("categories", "category"), "locations": ("locations", "location")}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB per upload request
app.json.ensure_ascii = False


# ---------------------------------------------------------------- database

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
    for field in ITEM_FIELDS:
        if field not in existing:
            conn.execute(f"ALTER TABLE items ADD COLUMN {field} TEXT")
    for table, cols in LATER_COLUMNS.items():
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for col, typ in cols:
            if col not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")

    # One-time: fill the category & location lists (defaults + whatever items already use)
    if conn.execute("PRAGMA user_version").fetchone()[0] < 2:
        for name, icon in DEFAULT_CATEGORIES.items():
            conn.execute("INSERT OR IGNORE INTO categories (name, icon) VALUES (?, ?)", (name, icon))
        for table, column in TERM_TABLES.values():
            conn.execute(f"INSERT OR IGNORE INTO {table} (name) "
                         f"SELECT DISTINCT {column} FROM items WHERE {column} IS NOT NULL")
        conn.execute("PRAGMA user_version = 2")
    conn.commit()
    conn.close()


def canonical_term(conn, url_name, value):
    """Return the list's spelling of a category/location, adding it if new."""
    if not value:
        return None
    table, _ = TERM_TABLES[url_name]
    conn.execute(f"INSERT OR IGNORE INTO {table} (name) VALUES (?)", (value,))
    return conn.execute(f"SELECT name FROM {table} WHERE name = ?", (value,)).fetchone()["name"]


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def now():
    return datetime.now().isoformat(timespec="seconds")


def parse_date(value):
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


# ---------------------------------------------------------------- shaping

def task_out(row, item_name=None):
    t = dict(row)
    last = parse_date(t["last_done"])
    due = last + timedelta(days=t["interval_days"]) if last else date.today()
    t["next_due"] = due.isoformat()
    t["days_left"] = (due - date.today()).days
    if item_name is not None:
        t["item_name"] = item_name
    return t


def item_out(row):
    it = dict(row)
    try:
        it["extra_fields"] = json.loads(it.get("extra_fields") or "[]")
    except ValueError:
        it["extra_fields"] = []
    return it


def get_item_row(item_id):
    row = db().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        abort(404)
    return row


def clean_item_payload(data):
    values = {}
    for field in ITEM_FIELDS:
        v = data.get(field)
        values[field] = str(v).strip() if v not in (None, "") else None
    if not values["name"]:
        abort(400, "Name is required")
    extras = []
    for ef in data.get("extra_fields") or []:
        label = str(ef.get("label", "")).strip()
        value = str(ef.get("value", "")).strip()
        if label or value:
            extras.append({"label": label, "value": value})
    values["extra_fields"] = json.dumps(extras)
    return values


def compute_alerts(conn):
    today = date.today()
    tasks = []
    for r in conn.execute(
        "SELECT t.*, i.name AS item_name FROM tasks t JOIN items i ON i.id = t.item_id"
    ):
        t = task_out(r)
        if t["days_left"] <= 7:
            tasks.append(t)
    tasks.sort(key=lambda t: t["days_left"])

    warranties = []
    for r in conn.execute(
        "SELECT id, name, warranty_expires FROM items WHERE warranty_expires IS NOT NULL"
    ):
        d = parse_date(r["warranty_expires"])
        if d and 0 <= (d - today).days <= WARRANTY_DAYS:
            warranties.append({"item_id": r["id"], "item_name": r["name"],
                               "warranty_expires": d.isoformat(), "days_left": (d - today).days})
    warranties.sort(key=lambda w: w["days_left"])
    return {"tasks": tasks, "warranties": warranties}


# ---------------------------------------------------------------- security

@app.before_request
def only_from_ingress():
    # When running as an add-on, only accept traffic from HA's ingress proxy
    # (which already enforces Home Assistant login).
    if SUPERVISOR_TOKEN and request.remote_addr not in (INGRESS_IP, "127.0.0.1"):
        abort(403)


@app.errorhandler(HTTPException)
def http_error(e):
    # API callers get JSON errors: {"error": "..."}
    if request.path.startswith("/api/"):
        return jsonify({"error": e.description}), e.code
    return e


@app.after_request
def headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ---------------------------------------------------------------- UI

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:name>")
def static_files(name):
    if name.startswith("api/"):
        abort(404)
    return send_from_directory(STATIC_DIR, name)


# ---------------------------------------------------------------- items

IMAGE_SQL = "content_type LIKE 'image/%' AND content_type != 'image/svg+xml'"


@app.get("/api/items")
def list_items():
    conn = db()
    items = [item_out(r) for r in conn.execute("SELECT * FROM items ORDER BY lower(name)")]
    first_image = {r["item_id"]: r["id"] for r in conn.execute(
        f"SELECT item_id, MIN(id) AS id FROM attachments WHERE {IMAGE_SQL} GROUP BY item_id")}
    due = {}
    for r in conn.execute("SELECT * FROM tasks"):
        if task_out(r)["days_left"] <= 0:
            due[r["item_id"]] = due.get(r["item_id"], 0) + 1
    for it in items:
        # Picture shown for the item: chosen cover photo > chosen emoji > first photo > category icon
        if it.get("cover_id"):
            it["thumb_id"] = it["cover_id"]
        elif it.get("icon"):
            it["thumb_id"] = None
        else:
            it["thumb_id"] = first_image.get(it["id"])
        it["tasks_due"] = due.get(it["id"], 0)
    return jsonify(items)


def save_terms(conn, v):
    v["category"] = canonical_term(conn, "categories", v["category"])
    v["location"] = canonical_term(conn, "locations", v["location"])


@app.post("/api/items")
def create_item():
    conn = db()
    v = clean_item_payload(request.get_json(force=True) or {})
    save_terms(conn, v)
    cols = list(v.keys()) + ["created_at", "updated_at"]
    vals = list(v.values()) + [now(), now()]
    cur = conn.execute(
        f"INSERT INTO items ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals
    )
    conn.commit()
    changed()
    return jsonify(item_out(get_item_row(cur.lastrowid))), 201


@app.get("/api/items/<int:item_id>")
def get_item(item_id):
    it = item_out(get_item_row(item_id))
    conn = db()
    it["attachments"] = [dict(r) for r in conn.execute(
        "SELECT id, filename, title, kind, content_type, size, created_at FROM attachments "
        "WHERE item_id = ? ORDER BY id", (item_id,))]
    it["tasks"] = sorted((task_out(r) for r in conn.execute(
        "SELECT * FROM tasks WHERE item_id = ?", (item_id,))), key=lambda t: t["days_left"])
    return jsonify(it)


@app.put("/api/items/<int:item_id>")
def update_item(item_id):
    get_item_row(item_id)
    conn = db()
    v = clean_item_payload(request.get_json(force=True) or {})
    save_terms(conn, v)
    v["updated_at"] = now()
    conn.execute(
        f"UPDATE items SET {', '.join(f'{k} = ?' for k in v)} WHERE id = ?",
        list(v.values()) + [item_id],
    )
    conn.commit()
    changed()
    return jsonify(item_out(get_item_row(item_id)))


@app.put("/api/items/<int:item_id>/appearance")
def set_appearance(item_id):
    """Set the item's picture: {"icon": "🔥"} or {"cover_id": 12}, or {} for automatic."""
    get_item_row(item_id)
    data = request.get_json(force=True) or {}
    conn = db()
    icon = (str(data.get("icon") or "").strip()[:16]) or None
    cover = data.get("cover_id")
    if cover is not None:
        ok = conn.execute(f"SELECT 1 FROM attachments WHERE id = ? AND item_id = ? AND {IMAGE_SQL}",
                          (cover, item_id)).fetchone()
        if not ok:
            abort(400, "That photo doesn't belong to this item")
        icon = None
    conn.execute("UPDATE items SET icon = ?, cover_id = ? WHERE id = ?", (icon, cover, item_id))
    conn.commit()
    return jsonify(item_out(get_item_row(item_id)))


@app.delete("/api/items/<int:item_id>")
def delete_item(item_id):
    get_item_row(item_id)
    conn = db()
    files = [r["stored_name"] for r in conn.execute(
        "SELECT stored_name FROM attachments WHERE item_id = ?", (item_id,))]
    conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
    conn.commit()
    for name in files:
        try:
            os.remove(os.path.join(UPLOAD_DIR, name))
        except OSError:
            pass
    changed()
    return "", 204


def term_list(conn, url_name):
    table, column = TERM_TABLES[url_name]
    return [dict(r) for r in conn.execute(
        f"SELECT t.id, t.name, t.icon, "
        f"(SELECT COUNT(*) FROM items i WHERE i.{column} = t.name COLLATE NOCASE) AS count "
        f"FROM {table} t ORDER BY lower(t.name)")]


@app.get("/api/meta")
def meta():
    conn = db()
    def distinct(col):
        return [r[0] for r in conn.execute(
            f"SELECT DISTINCT {col} FROM items WHERE {col} IS NOT NULL ORDER BY lower({col})")]
    return jsonify({"categories": term_list(conn, "categories"),
                    "locations": term_list(conn, "locations"),
                    "attachment_kinds": ATTACHMENT_KINDS,
                    "icons": icon_list(conn),
                    "vendors": distinct("purchased_from"), "manufacturers": distinct("manufacturer")})


@app.get("/api/summary")
def summary():
    data = compute_alerts(db())
    data["warranty_warning_days"] = WARRANTY_DAYS
    data["ha_connected"] = PUBLISH_SENSORS
    return jsonify(data)


# ---------------------------------------------------------------- categories & locations

def term_table(url_name):
    if url_name not in TERM_TABLES:
        abort(404)
    return TERM_TABLES[url_name]


def default_category_icon(name):
    return next((ic for n, ic in DEFAULT_CATEGORIES.items() if n.lower() == name.lower()), None)


def clean_term(data):
    name = str(data.get("name") or "").strip()[:80]
    if not name:
        abort(400, "Name is required")
    icon = str(data.get("icon") or "").strip()[:16] or None
    return name, icon


@app.post("/api/<any(categories, locations):kind>")
def create_term(kind):
    table, _ = term_table(kind)
    name, icon = clean_term(request.get_json(force=True) or {})
    conn = db()
    try:
        conn.execute(f"INSERT INTO {table} (name, icon) VALUES (?, ?)", (name, icon))
    except sqlite3.IntegrityError:
        abort(409, f"“{name}” already exists")
    conn.commit()
    return jsonify(term_list(conn, kind)), 201


@app.put("/api/<any(categories, locations):kind>/<int:term_id>")
def update_term(kind, term_id):
    table, column = term_table(kind)
    name, icon = clean_term(request.get_json(force=True) or {})
    conn = db()
    old = conn.execute(f"SELECT name FROM {table} WHERE id = ?", (term_id,)).fetchone()
    if old is None:
        abort(404)
    clash = conn.execute(f"SELECT id FROM {table} WHERE name = ? AND id != ?", (name, term_id)).fetchone()
    if clash:
        abort(409, f"“{name}” already exists")
    if not icon and table == "categories":
        icon = default_category_icon(name)  # "Default icon" means the built-in one, if there is one
    conn.execute(f"UPDATE {table} SET name = ?, icon = ? WHERE id = ?", (name, icon, term_id))
    # Renaming moves every item along with it
    conn.execute(f"UPDATE items SET {column} = ? WHERE {column} = ? COLLATE NOCASE", (name, old["name"]))
    conn.commit()
    return jsonify(term_list(conn, kind))


@app.delete("/api/<any(categories, locations):kind>/<int:term_id>")
def delete_term(kind, term_id):
    table, column = term_table(kind)
    conn = db()
    old = conn.execute(f"SELECT name FROM {table} WHERE id = ?", (term_id,)).fetchone()
    if old is None:
        abort(404)
    # Optionally move its items to another entry; otherwise they become unassigned
    move_to = request.args.get("move_to") or None
    if move_to:
        move_to = canonical_term(conn, kind, move_to)
    conn.execute(f"UPDATE items SET {column} = ? WHERE {column} = ? COLLATE NOCASE", (move_to, old["name"]))
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (term_id,))
    conn.commit()
    return jsonify(term_list(conn, kind))


# ---------------------------------------------------------------- custom icons
# Uploaded icons are referenced from items/categories/locations as "img:<id>"
# in the same `icon` column that otherwise holds an emoji.

ICON_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
              "image/webp": ".webp", "image/svg+xml": ".svg"}
ICON_EXT_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
                  ".webp": "image/webp", ".svg": "image/svg+xml"}
MAX_ICON_BYTES = 2 * 1024 * 1024


def icon_list(conn):
    return [dict(r) for r in conn.execute(
        "SELECT ic.id, ic.name, ic.content_type, "
        "  (SELECT COUNT(*) FROM items WHERE icon = 'img:' || ic.id)"
        " + (SELECT COUNT(*) FROM categories WHERE icon = 'img:' || ic.id)"
        " + (SELECT COUNT(*) FROM locations WHERE icon = 'img:' || ic.id) AS uses "
        "FROM icons ic ORDER BY lower(ic.name), ic.id")]


@app.get("/api/icons")
def list_icons():
    return jsonify(icon_list(db()))


@app.post("/api/icons")
def upload_icons():
    conn = db()
    files = [f for f in request.files.getlist("files") if f.filename]
    if not files:
        abort(400, "Choose one or more image files")
    given_name = (request.form.get("name") or "").strip()[:60]
    added, errors = [], []
    for f in files:
        ext = os.path.splitext(f.filename)[1].lower()
        ctype = f.mimetype if f.mimetype in ICON_TYPES else ICON_EXT_TYPES.get(ext)
        if not ctype:
            errors.append(f"{f.filename}: use PNG, SVG, JPG, WebP or GIF")
            continue
        data = f.read()
        if len(data) > MAX_ICON_BYTES:
            errors.append(f"{f.filename}: larger than 2 MB")
            continue
        stored = uuid.uuid4().hex + ICON_TYPES[ctype]
        with open(os.path.join(ICON_DIR, stored), "wb") as out:
            out.write(data)
        name = given_name if (given_name and len(files) == 1) else \
            re.sub(r"[_\-]+", " ", os.path.splitext(f.filename)[0]).strip()[:60] or "Icon"
        cur = conn.execute("INSERT INTO icons (name, stored_name, content_type, created_at) VALUES (?, ?, ?, ?)",
                           (name, stored, ctype, now()))
        added.append(cur.lastrowid)
    conn.commit()
    if not added:
        abort(400, "; ".join(errors))
    return jsonify({"added": added, "errors": errors, "icons": icon_list(conn)}), 201


@app.get("/api/icons/<int:icon_id>")
def get_icon(icon_id):
    r = db().execute("SELECT * FROM icons WHERE id = ?", (icon_id,)).fetchone()
    if r is None:
        abort(404)
    resp = send_from_directory(ICON_DIR, r["stored_name"], mimetype=r["content_type"], max_age=31536000)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    # An SVG opened on its own can contain script; this keeps it inert.
    resp.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return resp


@app.put("/api/icons/<int:icon_id>")
def rename_icon(icon_id):
    name = str((request.get_json(force=True) or {}).get("name") or "").strip()[:60]
    if not name:
        abort(400, "Name is required")
    conn = db()
    if conn.execute("UPDATE icons SET name = ? WHERE id = ?", (name, icon_id)).rowcount == 0:
        abort(404)
    conn.commit()
    return jsonify(icon_list(conn))


@app.delete("/api/icons/<int:icon_id>")
def delete_icon(icon_id):
    conn = db()
    r = conn.execute("SELECT * FROM icons WHERE id = ?", (icon_id,)).fetchone()
    if r is None:
        abort(404)
    ref = f"img:{icon_id}"
    for c in conn.execute("SELECT id, name FROM categories WHERE icon = ?", (ref,)).fetchall():
        conn.execute("UPDATE categories SET icon = ? WHERE id = ?", (default_category_icon(c["name"]), c["id"]))
    for table in ("items", "locations"):
        conn.execute(f"UPDATE {table} SET icon = NULL WHERE icon = ?", (ref,))  # fall back to default
    conn.execute("DELETE FROM icons WHERE id = ?", (icon_id,))
    conn.commit()
    try:
        os.remove(os.path.join(ICON_DIR, r["stored_name"]))
    except OSError:
        pass
    return jsonify(icon_list(conn))


# ---------------------------------------------------------------- attachments

INLINE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "application/pdf")


def clean_kind(value, content_type):
    if value in ATTACHMENT_KINDS:
        return value
    return "Photo" if content_type.startswith("image/") else "Other"


@app.post("/api/items/<int:item_id>/attachments")
def upload(item_id):
    get_item_row(item_id)
    conn = db()
    kind = request.form.get("kind")
    title = (request.form.get("title") or "").strip()[:200] or None
    saved = []
    for f in request.files.getlist("files"):
        if not f.filename:
            continue
        ext = os.path.splitext(secure_filename(f.filename))[1].lower()[:10]
        stored = uuid.uuid4().hex + ext
        path = os.path.join(UPLOAD_DIR, stored)
        f.save(path)
        ctype = f.mimetype or mimetypes.guess_type(f.filename)[0] or "application/octet-stream"
        cur = conn.execute(
            "INSERT INTO attachments (item_id, filename, title, kind, stored_name, content_type, size, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (item_id, f.filename, title, clean_kind(kind, ctype), stored, ctype, os.path.getsize(path), now()))
        saved.append(cur.lastrowid)
    conn.commit()
    return jsonify({"ids": saved}), 201


@app.get("/api/attachments/<int:att_id>")
def get_attachment(att_id):
    r = db().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if r is None:
        abort(404)
    inline = r["content_type"] in INLINE_TYPES and request.args.get("download") is None
    # Anything that isn't a plain image/PDF is downloaded rather than shown,
    # so an uploaded web page can never run inside the app.
    resp = send_from_directory(
        UPLOAD_DIR, r["stored_name"],
        mimetype=r["content_type"] if inline else "application/octet-stream",
        as_attachment=not inline, download_name=r["filename"], max_age=86400)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.put("/api/attachments/<int:att_id>")
def update_attachment(att_id):
    conn = db()
    r = conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if r is None:
        abort(404)
    data = request.get_json(force=True) or {}
    title = str(data.get("title") or "").strip()[:200] or None
    conn.execute("UPDATE attachments SET title = ?, kind = ? WHERE id = ?",
                 (title, clean_kind(data.get("kind"), r["content_type"]), att_id))
    conn.commit()
    return jsonify(dict(conn.execute(
        "SELECT id, filename, title, kind, content_type, size, created_at FROM attachments WHERE id = ?",
        (att_id,)).fetchone()))


@app.delete("/api/attachments/<int:att_id>")
def delete_attachment(att_id):
    conn = db()
    r = conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if r is None:
        abort(404)
    conn.execute("UPDATE items SET cover_id = NULL WHERE cover_id = ?", (att_id,))
    conn.execute("DELETE FROM attachments WHERE id = ?", (att_id,))
    conn.commit()
    try:
        os.remove(os.path.join(UPLOAD_DIR, r["stored_name"]))
    except OSError:
        pass
    return "", 204


# ---------------------------------------------------------------- maintenance tasks

def clean_task(data):
    title = str(data.get("title") or "").strip()
    try:
        interval = int(data.get("interval_days"))
    except (TypeError, ValueError):
        interval = 0
    if not title or interval < 1:
        abort(400, "Task needs a title and an interval of at least 1 day")
    last = parse_date(data.get("last_done"))
    return title, interval, last.isoformat() if last else None, (data.get("notes") or "").strip() or None


@app.post("/api/items/<int:item_id>/tasks")
def create_task(item_id):
    get_item_row(item_id)
    title, interval, last, notes = clean_task(request.get_json(force=True) or {})
    conn = db()
    cur = conn.execute(
        "INSERT INTO tasks (item_id, title, interval_days, last_done, notes) VALUES (?, ?, ?, ?, ?)",
        (item_id, title, interval, last, notes))
    conn.commit()
    changed()
    return jsonify(task_out(conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/tasks/<int:task_id>")
def update_task(task_id):
    title, interval, last, notes = clean_task(request.get_json(force=True) or {})
    conn = db()
    if conn.execute("UPDATE tasks SET title=?, interval_days=?, last_done=?, notes=? WHERE id=?",
                    (title, interval, last, notes, task_id)).rowcount == 0:
        abort(404)
    conn.commit()
    changed()
    return jsonify(task_out(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()))


@app.post("/api/tasks/<int:task_id>/done")
def task_done(task_id):
    conn = db()
    if conn.execute("UPDATE tasks SET last_done = ? WHERE id = ?",
                    (date.today().isoformat(), task_id)).rowcount == 0:
        abort(404)
    conn.commit()
    changed()
    return jsonify(task_out(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()))


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    conn = db()
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    changed()
    return "", 204


# ---------------------------------------------------------------- export

@app.get("/api/export.json")
def export_json():
    conn = db()
    items = []
    for r in conn.execute("SELECT * FROM items ORDER BY id"):
        it = item_out(r)
        it["tasks"] = [dict(t) for t in conn.execute("SELECT * FROM tasks WHERE item_id = ?", (r["id"],))]
        it["attachments"] = [dict(a) for a in conn.execute(
            "SELECT id, filename, title, kind, content_type, size FROM attachments WHERE item_id = ?",
            (r["id"],))]
        items.append(it)
    body = json.dumps({"exported_at": now(), "items": items}, indent=2)
    return Response(body, mimetype="application/json", headers={
        "Content-Disposition": f"attachment; filename=home-inventory-{date.today()}.json"})


@app.get("/api/export.csv")
def export_csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id"] + ITEM_FIELDS + ["custom_fields"])
    for r in db().execute("SELECT * FROM items ORDER BY lower(category), lower(name)"):
        extras = "; ".join(f"{e['label']}: {e['value']}" for e in item_out(r)["extra_fields"])
        w.writerow([r["id"]] + [r[f] or "" for f in ITEM_FIELDS] + [extras])
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f"attachment; filename=home-inventory-{date.today()}.csv"})


# ---------------------------------------------------------------- import (spreadsheet + bulk API)

MAX_IMPORT_ROWS = 5000
DATE_FIELDS = ("purchase_date", "warranty_expires")

# Spreadsheet headers we recognise for each field (compared ignoring case, spaces and punctuation)
FIELD_ALIASES = {
    "id": ["id", "item id"],
    "name": ["name", "item", "item name", "title", "equipment", "appliance", "description"],
    "category": ["category", "type", "item type", "group", "system"],
    "location": ["location", "room", "area", "where", "place"],
    "manufacturer": ["manufacturer", "make", "brand", "mfr", "mfg", "maker"],
    "model": ["model", "model number", "model no", "model #", "model num"],
    "serial_number": ["serial number", "serial", "serial no", "serial #", "sn", "s/n", "serial num"],
    "purchased_from": ["purchased from", "vendor", "store", "retailer", "seller", "supplier", "bought from", "dealer"],
    "installer": ["installer", "installed by", "contractor", "installation company", "builder"],
    "purchase_date": ["purchase date", "date purchased", "purchased", "bought", "install date",
                      "installation date", "installed", "date installed", "date"],
    "purchase_price": ["purchase price", "price", "cost", "amount", "paid"],
    "warranty_expires": ["warranty expires", "warranty", "warranty end", "warranty expiration",
                         "warranty expiry", "warranty until", "warranty end date", "warranty expiration date"],
    "website_url": ["website url", "website", "web site", "url", "link", "product url", "product page"],
    "manual_url": ["manual url", "manual", "manual link", "owners manual", "user manual"],
    "support_url": ["support url", "support site", "support website", "support link", "warranty registration"],
    "support_phone": ["support phone", "phone", "support number", "customer service", "telephone", "tel"],
    "support_email": ["support email", "email", "e-mail", "support e-mail"],
    "operating_notes": ["operating notes", "operating details", "operation", "operating instructions",
                        "instructions", "how to use", "how to operate", "usage"],
    "notes": ["notes", "note", "comments", "comment", "remarks"],
    "custom_fields": ["custom fields", "custom_fields", "extra fields", "more details"],
}


def _norm(header):
    return re.sub(r"[^a-z0-9#]", "", str(header).lower())


HEADER_LOOKUP = {}
for _field, _names in FIELD_ALIASES.items():
    for _n in [_field] + _names:
        HEADER_LOOKUP.setdefault(_norm(_n), _field)


def suggest_field(header):
    """Field a spreadsheet column most likely holds; unknown columns become custom fields."""
    return HEADER_LOOKUP.get(_norm(header), "extra")


def cell_text(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat(sep=" ")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))  # 12345.0 -> "12345" (serial numbers, years)
    return str(v).strip()


def read_table(upload):
    name = (upload.filename or "").lower()
    data = upload.read()
    if name.endswith(".xls"):
        abort(400, "That's the old .xls format. In Excel use File → Save As → Excel Workbook (.xlsx) or CSV.")
    if name.endswith((".xlsx", ".xlsm")) or data[:2] == b"PK":
        try:
            import openpyxl
        except ImportError:
            abort(400, "Excel support isn't installed on this server. Save the sheet as CSV and import that.")
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception:
            abort(400, "Couldn't open that Excel file. Try saving it again as .xlsx or CSV.")
        ws = wb.active or wb.worksheets[0]
        rows = [[cell_text(c) for c in r] for r in ws.iter_rows(values_only=True)]
        wb.close()
    else:
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]

    numbered = [(n, r) for n, r in enumerate(rows, 1) if any(c for c in r)]  # keep sheet row numbers
    if not numbered:
        abort(400, "That file has no rows.")
    header, body = numbered[0][1], numbered[1:]
    width = max(len(r) for _, r in numbered)
    header = [h or f"Column {i + 1}" for i, h in enumerate(header + [""] * (width - len(header)))]
    lines = [n for n, _ in body]
    body = [r + [""] * (width - len(r)) for _, r in body]
    if len(body) > MAX_IMPORT_ROWS:
        abort(400, f"Too many rows ({len(body)}). Split the file into parts of {MAX_IMPORT_ROWS} rows.")
    return header, body, lines


@app.post("/api/import/parse")
def import_parse():
    f = request.files.get("file")
    if not f or not f.filename:
        abort(400, "Choose a .csv or .xlsx file")
    header, body, lines = read_table(f)
    return jsonify({"filename": f.filename, "headers": header, "rows": body, "lines": lines,
                    "suggested": [suggest_field(h) for h in header]})


def flexible_date(value):
    s = str(value).strip()
    if not s:
        return None
    if re.fullmatch(r"\d{5}(\.0+)?", s) and 20000 < float(s) < 80000:  # Excel serial date number
        return (date(1899, 12, 30) + timedelta(days=int(float(s)))).isoformat()
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d", "%m/%d/%Y", "%m/%d/%y",
                "%m-%d-%Y", "%m.%d.%Y", "%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y", "%d %b %Y",
                "%d %B %Y", "%m/%Y", "%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"“{s}” isn't a date I recognise (use e.g. 2026-03-15 or 3/15/2026)")


def parse_extra_fields(value):
    """Accept [{label, value}], {label: value} or the export's "Label: value; Label: value" text."""
    if isinstance(value, dict):
        value = [{"label": k, "value": v} for k, v in value.items()]
    elif isinstance(value, str):
        pairs = []
        for part in value.split(";"):
            if part.strip():
                label, _, val = part.partition(":")
                pairs.append({"label": label.strip(), "value": val.strip()} if val else {"label": "", "value": label.strip()})
        value = pairs
    out = []
    for ef in value or []:
        if isinstance(ef, dict):
            label, val = cell_text(ef.get("label")), cell_text(ef.get("value"))
            if label or val:
                out.append({"label": label, "value": val})
    return out


def import_one(conn, row, update_existing):
    data = {}
    for field in ITEM_FIELDS:
        v = cell_text(row.get(field))
        if v:
            data[field] = v
    for field in DATE_FIELDS:
        if field in data:
            data[field] = flexible_date(data[field])
    extras = parse_extra_fields(row.get("extra_fields")) + parse_extra_fields(row.get("custom_fields"))

    existing = None
    if update_existing:
        rid = cell_text(row.get("id"))
        if rid.isdigit():
            existing = conn.execute("SELECT * FROM items WHERE id = ?", (int(rid),)).fetchone()
        if existing is None and data.get("serial_number"):
            existing = conn.execute("SELECT * FROM items WHERE serial_number = ? COLLATE NOCASE",
                                    (data["serial_number"],)).fetchone()
        if existing is None and data.get("name") and not data.get("serial_number"):
            # Same name - but only when exactly one item has it, so we never guess between two
            same = conn.execute("SELECT * FROM items WHERE name = ? COLLATE NOCASE", (data["name"],)).fetchall()
            if len(same) == 1:
                existing = same[0]
    if existing is None and not data.get("name"):
        raise ValueError("Name is required for a new item")

    if "category" in data:
        data["category"] = canonical_term(conn, "categories", data["category"])
    if "location" in data:
        data["location"] = canonical_term(conn, "locations", data["location"])

    if existing is not None:
        # Only fill in what the row provides; blank cells never erase existing details.
        merged = item_out(existing)["extra_fields"]
        for ef in extras:
            hit = next((m for m in merged if m["label"].lower() == ef["label"].lower() and ef["label"]), None)
            if hit:
                hit["value"] = ef["value"]
            else:
                merged.append(ef)
        data["extra_fields"] = json.dumps(merged)
        data["updated_at"] = now()
        conn.execute(f"UPDATE items SET {', '.join(f'{k} = ?' for k in data)} WHERE id = ?",
                     list(data.values()) + [existing["id"]])
        return "updated", existing["id"], data.get("name") or existing["name"]

    data["extra_fields"] = json.dumps(extras)
    data["created_at"] = data["updated_at"] = now()
    cur = conn.execute(f"INSERT INTO items ({', '.join(data)}) VALUES ({', '.join('?' * len(data))})",
                       list(data.values()))
    return "created", cur.lastrowid, data["name"]


@app.post("/api/import")
def import_items():
    """Bulk create/update. Body: [items] or {"items": [...], "update_existing": true, "dry_run": false}."""
    payload = request.get_json(force=True, silent=True)
    items = payload if isinstance(payload, list) else (payload or {}).get("items")
    opts = payload if isinstance(payload, dict) else {}
    if not isinstance(items, list):
        abort(400, 'Send JSON: a list of items, or {"items": [...]}')
    if len(items) > MAX_IMPORT_ROWS:
        abort(400, f"At most {MAX_IMPORT_ROWS} items per request")
    update_existing = bool(opts.get("update_existing", True))
    dry_run = bool(opts.get("dry_run")) or request.args.get("dry_run") in ("1", "true", "yes")

    conn = db()
    results, errors = [], []
    for n, row in enumerate(items, 1):
        row_no = row.get("_row", n) if isinstance(row, dict) else n
        if not isinstance(row, dict):
            errors.append({"row": row_no, "error": "Each item must be a JSON object"})
            continue
        try:
            action, item_id, name = import_one(conn, row, update_existing)
            results.append({"row": row_no, "action": action, "id": item_id, "name": name})
        except ValueError as e:
            errors.append({"row": row_no, "name": cell_text(row.get("name")), "error": str(e)})
    if dry_run:
        conn.rollback()
        for r in results:
            if r["action"] == "created":
                r["id"] = None  # nothing was saved
    else:
        conn.commit()
        changed()
    return jsonify({
        "dry_run": dry_run,
        "created": sum(r["action"] == "created" for r in results),
        "updated": sum(r["action"] == "updated" for r in results),
        "errors": errors,
        "results": results,
    })


@app.get("/api/import/template.csv")
def import_template():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(ITEM_FIELDS + ["custom_fields"])
    examples = [
        {"name": "Patio heater (east)", "category": "Outdoor", "location": "Back patio", "manufacturer": "Bromic",
         "model": "BH0420002", "serial_number": "SN-0001", "purchased_from": "Fireside Outdoor",
         "installer": "ABC Builders", "purchase_date": "2026-06-01", "purchase_price": "1899",
         "warranty_expires": "2028-06-01", "website_url": "bromic.com", "support_phone": "800-555-0100",
         "operating_notes": "Turn on at the wall switch, then use the remote.",
         "custom_fields": "Gas type: Natural gas; BTU: 39000"},
        {"name": "Refrigerator", "category": "Appliances", "location": "Kitchen", "manufacturer": "Sub-Zero",
         "model": "CL3650UFD", "serial_number": "SN-0002", "purchase_date": "6/15/2026",
         "custom_fields": "Water filter: 4204490"},
    ]
    for ex in examples:
        w.writerow([ex.get(f, "") for f in ITEM_FIELDS + ["custom_fields"]])
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": "attachment; filename=home-inventory-template.csv"})


# ---------------------------------------------------------------- Home Assistant sensors

_wake = threading.Event()


def changed():
    _wake.set()


def ha_set_state(entity_id, state, attributes):
    req = urllib.request.Request(
        f"{HA_API}/states/{entity_id}",
        data=json.dumps({"state": state, "attributes": attributes}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {HA_AUTH}", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


def publish_sensors():
    conn = connect()
    try:
        alerts = compute_alerts(conn)
        total = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    finally:
        conn.close()
    due = [t for t in alerts["tasks"] if t["days_left"] <= 0]
    ha_set_state("sensor.home_inventory_maintenance_due", len(due), {
        "friendly_name": "Home maintenance due",
        "icon": "mdi:wrench-clock",
        "unit_of_measurement": "tasks",
        "tasks": [{"item": t["item_name"], "task": t["title"], "due": t["next_due"],
                   "days_overdue": -t["days_left"],
                   "summary": f"{t['item_name']}: {t['title']}"} for t in due],
    })
    ha_set_state("sensor.home_inventory_warranties_expiring", len(alerts["warranties"]), {
        "friendly_name": "Warranties expiring soon",
        "icon": "mdi:shield-alert-outline",
        "unit_of_measurement": "items",
        "window_days": WARRANTY_DAYS,
        "items": [{"item": w["item_name"], "expires": w["warranty_expires"],
                   "days_left": w["days_left"],
                   "summary": f"{w['item_name']} ({w['warranty_expires']})"} for w in alerts["warranties"]],
    })
    ha_set_state("sensor.home_inventory_items", total, {
        "friendly_name": "Home inventory items",
        "icon": "mdi:home-search",
        "unit_of_measurement": "items",
    })


def publisher_loop():
    while True:
        try:
            publish_sensors()
        except urllib.error.HTTPError as e:
            hint = " - check HA_TOKEN" if e.code == 401 else ""
            print(f"[home_inventory] Home Assistant rejected sensor update: {e}{hint}", flush=True)
        except Exception as e:  # HA restarting, etc. - retry on next tick
            print(f"[home_inventory] could not reach Home Assistant at {HA_API}: {e}", flush=True)
        _wake.wait(timeout=900)  # refresh every 15 min (also restores after HA restarts)
        _wake.clear()
        time.sleep(2)  # coalesce bursts of edits


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    init_db()
    if PUBLISH_SENSORS:
        threading.Thread(target=publisher_loop, daemon=True).start()
    print(f"[home_inventory] serving on :{PORT}, data in {DATA_DIR}, "
          f"HA sensors {'on' if PUBLISH_SENSORS else 'off'}", flush=True)
    try:
        from waitress import serve
        serve(app, host="0.0.0.0", port=PORT, threads=8)
    except ImportError:
        app.run(host="0.0.0.0", port=PORT)
