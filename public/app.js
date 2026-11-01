'use strict';

const state = {
  view: 'files',
  path: '/sdcard',
  items: [],
  selected: new Set(),
  viewMode: 'grid',
  quickFolders: [],
};

function qs(sel) { return document.querySelector(sel); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtSize(n) {
  if (n === 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtDate(ms) { if (!ms) return ''; return new Date(ms).toLocaleString(); }
function extOf(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; }
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.3gp', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.opus']);
function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (e === '.pdf') return 'pdf';
  if (e === '.apk') return 'apk';
  return 'file';
}
function iconFor(kind) {
  return { image: '\u{1F5BC}', video: '\u{1F3AC}', audio: '\u{1F3B5}', pdf: '\u{1F4C4}', apk: '\u{1F4E6}', file: '\u{1F4C4}', dir: '\u{1F4C1}' }[kind] || '\u{1F4C4}';
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  qs('#toastHost').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Manager': '1' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res;
}

// ---------------- device & nav ----------------
async function loadDevice() {
  try {
    const res = await api('GET', '/api/device');
    const d = await res.json();
    qs('#deviceSub').textContent = `${d.manufacturer || ''} ${d.model || ''} · Android ${d.androidVersion || '?'}`;
    if (d.storage) {
      const s = d.storage;
      const cls = s.usedPct > 90 ? 'bad' : (s.usedPct > 80 ? 'warn' : '');
      qs('#storageBox').innerHTML = `<div>${s.freeGB} GB free of ${s.totalGB} GB</div><div class="storage-bar ${cls}"><div style="width:${s.usedPct}%"></div></div>`;
    }
    state.phoneConnected = true;
  } catch (e) {
    state.phoneConnected = false;
    qs('#deviceSub').textContent = 'Phone not connected';
    qs('#storageBox').innerHTML = '';
  }
}

async function loadQuickFolders() {
  try {
    const res = await api('GET', '/api/quick-folders');
    state.quickFolders = await res.json();
  } catch { state.quickFolders = []; }
  renderNav();
}

const PC_NAV = [
  ['pc:overview', '\u{1F5A5} Overview'], ['pc:ai', '\u{1F916} AI Scan'], ['pc:storage', '\u{1F4C1} Files & Storage'], ['pc:cleanup', '\u{1F9F9} Cleanup'],
  ['pc:programs', '\u{1F4E6} Programs'], ['pc:startup', '\u{1F680} Startup'], ['pc:processes', '⚙️ Processes'],
  ['pc:runtimes', '\u{1F40D} Dev Runtimes'], ['pc:tools', '\u{1F9F0} Tools & Launcher'], ['pc:browsers', '\u{1F310} Browsers'],
  ['pc:security', '\u{1F6E1} Security & Network'], ['pc:trash', '\u{1F5D1} PC Trash'],
];

function renderNav() {
  const nav = qs('#navLinks');
  let html = '<div class="group-label">This PC</div>';
  for (const [view, label] of PC_NAV) html += `<button data-view="${view}" class="navbtn">${label}</button>`;
  html += `<div class="group-label">Phone${state.phoneConnected ? '' : ' (not connected)'}</div>`;
  if (state.phoneConnected) {
    const items = [{ label: 'All Files', path: '/sdcard' }, ...state.quickFolders.map(q => ({ label: q.label, path: q.path }))];
    for (const it of items) html += `<button data-path="${esc(it.path)}" class="navbtn">${esc(it.label)}</button>`;
    html += `<button data-view="trash" class="navbtn">\u{1F5D1} Phone Trash</button>`;
    html += `<button data-view="apps" class="navbtn">\u{1F4F1} Phone Apps</button>`;
    html += `<button data-view="security" class="navbtn">\u{1F512} Phone Security</button>`;
  } else {
    html += `<button id="reconnectPhoneBtn" class="navbtn">\u{1F50C} Check for phone again</button>`;
  }
  nav.innerHTML = html;
  nav.querySelectorAll('button[data-path]').forEach(b => b.addEventListener('click', () => { setView('files'); navigateTo(b.dataset.path); }));
  nav.querySelectorAll('button[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  const rc = qs('#reconnectPhoneBtn');
  if (rc) rc.addEventListener('click', async () => {
    try { await api('POST', '/api/device/reconnect'); } catch { /* reported below */ }
    await loadDevice(); await loadQuickFolders();
    toast(state.phoneConnected ? 'Phone connected' : 'Still no phone - check the USB cable and the RSA prompt on the phone', state.phoneConnected ? 'ok' : 'err');
  });
}

function setView(view) {
  state.view = view;
  const isPc = view.startsWith('pc:');
  qs('#pcPane').classList.toggle('hidden', !isPc);
  qs('#topbar').style.display = view === 'files' ? 'flex' : 'none';
  qs('#dropzone').classList.toggle('hidden', view !== 'files');
  qs('#toolbar').style.display = view === 'files' ? 'flex' : 'none';
  qs('#appsPane').classList.toggle('hidden', view !== 'apps');
  qs('#securityPane').classList.toggle('hidden', view !== 'security');
  qs('#trashPane').classList.toggle('hidden', view !== 'trash');
  document.querySelectorAll('#navLinks button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'apps') loadApps();
  if (view === 'security') loadSecurity();
  if (view === 'trash') loadTrash();
  if (isPc) window.PC.show(view.slice(3));
}

function renderBreadcrumb() {
  const parts = state.path.replace(/^\/sdcard\/?/, '').split('/').filter(Boolean);
  let acc = '/sdcard';
  let html = `<span data-p="/sdcard">Storage</span>`;
  for (const p of parts) {
    acc += '/' + p;
    html += ` / <span data-p="${esc(acc)}">${esc(p)}</span>`;
  }
  qs('#breadcrumb').innerHTML = html;
  qs('#breadcrumb').querySelectorAll('span').forEach(s => s.addEventListener('click', () => navigateTo(s.dataset.p)));
  document.querySelectorAll('#navLinks button[data-path]').forEach(b => b.classList.toggle('active', state.view === 'files' && b.dataset.path === state.path));
}

async function navigateTo(path) {
  setView('files');
  state.path = path;
  state.selected.clear();
  renderBreadcrumb();
  qs('#fileArea').innerHTML = '<div style="color:var(--muted);padding:20px;">Loading…</div>';
  try {
    const res = await api('GET', '/api/list?path=' + encodeURIComponent(path));
    const data = await res.json();
    state.path = data.path;
    state.items = data.items;
    renderBreadcrumb();
    renderFiles();
  } catch (e) {
    qs('#fileArea').innerHTML = `<div style="color:var(--bad);padding:20px;">${esc(e.message)}</div>`;
  }
}

// ---------------- file rendering ----------------
function filteredItems() {
  const q = qs('#searchBox').value.trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter(i => i.name.toLowerCase().includes(q));
}

function renderFiles() {
  const items = filteredItems();
  const area = qs('#fileArea');
  area.classList.toggle('list-mode', state.viewMode === 'list');
  if (state.viewMode === 'grid') {
    area.className = 'grid';
    area.innerHTML = items.map(renderTile).join('') || '<div style="color:var(--muted);padding:20px;">Empty folder</div>';
    area.querySelectorAll('.tile').forEach(bindTile);
  } else {
    area.className = '';
    area.innerHTML = `<table class="filelist"><thead><tr><th></th><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody>${items.map(renderRow).join('')}</tbody></table>`;
    area.querySelectorAll('tr[data-path]').forEach(bindTile);
  }
  updateToolbar();
}

function renderTile(item) {
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const sel = state.selected.has(item.path) ? ' selected' : '';
  const thumb = kind === 'image'
    ? `<img loading="lazy" src="/api/thumb?path=${encodeURIComponent(item.path)}&mtime=${item.mtime}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'${iconFor(kind)}'}))">`
    : iconFor(kind);
  return `<div class="tile${sel}" data-path="${esc(item.path)}" data-isdir="${item.isDir}" data-name="${esc(item.name)}">
    <div class="check">✓</div>
    <div class="thumb">${thumb}</div>
    <div class="fname" title="${esc(item.name)}">${esc(item.name)}</div>
    <div class="fmeta">${item.isDir ? '' : fmtSize(item.size)}</div>
  </div>`;
}

function renderRow(item) {
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const sel = state.selected.has(item.path) ? ' selected' : '';
  return `<tr class="${sel.trim()}" data-path="${esc(item.path)}" data-isdir="${item.isDir}" data-name="${esc(item.name)}">
    <td><div class="check" style="position:static;opacity:1;display:inline-flex;width:16px;height:16px;">${state.selected.has(item.path) ? '✓' : ''}</div></td>
    <td class="nm">${iconFor(kind)} ${esc(item.name)}</td>
    <td>${item.isDir ? '—' : fmtSize(item.size)}</td>
    <td>${fmtDate(item.mtime)}</td>
  </tr>`;
}

function bindTile(el) {
  const path = el.dataset.path;
  const isDir = el.dataset.isdir === 'true';
  el.addEventListener('click', (e) => {
    if (isDir && !e.ctrlKey && !e.metaKey) { navigateTo(path); return; }
    toggleSelect(path, e);
  });
  el.addEventListener('dblclick', (e) => {
    if (!isDir) openPreview(path, el.dataset.name);
  });
}

function toggleSelect(path) {
  if (state.selected.has(path)) state.selected.delete(path); else state.selected.add(path);
  renderFiles();
}

function updateToolbar() {
  const n = state.selected.size;
  qs('#selectionInfo').textContent = n ? `${n} selected` : '';
  qs('#downloadSelBtn').disabled = n === 0;
  qs('#trashSelBtn').disabled = n === 0;
  qs('#renameSelBtn').disabled = n !== 1;
}

// ---------------- preview ----------------
function openPreview(path, name) {
  const kind = kindOf(name);
  const body = qs('#previewBody');
  const url = '/api/file?path=' + encodeURIComponent(path);
  if (kind === 'image') body.innerHTML = `<img src="${url}">`;
  else if (kind === 'video') body.innerHTML = `<video src="${url}" controls autoplay></video>`;
  else if (kind === 'audio') body.innerHTML = `<audio src="${url}" controls autoplay style="width:360px"></audio>`;
  else if (kind === 'pdf') body.innerHTML = `<iframe src="${url}" style="width:80vw;height:80vh;border:none;background:#fff;"></iframe>`;
  else { window.location.href = url + '&download=1'; return; }
  qs('#previewModal').classList.remove('hidden');
}
qs('#previewClose').addEventListener('click', closePreview);
qs('.modal-backdrop') && qs('.modal-backdrop').addEventListener('click', closePreview);
function closePreview() {
  qs('#previewModal').classList.add('hidden');
  qs('#previewBody').innerHTML = '';
}

// ---------------- toolbar actions ----------------
qs('#viewGridBtn').addEventListener('click', () => { state.viewMode = 'grid'; qs('#viewGridBtn').classList.add('active'); qs('#viewListBtn').classList.remove('active'); renderFiles(); });
qs('#viewListBtn').addEventListener('click', () => { state.viewMode = 'list'; qs('#viewListBtn').classList.add('active'); qs('#viewGridBtn').classList.remove('active'); renderFiles(); });
qs('#searchBox').addEventListener('input', renderFiles);

qs('#newFolderBtn').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try { await api('POST', '/api/mkdir', { path: state.path, name }); toast('Folder created', 'ok'); navigateTo(state.path); }
  catch (e) { toast(e.message, 'err'); }
});

qs('#uploadBtn').addEventListener('click', () => qs('#uploadInput').click());
qs('#uploadInput').addEventListener('change', (e) => uploadFiles(e.target.files));

async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  toast(`Uploading ${fileList.length} file(s)…`);
  try {
    const res = await fetch('/api/upload?path=' + encodeURIComponent(state.path), { method: 'POST', headers: { 'X-Manager': '1' }, body: fd });
    const data = await res.json();
    const failed = data.results.filter(r => !r.ok);
    toast(failed.length ? `${failed.length} upload(s) failed` : 'Upload complete', failed.length ? 'err' : 'ok');
    navigateTo(state.path);
  } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
}

const dropzone = qs('#dropzone');
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

qs('#downloadSelBtn').addEventListener('click', async () => {
  const paths = [...state.selected];
  if (paths.length === 1) {
    window.location.href = '/api/file?path=' + encodeURIComponent(paths[0]) + '&download=1';
    return;
  }
  toast(`Zipping ${paths.length} item(s)…`);
  const res = await fetch('/api/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Manager': '1' }, body: JSON.stringify({ paths }) });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'phone-files.zip';
  a.click();
});

qs('#renameSelBtn').addEventListener('click', async () => {
  const path = [...state.selected][0];
  const oldName = path.split('/').pop();
  const newName = prompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  try { await api('POST', '/api/rename', { path, newName }); toast('Renamed', 'ok'); navigateTo(state.path); }
  catch (e) { toast(e.message, 'err'); }
});

qs('#trashSelBtn').addEventListener('click', async () => {
  const paths = [...state.selected];
  if (!confirm(`Move ${paths.length} item(s) to Trash? You can restore them from the Trash view.`)) return;
  try { await api('POST', '/api/trash', { paths }); toast('Moved to trash', 'ok'); navigateTo(state.path); }
  catch (e) { toast(e.message, 'err'); }
});

// ---------------- apps pane ----------------
const appsState = { data: null, meta: {}, category: 'all', sortKey: 'daysSinceInstall', sortDir: 'desc', search: '' };
let metaPollTimer = null;

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 45%, 38%)`;
}

function appIconHtml(pkg, label) {
  const m = appsState.meta[pkg];
  if (m && m.iconMode === 'composite') {
    const v = m.fetchedAt || 0;
    return `<div class="app-icon-stack">
      <img src="/api/apps/${encodeURIComponent(pkg)}/icon/bg?v=${v}">
      <img src="/api/apps/${encodeURIComponent(pkg)}/icon/fg?v=${v}">
    </div>`;
  }
  if (m && m.iconMode === 'flat') {
    const v = m.fetchedAt || 0;
    return `<div class="app-icon-stack"><img src="/api/apps/${encodeURIComponent(pkg)}/icon/flat?v=${v}"></div>`;
  }
  const letter = (label || pkg).replace(/^[a-z]+\./i, '').charAt(0).toUpperCase() || '?';
  return `<div class="app-icon-letter" style="background:${hashColor(pkg)}">${esc(letter)}</div>`;
}

const CATEGORY_INFO = {
  active: { label: 'Active', pill: 'ok' },
  stale: { label: 'Long unused', pill: 'bad' },
  unused_recent: { label: 'Possibly unused', pill: 'warn' },
};

function fmtDays(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 30) return `${n}d ago`;
  if (n < 365) return `${Math.round(n / 30)}mo ago`;
  return `${(n / 365).toFixed(1)}y ago`;
}

async function loadApps(forceRefresh) {
  const pane = qs('#appsPane');
  pane.innerHTML = '<div style="color:var(--muted)">Scanning installed apps and usage history (this takes a few seconds)…</div>';
  const res = await api('GET', '/api/apps' + (forceRefresh ? '?refresh=1' : ''));
  appsState.data = await res.json();
  await loadAppMetaOnly();
  renderApps();
}

async function loadAppMetaOnly() {
  try {
    const res = await api('GET', '/api/apps/metadata');
    appsState.meta = await res.json();
  } catch { /* non-fatal, names/icons just won't show yet */ }
}

async function startMetaRefresh() {
  try { await api('POST', '/api/apps/metadata/refresh', {}); }
  catch (e) { toast(e.message, 'err'); return; }
  if (metaPollTimer) clearInterval(metaPollTimer);
  metaPollTimer = setInterval(async () => {
    const res = await api('GET', '/api/apps/metadata/status');
    const status = await res.json();
    await loadAppMetaOnly();
    renderApps(status);
    if (!status.running) { clearInterval(metaPollTimer); metaPollTimer = null; toast('Finished fetching app names & icons', 'ok'); }
  }, 1500);
}

function renderApps(jobStatus) {
  const pane = qs('#appsPane');
  const { apps, usageWindowDays } = appsState.data;
  const metaCount = Object.keys(appsState.meta).length;
  const counts = { all: apps.length, active: 0, stale: 0, unused_recent: 0 };
  apps.forEach(a => counts[a.category]++);

  const filterBtns = [
    ['all', `All (${counts.all})`],
    ['active', `Active (${counts.active})`],
    ['stale', `Long unused (${counts.stale})`],
    ['unused_recent', `Possibly unused (${counts.unused_recent})`],
  ].map(([key, label]) => `<button class="rowbtn cat-filter-btn${appsState.category === key ? ' active-filter' : ''}" data-cat="${key}" style="margin-right:6px;${appsState.category === key ? 'border-color:var(--accent);color:var(--accent);' : ''}">${label}</button>`).join('');

  let rows = apps.filter(a => appsState.category === 'all' || a.category === appsState.category);
  if (appsState.search) {
    const q = appsState.search.toLowerCase();
    rows = rows.filter(a => {
      const label = appsState.meta[a.package]?.label || '';
      return a.package.toLowerCase().includes(q) || label.toLowerCase().includes(q);
    });
  }
  rows.sort((a, b) => {
    const va = a[appsState.sortKey], vb = b[appsState.sortKey];
    const na = va === null || va === undefined ? -Infinity : va;
    const nb = vb === null || vb === undefined ? -Infinity : vb;
    return appsState.sortDir === 'asc' ? (na > nb ? 1 : -1) : (na < nb ? 1 : -1);
  });

  const sortArrow = (key) => appsState.sortKey === key ? (appsState.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const body = rows.map(a => {
    const info = CATEGORY_INFO[a.category];
    const m = appsState.meta[a.package];
    const label = m && m.label ? m.label : null;
    const source = !a.installer ? '<span class="pill warn">Sideloaded</span>'
      : a.installer === 'com.google.android.packageinstaller' ? '<span class="pill info">Manual install</span>'
      : a.installer === 'com.android.vending' ? '<span class="pill ok">Play Store</span>'
      : `<span class="pill info">${esc(a.installer)}</span>`;
    return `<tr>
      <td><div class="app-cell">${appIconHtml(a.package, label)}<div><div class="app-label">${esc(label || a.package)}</div><div class="app-pkg mono">${esc(a.package)}</div></div></div></td>
      <td>${source}</td>
      <td>${fmtDays(a.daysSinceInstall)}</td>
      <td>${fmtDays(a.daysSinceUse)}</td>
      <td><span class="pill ${info.pill}">${info.label}</span></td>
      <td>
        <a class="rowbtn" href="https://play.google.com/store/apps/details?id=${encodeURIComponent(a.package)}" target="_blank" rel="noopener">Play Store ↗</a>
        <button class="rowbtn uninstall-btn" data-pkg="${esc(a.package)}">Uninstall</button>
      </td>
    </tr>`;
  }).join('');

  const fetchBtnHtml = jobStatus && jobStatus.running
    ? `<button class="rowbtn" disabled>Fetching… ${jobStatus.done}/${jobStatus.total}${jobStatus.currentPkg ? ' (' + esc(jobStatus.currentPkg) + ')' : ''}</button>`
    : `<button id="appsFetchMetaBtn" class="rowbtn">Fetch app names &amp; icons${metaCount ? ' (refresh)' : ''}</button>`;

  pane.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
      <h2 style="font-size:15px;margin:0;">Installed Apps</h2>
      <button id="appsRefreshBtn" class="rowbtn">Refresh usage data</button>
      ${fetchBtnHtml}
    </div>
    <p class="note" style="margin-top:0;">Status is based on ${usageWindowDays}-day on-device usage history (the longest Android exposes without root). Names/icons are read from each app's own installed package (first run takes a couple of minutes and pulls each APK briefly over USB; results are cached after that). Some modern apps use vector-only icons we can't extract, so you'll see a letter avatar instead — a "Play Store" link is provided for the real icon/description.</p>
    <div style="margin-bottom:10px;">${filterBtns}</div>
    <input id="appsSearch" type="text" placeholder="Search package or app name..." value="${esc(appsState.search)}" style="background:var(--panel2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;width:260px;margin-bottom:10px;">
    <table class="apptable">
      <thead><tr>
        <th data-k="package">App${sortArrow('package')}</th>
        <th data-k="installer">Source</th>
        <th data-k="daysSinceInstall">Installed${sortArrow('daysSinceInstall')}</th>
        <th data-k="daysSinceUse">Last used${sortArrow('daysSinceUse')}</th>
        <th data-k="category">Status${sortArrow('category')}</th>
        <th></th>
      </tr></thead>
      <tbody>${body || '<tr><td colspan=6 style="color:var(--muted)">No apps match</td></tr>'}</tbody>
    </table>`;

  pane.querySelectorAll('.cat-filter-btn').forEach(b => b.addEventListener('click', () => { appsState.category = b.dataset.cat; renderApps(); }));
  const fetchBtn = qs('#appsFetchMetaBtn');
  if (fetchBtn) fetchBtn.addEventListener('click', startMetaRefresh);
  pane.querySelectorAll('thead th[data-k]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (appsState.sortKey === k) appsState.sortDir = appsState.sortDir === 'asc' ? 'desc' : 'asc';
    else { appsState.sortKey = k; appsState.sortDir = 'desc'; }
    renderApps();
  }));
  qs('#appsSearch').addEventListener('input', (e) => { appsState.search = e.target.value; renderApps(); });
  qs('#appsRefreshBtn').addEventListener('click', () => loadApps(true));
  pane.querySelectorAll('.uninstall-btn').forEach(b => b.addEventListener('click', async () => {
    const pkg = b.dataset.pkg;
    if (!confirm(`Uninstall ${pkg} from the phone? This removes the app and its data. This cannot be undone from here (you'd need to reinstall it).`)) return;
    try {
      await api('POST', `/api/apps/${encodeURIComponent(pkg)}/uninstall`);
      toast(`Uninstalled ${pkg}`, 'ok');
      // Remove it from the already-loaded list in place instead of re-running the
      // ~10-15s usage-stats scan for every app just to drop one row.
      appsState.data.apps = appsState.data.apps.filter(a => a.package !== pkg);
      delete appsState.meta[pkg];
      renderApps();
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// ---------------- security pane ----------------
async function loadSecurity() {
  const pane = qs('#securityPane');
  pane.innerHTML = '<div style="color:var(--muted)">Scanning device…</div>';
  const res = await api('GET', '/api/security');
  const s = await res.json();
  const alerts = [];
  if (s.rootIndicatorsFound) alerts.push({ level: 'bad', tag: 'ROOT', title: 'Root access (su binary) found', desc: '' });
  else alerts.push({ level: 'ok', tag: 'ROOT', title: 'No root (su binary) detected', desc: '' });

  if (s.accessibilityServicesEnabled) alerts.push({ level: 'warn', tag: 'A11Y', title: 'Accessibility service(s) enabled', desc: s.accessibilityServicesEnabled });
  else alerts.push({ level: 'ok', tag: 'A11Y', title: 'No accessibility services enabled', desc: 'Good — this is the most common malware/stalkerware persistence mechanism on Android.' });

  if (s.deviceAdminOwners && s.deviceAdminOwners !== 'no owners') alerts.push({ level: 'warn', tag: 'ADMIN', title: 'Device admin owner(s) set', desc: s.deviceAdminOwners });
  else alerts.push({ level: 'ok', tag: 'ADMIN', title: 'No device admin owners', desc: '' });

  if (s.overlayGrantedTo.length) alerts.push({ level: 'info', tag: 'OVERLAY', title: `${s.overlayGrantedTo.length} app(s) can draw over other apps`, desc: s.overlayGrantedTo.join(', ') });

  if (s.sideloadedApps.length) alerts.push({ level: 'info', tag: 'INSTALL', title: `${s.sideloadedApps.length} app(s) not installed from Play Store`, desc: s.sideloadedApps.map(a => a.package).join(', ') });

  pane.innerHTML = `<h2 style="font-size:15px;">Security Report</h2>` + alerts.map(a => `
    <div class="alert ${a.level}"><span class="tag">${a.tag}</span><div><b>${esc(a.title)}</b>${a.desc ? `<div class="desc">${esc(a.desc)}</div>` : ''}</div></div>
  `).join('');
}

// ---------------- trash pane ----------------
async function loadTrash() {
  const pane = qs('#trashPane');
  pane.innerHTML = '<div style="color:var(--muted)">Loading trash…</div>';
  const res = await api('GET', '/api/trash');
  const entries = await res.json();
  const rows = entries.map(e => `
    <tr>
      <td>${esc(e.originalPath)}</td>
      <td>${e.isDir ? '—' : fmtSize(e.size)}</td>
      <td>${fmtDate(e.deletedAt)}</td>
      <td><button class="rowbtn" data-act="restore" data-id="${e.id}">Restore</button>
          <button class="rowbtn" data-act="delete" data-id="${e.id}">Delete forever</button></td>
    </tr>`).join('');
  pane.innerHTML = `<h2 style="font-size:15px;">Trash (${entries.length})</h2>
    <button id="emptyTrashBtn" class="rowbtn" style="margin-bottom:10px;" ${entries.length ? '' : 'disabled'}>Empty trash</button>
    <table class="apptable"><thead><tr><th>Original location</th><th>Size</th><th>Deleted</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan=4 style="color:var(--muted)">Trash is empty</td></tr>'}</tbody></table>`;
  pane.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'restore') {
      try { await api('POST', `/api/trash/${id}/restore`); toast('Restored', 'ok'); loadTrash(); } catch (e) { toast(e.message, 'err'); }
    } else {
      if (!confirm('Permanently delete this item from the phone? This cannot be undone.')) return;
      try { await api('POST', `/api/trash/${id}/delete`); toast('Deleted permanently', 'ok'); loadTrash(); } catch (e) { toast(e.message, 'err'); }
    }
  }));
  const emptyBtn = qs('#emptyTrashBtn');
  if (emptyBtn) emptyBtn.addEventListener('click', async () => {
    if (!confirm(`Permanently delete all ${entries.length} item(s) in Trash? This cannot be undone.`)) return;
    try { await api('POST', '/api/trash/empty'); toast('Trash emptied', 'ok'); loadTrash(); } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------------- init ----------------
window.addEventListener('DOMContentLoaded', async () => {
  renderNav();
  setView('pc:overview');
  await loadDevice();
  await loadQuickFolders();
  renderNav();
  document.querySelectorAll('#navLinks button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
});
