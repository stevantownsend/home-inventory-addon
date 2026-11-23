'use strict';
// Home Inventory front end. Plain JS, no build step. All URLs are relative so
// it works behind Home Assistant Ingress (/api/hassio_ingress/<token>/).

const $app = document.getElementById('app');
const $title = document.getElementById('title');
const $back = document.getElementById('back');
const $topaction = document.getElementById('topaction');
const $lightbox = document.getElementById('lightbox');

const CATEGORIES = {
  'Appliances': '🔌', 'HVAC': '🌡️', 'Water Heater': '♨️', 'Plumbing': '🚰', 'Electrical': '⚡',
  'Lighting': '💡', 'Pool & Spa': '🏊', 'Outdoor': '🌳', 'Irrigation': '💧', 'Garage': '🚗',
  'Doors & Windows': '🚪', 'Roof & Exterior': '🏠', 'Flooring & Finishes': '🪵',
  'Security': '🔒', 'Smart Home & Network': '📡', 'Entertainment': '📺', 'Furniture': '🛋️', 'Other': '📦',
};
const INTERVALS = [[7, 'Weekly'], [30, 'Monthly'], [90, 'Every 3 months'], [180, 'Every 6 months'], [365, 'Yearly'], [730, 'Every 2 years']];

const state = { q: '', cat: '', items: [] };

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { u = String(u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u; };
const hostOf = (u) => { try { return new URL(safeUrl(u)).hostname.replace(/^www\./, ''); } catch { return u; } };
const iconFor = (cat) => CATEGORIES[cat] || '📦';
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<]+/g, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function dueBadge(days) {
  if (days < 0) return `<span class="badge bad">${-days} day${days === -1 ? '' : 's'} overdue</span>`;
  if (days === 0) return '<span class="badge bad">Due today</span>';
  if (days <= 7) return `<span class="badge warn">Due in ${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span class="badge ok">Due ${fmtDate(new Date(Date.now() + days * 864e5).toISOString())}</span>`;
}
function warrantyBadge(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const days = Math.round((new Date(y, m - 1, d) - new Date(new Date().toDateString())) / 864e5);
  if (days < 0) return '<span class="badge bad">Expired</span>';
  if (days <= 60) return `<span class="badge warn">${days} days left</span>`;
  return '<span class="badge ok">Active</span>';
}
function intervalLabel(n) {
  const hit = INTERVALS.find(([d]) => d === n);
  return hit ? hit[1] : `Every ${n} days`;
}

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { 'Content-Type': 'application/json' };
    delete init.json;
  }
  const r = await fetch('api/' + path, init);
  if (!r.ok) {
    const text = await r.text();
    const msg = (text.match(/<p>(.*?)<\/p>/) || [])[1] || r.statusText;
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs HTTPS; fall back for plain-http HA installs.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copied');
}

function setHeader(title, back, action = '') {
  $title.textContent = title;
  document.title = title === 'Home Inventory' ? title : `${title} · Home Inventory`;
  $back.hidden = !back;
  if (back) $back.setAttribute('href', back);
  $topaction.innerHTML = action;
}

// ------------------------------------------------------------------ router
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'item' && parts[1]) await viewItem(+parts[1]);
    else if (parts[0] === 'edit' && parts[1]) await viewEdit(+parts[1]);
    else if (parts[0] === 'new') await viewEdit(null);
    else await viewHome();
  } catch (e) {
    $app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to list</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ home
async function viewHome() {
  setHeader('Home Inventory', false);
  const [items, summary] = await Promise.all([api('items'), api('summary')]);
  state.items = items;

  const alerts = [
    ...summary.tasks.filter((t) => t.days_left <= 0).map((t) => `
      <div class="alert">
        <div class="thumb" style="width:40px;height:40px;font-size:20px">🔧</div>
        <div class="meta"><a href="#/item/${t.item_id}">${esc(t.title)}</a>
          <div class="sub">${esc(t.item_name)} · ${dueBadge(t.days_left)}</div></div>
        <button class="btn small" data-act="task-done" data-id="${t.id}">Done</button>
      </div>`),
    ...summary.warranties.map((w) => `
      <div class="alert">
        <div class="thumb" style="width:40px;height:40px;font-size:20px">🛡️</div>
        <div class="meta"><a href="#/item/${w.item_id}">${esc(w.item_name)}</a>
          <div class="sub">Warranty ends ${fmtDate(w.warranty_expires)} · <span class="badge warn">${w.days_left} days</span></div></div>
      </div>`),
  ].join('');

  if (!items.length) {
    $app.innerHTML = `
      <div class="empty">
        <div style="font-size:56px">🏡</div>
        <h2>Start your home inventory</h2>
        <p>Add your appliances, pool equipment, HVAC, heaters and anything else — make, model, serial number, where you bought it, support contacts, manuals and how to operate it.</p>
        <a class="btn primary" href="#/new">Add your first item</a>
      </div>`;
    return;
  }

  const cats = [...new Set(items.map((i) => i.category || 'Other'))].sort();
  $app.innerHTML = `
    ${alerts ? `<section class="alerts">${alerts}</section>` : ''}
    <div class="searchbar">
      <input type="search" id="q" placeholder="Search name, make, model, serial, room…" value="${esc(state.q)}" autocomplete="off">
      <div class="chips" role="toolbar" aria-label="Filter by category">
        <button class="chip" data-cat="" aria-pressed="${!state.cat}">All (${items.length})</button>
        ${cats.map((c) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${iconFor(c)} ${esc(c)}</button>`).join('')}
      </div>
    </div>
    <div id="list"></div>
    <nav class="footer-links">
      <a href="api/export.csv" download>⬇ Export spreadsheet (CSV)</a>
      <a href="api/export.json" download>⬇ Export backup (JSON)</a>
    </nav>
    <a class="fab" href="#/new" aria-label="Add item">+</a>`;

  const $q = document.getElementById('q');
  $q.addEventListener('input', () => { state.q = $q.value; renderList(); });
  renderList();
}

function renderList() {
  const q = state.q.trim().toLowerCase();
  const fields = ['name', 'category', 'location', 'manufacturer', 'model', 'serial_number', 'purchased_from', 'installer', 'notes'];
  const hits = state.items.filter((it) =>
    (!state.cat || (it.category || 'Other') === state.cat) &&
    (!q || fields.some((f) => (it[f] || '').toLowerCase().includes(q)) ||
      it.extra_fields.some((e) => `${e.label} ${e.value}`.toLowerCase().includes(q))));

  const groups = {};
  hits.forEach((it) => (groups[it.category || 'Other'] ||= []).push(it));
  const $list = document.getElementById('list');
  if (!hits.length) { $list.innerHTML = '<p class="empty">No matching items.</p>'; return; }
  $list.innerHTML = Object.keys(groups).sort().map((cat) => `
    <h2 class="group-title">${iconFor(cat)} ${esc(cat)}</h2>
    <div class="list">${groups[cat].map((it) => `
      <a class="item" href="#/item/${it.id}">
        <div class="thumb">${it.thumb_id ? `<img src="api/attachments/${it.thumb_id}" alt="" loading="lazy">` : iconFor(it.category)}</div>
        <div class="meta">
          <div class="name">${esc(it.name)}</div>
          <div class="sub">${esc([it.manufacturer, it.model].filter(Boolean).join(' · ') || '—')}</div>
          ${it.location ? `<div class="sub">📍 ${esc(it.location)}</div>` : ''}
        </div>
        ${it.tasks_due ? `<span class="badge bad">${it.tasks_due} due</span>` : ''}
      </a>`).join('')}
    </div>`).join('');

  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.cat === state.cat)));
}

// ------------------------------------------------------------------ detail
async function viewItem(id) {
  const it = await api(`items/${id}`);
  setHeader(it.name, '#/', `<a class="iconbtn" href="#/edit/${id}" aria-label="Edit">✏️</a>`);
  const images = it.attachments.filter((a) => /^image\/(jpeg|png|gif|webp)/.test(a.content_type));

  const row = (label, value, copy) => value ? `
    <div class="row"><dt>${label}</dt><dd><span class="${copy ? 'mono' : ''}">${esc(value)}</span>
      ${copy ? `<button class="copy" data-act="copy" data-text="${esc(value)}">Copy</button>` : ''}</dd></div>` : '';
  const section = (title, body, extra = '') => body.trim() ? `<section class="card"><h3>${title}${extra}</h3>${body}</section>` : '';
  const link = (ico, label, href, sub, external = true) => `
    <a class="linkrow" href="${esc(href)}" ${external ? 'target="_blank" rel="noopener"' : ''}>
      <span class="ico">${ico}</span><span class="meta"><div>${label}</div><div class="sub">${esc(sub)}</div></span><span>›</span></a>`;

  const links = [
    it.website_url && link('🌐', 'Product website', safeUrl(it.website_url), hostOf(it.website_url)),
    it.manual_url && link('📘', 'Owner’s manual', safeUrl(it.manual_url), hostOf(it.manual_url)),
    it.support_url && link('🛟', 'Support / warranty site', safeUrl(it.support_url), hostOf(it.support_url)),
    it.support_phone && link('📞', 'Call support', 'tel:' + it.support_phone.replace(/[^\d+]/g, ''), it.support_phone, false),
    it.support_email && link('✉️', 'Email support', 'mailto:' + it.support_email, it.support_email, false),
  ].filter(Boolean).join('');

  const tasks = it.tasks.map((t) => `
    <div class="task">
      <div class="meta"><div><strong>${esc(t.title)}</strong></div>
        <div class="sub">${intervalLabel(t.interval_days)} · last done ${t.last_done ? fmtDate(t.last_done) : 'never'}</div>
        <div>${dueBadge(t.days_left)}</div>
        ${t.notes ? `<div class="sub">${esc(t.notes)}</div>` : ''}</div>
      <button class="btn small" data-act="task-done" data-id="${t.id}">Done</button>
      <button class="copy" data-act="task-del" data-id="${t.id}" aria-label="Delete task">✕</button>
    </div>`).join('');

  const files = it.attachments.map((a) => {
    const isImg = images.includes(a);
    return `<div class="tile">
      ${isImg ? `<img src="api/attachments/${a.id}" alt="${esc(a.filename)}" loading="lazy" data-act="zoom">`
              : `<a class="doc" href="api/attachments/${a.id}" target="_blank" rel="noopener"><span>${a.content_type === 'application/pdf' ? '📄' : '📎'}</span>${esc(a.filename)}</a>`}
      <button class="del" data-act="att-del" data-id="${a.id}" aria-label="Delete ${esc(a.filename)}">✕</button>
    </div>`;
  }).join('');

  $app.innerHTML = `
    <div class="hero">
      <div class="thumb" ${images[0] ? 'data-act="zoom-first"' : ''}>${images[0] ? `<img src="api/attachments/${images[0].id}" alt="">` : iconFor(it.category)}</div>
      <div><h2>${esc(it.name)}</h2><div class="sub">${esc([it.category, it.location].filter(Boolean).join(' · '))}</div></div>
    </div>

    ${section('Identification', `<dl>${row('Manufacturer', it.manufacturer)}${row('Model', it.model, true)}${row('Serial number', it.serial_number, true)}</dl>`)}

    ${section('Purchase & warranty', `<dl>
      ${row('Purchased from', it.purchased_from)}
      ${row('Installed by', it.installer)}
      ${row('Purchase date', fmtDate(it.purchase_date))}
      ${row('Price', it.purchase_price)}
      ${it.warranty_expires ? `<div class="row"><dt>Warranty until</dt><dd>${fmtDate(it.warranty_expires)} ${warrantyBadge(it.warranty_expires)}</dd></div>` : ''}
    </dl>`)}

    ${section('Links & support', links)}

    ${it.operating_notes ? section('Operating details', `<div class="prose">${linkify(it.operating_notes)}</div>`) : ''}

    ${section('More details', `<dl>${it.extra_fields.map((e) => row(esc(e.label) || '—', e.value)).join('')}</dl>`)}

    <section class="card">
      <h3>Maintenance <button class="btn small" data-act="task-add">+ Add</button></h3>
      ${tasks || '<p class="hint" style="padding-bottom:12px">Add recurring tasks like “Clean filter” or “Replace water filter”. Due tasks show up in Home Assistant.</p>'}
      <form id="taskform" class="inline-form" hidden>
        <label>Task<input type="text" name="title" required placeholder="e.g. Replace water filter"></label>
        <div class="grid2">
          <label>Repeat
            <select name="interval">
              ${INTERVALS.map(([d, l]) => `<option value="${d}" ${d === 180 ? 'selected' : ''}>${l}</option>`).join('')}
              <option value="custom">Custom…</option>
            </select></label>
          <label>Last done<input type="date" name="last_done" value="${todayIso()}"></label>
        </div>
        <label name="customwrap" hidden>Every how many days?<input type="number" name="custom_days" min="1" inputmode="numeric"></label>
        <label>Notes<input type="text" name="notes" placeholder="Part number, size, etc. (optional)"></label>
        <div class="actions"><button class="btn primary" type="submit">Save task</button><button class="btn" type="button" data-act="task-cancel">Cancel</button></div>
      </form>
    </section>

    <section class="card">
      <h3>Photos & documents
        <label class="btn small" style="margin:0;color:var(--text)">+ Add<input id="upload" type="file" multiple accept="image/*,application/pdf" hidden></label></h3>
      ${files ? `<div class="gallery">${files}</div>` : '<p class="hint" style="padding-bottom:12px">Snap the data plate / serial sticker, receipts, and PDF manuals.</p>'}
    </section>

    ${it.notes ? section('Notes', `<div class="prose">${linkify(it.notes)}</div>`) : ''}

    <div class="actions">
      <a class="btn" href="#/edit/${id}">Edit details</a>
      <button class="btn danger" data-act="item-del">Delete item</button>
    </div>
    <p class="hint">Added ${fmtDate(it.created_at)} · updated ${fmtDate(it.updated_at)}</p>`;

  // --- wire up
  const $tf = document.getElementById('taskform');
  $tf.interval.addEventListener('change', () => {
    $tf.querySelector('[name=customwrap]').hidden = $tf.interval.value !== 'custom';
  });
  $tf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = $tf.interval.value === 'custom' ? +$tf.custom_days.value : +$tf.interval.value;
    try {
      await api(`items/${id}/tasks`, { method: 'POST', json: { title: $tf.elements.title.value, interval_days: days, last_done: $tf.last_done.value, notes: $tf.notes.value } });
      toast('Task added'); viewItem(id);
    } catch (err) { toast(err.message); }
  });

  document.getElementById('upload').addEventListener('change', async (e) => {
    const fd = new FormData();
    [...e.target.files].forEach((f) => fd.append('files', f));
    if (!e.target.files.length) return;
    toast('Uploading…');
    try { await api(`items/${id}/attachments`, { method: 'POST', body: fd }); toast('Uploaded'); viewItem(id); }
    catch (err) { toast('Upload failed: ' + err.message); }
  });

  $app.dataset.itemId = id;
}

// ------------------------------------------------------------------ edit / new
async function viewEdit(id) {
  const [it, meta] = await Promise.all([
    id ? api(`items/${id}`) : Promise.resolve({ extra_fields: [] }),
    api('meta'),
  ]);
  setHeader(id ? `Edit ${it.name}` : 'New item', id ? `#/item/${id}` : '#/');

  const v = (k) => esc(it[k] || '');
  const field = (name, label, type = 'text', attrs = '') =>
    `<label>${label}<input type="${type}" name="${name}" value="${v(name)}" ${attrs}></label>`;
  const options = (list) => list.map((x) => `<option value="${esc(x)}">`).join('');
  const allCats = [...new Set([...Object.keys(CATEGORIES), ...meta.categories])];

  $app.innerHTML = `
    <form id="itemform" autocomplete="off">
      <section class="card"><h3>Basics</h3>
        ${field('name', 'Name *', 'text', 'required placeholder="e.g. Kitchen refrigerator"')}
        <div class="grid2">
          ${field('category', 'Category', 'text', 'list="dl-cat" placeholder="Choose or type"')}
          ${field('location', 'Location / room', 'text', 'list="dl-loc" placeholder="e.g. Back patio"')}
        </div>
      </section>

      <section class="card"><h3>Identification</h3>
        ${field('manufacturer', 'Make / manufacturer', 'text', 'list="dl-mfr"')}
        <div class="grid2">
          ${field('model', 'Model number', 'text', 'autocapitalize="characters" spellcheck="false"')}
          ${field('serial_number', 'Serial number', 'text', 'autocapitalize="characters" spellcheck="false"')}
        </div>
      </section>

      <section class="card"><h3>Purchase & warranty</h3>
        <div class="grid2">
          ${field('purchased_from', 'Purchased from', 'text', 'list="dl-vendor"')}
          ${field('installer', 'Installed by', 'text', 'list="dl-vendor" placeholder="Builder, contractor…"')}
          ${field('purchase_date', 'Purchase / install date', 'date')}
          ${field('purchase_price', 'Price', 'text', 'inputmode="decimal" placeholder="$"')}
          ${field('warranty_expires', 'Warranty expires', 'date')}
        </div>
      </section>

      <section class="card"><h3>Links & support</h3>
        ${field('website_url', 'Product website', 'text', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. bromic.com/support"')}
        ${field('manual_url', 'Manual link', 'text', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. bromic.com/support"')}
        ${field('support_url', 'Support / warranty registration site', 'text', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. bromic.com/support"')}
        <div class="grid2">
          ${field('support_phone', 'Support phone', 'tel')}
          ${field('support_email', 'Support email', 'email')}
        </div>
      </section>

      <section class="card"><h3>Operating details</h3>
        <label>How to operate, settings, tips<textarea name="operating_notes" placeholder="e.g. Pilot light: hold knob 30s, then push ignite. Pool pump schedule: 8am–4pm at 2,400 RPM.">${v('operating_notes')}</textarea></label>
      </section>

      <section class="card"><h3>More details <button type="button" class="btn small" data-act="extra-add">+ Field</button></h3>
        <p class="hint">Anything else: filter size, gas type, BTU, voltage, paint color, breaker #…</p>
        <div id="extras"></div>
      </section>

      <section class="card"><h3>Notes</h3>
        <label>Notes<textarea name="notes">${v('notes')}</textarea></label>
      </section>

      <div class="savebar">
        <a class="btn" href="${id ? `#/item/${id}` : '#/'}">Cancel</a>
        <button class="btn primary" type="submit">${id ? 'Save changes' : 'Add item'}</button>
      </div>
    </form>
    <datalist id="dl-cat">${options(allCats)}</datalist>
    <datalist id="dl-loc">${options(meta.locations)}</datalist>
    <datalist id="dl-vendor">${options(meta.vendors)}</datalist>
    <datalist id="dl-mfr">${options(meta.manufacturers)}</datalist>`;

  const $extras = document.getElementById('extras');
  const addExtra = (e = { label: '', value: '' }) => {
    const div = document.createElement('div');
    div.className = 'extra';
    div.innerHTML = `<input type="text" placeholder="Label" value="${esc(e.label)}" aria-label="Field label">
      <input type="text" placeholder="Value" value="${esc(e.value)}" aria-label="Field value">
      <button type="button" class="iconbtn" aria-label="Remove field">✕</button>`;
    div.querySelector('button').onclick = () => div.remove();
    $extras.appendChild(div);
  };
  it.extra_fields.forEach(addExtra);
  $app.querySelector('[data-act=extra-add]').onclick = () => { addExtra(); $extras.lastChild.querySelector('input').focus(); };

  const $form = document.getElementById('itemform');
  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData($form));
    data.extra_fields = [...$extras.children].map((d) => {
      const [l, val] = d.querySelectorAll('input');
      return { label: l.value, value: val.value };
    });
    const btn = $form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const saved = await api(id ? `items/${id}` : 'items', { method: id ? 'PUT' : 'POST', json: data });
      toast(id ? 'Saved' : 'Item added — now add photos & maintenance');
      location.hash = `#/item/${saved.id}`;
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  if (!id) $form.elements.name.focus();
}

// ------------------------------------------------------------------ shared click actions
$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act], .chip');
  if (!el) return;
  if (el.classList.contains('chip')) { state.cat = el.dataset.cat; renderList(); return; }
  const id = el.dataset.id;
  const itemId = $app.dataset.itemId;
  const refresh = () => (location.hash.startsWith('#/item/') ? viewItem(+itemId) : viewHome());
  try {
    switch (el.dataset.act) {
      case 'copy': copyText(el.dataset.text); break;
      case 'zoom': openLightbox(el.src); break;
      case 'zoom-first': openLightbox(el.querySelector('img').src); break;
      case 'task-add': { const f = document.getElementById('taskform'); f.hidden = false; f.elements.title.focus(); break; }
      case 'task-cancel': document.getElementById('taskform').hidden = true; break;
      case 'task-done': await api(`tasks/${id}/done`, { method: 'POST' }); toast('Marked done'); refresh(); break;
      case 'task-del': if (confirm('Delete this maintenance task?')) { await api(`tasks/${id}`, { method: 'DELETE' }); refresh(); } break;
      case 'att-del': if (confirm('Delete this file?')) { await api(`attachments/${id}`, { method: 'DELETE' }); refresh(); } break;
      case 'item-del':
        if (confirm('Delete this item, its photos and maintenance tasks? This cannot be undone.')) {
          await api(`items/${itemId}`, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/';
        }
        break;
    }
  } catch (err) { toast(err.message); }
});

function openLightbox(src) {
  $lightbox.querySelector('img').src = src;
  $lightbox.showModal();
}
$lightbox.addEventListener('click', () => $lightbox.close());

route();
