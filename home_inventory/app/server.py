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
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "inventory.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8099"))
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
INGRESS_IP = "172.30.32.2"  # Home Assistant's ingress proxy

os.makedirs(UPLOAD_DIR, exist_ok=True)


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
"""

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB per upload request


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
    conn.commit()
    conn.close()


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

@app.get("/api/items")
def list_items():
    conn = db()
    items = [item_out(r) for r in conn.execute("SELECT * FROM items ORDER BY lower(name)")]
    thumbs = {}
    for r in conn.execute(
        "SELECT item_id, MIN(id) AS id FROM attachments "
        "WHERE content_type LIKE 'image/%' AND content_type != 'image/svg+xml' GROUP BY item_id"
    ):
        thumbs[r["item_id"]] = r["id"]
    due = {}
    for r in conn.execute("SELECT * FROM tasks"):
        if task_out(r)["days_left"] <= 0:
            due[r["item_id"]] = due.get(r["item_id"], 0) + 1
    for it in items:
        it["thumb_id"] = thumbs.get(it["id"])
        it["tasks_due"] = due.get(it["id"], 0)
    return jsonify(items)


@app.post("/api/items")
def create_item():
    v = clean_item_payload(request.get_json(force=True) or {})
    cols = list(v.keys()) + ["created_at", "updated_at"]
    vals = list(v.values()) + [now(), now()]
    conn = db()
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
        "SELECT id, filename, content_type, size, created_at FROM attachments "
        "WHERE item_id = ? ORDER BY id", (item_id,))]
    it["tasks"] = sorted((task_out(r) for r in conn.execute(
        "SELECT * FROM tasks WHERE item_id = ?", (item_id,))), key=lambda t: t["days_left"])
    return jsonify(it)


@app.put("/api/items/<int:item_id>")
def update_item(item_id):
    get_item_row(item_id)
    v = clean_item_payload(request.get_json(force=True) or {})
    v["updated_at"] = now()
    conn = db()
    conn.execute(
        f"UPDATE items SET {', '.join(f'{k} = ?' for k in v)} WHERE id = ?",
        list(v.values()) + [item_id],
    )
    conn.commit()
    changed()
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


@app.get("/api/meta")
def meta():
    conn = db()
    def distinct(col):
        return [r[0] for r in conn.execute(
            f"SELECT DISTINCT {col} FROM items WHERE {col} IS NOT NULL ORDER BY lower({col})")]
    return jsonify({"categories": distinct("category"), "locations": distinct("location"),
                    "vendors": distinct("purchased_from"), "manufacturers": distinct("manufacturer")})


@app.get("/api/summary")
def summary():
    data = compute_alerts(db())
    data["warranty_warning_days"] = WARRANTY_DAYS
    data["ha_connected"] = PUBLISH_SENSORS
    return jsonify(data)


# ---------------------------------------------------------------- attachments

INLINE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "application/pdf")


@app.post("/api/items/<int:item_id>/attachments")
def upload(item_id):
    get_item_row(item_id)
    conn = db()
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
            "INSERT INTO attachments (item_id, filename, stored_name, content_type, size, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (item_id, f.filename, stored, ctype, os.path.getsize(path), now()))
        saved.append(cur.lastrowid)
    conn.commit()
    return jsonify({"ids": saved}), 201


@app.get("/api/attachments/<int:att_id>")
def get_attachment(att_id):
    r = db().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if r is None:
        abort(404)
    inline = r["content_type"] in INLINE_TYPES and request.args.get("download") is None
    # Anything that isn't a plain image/PDF is forced to download so it can't
    # run script in Home Assistant's origin.
    resp = send_from_directory(
        UPLOAD_DIR, r["stored_name"],
        mimetype=r["content_type"] if inline else "application/octet-stream",
        as_attachment=not inline, download_name=r["filename"], max_age=86400)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.delete("/api/attachments/<int:att_id>")
def delete_attachment(att_id):
    conn = db()
    r = conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if r is None:
        abort(404)
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
            "SELECT id, filename, content_type, size FROM attachments WHERE item_id = ?", (r["id"],))]
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
