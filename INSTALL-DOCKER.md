# Install on Home Assistant Container / Core (Docker on the Pi)

Use this if Home Assistant shows *"Apps require the Home Assistant Operating System"*.
Home Inventory then runs as its own Docker container on the same Pi:

- you open it at `http://<pi-address>:8099`, or from a Home Assistant sidebar entry
- it still creates the `sensor.home_inventory_*` sensors in Home Assistant

## 1. Find your Pi's address
Use your router's device list, or SSH in and run `hostname -I`. The first number is the address, e.g. `192.168.1.50`.
The steps below call it **PI_IP**.

## 2. Connect to the Pi
On the Mac, open **Terminal** and run the command below, using the username you set up on the Pi:
```bash
ssh pi@PI_IP
```

## 3. Check Docker and git
```bash
docker compose version
```
- If this prints a version, carry on.
- If it says *permission denied*, run `sudo usermod -aG docker $USER`, log out, then SSH back in.
- If it says *'compose' is not a docker command*, run `sudo apt update && sudo apt install -y docker-compose-plugin`.
```bash
sudo apt install -y git
```

## 4. Download the app from GitHub
```bash
cd ~ && git clone https://github.com/stevantownsend/home-inventory-addon.git
```
```bash
cd ~/home-inventory-addon
```

## 5. Create a Home Assistant access token
In Home Assistant: click your **name** (bottom-left) → **Security** tab → **Long-lived access tokens** → **Create token**.
Name it `Home Inventory` and **copy the token**. Home Assistant only shows it once.

## 6. Create the settings file (.env)
```bash
nano .env
```
Type these lines, pasting your token after `HA_TOKEN=` and setting your time zone
(e.g. `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`):
```
TZ=America/Chicago
HA_TOKEN=paste-the-long-token-here
WARRANTY_WARNING_DAYS=60
```
Save: **Ctrl+O**, **Enter**, then **Ctrl+X**. The token stays on the Pi and is never uploaded to GitHub.

## 7. Build and start
```bash
docker compose up -d --build
```
The first build takes a few minutes. Then check the log:
```bash
docker compose logs -f
```
You should see `serving on :8099 ... HA sensors on`. Press **Ctrl+C** to stop watching. The app keeps running and restarts with the Pi.

## 8. Open it
On your phone or computer (same Wi-Fi), go to `http://PI_IP:8099`.
On iPhone you can tap Share → **Add to Home Screen** to get an app icon.

## 9. Add it to the Home Assistant sidebar
Home Assistant: **Settings → Dashboards → + Add dashboard → Webpage**.
URL `http://PI_IP:8099`, title `Home Inventory`, icon `mdi:home-search` → **Create**.
It now shows in the sidebar and in the companion app's menu.

> If you open Home Assistant through an **https** address (e.g. Nabu Casa remote access), the browser blocks this http page
> inside it, and it isn't reachable away from home. It works whenever you use Home Assistant at home over `http://PI_IP:8123`.

## 10. Check the sensors
Home Assistant: **Developer tools → States**, search `home_inventory`. You should see 3 sensors.
The notification and dashboard-card examples are in [home_inventory/DOCS.md](home_inventory/DOCS.md).

## Updating
```bash
cd ~/home-inventory-addon && git pull && docker compose up -d --build
```

## Backups (important)
Home Assistant backups do **not** include this app's data. Everything is in `~/home-inventory-addon/data` on the Pi.
Copy that folder somewhere safe now and then, or use **Export backup (JSON)** / **Export spreadsheet (CSV)** at the bottom of the app.

## Security
Anyone on your home Wi-Fi can open the app, because it has no login of its own. Don't forward port 8099 on your router.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Log says `check HA_TOKEN` | Token pasted wrong in `.env`. Fix it, then `docker compose up -d` |
| Log says `could not reach Home Assistant` | Home Assistant isn't on this Pi or not on port 8123. Add `HA_URL=http://HA_IP:8123` to `.env` |
| Page won't load | `docker compose ps` should show it running; check `docker compose logs` |
| Due dates off by a day | Set `TZ` in `.env`, then `docker compose up -d` |
