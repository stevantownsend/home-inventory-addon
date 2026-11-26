# Home Inventory API

Everything the app does goes through a small JSON API, so you can load or read data from scripts,
spreadsheets, Home Assistant, Node-RED, Postman, etc.

**Base URL:** `http://PI_IP:8099/api` (replace `PI_IP` with your Pi's address)

> **Security:** there is no login. Anyone on your home network can use the API, just like the app.
> Never forward port 8099 on your router.

Errors come back as JSON with an HTTP error code, e.g. `400 {"error": "Name is required"}`.

---

## Bulk import (create or update many items)

`POST /api/import`

Send either a plain list of items, or an object with options:

```json
{
  "items": [ { "name": "Pool pump", "manufacturer": "Pentair", "serial_number": "1122" } ],
  "update_existing": true,
  "dry_run": false
}
```

| Option | Default | Meaning |
|---|---|---|
| `update_existing` | `true` | If an item already exists, update it instead of adding a duplicate. Items are matched by `id`, then `serial_number`, then `name` (only when exactly one item has that name). |
| `dry_run` | `false` | Check everything and report what *would* happen, without saving. Also available as `?dry_run=1`. |

**Updates only change the fields you send.** Missing or blank fields are left alone, and custom fields are merged by label.

**Response:**
```json
{
  "dry_run": false,
  "created": 1,
  "updated": 1,
  "errors":  [ { "row": 3, "name": "Dishwasher", "error": "“soon” isn't a date I recognise" } ],
  "results": [ { "row": 1, "action": "created", "id": 7, "name": "Pool pump" },
               { "row": 2, "action": "updated", "id": 2, "name": "Furnace" } ]
}
```
Rows with errors are skipped; the rest are saved. `row` is the item's position in your list (1 = first),
or your own number if you include `"_row": n` in an item.

### Item fields

All optional except `name` (needed when creating).

| Field | Example |
|---|---|
| `name` | `"Patio heater (east)"` |
| `category` | `"Outdoor"`, added to your category list if new |
| `location` | `"Back patio"`, added to your location list if new |
| `manufacturer`, `model`, `serial_number` | `"Bromic"`, `"BH0420002"`, `"SN-0001"` |
| `purchased_from`, `installer` | `"Fireside Outdoor"`, `"ABC Builders"` |
| `purchase_date`, `warranty_expires` | `"2026-06-01"`, also accepts `6/1/2026`, `Jun 1, 2026` |
| `purchase_price` | `"1899"` (stored as text) |
| `website_url`, `manual_url`, `support_url` | `"bromic.com/support"` |
| `support_phone`, `support_email` | `"800-555-0100"`, `"help@example.com"` |
| `operating_notes`, `notes` | free text, may contain line breaks |
| `extra_fields` | `{"Gas type": "Natural gas", "BTU": "39000"}` or `[{"label": "BTU", "value": "39000"}]` |
| `id` | only for updating a specific existing item |

### Examples

**curl** (Mac/Linux Terminal):
```bash
curl -X POST http://PI_IP:8099/api/import -H "Content-Type: application/json" -d '[
  {"name": "Water heater", "category": "Water Heater", "location": "Garage",
   "manufacturer": "Rheem", "model": "XE50", "serial_number": "RH-123",
   "purchase_date": "2026-05-01", "warranty_expires": "2032-05-01",
   "extra_fields": {"Capacity": "50 gal", "Anode rod": "Magnesium"}}
]'
```

**Check first without saving:**
```bash
curl -X POST "http://PI_IP:8099/api/import?dry_run=1" -H "Content-Type: application/json" -d @items.json
```

**Python:**
```python
import requests

items = [
    {"name": "Pool pump", "category": "Pool & Spa", "manufacturer": "Pentair",
     "model": "IntelliFlo3 VSF", "serial_number": "PEN-001", "location": "Equipment pad"},
]
r = requests.post("http://PI_IP:8099/api/import", json={"items": items})
print(r.json())
```

**Update one field on an existing item** (matched by serial number):
```bash
curl -X POST http://PI_IP:8099/api/import -H "Content-Type: application/json" \
  -d '[{"serial_number": "RH-123", "notes": "Anode rod replaced Nov 2026"}]'
```

---

## Uploading a spreadsheet through the API

`POST /api/import/parse`, as multipart form with a `file` (.xlsx or .csv). It reads the file and returns
`headers`, `rows`, the sheet row numbers in `lines`, and `suggested` field names for each column.
It does **not** save anything: turn the rows into items and send them to `POST /api/import`.
(The app's **Import from Excel / CSV** screen works exactly this way.)

`GET /api/import/template.csv` gives a template with every column.

---

## Other endpoints

| Method & path | What it does |
|---|---|
| `GET /api/items` | All items (summary fields) |
| `GET /api/items/{id}` | One item with its files and maintenance tasks |
| `POST /api/items` | Create one item (JSON, `name` required) |
| `PUT /api/items/{id}` | Replace an item's details (send all fields; missing ones are cleared) |
| `DELETE /api/items/{id}` | Delete an item and its files |
| `PUT /api/items/{id}/appearance` | Item picture: `{"icon": "🔥"}`, `{"cover_id": 12}` or `{}` for automatic |
| `POST /api/items/{id}/attachments` | Upload files: multipart `files` (one or more), optional `kind`, `title` |
| `GET /api/attachments/{id}` | Download a file |
| `PUT /api/attachments/{id}` | Change a file's `kind` / `title` |
| `DELETE /api/attachments/{id}` | Delete a file |
| `POST /api/items/{id}/tasks` | Add a maintenance task: `{"title", "interval_days", "last_done", "notes"}` |
| `POST /api/tasks/{id}/done` | Mark a task done today |
| `DELETE /api/tasks/{id}` | Delete a task |
| `GET /api/meta` | Categories, locations (with item counts), attachment types |
| `POST /api/categories`, `/api/locations` | Add: `{"name", "icon"}` |
| `PUT /api/categories/{id}`, `/api/locations/{id}` | Rename / change icon (items follow the rename) |
| `DELETE /api/categories/{id}?move_to=Name` | Delete; items move to `move_to` or become unassigned |
| `GET /api/icons` | Your uploaded icons (`id`, `name`, how many places use each) |
| `POST /api/icons` | Upload icons: multipart `files` (PNG, SVG, JPG, WebP, GIF; max 2 MB each), optional `name` |
| `GET /api/icons/{id}` | The icon image |
| `PUT /api/icons/{id}` | Rename: `{"name": "Pool pump"}` |
| `DELETE /api/icons/{id}` | Delete; anything using it goes back to its default icon |
| `GET /api/summary` | Maintenance due and warranties expiring soon |
| `GET /api/export.csv`, `/api/export.json` | Full export |

**Icons:** anywhere an `icon` is accepted (item appearance, categories, locations) you can pass an emoji such as
`"🔥"` or an uploaded icon as `"img:<id>"`, e.g. `{"icon": "img:4"}`.

Attachment `kind` is one of: Photo, Manual, Receipt, Invoice, Contract, Warranty, Permit, Plans & drawings, Other.

**Upload a file with curl:**
```bash
curl -F "files=@contract.pdf" -F "kind=Contract" -F "title=Installation contract" \
  http://PI_IP:8099/api/items/7/attachments
```
