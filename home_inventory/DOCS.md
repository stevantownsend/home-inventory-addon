# Home Inventory

A catalog of everything in your house: appliances, pool equipment, heaters, HVAC, and anything else.
For each item you can record:

- **Identification**: make, model, serial number (with copy buttons)
- **Purchase & warranty**: who you bought it from, who installed it, date, price, warranty end date
- **Links & support**: product site, manual, support site, tap-to-call phone, email
- **Operating details**: free text, and any links in it become clickable
- **More details**: your own fields (filter size, BTU, gas type, breaker #…)
- **Photos & documents**: photos of the data plate, receipts, PDF manuals (uses the phone camera)
- **Maintenance tasks**: recurring jobs like "Clean pool filter every 3 months"

It opens from the Home Assistant sidebar and in the HA companion app on your phone.
Home Assistant login protects it. Nothing is exposed outside HA.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `publish_sensors` | `true` | Create the Home Assistant sensors below |
| `warranty_warning_days` | `60` | How many days ahead a warranty counts as "expiring soon" |

## Home Assistant sensors

| Entity | State | Attributes |
| --- | --- | --- |
| `sensor.home_inventory_maintenance_due` | number of tasks due/overdue | `tasks`: list of `{item, task, due, days_overdue, summary}` |
| `sensor.home_inventory_warranties_expiring` | number of warranties ending soon | `items`: list of `{item, expires, days_left, summary}` |
| `sensor.home_inventory_items` | total items | |

They refresh right after every change and every 15 minutes.

### Example: phone notification for due maintenance

Settings → Automations → Create → ⋮ → Edit in YAML. Replace `notify.mobile_app_your_phone` with your phone's notify service:

```yaml
alias: Home maintenance reminder
triggers:
  - trigger: time
    at: "09:00:00"
conditions:
  - condition: numeric_state
    entity_id: sensor.home_inventory_maintenance_due
    above: 0
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "🔧 Home maintenance due"
      message: >-
        {{ state_attr('sensor.home_inventory_maintenance_due', 'tasks')
           | map(attribute='summary') | join('\n') }}
mode: single
```

### Example: dashboard card

```yaml
type: markdown
title: Home maintenance
content: >-
  {% set t = state_attr('sensor.home_inventory_maintenance_due', 'tasks') or [] %}
  {% for x in t %}- **{{ x.item }}**: {{ x.task }} ({{ x.days_overdue }} days overdue)
  {% else %}All caught up ✅{% endfor %}
```

## Backups

All data (database + photos) is in the add-on's `/data` folder, so regular Home Assistant backups include it.
You can also export a CSV spreadsheet or a JSON backup from the bottom of the home screen.
