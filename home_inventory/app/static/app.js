'use strict';
// Home Inventory front end. Plain JS, no build step. All URLs are relative so
// it works both standalone and behind Home Assistant Ingress.

const $app = document.getElementById('app');
const $title = document.getElementById('title');
const $back = document.getElementById('back');
const $topaction = document.getElementById('topaction');
const $lightbox = document.getElementById('lightbox');
const $sheet = document.getElementById('sheet');

const INTERVALS = [[7, 'Weekly'], [30, 'Monthly'], [90, 'Every 3 months'], [180, 'Every 6 months'], [365, 'Yearly'], [730, 'Every 2 years']];
const KIND_ICONS = {
  'Photo': '🖼️', 'Manual': '📘', 'Receipt': '🧾', 'Invoice': '💵', 'Contract': '📝',
  'Warranty': '🛡️', 'Permit': '🏛️', 'Plans & drawings': '📐', 'Other': '📎',
};
const EMOJI = [
  '🏠', '🏡', '🔌', '🍳', '🧊', '❄️', '🔥', '♨️', '🌡️', '💨', '🚰', '🚿', '🛁', '🚽', '💧', '⚡',
  '💡', '🔋', '🏊', '🌊', '🌳', '🌿', '🌱', '🪴', '⛱️', '☀️', '🚗', '🔧', '🪛', '🔨', '🧰', '🚪',
  '🪟', '🔒', '🔑', '🛡️', '🚨', '🧯', '📡', '📶', '📺', '🔊', '🖥️', '💻', '🖨️', '📷', '🎮', '🛋️',
  '🛏️', '🪑', '🧺', '🧹', '🗑️', '♻️', '🚲', '⛽', '🪵', '🧱', '📦', '📍', '🍽️', '☕', '🐶', '🐱',
];
const NEW_OPTION = '__new__';

const state = {
  q: '', filter: '', items: [], item: null,
  meta: { categories: [], locations: [], attachment_kinds: Object.keys(KIND_ICONS), vendors: [], manufacturers: [] },
  groupBy: lsGet('groupBy') || 'category',
};

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { u = String(u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u; };
const hostOf = (u) => { try { return new URL(safeUrl(u)).hostname.replace(/^www\./, ''); } catch { return u; } };
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<]+/g, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
const isImage = (a) => /^image\/(jpeg|png|gif|webp)/.test(a.content_type);
const attUrl = (id) => `api/attachments/${id}`;
const kindOf = (a) => a.kind || (isImage(a) ? 'Photo' : 'Other');

function lsGet(k) { try { return localStorage.getItem('hi.' + k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem('hi.' + k, v); } catch { /* private mode */ } }

function termIcon(kind, name) {
  const t = state.meta[kind].find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
  return (t && t.icon) || (kind === 'locations' ? '📍' : '📦');
}
const catIcon = (name) => termIcon('categories', name);
const itemIcon = (it) => it.icon || catIcon(it.category);
function thumbHtml(it) {
  return it.thumb_id ? `<img src="${attUrl(it.thumb_id)}" alt="" loading="lazy">` : esc(itemIcon(it));
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
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
function guessKind(files) {
  const all = [...files];
  if (all.every((f) => f.type.startsWith('image/'))) return 'Photo';
  const name = all.map((f) => f.name).join(' ');
  const rules = [[/contract|agreement/i, 'Contract'], [/receipt/i, 'Receipt'], [/invoice|bill/i, 'Invoice'],
    [/warrant/i, 'Warranty'], [/manual|guide|instruction/i, 'Manual'], [/permit/i, 'Permit'],
    [/plan|drawing|blueprint|\.dwg/i, 'Plans & drawings']];
  const hit = rules.find(([re]) => re.test(name));
  return hit ? hit[1] : 'Other';
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
    let msg;
    try { msg = JSON.parse(text).error; } catch { msg = (text.match(/<p>(.*?)<\/p>/) || [])[1]; }
    throw new Error(msg || r.statusText);
  }
  return r.status === 204 ? null : r.json();
}
async function loadMeta() { state.meta = await api('meta'); return state.meta; }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs HTTPS; fall back for plain-http installs.
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

// ------------------------------------------------------------------ bottom sheet (dialogs)
function openSheet(html) {
  $sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  if (!$sheet.open) $sheet.showModal();
  return $sheet;
}
function closeSheet() { if ($sheet.open) $sheet.close(); }
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) closeSheet(); });

/** Emoji / photo picker. Resolves to {emoji}, {photo}, {reset:true} or null (cancelled). */
function pickIcon({ title, current, photos = [], coverId = null, resetLabel }) {
  return new Promise((resolve) => {
    const s = openSheet(`
      <h2>${esc(title)}</h2>
      ${photos.length ? `<h3>Use one of its photos</h3>
        <div class="pick-photos">${photos.map((p) => `
          <button type="button" data-pick="photo:${p.id}" class="${p.id === coverId ? 'sel' : ''}" aria-label="Use photo ${esc(p.title || p.filename)}">
            <img src="${attUrl(p.id)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
      <h3>${photos.length ? 'Or pick an icon' : 'Pick an icon'}</h3>
      <div class="emoji-grid">${EMOJI.map((e) => `<button type="button" data-pick="emoji:${e}" class="${e === current && !coverId ? 'sel' : ''}">${e}</button>`).join('')}</div>
      <label>Any other emoji
        <div class="inline-input"><input type="text" id="custom-emoji" maxlength="16" placeholder="Type or paste one" autocomplete="off">
        <button type="button" class="btn small" data-pick="custom">Use</button></div></label>
      <div class="actions">
        <button type="button" class="btn" data-pick="reset">${esc(resetLabel)}</button>
        <button type="button" class="btn" data-pick="cancel">Cancel</button>
      </div>`);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } closeSheet(); };
    s.onclose = () => done(null);
    s.onclick = (e) => {
      if (e.target === s) return done(null);
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const [kind, val] = b.dataset.pick.split(/:(.*)/s);
      if (kind === 'emoji') done({ emoji: val });
      else if (kind === 'photo') done({ photo: +val });
      else if (kind === 'reset') done({ reset: true });
      else if (kind === 'cancel') done(null);
      else if (kind === 'custom') {
        const v = s.querySelector('#custom-emoji').value.trim();
        if (v) done({ emoji: v }); else toast('Type or paste an emoji first');
      }
    };
  });
}

/** Small form in a sheet. fieldsHtml uses named inputs; resolves to their values or null. */
function formSheet(title, fieldsHtml, submitLabel = 'Save') {
  return new Promise((resolve) => {
    const s = openSheet(`<h2>${esc(title)}</h2><form id="sheetform">${fieldsHtml}
      <div class="actions"><button class="btn primary" type="submit">${esc(submitLabel)}</button>
      <button class="btn" type="button" data-close>Cancel</button></div></form>`);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } closeSheet(); };
    const f = s.querySelector('form');
    s.onclose = () => done(null);
    s.onclick = (e) => { if (e.target === s || e.target.closest('[data-close]')) done(null); };
    f.onsubmit = (e) => { e.preventDefault(); done(Object.fromEntries(new FormData(f))); };
    const first = f.querySelector('input[type=text]');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

// ------------------------------------------------------------------ router
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  closeSheet();
  if ($lightbox.open) $lightbox.close();
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'item' && parts[1]) await viewItem(+parts[1]);
    else if (parts[0] === 'edit' && parts[1]) await viewEdit(+parts[1]);
    else if (parts[0] === 'new') await viewEdit(null);
    else if (parts[0] === 'manage') await viewManage();
    else if (parts[0] === 'import') await viewImport();
    else await viewHome();
  } catch (e) {
    $app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to list</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ home
async function viewHome() {
  setHeader('Home Inventory', false, '<a class="iconbtn" href="#/manage" aria-label="Manage categories and locations">⚙️</a>');
  const [items, summary] = await Promise.all([api('items'), api('summary'), loadMeta()]);
  state.items = items;

  const alerts = [
    ...summary.tasks.filter((t) => t.days_left <= 0).map((t) => `
      <div class="alert">
        <div class="thumb sm">🔧</div>
        <div class="meta"><a href="#/item/${t.item_id}">${esc(t.title)}</a>
          <div class="sub">${esc(t.item_name)} · ${dueBadge(t.days_left)}</div></div>
        <button class="btn small" data-act="task-done" data-id="${t.id}">Done</button>
      </div>`),
    ...summary.warranties.map((w) => `
      <div class="alert">
        <div class="thumb sm">🛡️</div>
        <div class="meta"><a href="#/item/${w.item_id}">${esc(w.item_name)}</a>
          <div class="sub">Warranty ends ${fmtDate(w.warranty_expires)} · <span class="badge warn">${w.days_left} days</span></div></div>
      </div>`),
  ].join('');

  if (!items.length) {
    $app.innerHTML = `
      <div class="empty">
        <div style="font-size:56px">🏡</div>
        <h2>Start your home inventory</h2>
        <p>Add your appliances, pool equipment, HVAC, heaters and anything else: make, model, serial number, where you bought it, support contacts, manuals, contracts and how to operate it.</p>
        <div class="actions" style="justify-content:center">
          <a class="btn primary" href="#/new">Add your first item</a>
          <a class="btn" href="#/import">Import a spreadsheet</a>
        </div>
        <p><a href="#/manage">Set up categories & locations</a></p>
      </div>`;
    return;
  }

  $app.innerHTML = `
    ${alerts ? `<section class="alerts">${alerts}</section>` : ''}
    <div class="searchbar">
      <input type="search" id="q" placeholder="Search name, make, model, serial, room…" value="${esc(state.q)}" autocomplete="off">
      <div class="groupby">
        <span>Group by</span>
        <div class="seg" role="group" aria-label="Group by">
          <button type="button" data-group="category" aria-pressed="${state.groupBy === 'category'}">Category</button>
          <button type="button" data-group="location" aria-pressed="${state.groupBy === 'location'}">Location</button>
        </div>
      </div>
      <div class="chips" id="chips" role="toolbar" aria-label="Filter"></div>
    </div>
    <div id="list"></div>
    <nav class="footer-links">
      <a href="#/manage">⚙️ Categories & locations</a>
      <a href="#/import">⬆ Import from Excel / CSV</a>
      <a href="api/export.csv" download>⬇ Export spreadsheet (CSV)</a>
      <a href="api/export.json" download>⬇ Export backup (JSON)</a>
    </nav>
    <a class="fab" href="#/new" aria-label="Add item">+</a>`;

  const $q = document.getElementById('q');
  $q.addEventListener('input', () => { state.q = $q.value; renderList(); });
  renderList();
}

function groupKey(it) {
  return state.groupBy === 'location' ? (it.location || 'No location') : (it.category || 'Uncategorized');
}
function groupIcon(key) {
  if (state.groupBy === 'location') return key === 'No location' ? '❔' : termIcon('locations', key);
  return key === 'Uncategorized' ? '❔' : catIcon(key);
}

function renderList() {
  const keys = [...new Set(state.items.map(groupKey))].sort((a, b) => a.localeCompare(b));
  if (state.filter && !keys.includes(state.filter)) state.filter = '';
  document.getElementById('chips').innerHTML = `
    <button class="chip" data-filter="" aria-pressed="${!state.filter}">All (${state.items.length})</button>
    ${keys.map((k) => `<button class="chip" data-filter="${esc(k)}" aria-pressed="${state.filter === k}">${esc(groupIcon(k))} ${esc(k)}</button>`).join('')}`;

  const q = state.q.trim().toLowerCase();
  const fields = ['name', 'category', 'location', 'manufacturer', 'model', 'serial_number', 'purchased_from', 'installer', 'notes'];
  const hits = state.items.filter((it) =>
    (!state.filter || groupKey(it) === state.filter) &&
    (!q || fields.some((f) => (it[f] || '').toLowerCase().includes(q)) ||
      it.extra_fields.some((e) => `${e.label} ${e.value}`.toLowerCase().includes(q))));

  const groups = {};
  hits.forEach((it) => (groups[groupKey(it)] ||= []).push(it));
  const $list = document.getElementById('list');
  if (!hits.length) { $list.innerHTML = '<p class="empty">No matching items.</p>'; return; }
  const second = state.groupBy === 'location' ? 'category' : 'location';
  $list.innerHTML = Object.keys(groups).sort((a, b) => a.localeCompare(b)).map((key) => `
    <h2 class="group-title">${esc(groupIcon(key))} ${esc(key)}</h2>
    <div class="list">${groups[key].map((it) => `
      <a class="item" href="#/item/${it.id}">
        <div class="thumb">${thumbHtml(it)}</div>
        <div class="meta">
          <div class="name">${esc(it.name)}</div>
          <div class="sub">${esc([it.manufacturer, it.model].filter(Boolean).join(' · ') || '—')}</div>
          ${it[second] ? `<div class="sub">${second === 'location' ? '📍' : esc(catIcon(it.category))} ${esc(it[second])}</div>` : ''}
        </div>
        ${it.tasks_due ? `<span class="badge bad">${it.tasks_due} due</span>` : ''}
      </a>`).join('')}
    </div>`).join('');
}

// ------------------------------------------------------------------ detail
async function viewItem(id) {
  const [it] = await Promise.all([api(`items/${id}`), loadMeta()]);
  state.item = it;
  setHeader(it.name, '#/', `<a class="iconbtn" href="#/edit/${id}" aria-label="Edit">✏️</a>`);

  const photos = it.attachments.filter((a) => isImage(a) && kindOf(a) === 'Photo');
  const docs = it.attachments.filter((a) => !photos.includes(a));
  const allImages = it.attachments.filter(isImage);
  const cover = it.cover_id && allImages.find((a) => a.id === it.cover_id);
  const heroImg = cover || (!it.icon && allImages[0]);

  const row = (label, value, copy) => value ? `
    <div class="row"><dt>${label}</dt><dd><span class="${copy ? 'mono' : ''}">${esc(value)}</span>
      ${copy ? `<button class="copy" data-act="copy" data-text="${esc(value)}">Copy</button>` : ''}</dd></div>` : '';
  const section = (title, body) => body.replace(/<(?!img)[^>]*>/g, '').trim()
    ? `<section class="card"><h3>${title}</h3>${body}</section>` : '';
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

  const photoTiles = photos.map((a) => `
    <button type="button" class="tile" data-act="att-open" data-id="${a.id}" aria-label="Open ${esc(a.title || a.filename)}">
      <img src="${attUrl(a.id)}" alt="" loading="lazy">
      ${a.id === it.cover_id ? '<span class="cover-tag">Item picture</span>' : ''}
      ${a.title ? `<span class="caption">${esc(a.title)}</span>` : ''}
    </button>`).join('');

  const docRows = docs.sort((a, b) => kindOf(a).localeCompare(kindOf(b)) || a.id - b.id).map((a) => `
    <div class="docrow">
      <button type="button" class="docmain" data-act="att-open" data-id="${a.id}">
        <span class="docicon">${isImage(a) ? `<img src="${attUrl(a.id)}" alt="" loading="lazy">` : KIND_ICONS[kindOf(a)] || '📎'}</span>
        <span class="meta"><span class="name">${esc(a.title || a.filename)}</span>
          <span class="sub"><span class="badge kind">${esc(kindOf(a))}</span> ${fmtDate(a.created_at)} · ${fmtSize(a.size)}</span></span>
      </button>
      <button type="button" class="copy" data-act="att-edit" data-id="${a.id}" aria-label="Edit ${esc(a.title || a.filename)}">Edit</button>
    </div>`).join('');

  $app.innerHTML = `
    <div class="hero">
      <button type="button" class="thumb editable" data-act="icon-pick" aria-label="Change item picture">
        ${heroImg ? `<img src="${attUrl(heroImg.id)}" alt="">` : esc(itemIcon(it))}
        <span class="edit-badge" aria-hidden="true">✎</span>
      </button>
      <div><h2>${esc(it.name)}</h2>
        <div class="sub">${it.category ? `${esc(catIcon(it.category))} ${esc(it.category)}` : ''}${it.category && it.location ? ' · ' : ''}${it.location ? `📍 ${esc(it.location)}` : ''}</div></div>
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

    <section class="card" id="files">
      <h3>Photos & documents <button type="button" class="btn small" data-act="att-add">+ Add</button></h3>
      <input id="upload" type="file" multiple hidden>
      <form id="uploadform" class="inline-form" hidden></form>
      ${photoTiles ? `<div class="gallery">${photoTiles}</div>` : ''}
      ${docRows ? `<div class="doclist">${docRows}</div>` : ''}
      ${!photoTiles && !docRows ? '<p class="hint" style="padding-bottom:12px">Add photos (data plate, serial sticker, installation), contracts, receipts, invoices, warranties, manuals, permits, plans: any file.</p>' : ''}
    </section>

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
        <label data-customwrap hidden>Every how many days?<input type="number" name="custom_days" min="1" inputmode="numeric"></label>
        <label>Notes<input type="text" name="notes" placeholder="Part number, size, etc. (optional)"></label>
        <div class="actions"><button class="btn primary" type="submit">Save task</button><button class="btn" type="button" data-act="task-cancel">Cancel</button></div>
      </form>
    </section>

    ${it.notes ? section('Notes', `<div class="prose">${linkify(it.notes)}</div>`) : ''}

    <div class="actions">
      <a class="btn" href="#/edit/${id}">Edit details</a>
      <button class="btn danger" data-act="item-del">Delete item</button>
    </div>
    <p class="hint">Added ${fmtDate(it.created_at)} · updated ${fmtDate(it.updated_at)}</p>`;

  // --- maintenance form
  const $tf = document.getElementById('taskform');
  $tf.elements.interval.addEventListener('change', () => {
    $tf.querySelector('[data-customwrap]').hidden = $tf.elements.interval.value !== 'custom';
  });
  $tf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const el = $tf.elements;
    const days = el.interval.value === 'custom' ? +el.custom_days.value : +el.interval.value;
    try {
      await api(`items/${id}/tasks`, { method: 'POST', json: { title: el.title.value, interval_days: days, last_done: el.last_done.value, notes: el.notes.value } });
      toast('Task added'); viewItem(id);
    } catch (err) { toast(err.message); }
  });

  // --- upload: pick files, then choose type + title, then upload
  const $up = document.getElementById('upload');
  const $uf = document.getElementById('uploadform');
  $up.addEventListener('change', () => {
    const files = [...$up.files];
    if (!files.length) return;
    $uf.hidden = false;
    $uf.innerHTML = `
      <p class="hint"><strong>${files.length} file${files.length > 1 ? 's' : ''}:</strong> ${esc(files.map((f) => f.name).join(', '))}</p>
      <div class="grid2">
        <label>Type<select name="kind">${state.meta.attachment_kinds.map((k) =>
          `<option ${k === guessKind(files) ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
        <label>Title (optional)<input type="text" name="title" placeholder="e.g. Installation contract"></label>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Upload</button>
        <button class="btn" type="button" data-act="upload-cancel">Cancel</button></div>`;
    $uf.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $uf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData();
    [...$up.files].forEach((f) => fd.append('files', f));
    fd.append('kind', $uf.elements.kind.value);
    fd.append('title', $uf.elements.title.value);
    $uf.querySelector('[type=submit]').disabled = true;
    toast('Uploading…');
    try { await api(`items/${id}/attachments`, { method: 'POST', body: fd }); toast('Uploaded'); viewItem(id); }
    catch (err) { toast('Upload failed: ' + err.message); $uf.querySelector('[type=submit]').disabled = false; }
  });
}

async function changeItemPicture() {
  const it = state.item;
  const choice = await pickIcon({
    title: 'Item picture', current: it.icon, coverId: it.cover_id,
    photos: it.attachments.filter(isImage), resetLabel: 'Automatic',
  });
  if (!choice) return;
  const body = choice.photo ? { cover_id: choice.photo } : choice.emoji ? { icon: choice.emoji } : {};
  await api(`items/${it.id}/appearance`, { method: 'PUT', json: body });
  toast('Picture updated');
  viewItem(it.id);
}

function openAttachment(att) {
  if (!isImage(att)) { window.open(attUrl(att.id), '_blank', 'noopener'); return; }
  $lightbox.querySelector('img').src = attUrl(att.id);
  $lightbox.querySelector('.lb-title').textContent = att.title || att.filename;
  $lightbox.querySelector('.lb-bar').innerHTML = `
    <button type="button" class="btn small" data-act="att-cover" data-id="${att.id}">${att.id === state.item.cover_id ? '✓ Item picture' : 'Use as item picture'}</button>
    <button type="button" class="btn small" data-act="att-edit" data-id="${att.id}">Edit</button>
    <a class="btn small" href="${attUrl(att.id)}?download" download>Download</a>`;
  $lightbox.showModal();
}

async function editAttachment(att) {
  if ($lightbox.open) $lightbox.close();
  const res = await formSheet('Edit file', `
    <p class="hint">${esc(att.filename)} · ${fmtSize(att.size)}</p>
    <label>Type<select name="kind">${state.meta.attachment_kinds.map((k) =>
      `<option ${k === kindOf(att) ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
    <label>Title<input type="text" name="title" value="${esc(att.title || '')}" placeholder="${esc(att.filename)}"></label>
    <div class="actions"><button type="button" class="btn danger" data-act="att-del" data-id="${att.id}">Delete file</button></div>`);
  if (!res) return;
  await api(`attachments/${att.id}`, { method: 'PUT', json: res });
  toast('Saved');
  viewItem(state.item.id);
}

// ------------------------------------------------------------------ edit / new
async function viewEdit(id) {
  const [it] = await Promise.all([
    id ? api(`items/${id}`) : Promise.resolve({ extra_fields: [] }),
    loadMeta(),
  ]);
  const meta = state.meta;
  setHeader(id ? `Edit ${it.name}` : 'New item', id ? `#/item/${id}` : '#/');

  const v = (k) => esc(it[k] || '');
  const field = (name, label, type = 'text', attrs = '') =>
    `<label>${label}<input type="${type}" name="${name}" value="${v(name)}" ${attrs}></label>`;
  const options = (list) => list.map((x) => `<option value="${esc(x)}">`).join('');
  const termSelect = (name, kind, label, noneLabel) => {
    const names = meta[kind].map((t) => t.name);
    if (it[name] && !names.some((n) => n.toLowerCase() === it[name].toLowerCase())) names.push(it[name]);
    return `<label>${label}<select name="${name}" data-kind="${kind}">
      <option value="">${noneLabel}</option>
      ${names.map((n) => `<option value="${esc(n)}" ${(it[name] || '').toLowerCase() === n.toLowerCase() ? 'selected' : ''}>${esc(termIcon(kind, n))} ${esc(n)}</option>`).join('')}
      <option value="${NEW_OPTION}">＋ Add new…</option></select></label>`;
  };

  $app.innerHTML = `
    <form id="itemform" autocomplete="off">
      <section class="card"><h3>Basics</h3>
        ${field('name', 'Name *', 'text', 'required placeholder="e.g. Kitchen refrigerator"')}
        <div class="grid2">
          ${termSelect('category', 'categories', 'Category', '— None —')}
          ${termSelect('location', 'locations', 'Location / room', '— None —')}
        </div>
        <p class="hint"><a href="#/manage">Manage categories & locations</a></p>
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
        ${field('website_url', 'Product website', 'text', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. bromic.com"')}
        ${field('manual_url', 'Manual link', 'text', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. bromic.com/manuals/heater.pdf"')}
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

      ${id ? '' : '<p class="hint">After saving you can add photos, contracts and other files, and choose the item\'s picture.</p>'}
      <div class="savebar">
        <a class="btn" href="${id ? `#/item/${id}` : '#/'}">Cancel</a>
        <button class="btn primary" type="submit">${id ? 'Save changes' : 'Add item'}</button>
      </div>
    </form>
    <datalist id="dl-vendor">${options(meta.vendors)}</datalist>
    <datalist id="dl-mfr">${options(meta.manufacturers)}</datalist>`;

  // "+ Add new…" in the category / location dropdowns
  $app.querySelectorAll('select[data-kind]').forEach((sel) => {
    let previous = sel.value;
    sel.addEventListener('change', () => {
      if (sel.value !== NEW_OPTION) { previous = sel.value; return; }
      const label = sel.dataset.kind === 'categories' ? 'category' : 'location';
      const name = (prompt(`New ${label} name`) || '').trim();
      if (!name) { sel.value = previous; return; }
      let opt = [...sel.options].find((o) => o.value.toLowerCase() === name.toLowerCase());
      if (!opt) {
        opt = new Option(`${sel.dataset.kind === 'locations' ? '📍' : '📦'} ${name}`, name);
        sel.insertBefore(opt, sel.lastElementChild);
      }
      sel.value = opt.value;
      previous = sel.value;
    });
  });

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
      toast(id ? 'Saved' : 'Item added. Now add photos & files');
      location.hash = `#/item/${saved.id}`;
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  if (!id) $form.elements.name.focus();
}

// ------------------------------------------------------------------ manage categories & locations
const TERM_LABEL = { categories: ['Categories', 'category'], locations: ['Locations / rooms', 'location'] };

async function viewManage() {
  setHeader('Categories & locations', '#/');
  await loadMeta();
  const block = (kind) => {
    const [title, one] = TERM_LABEL[kind];
    const rows = state.meta[kind].map((t) => `
      <div class="term">
        <button type="button" class="term-icon" data-act="term-icon" data-kind="${kind}" data-id="${t.id}" aria-label="Change icon for ${esc(t.name)}">${esc(termIcon(kind, t.name))}</button>
        <div class="meta"><div class="name">${esc(t.name)}</div><div class="sub">${t.count} item${t.count === 1 ? '' : 's'}</div></div>
        <button type="button" class="copy" data-act="term-rename" data-kind="${kind}" data-id="${t.id}">Rename</button>
        <button type="button" class="copy" data-act="term-del" data-kind="${kind}" data-id="${t.id}" aria-label="Delete ${esc(t.name)}">✕</button>
      </div>`).join('');
    return `
      <section class="card">
        <h3>${title} <span class="count">${state.meta[kind].length}</span></h3>
        <form class="addterm" data-kind="${kind}">
          <input type="text" name="name" placeholder="Add a ${one}…" aria-label="New ${one} name" maxlength="80" required>
          <button class="btn small primary" type="submit">Add</button>
        </form>
        ${rows || `<p class="hint" style="padding-bottom:12px">No ${title.toLowerCase()} yet.</p>`}
      </section>`;
  };
  $app.innerHTML = `
    <p class="hint">Tap an icon to change it. Renaming updates every item that uses it.</p>
    ${block('categories')}
    ${block('locations')}`;

  $app.querySelectorAll('form.addterm').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(f.dataset.kind, { method: 'POST', json: { name: f.elements.name.value } });
      toast('Added'); viewManage();
    } catch (err) { toast(err.message); }
  }));
}

async function termAction(act, kind, id) {
  const t = state.meta[kind].find((x) => x.id === id);
  if (!t) return;
  const one = TERM_LABEL[kind][1];
  if (act === 'term-icon') {
    const choice = await pickIcon({ title: `Icon for ${t.name}`, current: t.icon, resetLabel: 'Default icon' });
    if (!choice) return;
    await api(`${kind}/${id}`, { method: 'PUT', json: { name: t.name, icon: choice.emoji || null } });
  } else if (act === 'term-rename') {
    const res = await formSheet(`Rename ${one}`, `<label>Name<input type="text" name="name" value="${esc(t.name)}" required maxlength="80"></label>
      ${t.count ? `<p class="hint">${t.count} item${t.count === 1 ? '' : 's'} will move to the new name.</p>` : ''}`);
    if (!res || !res.name.trim() || res.name.trim() === t.name) return;
    await api(`${kind}/${id}`, { method: 'PUT', json: { name: res.name, icon: t.icon } });
  } else if (act === 'term-del') {
    if (t.count) {
      const others = state.meta[kind].filter((x) => x.id !== id);
      const res = await formSheet(`Delete “${t.name}”`, `
        <p>${t.count} item${t.count === 1 ? ' uses' : 's use'} this ${one}. Move ${t.count === 1 ? 'it' : 'them'} to:</p>
        <label>Move to<select name="move_to"><option value="">— No ${one} —</option>
          ${others.map((o) => `<option value="${esc(o.name)}">${esc(termIcon(kind, o.name))} ${esc(o.name)}</option>`).join('')}</select></label>`, 'Delete');
      if (!res) return;
      await api(`${kind}/${id}?move_to=${encodeURIComponent(res.move_to)}`, { method: 'DELETE' });
    } else {
      if (!confirm(`Delete the ${one} “${t.name}”?`)) return;
      await api(`${kind}/${id}`, { method: 'DELETE' });
    }
  }
  toast('Saved');
  viewManage();
}

// ------------------------------------------------------------------ import from Excel / CSV
const IMPORT_TARGETS = [
  ['name', 'Name'], ['category', 'Category'], ['location', 'Location / room'],
  ['manufacturer', 'Make / manufacturer'], ['model', 'Model number'], ['serial_number', 'Serial number'],
  ['purchased_from', 'Purchased from'], ['installer', 'Installed by'], ['purchase_date', 'Purchase / install date'],
  ['purchase_price', 'Price'], ['warranty_expires', 'Warranty expires'], ['website_url', 'Product website'],
  ['manual_url', 'Manual link'], ['support_url', 'Support site'], ['support_phone', 'Support phone'],
  ['support_email', 'Support email'], ['operating_notes', 'Operating details'], ['notes', 'Notes'],
  ['extra', 'Custom field (named after the column)'], ['custom_fields', 'Custom fields list (Label: value; …)'],
  ['id', 'Item ID (to update existing items)'], ['ignore', 'Don’t import'],
];
const imp = { parsed: null };

async function viewImport() {
  setHeader('Import items', '#/');
  imp.parsed = null;
  $app.innerHTML = `
    <section class="card"><h3>1. Choose a spreadsheet</h3>
      <p class="hint">Excel (.xlsx) or CSV. The first row must be column headings; every other row becomes one item.</p>
      <div class="actions" style="margin:10px 0">
        <label class="btn primary">Choose file…<input type="file" id="impfile" hidden
          accept=".csv,.xlsx,.xlsm,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      </div>
      <p class="hint" style="padding-bottom:12px"><a href="api/import/template.csv" download>⬇ Download a template</a> to fill in, or
        <a href="api/export.csv" download>export your current items</a>, edit them in Excel and import them back.</p>
    </section>
    <div id="impstep"></div>
    <p class="hint">Loading data from a script? The same import is available as an API: see API.md in the project.</p>`;

  document.getElementById('impfile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    toast('Reading file…');
    try {
      imp.parsed = await api('import/parse', { method: 'POST', body: fd });
      renderMapping();
    } catch (err) { toast(err.message); }
    e.target.value = '';
  });
}

function renderMapping() {
  const p = imp.parsed;
  const sample = (i) => (p.rows.find((r) => r[i]) || [])[i] || '';
  const opts = (sel) => IMPORT_TARGETS.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  document.getElementById('impstep').innerHTML = `
    <section class="card"><h3>2. Match the columns</h3>
      <p class="hint"><strong>${esc(p.filename)}</strong>: ${p.rows.length} row${p.rows.length === 1 ? '' : 's'}, ${p.headers.length} columns. Check what each column should go into.</p>
      ${p.headers.map((h, i) => `
        <div class="maprow">
          <div class="meta"><div class="name">${esc(h)}</div><div class="sub">${sample(i) ? `e.g. ${esc(sample(i).slice(0, 60))}` : '(empty)'}</div></div>
          <select data-col="${i}" aria-label="Import column ${esc(h)} as">${opts(sample(i) ? p.suggested[i] : 'ignore')}</select>
        </div>`).join('')}
      <p class="hint" id="noname" hidden>⚠️ No column is set to <strong>Name</strong>. Rows can only update existing items (by ID or serial number).</p>
    </section>
    <section class="card"><h3>3. Options</h3>
      <label class="check"><input type="checkbox" id="impupdate" checked>
        <span>Update items that already exist, matched by ID, serial number, or a unique name. Blank cells never erase anything.
        Untick to always add new items.</span></label>
      <p class="hint" style="padding-bottom:12px">Dates like 3/15/2026 are read as month/day/year.</p>
    </section>
    <div class="actions"><button class="btn primary" id="impcheck">Check file</button></div>
    <div id="impresult"></div>`;

  const refreshNameHint = () => {
    document.getElementById('noname').hidden = [...document.querySelectorAll('select[data-col]')].some((s) => s.value === 'name');
  };
  refreshNameHint();
  document.querySelectorAll('select[data-col], #impupdate').forEach((el) => el.addEventListener('change', () => {
    document.getElementById('impresult').innerHTML = ''; // settings changed: check again
    refreshNameHint();
  }));
  document.getElementById('impcheck').addEventListener('click', () => runImport(true));
}

function buildImportItems() {
  const p = imp.parsed;
  const targets = [...document.querySelectorAll('select[data-col]')].map((s) => s.value);
  return p.rows.map((r, idx) => {
    const o = { _row: p.lines[idx], extra_fields: [] };
    let any = false;
    targets.forEach((t, i) => {
      const v = String(r[i] ?? '').trim();
      if (!v || t === 'ignore') return;
      any = true;
      if (t === 'extra') o.extra_fields.push({ label: p.headers[i], value: v });
      else if (t === 'custom_fields') o.custom_fields = o.custom_fields ? `${o.custom_fields}; ${v}` : v;
      else o[t] = o[t] ? `${o[t]}\n${v}` : v; // two columns into one field are joined
    });
    return any ? o : null;
  }).filter(Boolean);
}

async function runImport(dryRun) {
  const items = buildImportItems();
  const $res = document.getElementById('impresult');
  if (!items.length) { toast('Nothing to import: every row is empty or ignored'); return; }
  const btns = document.querySelectorAll('#impcheck, #impgo');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await api('import', { method: 'POST', json: { items, update_existing: document.getElementById('impupdate').checked, dry_run: dryRun } });
    const total = r.created + r.updated;
    if (!dryRun) {
      $res.innerHTML = `<section class="card done"><h3>Imported</h3>
        <p>✅ Added <strong>${r.created}</strong> and updated <strong>${r.updated}</strong> item${total === 1 ? '' : 's'}.
        ${r.errors.length ? `${r.errors.length} row${r.errors.length === 1 ? ' was' : 's were'} skipped.` : ''}</p>
        <div class="actions"><a class="btn primary" href="#/">View items</a></div></section>`;
      document.getElementById('impcheck').hidden = true;
      $res.scrollIntoView({ behavior: 'smooth' });
      toast('Import complete');
      return;
    }
    const shown = r.results.slice(0, 15);
    $res.innerHTML = `
      <section class="card"><h3>4. Review</h3>
        <p><span class="badge ok">${r.created} new</span> <span class="badge warn">${r.updated} update${r.updated === 1 ? '' : 's'}</span>
          ${r.errors.length ? `<span class="badge bad">${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}</span>` : ''}</p>
        ${r.errors.length ? `<div class="problems">${r.errors.slice(0, 50).map((e) => `
          <div>Row ${e.row}${e.name ? ` (${esc(e.name)})` : ''}: ${esc(e.error)}</div>`).join('')}
          ${r.errors.length > 50 ? `<div>…and ${r.errors.length - 50} more</div>` : ''}</div>
          <p class="hint">Rows with problems are skipped. You can fix them in the spreadsheet and import it again later.</p>` : ''}
        ${shown.map((x) => `<div class="task"><div class="meta">${esc(x.name)}<div class="sub">Row ${x.row}</div></div>
          <span class="badge ${x.action === 'created' ? 'ok' : 'warn'}">${x.action === 'created' ? 'New' : 'Update'}</span></div>`).join('')}
        ${r.results.length > shown.length ? `<p class="hint">…and ${r.results.length - shown.length} more</p>` : ''}
        <div class="actions"><button class="btn primary" id="impgo" ${total ? '' : 'disabled'}>Import ${total} item${total === 1 ? '' : 's'}</button></div>
      </section>`;
    document.getElementById('impgo').addEventListener('click', () => runImport(false));
    $res.scrollIntoView({ behavior: 'smooth' });
  } catch (err) { toast(err.message); } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

// ------------------------------------------------------------------ shared click actions
document.addEventListener('click', async (e) => {
  const groupBtn = e.target.closest('[data-group]');
  if (groupBtn) {
    state.groupBy = groupBtn.dataset.group; state.filter = '';
    lsSet('groupBy', state.groupBy);
    document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b === groupBtn)));
    renderList(); return;
  }
  const chip = e.target.closest('.chip');
  if (chip) { state.filter = chip.dataset.filter; renderList(); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id ? +el.dataset.id : null;
  const it = state.item;
  const att = it && id ? it.attachments.find((a) => a.id === id) : null;
  const refresh = () => (location.hash.startsWith('#/item/') ? viewItem(it.id) : viewHome());
  try {
    switch (el.dataset.act) {
      case 'copy': copyText(el.dataset.text); break;
      case 'icon-pick': await changeItemPicture(); break;
      case 'att-add': document.getElementById('upload').click(); break;
      case 'upload-cancel': {
        const f = document.getElementById('uploadform'); f.hidden = true; f.innerHTML = '';
        document.getElementById('upload').value = ''; break;
      }
      case 'att-open': if (att) openAttachment(att); break;
      case 'att-edit': if (att) await editAttachment(att); break;
      case 'att-cover':
        await api(`items/${it.id}/appearance`, { method: 'PUT', json: { cover_id: id } });
        $lightbox.close(); toast('Item picture updated'); refresh(); break;
      case 'att-del':
        if (confirm('Delete this file? This cannot be undone.')) {
          closeSheet(); await api(`attachments/${id}`, { method: 'DELETE' }); toast('File deleted'); refresh();
        }
        break;
      case 'task-add': { const f = document.getElementById('taskform'); f.hidden = false; f.elements.title.focus(); break; }
      case 'task-cancel': document.getElementById('taskform').hidden = true; break;
      case 'task-done': await api(`tasks/${id}/done`, { method: 'POST' }); toast('Marked done'); refresh(); break;
      case 'task-del': if (confirm('Delete this maintenance task?')) { await api(`tasks/${id}`, { method: 'DELETE' }); refresh(); } break;
      case 'item-del':
        if (confirm('Delete this item, its files and maintenance tasks? This cannot be undone.')) {
          await api(`items/${it.id}`, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/';
        }
        break;
      case 'term-icon': case 'term-rename': case 'term-del':
        await termAction(el.dataset.act, el.dataset.kind, id); break;
    }
  } catch (err) { toast(err.message); }
});

// Lightbox: tap the photo or backdrop to close; buttons in the bar act on the photo
$lightbox.addEventListener('click', (e) => {
  if (!e.target.closest('.lb-bar')) $lightbox.close();
});

route();
