# Home Inventory: Home Assistant add-on

A mobile-friendly inventory for your house (make, model, serial, purchase, warranty, support,
manuals, photos, operating notes, maintenance reminders). It runs on your Raspberry Pi as a Home Assistant
add-on and shows up in the HA sidebar and the companion app. See [home_inventory/DOCS.md](home_inventory/DOCS.md).

> **Home Assistant Container or Core?** If HA says *"Apps require the Home Assistant Operating System"*,
> follow **[INSTALL-DOCKER.md](INSTALL-DOCKER.md)** instead. It runs as a Docker container on the Pi.

## Install on Home Assistant OS (local add-on, no GitHub needed)

1. In Home Assistant, install the **Samba share** or **Advanced SSH & Web Terminal** add-on
   (Settings → Add-ons → Add-on Store) so you can copy files to the Pi.
2. Copy the `home_inventory` folder into the Pi's **`addons`** share, so you get
   `/addons/home_inventory/config.yaml`.
   - Samba: open `\\homeassistant.local\addons` (Windows) or `smb://homeassistant.local/addons` (Mac).
3. Settings → Add-ons → **Add-on Store** → ⋮ (top right) → **Check for updates**.
4. Scroll down to **Local add-ons** → **Home Inventory** → **Install**. The Pi builds it, which takes a few minutes.
5. Turn on **Show in sidebar**, then **Start**.
6. Open **Home Inventory** from the sidebar (or the companion app's menu).

To update later: copy over the changed files, bump `version` in `config.yaml`, then *Check for updates* → **Update**.

## Alternative: install from GitHub

Push this whole folder to a GitHub repo, set the URL in `repository.yaml`, then in HA:
Add-on Store → ⋮ → **Repositories** → paste the repo URL.

## Run locally (for development)

```bash
python3 -m venv venv && ./venv/bin/pip install flask waitress
cd home_inventory/app && DATA_DIR=./devdata ../../venv/bin/python server.py
```

Open http://localhost:8099. HA sensors are off when it is not running as an add-on.

## Layout

```
repository.yaml            add-on repository manifest
home_inventory/
  config.yaml              add-on config (ingress, options, HA API access)
  build.yaml / Dockerfile  Alpine + Python + Flask image
  DOCS.md                  shown in the add-on's Documentation tab
  app/server.py            REST API, SQLite, HA sensor publisher
  app/static/              the web app (plain HTML/CSS/JS, no build step)
```
