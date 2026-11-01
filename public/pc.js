'use strict';
// "This PC" views. Relies on helpers from app.js: qs, esc, api, toast, hashColor.
(function () {
  const pane = () => qs('#pcPane');
  const pc = { view: null, token: 0, timers: [], logical: 1, home: null, sel: new Set(), storage: { path: null, sortKey: 'size', sortDir: 'desc', q: '' } };
  const actions = {};

  // ---------------- helpers ----------------
  async function getJSON(url) { const r = await api('GET', url); return r.json(); }
  async function postJSON(url, body) { const r = await api('POST', url, body || {}); return r.json(); }
  function fmtBytes(n) {
    if (n === null || n === undefined) return '\u2014';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtAgo(ms) {
    if (typeof ms !== 'number' || !ms) return '\u2014';
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 45) return d + 'd ago';
    if (d < 365) return Math.round(d / 30) + ' mo ago';
    return (d / 365).toFixed(1) + ' y ago';
  }
  function fmtDate(ms) { return typeof ms === 'number' && ms ? new Date(ms).toLocaleDateString() : '\u2014'; }
  const pill = (cls, text, title) => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  const btn = (act, label, data = {}, extra = '') => `<button class="rowbtn" data-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')} ${extra}>${label}</button>`;
  const pathBtns = (p, opts = {}) => [opts.open !== false ? btn('open', 'Open', { path: p }) : '', btn('reveal', 'Show in Explorer', { path: p }), opts.term ? btn('terminal', 'Terminal', { path: p }) : ''].join(' ');
  function avatar(name, key, size = 26) {
    if (key) return `<img class="pc-icon" style="width:${size}px;height:${size}px" src="/api/pc/icon/${key}" onerror="this.outerHTML='<div class=&quot;pc-letter&quot; style=&quot;width:${size}px;height:${size}px;background:${hashColor(name)}&quot;>${esc((name || '?').charAt(0).toUpperCase())}</div>'">`;
    return `<div class="pc-letter" style="width:${size}px;height:${size}px;background:${hashColor(name || '?')}">${esc((name || '?').charAt(0).toUpperCase())}</div>`;
  }
  function bar(frac, cls = '') { return `<div class="pc-bar ${cls}"><div style="width:${Math.max(0.5, Math.min(100, frac * 100)).toFixed(1)}%"></div></div>`; }
  function loading(msg) { return `<div class="note" style="padding:14px 0">${esc(msg || 'Loading\u2026')}</div>`; }
  function current(token) { return token === pc.token; }
  function every(ms, fn) { pc.timers.push(setInterval(fn, ms)); }

  function modal(title, html) {
    let m = qs('#pcModal');
    if (!m) {
      m = document.createElement('div'); m.id = 'pcModal'; m.className = 'modal';
      m.innerHTML = '<div class="modal-backdrop" data-act="closeModal"></div><div class="modal-content pc-modal"><div class="pc-modal-head"><b id="pcModalTitle"></b><button class="rowbtn" data-act="closeModal">Close</button></div><div id="pcModalBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', onClick);
      m.addEventListener('input', onInput);
    }
    qs('#pcModalTitle').textContent = title;
    qs('#pcModalBody').innerHTML = html;
    m.classList.remove('hidden');
  }
  actions.closeModal = () => qs('#pcModal').classList.add('hidden');

  // Generic sortable/searchable table. cfg: { id, columns:[{key,label,render,sort,cls}], rows, search(row)->string, sortKey, sortDir, empty }
  const tables = {};
  function table(cfg) {
    const prev = tables[cfg.id] || {};
    const t = { sortKey: cfg.sortKey, sortDir: cfg.sortDir || 'desc', q: '', ...prev, ...cfg, sortKey: prev.sortKey || cfg.sortKey, sortDir: prev.sortDir || cfg.sortDir || 'desc', q: prev.q || '' };
    tables[cfg.id] = t;
    return `<div class="pc-table" data-table="${cfg.id}">${renderTableInner(t)}</div>`;
  }
  function renderTableInner(t) {
    let rows = t.rows;
    if (t.q && t.search) { const q = t.q.toLowerCase(); rows = rows.filter((r) => t.search(r).toLowerCase().includes(q)); }
    const col = t.columns.find((c) => c.key === t.sortKey);
    if (col) {
      const val = col.sort || ((r) => r[col.key]);
      rows = [...rows].sort((a, b) => {
        let va = val(a), vb = val(b);
        if (va === null || va === undefined) va = -Infinity; if (vb === null || vb === undefined) vb = -Infinity;
        const r = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
        return t.sortDir === 'asc' ? r : -r;
      });
    }
    const head = t.columns.map((c) => `<th data-act="sort" data-table="${t.id}" data-key="${c.key}" class="${c.sortable === false ? '' : 'sortable'}">${c.label}${t.sortKey === c.key ? (t.sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : ''}</th>`).join('');
    const body = rows.slice(0, t.limit || 1500).map((r) => `<tr${t.rowAttr ? ' ' + t.rowAttr(r) : ''}>${t.columns.map((c) => `<td class="${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    const searchBox = t.search ? `<input class="pc-search" data-table="${t.id}" placeholder="Search ${t.rows.length} rows\u2026" value="${esc(t.q)}">` : '';
    return `${searchBox}<span class="note"> ${rows.length !== t.rows.length ? rows.length + ' of ' + t.rows.length : ''}</span>
      <table class="apptable"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${t.columns.length}" class="note">${t.empty || 'Nothing here'}</td></tr>`}</tbody></table>`;
  }
  function rerenderTable(id) {
    const el = document.querySelector(`.pc-table[data-table="${id}"]`);
    if (!el) return;
    const focused = document.activeElement && document.activeElement.classList.contains('pc-search');
    el.innerHTML = renderTableInner(tables[id]);
    if (focused) { const s = el.querySelector('.pc-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
  actions.sort = (d) => {
    const t = tables[d.table]; if (!t) return;
    const col = t.columns.find((c) => c.key === d.key); if (!col || col.sortable === false) return;
    if (t.sortKey === d.key) t.sortDir = t.sortDir === 'asc' ? 'desc' : 'asc'; else { t.sortKey = d.key; t.sortDir = 'desc'; }
    rerenderTable(d.table);
  };

  // ---------------- shared actions ----------------
  actions.open = async (d) => {
    if (/\.(exe|bat|cmd|ps1|vbs|msi|jar|py|sh)$/i.test(d.path) && !confirm(`Run ${d.path}?`)) return;
    try { await postJSON('/api/pc/fs/open', { path: d.path }); toast('Opened', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  actions.reveal = async (d) => { try { await postJSON('/api/pc/fs/reveal', { path: d.path }); } catch (e) { toast(e.message, 'err'); } };
  actions.terminal = async (d) => { try { await postJSON('/api/pc/fs/terminal', { path: d.path }); } catch (e) { toast(e.message, 'err'); } };
  actions.browse = (d) => { pc.storage.path = d.path; setView('pc:storage'); };
  actions.copy = async (d) => { try { await navigator.clipboard.writeText(d.text); toast('Copied: ' + d.text, 'ok'); } catch { toast('Copy failed', 'err'); } };

  async function trashPaths(paths, label) {
    if (!paths.length) return [];
    if (!confirm(`Move ${label || paths.length + ' item(s)'} to PC Trash?\n\nNothing is deleted yet - you can restore from PC Trash. Disk space is freed only when you "Delete forever" there.`)) return null;
    const { results } = await postJSON('/api/pc/trash', { paths });
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    if (ok.length) toast(`Moved ${ok.length} item(s) to PC Trash`, 'ok');
    bad.forEach((r) => toast(`${r.path}: ${r.error}`, 'err'));
    return ok.map((r) => r.path);
  }

  // ---------------- purpose ("what is this?") ----------------
  pc.purp = {};
  const CRIT = { critical: ['bad', 'critical'], important: ['warn', 'important'], normal: ['info', 'normal'], disposable: ['ok', 'disposable'] };
  const CLEAN = { safe: ['ok', 'safe to remove'], review: ['warn', 'review'], keep: ['info', 'keep'] };
  function purposeCell(p, extraWhy) {
    const x = pc.purp[p];
    if (!x) return '<span class="note">identifying…</span>';
    if (x.error) return '<span class="note">—</span>';
    const tip = [x.detail, x.createdBy ? 'Created by: ' + x.createdBy : '', x.cleanup && x.cleanup.why ? 'Cleanup: ' + x.cleanup.why : '', x.ai && x.ai.short ? 'AI: ' + x.ai.short : ''].filter(Boolean).join('\n\n');
    return `<div class="purp" data-act="explain" data-path="${esc(p)}" title="${esc(tip)}">
      <span class="purp-short">${esc(x.short)}</span>
      <div class="purp-tags">${pill(CRIT[x.criticality] ? CRIT[x.criticality][0] : 'info', CRIT[x.criticality] ? CRIT[x.criticality][1] : x.criticality)}${x.orphan ? ' ' + pill('warn', 'owner uninstalled') : ''}${x.ai ? ' ' + pill('info', 'AI') : ''}
      <span class="note">${esc(x.createdBy || '')}</span></div>${extraWhy ? `<div class="note why">${esc(extraWhy)}</div>` : ''}</div>`;
  }
  async function loadPurposes(paths, token, onDone) {
    const need = [...new Set(paths)].filter((p) => !pc.purp[p]);
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      try { Object.assign(pc.purp, await postJSON('/api/pc/fs/explain-batch', { paths: chunk })); } catch { for (const p of chunk) pc.purp[p] = { error: true }; }
      if (!current(token)) return;
      onDone();
    }
    if (!need.length) onDone();
  }
  actions.explain = async (d) => {
    modal('What is this?', loading('Inspecting…'));
    try {
      const x = await getJSON('/api/pc/fs/explain?path=' + encodeURIComponent(d.path));
      const row = (k, v) => v ? `<tr><td class="note" style="width:150px">${k}</td><td>${v}</td></tr>` : '';
      qs('#pcModalBody').innerHTML = `
        <div class="mono note">${esc(x.path)}</div>
        <h3 style="margin:8px 0 4px">${esc(x.short)}</h3>
        <div>${pill(CRIT[x.criticality] ? CRIT[x.criticality][0] : 'info', CRIT[x.criticality] ? CRIT[x.criticality][1] : x.criticality)} ${pill('info', x.kind)} ${pill(CLEAN[x.cleanup.verdict][0], CLEAN[x.cleanup.verdict][1])} ${x.orphan ? pill('warn', 'owner uninstalled') : ''}</div>
        <p class="explain-detail">${esc(x.detail)}</p>
        <table class="apptable">
          ${row('Created by', esc(x.createdBy))}
          ${row('Owning program', x.ownerInstalled === null ? '' : x.ownerInstalled ? `${pill('ok', 'installed')} ${esc(x.owner)}` : pill('warn', 'not found on this PC'))}
          ${row('Size', fmtBytes(x.size))}
          ${row('Last activity', x.lastActivity ? `${fmtAgo(x.lastActivity)} (${new Date(x.lastActivity).toLocaleString()})` : '')}
          ${row('Cleanup', `<b>${esc(CLEAN[x.cleanup.verdict][1])}</b> — ${esc(x.cleanup.why)}`)}
        </table>
        ${x.evidence.length ? `<h4 class="pc-h3">How this was worked out</h4><ul class="explain-ev">${x.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        ${x.ai ? `<h4 class="pc-h3">AI analysis — ${esc(x.ai.agent)} report ${fmtAgo(x.ai.at)}</h4>
          <p><b>${esc(x.ai.short)}</b></p><p class="explain-detail">${esc(x.ai.detail)}</p>
          <table class="apptable">${row('Created by', esc(x.ai.created_by))}${row('Owner installed', esc(x.ai.owner_installed))}${row('Verdict', esc(x.ai.cleanup))}${row('Reasoning', esc(x.ai.reasoning))}</table>` : ''}
        <div style="margin-top:10px">${btn('reveal', 'Show in Explorer', { path: x.path })} ${x.isDir ? btn('browse', 'Browse it', { path: x.path }) + ' ' + btn('terminal', 'Terminal here', { path: x.path }) : ''}</div>`;
    } catch (e) { qs('#pcModalBody').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  };
  actions.browse = ((orig) => (d) => { const m = qs('#pcModal'); if (m) m.classList.add('hidden'); orig(d); })(actions.browse);

  // ---------------- scan status (shared by overview/storage/cleanup) ----------------
  async function scanBanner(token, onDone) {
    const s = await getJSON('/api/pc/scan/status');
    if (!current(token)) return '';
    const el = qs('#pcScanBanner');
    const render = (st) => {
      if (!qs('#pcScanBanner')) return;
      if (st.running) {
        qs('#pcScanBanner').innerHTML = `<div class="pc-scan running"><b>Scanning ${esc(st.roots.join(', '))}\u2026</b> ${st.phase} \u00b7 ${st.files.toLocaleString()} files \u00b7 ${fmtBytes(st.bytes)} \u00b7 ${Math.round((Date.now() - st.startedAt) / 1000)}s<div class="note">${esc(st.current)}</div></div>`;
      } else {
        const ls = st.lastScan;
        qs('#pcScanBanner').innerHTML = `<div class="pc-scan">${ls ? `Folder sizes from scan of <b>${esc(ls.roots.join(', '))}</b> ${fmtAgo(ls.finishedAt)} (${ls.files.toLocaleString()} files, ${fmtBytes(ls.bytes)}).` : '<b>No disk scan yet.</b> Folder sizes and cleanup suggestions need one scan (about 2 minutes for your profile).'}
          ${btn('scan', ls ? 'Rescan my profile' : 'Scan my profile', { scope: 'profile' })} ${btn('scan', 'Scan whole C: drive', { scope: 'drive' })}</div>`;
      }
    };
    if (el) render(s);
    if (s.running) {
      const iv = setInterval(async () => {
        if (!current(token)) return clearInterval(iv);
        const st = await getJSON('/api/pc/scan/status');
        render(st);
        if (!st.running) { clearInterval(iv); toast('Disk scan finished', 'ok'); if (onDone) onDone(); }
      }, 2000);
      pc.timers.push(iv);
    }
    return s;
  }
  actions.scan = async (d) => {
    try { await postJSON('/api/pc/scan', { scope: d.scope }); toast('Scan started', 'ok'); show(pc.view); } catch (e) { toast(e.message, 'err'); }
  };

  // ================= OVERVIEW =================
  async function viewOverview(root, token) {
    root.innerHTML = `<h2 class="pc-h">This PC</h2><div id="ovCards" class="pc-cards">${loading()}</div>
      <div id="pcScanBanner"></div>
      <div class="pc-grid2"><div><h3 class="pc-h3">Attention</h3><div id="ovAlerts">${loading('Checking\u2026')}</div></div>
      <div><h3 class="pc-h3">Quick launch <span class="note">(star tools in Tools &amp; Launcher)</span></h3><div id="ovFav">${loading()}</div></div></div>
      <div class="pc-grid2"><div><h3 class="pc-h3">Biggest folders in your profile</h3><div id="ovSpace">${loading()}</div></div>
      <div><h3 class="pc-h3">What kind of files use the space</h3><div id="ovTypes">${loading()}</div></div></div>`;
    const alerts = [];
    const pushAlert = (level, title, desc, act) => { alerts.push({ level, title, desc, act }); renderAlerts(); };
    const renderAlerts = () => {
      if (!current(token) || !qs('#ovAlerts')) return;
      const order = { bad: 0, warn: 1, info: 2, ok: 3 };
      qs('#ovAlerts').innerHTML = alerts.sort((a, b) => order[a.level] - order[b.level]).map((a) => `<div class="alert ${a.level}"><div><b>${esc(a.title)}</b>${a.desc ? `<div class="desc">${esc(a.desc)}</div>` : ''}${a.act || ''}</div></div>`).join('') || loading();
    };

    getJSON('/api/pc/overview').then((o) => {
      if (!current(token)) return;
      pc.logical = o.logical || 1; pc.home = o.home;
      qs('#pcSub').textContent = `${o.computer} \u00b7 ${o.os.replace('Microsoft ', '')}`;
      const memUsed = o.totalMem - o.freeMem;
      const disks = o.disks.map((d) => { const used = (d.size - d.free) / d.size; return `<div class="card"><div class="k">Disk ${esc(d.id)} ${esc(d.label)}</div><div class="v">${fmtBytes(d.free)} free</div><div class="note">of ${fmtBytes(d.size)}</div>${bar(used, used > 0.9 ? 'bad' : used > 0.8 ? 'warn' : '')}</div>`; }).join('');
      const av = o.antivirus.filter((a) => a.enabled);
      qs('#ovCards').innerHTML = `
        <div class="card"><div class="k">Computer</div><div class="v sm">${esc(o.manufacturer)} ${esc(o.model)}</div><div class="note">${esc(o.os)} (build ${esc(o.build)})</div></div>
        <div class="card"><div class="k">CPU</div><div class="v sm">${esc(o.cpu)}</div><div class="note">${o.cores} cores \u00b7 load ${Math.round(o.cpuLoad || 0)}%</div>${bar((o.cpuLoad || 0) / 100)}</div>
        <div class="card"><div class="k">Memory</div><div class="v">${fmtBytes(memUsed)} used</div><div class="note">of ${fmtBytes(o.totalMem)}</div>${bar(memUsed / o.totalMem, memUsed / o.totalMem > 0.9 ? 'bad' : '')}</div>
        ${disks}
        <div class="card"><div class="k">Up since</div><div class="v sm">${new Date(o.lastBoot).toLocaleString()}</div><div class="note">${fmtAgo(o.lastBoot).replace(' ago', '')} uptime</div></div>
        <div class="card"><div class="k">Antivirus</div>${o.antivirus.map((a) => `<div>${esc(a.name)} ${pill(a.state === 'on' ? 'ok' : a.state === 'off' ? 'info' : 'bad', a.state)}</div>`).join('')}</div>
        <div class="card"><div class="k">GPU</div><div class="v sm">${esc(o.gpus.join(' + '))}</div></div>`;
      for (const d of o.disks) { const used = (d.size - d.free) / d.size; if (used > 0.85) pushAlert(used > 0.92 ? 'bad' : 'warn', `Drive ${d.id} is ${Math.round(used * 100)}% full`, `${fmtBytes(d.free)} free`, btn('go', 'Open Cleanup', { view: 'cleanup' })); }
      if (!av.length) {
        const paused = o.antivirus.filter((a) => a.state === 'snoozed' || a.state === 'expired');
        pushAlert('bad', paused.length ? `Real-time protection is not running: ${paused.map((a) => `${a.name} is ${a.state}`).join(', ')}` : 'No active antivirus reported by Windows Security Center',
          paused.length ? 'Resume its shields from the antivirus window. While it is registered, Windows Defender stays passive, so nothing is scanning in real time.' : 'Turn on Windows Defender or another antivirus.');
      }
      if (uptimeDays(o.lastBoot) > 14) pushAlert('info', `PC has been running for ${uptimeDays(o.lastBoot)} days`, 'A restart applies pending Windows updates and frees leaked memory.');
    }).catch((e) => { if (current(token)) qs('#ovCards').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });

    scanBanner(token, () => show('overview'));
    getJSON('/api/pc/scan/results').then(async (r) => {
      if (!current(token)) return;
      if (!r) { qs('#ovSpace').innerHTML = '<div class="note">Run a scan to see folder sizes.</div>'; qs('#ovTypes').innerHTML = ''; pushAlert('info', 'No disk scan yet', 'Run one to get folder sizes and cleanup suggestions.'); return; }
      const safe = [...r.artifacts.filter((a) => a.safety === 'safe'), ...r.known.filter((k) => k.safety === 'safe' && k.action !== 'info'), ...r.appCaches].reduce((a, x) => a + x.size, 0);
      if (safe > 5 * 1024 ** 3) pushAlert('warn', `~${fmtBytes(safe)} looks safely reclaimable`, 'Build outputs, caches and temp files that regenerate automatically.', btn('go', 'Review in Cleanup', { view: 'cleanup' }));
      const dupes = r.duplicates.reduce((a, g) => a + g.wasted, 0);
      if (dupes > 1024 ** 3) pushAlert('info', `${fmtBytes(dupes)} in duplicate large files`, `${r.duplicates.length} groups of identical files.`, btn('go', 'See duplicates', { view: 'cleanup' }));
      const types = Object.entries(r.types).sort((a, b) => b[1].bytes - a[1].bytes);
      const maxT = types[0] ? types[0][1].bytes : 1;
      qs('#ovTypes').innerHTML = types.map(([k, v]) => `<div class="pc-barrow"><span>${esc(k)}</span>${bar(v.bytes / maxT)}<span class="note">${fmtBytes(v.bytes)} \u00b7 ${v.count.toLocaleString()} files</span></div>`).join('');
      const list = await getJSON('/api/pc/fs/list?path=' + encodeURIComponent(r.roots[0]));
      if (!current(token)) return;
      const top = list.items.filter((i) => i.isDir && i.size).sort((a, b) => b.size - a.size).slice(0, 12);
      const max = top[0] ? top[0].size : 1;
      qs('#ovSpace').innerHTML = top.map((i) => `<div class="pc-barrow link" data-act="browse" data-path="${esc(i.path)}"><span>${esc(i.name)}</span>${bar(i.size / max)}<span class="note">${fmtBytes(i.size)}</span></div>`).join('');
    }).catch(() => {});

    getJSON('/api/pc/programs').then((d) => {
      if (!current(token)) return;
      const unused = d.programs.filter((p) => p.status === 'unused');
      if (unused.length) pushAlert('info', `${unused.length} program(s) not launched in 90+ days`, unused.slice(0, 6).map((p) => p.name).join(', ') + (unused.length > 6 ? '\u2026' : ''), btn('go', 'Review programs', { view: 'programs' }));
    }).catch(() => {});
    getJSON('/api/pc/browsers').then((bs) => {
      if (!current(token)) return;
      const exts = bs.flatMap((b) => b.profiles.flatMap((p) => p.extensions));
      const disabled = exts.filter((e) => e.status === 'disabled').length;
      const stale = exts.filter((e) => e.status === 'stale').length;
      if (disabled + stale) pushAlert('info', `${disabled} disabled and ${stale} possibly-unused browser extension(s)`, 'Disabled extensions still sit in your profile; remove the ones you don\u2019t need.', btn('go', 'Review extensions', { view: 'browsers' }));
      const high = exts.filter((e) => e.enabled && e.risk === 'high').length;
      if (high) pushAlert('info', `${high} enabled extension(s) can read/modify all websites`, 'Normal for password managers, proxies and dev tools - just make sure you still use each one.', btn('go', 'Review', { view: 'browsers' }));
    }).catch(() => {});
    getJSON('/api/pc/startup').then((s) => {
      if (!current(token)) return;
      const on = s.items.filter((i) => i.enabled).length;
      pushAlert(on > 12 ? 'warn' : 'ok', `${on} app(s) start automatically at login`, `${s.items.length - on} more are registered but disabled.`, btn('go', 'Manage startup', { view: 'startup' }));
    }).catch(() => {});
    getJSON('/api/pc/tools').then((t) => {
      if (!current(token)) return;
      const fav = t.filter((x) => x.favorite);
      qs('#ovFav').innerHTML = fav.length ? `<div class="pc-tiles">${fav.map(toolTile).join('')}</div>` : '<div class="note">No favorites yet. Open <a href="#" data-act="go" data-view="tools">Tools &amp; Launcher</a> and click \u2606 on the tools you use most.</div>';
    }).catch(() => {});
  }
  const uptimeDays = (boot) => Math.floor((Date.now() - boot) / 86400000);
  actions.go = (d) => setView('pc:' + d.view);

  // ================= STORAGE =================
  async function viewStorage(root, token) {
    root.innerHTML = `<h2 class="pc-h">Files &amp; Storage</h2>${loading()}`;
    if (!pc.home) { try { pc.home = (await getJSON('/api/pc/fs/list')).path; } catch { pc.home = 'C:\\Users'; } } // default listing = home folder (fast)
    if (!current(token)) return;
    const st = pc.storage;
    if (!st.path) st.path = pc.home;
    const sep = '\\';
    const roots = [['Home', pc.home], ['WORK', pc.home + sep + 'WORK'], ['Downloads', pc.home + sep + 'Downloads'], ['Desktop', pc.home + sep + 'Desktop'],
      ['Documents', pc.home + sep + 'Documents'], ['AppData', pc.home + sep + 'AppData'], ['Temp', pc.home + sep + 'AppData\\Local\\Temp'], ['C:\\', 'C:\\']];
    root.innerHTML = `<h2 class="pc-h">Files &amp; Storage</h2><div id="pcScanBanner"></div>
      <div class="pc-roots">${roots.map(([l, p]) => `<button class="rowbtn" data-act="browse" data-path="${esc(p)}">${esc(l)}</button>`).join('')}</div>
      <div id="stBody">${loading()}</div>`;
    scanBanner(token, () => show('storage'));
    let data;
    try { data = await getJSON('/api/pc/fs/list?path=' + encodeURIComponent(st.path)); } catch (e) { if (current(token)) qs('#stBody').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
    if (!current(token)) return;
    pc.sel.clear();
    const parts = data.path.split('\\').filter(Boolean);
    let acc = '';
    const crumbs = parts.map((p, i) => { acc += (i === 0 ? p + '\\' : (acc.endsWith('\\') ? '' : '\\') + p); return `<span class="crumb" data-act="browse" data-path="${esc(acc)}">${esc(p)}</span>`; }).join(' \u203A ');
    const maxSize = Math.max(1, ...data.items.map((i) => i.size || 0));
    const sizeCell = (i) => i.size !== null && i.size !== undefined ? `<div class="pc-sizecell">${bar(i.size / maxSize)}<span>${fmtBytes(i.size)}</span></div>` : (i.sizeSmall ? '<span class="note">&lt; 1 MB</span>' : (i.isDir ? '<span class="note">not scanned</span>' : '\u2014'));
    qs('#stBody').innerHTML = `<div class="pc-crumbs">${data.parent ? btn('browse', '\u2191 Up', { path: data.parent }) : ''} ${crumbs} <span class="note">${data.size ? '\u00b7 ' + fmtBytes(data.size) : ''}</span></div>
      <div class="pc-actionsbar"><span id="stSelInfo" class="note">Select items to act on them</span>
        ${btn('stTrash', 'Move selected to PC Trash', {}, 'id="stTrashBtn" disabled')} ${btn('terminal', 'Terminal here', { path: data.path })} ${btn('reveal', 'Open in Explorer', { path: data.path })}</div>
      ${table({ id: 'storage', sortKey: 'size', sortDir: 'desc', rows: data.items, search: (r) => r.name, empty: 'Empty folder',
        rowAttr: (r) => r.isDir ? `data-dbl="browse" data-path="${esc(r.path)}"` : `data-dbl="open" data-path="${esc(r.path)}"`,
        columns: [
          { key: 'sel', label: '', sortable: false, render: (r) => `<input type="checkbox" class="pc-chk" data-path="${esc(r.path)}">` },
          { key: 'name', label: 'Name', sort: (r) => (r.isDir ? '0' : '1') + r.name.toLowerCase(), render: (r) => `${r.isDir ? '\u{1F4C1}' : r.isLink ? '\u{1F517}' : '\u{1F4C4}'} ${r.isDir ? `<a href="#" data-act="browse" data-path="${esc(r.path)}">${esc(r.name)}</a>` : esc(r.name)}${r.error ? ' ' + pill('warn', r.error) : ''}` },
          { key: 'purpose', label: 'What is it', sortable: false, cls: 'purp-col', render: (r) => purposeCell(r.path) },
          { key: 'size', label: 'Size', sort: (r) => r.size ?? (r.sizeSmall ? 0.5 : -1), render: sizeCell },
          { key: 'mtime', label: 'Modified', render: (r) => fmtDate(r.mtime) },
          { key: 'act', label: '', sortable: false, render: (r) => r.isDir ? btn('terminal', 'Terminal', { path: r.path }) + ' ' + btn('reveal', 'Explorer', { path: r.path }) : btn('open', 'Open', { path: r.path }) + ' ' + btn('reveal', 'Explorer', { path: r.path }) },
        ] })}
      <p class="note">Double-click a folder to open it, a file to open it with its default app. Hover "What is it" for the full explanation; click it for who created it, whether its program is still installed and the cleanup verdict. Sizes come from the last scan; rescan after big changes.</p>`;
    loadPurposes(data.items.map((i) => i.path), token, () => rerenderTable('storage'));
  }
  actions.stTrash = async () => {
    const paths = [...pc.sel];
    const moved = await trashPaths(paths);
    if (moved && moved.length) show('storage');
  };
  function onSelChange() {
    const n = pc.sel.size;
    const info = qs('#stSelInfo'); const b = qs('#stTrashBtn');
    if (info) info.textContent = n ? `${n} selected` : 'Select items to act on them';
    if (b) b.disabled = n === 0;
  }

  // ================= CLEANUP =================
  async function viewCleanup(root, token) {
    root.innerHTML = `<h2 class="pc-h">Cleanup</h2><div id="pcScanBanner"></div><div id="clBody">${loading()}</div>`;
    scanBanner(token, () => show('cleanup'));
    const r = await getJSON('/api/pc/scan/results');
    if (!current(token)) return;
    if (!r) { qs('#clBody').innerHTML = '<div class="note">Run a scan first - cleanup suggestions come from it.</div>'; return; }
    pc.sel.clear();
    const safetyPill = (s) => s === 'safe' ? pill('ok', 'Safe to remove', 'Regenerates automatically when needed') : s === 'review' ? pill('warn', 'Review first', 'Probably fine, but check before removing') : pill('info', 'Info only');
    const chk = (p, size) => `<input type="checkbox" class="pc-chk" data-path="${esc(p)}" data-size="${size || 0}">`;
    const section = (title, sub, inner) => `<div class="pc-section"><h3 class="pc-h3">${title}</h3>${sub ? `<p class="note">${sub}</p>` : ''}${inner}</div>`;
    const total = (xs) => fmtBytes(xs.reduce((a, x) => a + (x.size || 0), 0));

    const caches = [...r.known.filter((k) => k.action !== 'info'), ...r.appCaches.map((c) => ({ ...c, label: `${c.app} cache`, safety: 'safe', hint: 'Application cache; the app rebuilds it (close the app first).' }))];
    const info = r.known.filter((k) => k.action === 'info');
    qs('#clBody').innerHTML = `
      <div class="alert info"><div><b>Nothing is deleted from this page.</b><div class="desc">Selected items move to PC Trash (instant, reversible). Disk space is freed when you "Delete forever" in PC Trash. Close apps before removing their caches. Every item says what it is and why it was suggested - click it for the full explanation.</div></div></div>
      <div id="clOrphans">${section('Leftovers from uninstalled programs &amp; games', '', loading('Checking which app-data folders no longer have an installed owner\u2026'))}</div>
      ${section(`Build artifacts \u00b7 ${total(r.artifacts)}`, 'node_modules, virtual environments and compiler output inside your projects. They are recreated by reinstalling/rebuilding.',
        table({ id: 'clArt', sortKey: 'size', rows: r.artifacts, search: (x) => x.path + ' ' + x.label, columns: [
          { key: 'sel', label: '', sortable: false, render: (x) => chk(x.path, x.size) },
          { key: 'label', label: 'Type' },
          { key: 'why', label: 'What it is &amp; why suggested', sortable: false, cls: 'purp-col', render: (x) => purposeCell(x.project, `${x.label}: ${x.hint}`) },
          { key: 'path', label: 'Location', render: (x) => `<span class="mono" title="${esc(x.hint)}">${esc(x.path)}</span>` },
          { key: 'size', label: 'Size', render: (x) => fmtBytes(x.size) },
          { key: 'safety', label: '', render: (x) => safetyPill(x.safety) },
          { key: 'a', label: '', sortable: false, render: (x) => btn('reveal', 'Explorer', { path: x.path }) },
        ] }))}
      ${section(`Caches &amp; temporary files \u00b7 ${total(caches)}`, 'Tool, browser and app caches. They refill over time, but clearing big stale ones is a quick win.',
        table({ id: 'clCache', sortKey: 'size', rows: caches, search: (x) => x.path + ' ' + x.label, columns: [
          { key: 'sel', label: '', sortable: false, render: (x) => x.action === 'browse' ? '' : chk(x.path, x.size) },
          { key: 'label', label: 'What it is &amp; why suggested', cls: 'purp-col', render: (x) => `<b>${esc(x.label)}</b>${purposeCell(x.path, x.hint)}` },
          { key: 'path', label: 'Location', render: (x) => `<span class="mono">${esc(x.path)}</span>` },
          { key: 'size', label: 'Size', render: (x) => fmtBytes(x.size) },
          { key: 'safety', label: '', render: (x) => safetyPill(x.safety) },
          { key: 'a', label: '', sortable: false, render: (x) => x.action === 'browse' ? btn('browse', 'Review contents', { path: x.path }) : btn('reveal', 'Explorer', { path: x.path }) },
        ] }))}
      ${section(`Large files (250 MB+) \u00b7 ${total(r.largeFiles)}`, 'Not necessarily removable - this is just where the space is. Installers, old videos and repack/download leftovers are usual suspects.',
        table({ id: 'clLarge', sortKey: 'size', rows: r.largeFiles, search: (x) => x.path + ' ' + x.type, columns: [
          { key: 'sel', label: '', sortable: false, render: (x) => chk(x.path, x.size) },
          { key: 'path', label: 'File', render: (x) => `<span class="mono">${esc(x.path)}</span>` },
          { key: 'why', label: 'What it is', sortable: false, cls: 'purp-col', render: (x) => purposeCell(x.path, 'Suggested because of its size - decide whether you still need it.') },
          { key: 'type', label: 'Type' },
          { key: 'size', label: 'Size', render: (x) => fmtBytes(x.size) },
          { key: 'mtime', label: 'Modified', render: (x) => fmtDate(x.mtime) },
          { key: 'a', label: '', sortable: false, render: (x) => btn('reveal', 'Explorer', { path: x.path }) },
        ] }))}
      ${section(`Duplicate files (50 MB+) \u00b7 ${fmtBytes(r.duplicates.reduce((a, g) => a + g.wasted, 0))} wasted`, 'Same size and identical first/last megabyte. Keep one copy of each group; you cannot select every copy.',
        r.duplicates.length ? r.duplicates.map((g, gi) => `<div class="pc-dupe"><div class="note">${g.files.length} copies \u00b7 ${fmtBytes(g.size)} each</div>${g.files.map((f) => `<div class="pc-duperow">${chk(f.path, g.size).replace('class="pc-chk"', `class="pc-chk" data-group="${gi}"`)} <span class="mono">${esc(f.path)}</span> <span class="note">${fmtDate(f.mtime)}</span> ${btn('reveal', 'Explorer', { path: f.path })}</div>`).join('')}</div>`).join('') : '<div class="note">No duplicates found.</div>')}
      ${section(`Old downloads (180+ days) \u00b7 ${total(r.oldDownloads)}`, '',
        table({ id: 'clDl', sortKey: 'size', rows: r.oldDownloads, empty: 'Nothing old in Downloads', search: (x) => x.path, columns: [
          { key: 'sel', label: '', sortable: false, render: (x) => chk(x.path, x.size) },
          { key: 'path', label: 'File', render: (x) => `<span class="mono">${esc(x.path)}</span>` },
          { key: 'why', label: 'What it is', sortable: false, cls: 'purp-col', render: (x) => purposeCell(x.path, 'In Downloads and untouched for 180+ days.') },
          { key: 'size', label: 'Size', render: (x) => fmtBytes(x.size) },
          { key: 'mtime', label: 'Modified', render: (x) => fmtDate(x.mtime) },
        ] }))}
      ${section('Big, but clean these from their own app', 'Deleting these files directly would break the app that owns them.',
        info.map((k) => `<div class="alert info"><div><b>${esc(k.label)} \u00b7 ${fmtBytes(k.size)}</b><div class="desc">${esc(k.hint)}</div><div class="mono note">${esc(k.path)}</div>${btn('reveal', 'Show in Explorer', { path: k.path })}</div></div>`).join(''))}
      <div class="pc-sticky"><span id="clSelInfo">Nothing selected</span> ${btn('clTrash', 'Move selected to PC Trash', {}, 'id="clTrashBtn" disabled')}</div>`;

    const refresh = () => ['clArt', 'clCache', 'clLarge', 'clDl', 'clOrphan'].forEach(rerenderTable);
    getJSON('/api/pc/cleanup/orphans').then((orphans) => {
      if (!current(token)) return;
      for (const o of orphans) pc.purp[o.path] = o;
      qs('#clOrphans').innerHTML = section(`Leftovers from uninstalled programs &amp; games · ${orphans.length} · ${total(orphans)}`,
        'App-data folders whose owning program could not be found anywhere on this PC (installed programs, Store apps, Steam/Epic libraries, GAMES, Start menu, PATH, running processes) and that nothing has written to for 120+ days. Game folders may still hold saves - check before removing.',
        table({ id: 'clOrphan', sortKey: 'size', rows: orphans, empty: 'No leftovers found', search: (x) => x.path + ' ' + x.short, columns: [
          { key: 'sel', label: '', sortable: false, render: (x) => chk(x.path, x.size) },
          { key: 'short', label: 'What it is &amp; why suggested', cls: 'purp-col', render: (x) => purposeCell(x.path, x.cleanup.why) },
          { key: 'path', label: 'Location', render: (x) => `<span class="mono">${esc(x.path)}</span>` },
          { key: 'size', label: 'Size', render: (x) => x.size ? fmtBytes(x.size) : '<span class="note">&lt; 1 MB</span>' },
          { key: 'lastActivity', label: 'Last written', render: (x) => fmtAgo(x.lastActivity) },
          { key: 'a', label: '', sortable: false, render: (x) => btn('browse', 'Look inside', { path: x.path }) },
        ] }));
    }).catch((e) => { if (current(token)) qs('#clOrphans').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });
    loadPurposes([...r.artifacts.map((a) => a.project), ...caches.map((c) => c.path), ...r.largeFiles.map((f) => f.path), ...r.oldDownloads.map((f) => f.path)], token, refresh);
  }
  function onCleanupSel() {
    const boxes = [...document.querySelectorAll('#clBody .pc-chk:checked')];
    const size = boxes.reduce((a, b) => a + Number(b.dataset.size || 0), 0);
    if (qs('#clSelInfo')) qs('#clSelInfo').textContent = boxes.length ? `${boxes.length} selected \u00b7 ${fmtBytes(size)}` : 'Nothing selected';
    if (qs('#clTrashBtn')) qs('#clTrashBtn').disabled = boxes.length === 0;
  }
  actions.clTrash = async () => {
    const boxes = [...document.querySelectorAll('#clBody .pc-chk:checked')];
    const size = boxes.reduce((a, b) => a + Number(b.dataset.size || 0), 0);
    const moved = await trashPaths(boxes.map((b) => b.dataset.path), `${boxes.length} item(s) (${fmtBytes(size)})`);
    if (moved && moved.length) show('cleanup');
  };

  // ================= PROGRAMS =================
  let progFilter = 'all';
  async function viewPrograms(root, token, force) {
    root.innerHTML = `<h2 class="pc-h">Programs</h2>${loading('Reading installed programs and Windows launch history\u2026')}`;
    const d = await getJSON('/api/pc/programs' + (force ? '?refresh=1' : ''));
    if (!current(token)) return;
    const counts = { all: d.programs.length }; d.programs.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
    const st = { active: ['ok', 'Active'], idle: ['info', 'Idle 30-90d'], unused: ['bad', 'Not used 90d+'], no_record: ['info', 'No launch record'], component: ['info', 'Component'] };
    const rows = d.programs.filter((p) => progFilter === 'all' || p.status === progFilter);
    const filters = [['all', 'All'], ['unused', 'Not used 90d+'], ['idle', 'Idle 30-90d'], ['active', 'Active'], ['no_record', 'No launch record'], ['component', 'Runtimes/drivers']]
      .map(([k, l]) => `<button class="rowbtn ${progFilter === k ? 'on' : ''}" data-act="progFilter" data-f="${k}">${l} (${counts[k] || 0})</button>`).join(' ');
    root.innerHTML = `<h2 class="pc-h">Programs ${btn('progRefresh', 'Refresh')}</h2>
      <p class="note">"Last launched" comes from Windows' own per-user launch history (UserAssist: Start menu, taskbar, desktop and Explorer launches). Apps opened through file associations, command line or as background services won't have a record - so "No launch record" doesn't mean unused. Runtimes/drivers are dependencies other apps need; don't remove them unless you know what uses them.</p>
      <div class="pc-roots">${filters}</div>
      ${table({ id: 'programs', sortKey: 'daysSinceUse', sortDir: 'desc', rows, search: (p) => `${p.name} ${p.publisher}`, columns: [
        { key: 'name', label: 'Program', sort: (p) => p.name.toLowerCase(), render: (p) => `<div class="app-cell">${avatar(p.name, p.iconKey)}<div><div class="app-label">${esc(p.name)}</div><div class="app-pkg">${esc(p.publisher || '')}${p.kind === 'store' ? ' \u00b7 Store app' : ''}</div></div></div>` },
        { key: 'version', label: 'Version', render: (p) => `<span class="note">${esc(p.version)}</span>` },
        { key: 'installTime', label: 'Installed', render: (p) => fmtDate(p.installTime) },
        { key: 'daysSinceUse', label: 'Last launched', sort: (p) => p.daysSinceUse ?? -1, render: (p) => p.runningNow ? pill('ok', 'running now') : p.lastUsed ? `${fmtAgo(p.lastUsed)}<div class="note">${fmtDate(p.lastUsed)}</div>` : '\u2014' },
        { key: 'sizeBytes', label: 'Size', render: (p) => fmtBytes(p.sizeBytes) },
        { key: 'status', label: 'Status', render: (p) => pill(st[p.status][0], st[p.status][1]) },
        { key: 'a', label: '', sortable: false, render: (p) => `${p.location ? btn('reveal', 'Folder', { path: p.location.replace(/^"|"$/g, '') }) : ''} ${p.canUninstall ? btn('uninstall', 'Uninstall', { id: p.id, name: p.name, kind: p.kind }) : ''}` },
      ] })}`;
  }
  actions.progFilter = (d) => { progFilter = d.f; delete tables.programs; show('programs'); };
  actions.progRefresh = () => { const t = ++pc.token; viewPrograms(pane(), t, true); };
  actions.uninstall = async (d) => {
    const msg = d.kind === 'store' ? `Remove the Store app "${d.name}" for your account?` : `Open the uninstaller for "${d.name}"?\n\nIts own uninstall window will appear (and maybe a Windows admin prompt). Nothing is removed until you confirm there.`;
    if (!confirm(msg)) return;
    try { const r = await postJSON('/api/pc/programs/uninstall', { id: d.id }); toast(r.message, 'ok'); } catch (e) { toast(e.message, 'err'); }
  };

  // ================= STARTUP =================
  async function viewStartup(root, token) {
    root.innerHTML = `<h2 class="pc-h">Startup</h2>${loading()}`;
    const d = await getJSON('/api/pc/startup');
    if (!current(token)) return;
    root.innerHTML = `<h2 class="pc-h">Startup</h2>
      <p class="note">Same switch Windows uses in Task Manager \u203A Startup apps: turning one off doesn't uninstall or delete anything, it just stops it launching at login. Entries registered "for all users" need administrator rights to change.</p>
      ${table({ id: 'startup', sortKey: 'enabled', sortDir: 'desc', rows: d.items, search: (i) => i.name + ' ' + i.command, columns: [
        { key: 'enabled', label: 'Starts at login', sort: (i) => (i.enabled ? 1 : 0), render: (i) => `<label class="switch"><input type="checkbox" class="pc-startup" data-source="${esc(i.source)}" data-name="${esc(i.name)}" ${i.enabled ? 'checked' : ''}><span></span></label>` },
        { key: 'name', label: 'Name', render: (i) => `<b>${esc(i.name)}</b>${!i.enabled && i.disabledAt ? `<div class="note">disabled ${fmtAgo(i.disabledAt)}</div>` : ''}` },
        { key: 'command', label: 'Runs', render: (i) => `<span class="mono">${esc(i.command)}</span>` },
        { key: 'sourceLabel', label: 'Registered in' },
      ] })}
      <h3 class="pc-h3">Third-party scheduled tasks that run at logon/boot</h3>
      ${table({ id: 'logonTasks', sortKey: 'name', sortDir: 'asc', rows: d.logonTasks, empty: 'None', columns: [
        { key: 'name', label: 'Task' }, { key: 'folder', label: 'Folder' }, { key: 'runs', label: 'Runs', render: (t) => `<span class="mono">${esc(t.runs)}</span>` },
      ] })}`;
  }
  async function onStartupToggle(el) {
    const enabled = el.checked;
    try { await postJSON('/api/pc/startup/toggle', { source: el.dataset.source, name: el.dataset.name, enabled }); toast(`${el.dataset.name} will ${enabled ? '' : 'no longer '}start at login`, 'ok'); }
    catch (e) { el.checked = !enabled; toast(e.message, 'err'); }
  }

  // ================= PROCESSES =================
  async function viewProcesses(root, token) {
    root.innerHTML = `<h2 class="pc-h">Processes</h2>${loading()}`;
    const prev = new Map();
    let auto = true;
    const load = async () => {
      const list = await getJSON('/api/pc/processes');
      if (!current(token)) return;
      const now = Date.now();
      for (const p of list) {
        const pr = prev.get(p.pid);
        p.cpuPct = pr ? Math.max(0, ((p.cpu - pr.cpu) / ((now - pr.t) / 1000)) / pc.logical * 100) : null;
        prev.set(p.pid, { cpu: p.cpu, t: now });
      }
      const groups = {};
      for (const p of list) { const k = p.description || p.name; if (!groups[k]) groups[k] = { name: k, mem: 0, count: 0, cpuPct: 0 }; groups[k].mem += p.mem; groups[k].count++; groups[k].cpuPct += p.cpuPct || 0; }
      const top = Object.values(groups).sort((a, b) => b.mem - a.mem).slice(0, 10);
      const maxM = top[0] ? top[0].mem : 1;
      const totalMem = list.reduce((a, p) => a + p.mem, 0);
      const scrollY = pane().scrollTop;
      root.innerHTML = `<h2 class="pc-h">Processes <span class="note">${list.length} running \u00b7 ${fmtBytes(totalMem)} working set</span>
          <label class="note" style="margin-left:10px"><input type="checkbox" id="procAuto" ${auto ? 'checked' : ''}> auto-refresh every 5s</label></h2>
        <h3 class="pc-h3">Top apps by memory (all their processes combined)</h3>
        ${top.map((g) => `<div class="pc-barrow"><span>${esc(g.name)} <span class="note">\u00d7${g.count}</span></span>${bar(g.mem / maxM)}<span class="note">${fmtBytes(g.mem)}${g.cpuPct ? ' \u00b7 ' + g.cpuPct.toFixed(1) + '% CPU' : ''}</span></div>`).join('')}
        <h3 class="pc-h3">All processes</h3>
        ${table({ id: 'procs', sortKey: 'mem', rows: list, search: (p) => `${p.name} ${p.description || ''} ${p.cmd || ''} ${p.pid}`, columns: [
          { key: 'name', label: 'Process', sort: (p) => p.name.toLowerCase(), render: (p) => `<b>${esc(p.name)}</b><div class="note">${esc(p.description || '')}${p.company ? ' \u00b7 ' + esc(p.company) : ''}</div>` },
          { key: 'pid', label: 'PID' },
          { key: 'cpuPct', label: 'CPU', render: (p) => p.cpuPct === null ? '<span class="note">\u2026</span>' : p.cpuPct.toFixed(1) + '%' },
          { key: 'mem', label: 'Memory', render: (p) => fmtBytes(p.mem) },
          { key: 'start', label: 'Started', render: (p) => fmtAgo(p.start) },
          { key: 'cmd', label: 'Command line', sortable: false, render: (p) => `<span class="mono clip" title="${esc(p.cmd || p.path || '')}">${esc(p.cmd || p.path || '')}</span>` },
          { key: 'a', label: '', sortable: false, render: (p) => `${p.path ? btn('reveal', 'File', { path: p.path }) : ''} ${btn('kill', 'End', { pid: p.pid, name: p.name })} ${btn('kill', 'End tree', { pid: p.pid, name: p.name, tree: '1' })}` },
        ] })}`;
      pane().scrollTop = scrollY;
      const a = qs('#procAuto'); if (a) a.addEventListener('change', () => { auto = a.checked; });
    };
    await load();
    setTimeout(() => current(token) && load(), 1500); // second sample so CPU% shows quickly
    every(5000, () => { if (auto && current(token) && !(document.activeElement && document.activeElement.classList.contains('pc-search'))) load(); });
  }
  actions.kill = async (d) => {
    if (!confirm(`End ${d.name} (PID ${d.pid})${d.tree ? ' and all its child processes' : ''}?\n\nUnsaved work in it will be lost.`)) return;
    try { await postJSON(`/api/pc/processes/${d.pid}/kill`, { tree: d.tree === '1' }); toast(`Ended ${d.name}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
  };

  // ================= RUNTIMES =================
  async function viewRuntimes(root, token, force) {
    root.innerHTML = `<h2 class="pc-h">Dev Runtimes</h2>${loading('Probing every Python/Node/toolchain install\u2026')}`;
    const d = await getJSON('/api/pc/runtimes' + (force ? '?refresh=1' : ''));
    if (!current(token)) return;
    const py = d.python.interpreters;
    const base = py.filter((p) => !p.isVenv);
    const venvs = py.filter((p) => p.isVenv);
    const pyCols = (isVenv) => [
      { key: 'version', label: 'Version', sort: (p) => p.version || '', render: (p) => p.broken ? pill('bad', 'broken') : `<b>${esc(p.version)}</b>${p.isDefault ? ' ' + pill('ok', 'default "python"') : ''}` },
      isVenv ? { key: 'project', label: 'Project', render: (p) => `<span class="mono">${esc(p.project || '')}</span>` } : { key: 'source', label: 'Installed via', render: (p) => esc(p.source) + (p.tag ? ` <span class="note">py -${esc(p.tag)}</span>` : '') },
      { key: 'exe', label: 'Path', render: (p) => `<span class="mono">${esc(p.exe)}</span>` },
      { key: 'size', label: 'Size', render: (p) => fmtBytes(p.size) },
      { key: 'a', label: '', sortable: false, render: (p) => `${btn('pyPkgs', 'Packages', { exe: p.exe })} ${btn('terminal', 'Terminal', { path: p.prefix || p.exe })} ${btn('reveal', 'Explorer', { path: p.exe })}` },
    ];
    const tools = d.tools.filter((t) => t.installed);
    const missing = d.tools.filter((t) => !t.installed).map((t) => t.name);
    root.innerHTML = `<h2 class="pc-h">Dev Runtimes ${btn('rtRefresh', 'Refresh')}</h2>
      <h3 class="pc-h3">Python interpreters (${base.length})</h3>
      ${d.python.aliasStubs.length ? `<p class="note">Also on PATH: Microsoft Store "python" alias stubs (${esc(d.python.aliasStubs.join(', '))}). Typing <code>python</code> resolves in PATH order; the one marked default wins.</p>` : ''}
      ${table({ id: 'py', sortKey: 'version', rows: base, columns: pyCols(false) })}
      <h3 class="pc-h3">Virtual environments in your projects (${venvs.length})</h3>
      ${table({ id: 'venv', sortKey: 'size', rows: venvs, search: (p) => p.exe, empty: 'Run a disk scan to discover venvs', columns: pyCols(true) })}
      <h3 class="pc-h3">Node.js ${d.node.manager ? `<span class="note">managed by ${esc(d.node.manager)} \u00b7 switch with <code>nvm use &lt;version&gt;</code></span>` : ''} ${btn('npmGlobals', 'Global npm packages')}</h3>
      ${table({ id: 'node', sortKey: 'version', rows: d.node.versions, empty: 'nvm not found', columns: [
        { key: 'version', label: 'Version', render: (v) => `<b>${esc(v.version)}</b> ${v.current ? pill('ok', 'in use') : ''}` },
        { key: 'path', label: 'Path', render: (v) => `<span class="mono">${esc(v.path || '')}</span>` },
        { key: 'size', label: 'Size', render: (v) => fmtBytes(v.size) },
        { key: 'a', label: '', sortable: false, render: (v) => v.path ? btn('reveal', 'Explorer', { path: v.path }) : '' },
      ] })}
      <h3 class="pc-h3">Java installations</h3>
      ${d.java.map((j) => `<div class="pc-barrow"><span class="mono">${esc(j.path)}</span><span class="note">${fmtBytes(j.size)}</span>${btn('reveal', 'Explorer', { path: j.path })}</div>`).join('') || '<div class="note">None found</div>'}
      <h3 class="pc-h3">Other developer tools on PATH (${tools.length})</h3>
      ${table({ id: 'devtools', sortKey: 'name', sortDir: 'asc', rows: tools, search: (t) => t.name + ' ' + t.path, columns: [
        { key: 'name', label: 'Tool', render: (t) => `<b>${esc(t.name)}</b> <span class="note">${esc(t.bin)}</span>` },
        { key: 'version', label: 'Version', render: (t) => esc(t.version || '?') },
        { key: 'path', label: 'Resolves to', render: (t) => `<span class="mono">${esc(t.path)}</span>${t.allPaths.length > 1 ? `<div class="note">+${t.allPaths.length - 1} more on PATH (shadowed)</div>` : ''}` },
        { key: 'a', label: '', sortable: false, render: (t) => btn('reveal', 'Explorer', { path: t.path }) },
      ] })}
      <p class="note">Not installed: ${esc(missing.join(', '))}</p>`;
  }
  actions.rtRefresh = () => { const t = ++pc.token; viewRuntimes(pane(), t, true); };
  actions.pyPkgs = async (d) => {
    modal('Packages \u2014 ' + d.exe, loading('Running pip list\u2026'));
    try {
      const pk = await getJSON('/api/pc/runtimes/python/packages?exe=' + encodeURIComponent(d.exe));
      delete tables.pyPkgs;
      qs('#pcModalBody').innerHTML = `<p class="note">${pk.length} packages</p>` + table({ id: 'pyPkgs', sortKey: 'name', sortDir: 'asc', rows: pk, search: (p) => p.name, columns: [{ key: 'name', label: 'Package' }, { key: 'version', label: 'Version' }] });
    } catch (e) { qs('#pcModalBody').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  };
  actions.npmGlobals = async () => {
    modal('Global npm packages', loading());
    try {
      const pk = await getJSON('/api/pc/runtimes/node/globals');
      qs('#pcModalBody').innerHTML = pk.map((p) => `<div class="pc-barrow"><span>${esc(p.name)}</span><span class="note">${esc(p.version)}</span></div>`).join('') || '<div class="note">None</div>';
    } catch (e) { qs('#pcModalBody').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  };

  // ================= TOOLS =================
  let toolsQ = '';
  function toolTile(t) {
    const primary = t.kind === 'app' ? btn('open', 'Launch', { path: t.path }) : t.kind === 'cli' ? btn('copy', 'Copy cmd', { text: t.command || t.name }) : btn('reveal', 'Show', { path: t.path });
    return `<div class="pc-tile" title="${esc(t.path)}">
      <button class="star ${t.favorite ? 'on' : ''}" data-act="fav" data-path="${esc(t.path)}" data-on="${t.favorite ? '0' : '1'}" title="${t.favorite ? 'Remove from' : 'Add to'} quick launch">${t.favorite ? '\u2605' : '\u2606'}</button>
      ${avatar(t.name, t.iconKey, 34)}<div class="pc-tile-name">${esc(t.name)}</div><div class="note">${esc(t.version ? 'v' + t.version : t.source)}</div>
      <div class="pc-tile-acts">${primary} ${btn('terminal', '>_', { path: t.folder }, 'title="Terminal in its folder"')} ${btn('reveal', '\u{1F4C2}', { path: t.folder }, 'title="Open its folder"')}</div></div>`;
  }
  async function viewTools(root, token) {
    root.innerHTML = `<h2 class="pc-h">Tools &amp; Launcher</h2>${loading('Collecting Start menu apps, CyberTools, scoop, scripts and CLI tools\u2026')}`;
    const all = await getJSON('/api/pc/tools');
    if (!current(token)) return;
    pc.toolsAll = all;
    renderTools(root);
  }
  function renderTools(root) {
    const q = toolsQ.toLowerCase();
    const list = pc.toolsAll.filter((t) => !q || `${t.name} ${t.group} ${t.source}`.toLowerCase().includes(q));
    const order = ['CyberTools', 'CLI tools (scoop)', 'My scripts (on PATH)', 'CLI tools (.local/bin)', 'CLI tools (npm global)'];
    const groups = {};
    for (const t of list) (groups[t.group] = groups[t.group] || []).push(t);
    const keys = Object.keys(groups).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
    const fav = list.filter((t) => t.favorite);
    root.innerHTML = `<h2 class="pc-h">Tools &amp; Launcher <span class="note">${pc.toolsAll.length} tools</span></h2>
      <input id="toolsSearch" class="pc-search" placeholder="Search tools\u2026" value="${esc(toolsQ)}">
      ${fav.length ? `<h3 class="pc-h3">\u2605 Favorites</h3><div class="pc-tiles">${fav.map(toolTile).join('')}</div>` : ''}
      ${keys.map((g) => `<h3 class="pc-h3">${esc(g)} <span class="note">${groups[g].length}</span></h3><div class="pc-tiles">${groups[g].map(toolTile).join('')}</div>`).join('')}`;
    const s = qs('#toolsSearch');
    s.addEventListener('input', () => { toolsQ = s.value; renderTools(root); const s2 = qs('#toolsSearch'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); });
  }
  actions.fav = async (d) => {
    try {
      await postJSON('/api/pc/tools/favorite', { path: d.path, on: d.on === '1' });
      if (pc.toolsAll) { const t = pc.toolsAll.find((x) => x.path === d.path); if (t) t.favorite = d.on === '1'; }
      if (pc.view === 'tools') renderTools(pane()); else show(pc.view);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ================= BROWSERS =================
  let extFilter = 'all';
  async function viewBrowsers(root, token) {
    root.innerHTML = `<h2 class="pc-h">Browsers &amp; Extensions</h2>${loading()}`;
    const bs = await getJSON('/api/pc/browsers');
    if (!current(token)) return;
    const st = { active: ['ok', 'Active'], stale: ['warn', 'Possibly unused'], disabled: ['info', 'Disabled'], no_data: ['info', 'No activity data'] };
    const rk = { high: 'bad', medium: 'warn', low: 'ok' };
    const all = bs.flatMap((b) => b.profiles.flatMap((p) => p.extensions));
    const cnt = (f) => all.filter(f).length;
    const filters = [['all', 'All', () => true], ['disabled', 'Disabled', (e) => e.status === 'disabled'], ['stale', 'Possibly unused (90d+)', (e) => e.status === 'stale' || e.status === 'no_data'], ['high', 'Broad access (enabled)', (e) => e.enabled && e.risk === 'high']];
    const pred = filters.find((f) => f[0] === extFilter)[2];
    root.innerHTML = `<h2 class="pc-h">Browsers &amp; Extensions</h2>
      <p class="note">Browsers don't record when an extension was last used. "Last storage activity" is the last time the extension wrote to its own storage - a decent sign of use for enabled extensions, but browsers also touch it on startup, so treat it as approximate. Removing is done in the browser itself: "Manage" opens that extension's page in the right profile.</p>
      <div class="pc-roots">${filters.map(([k, l, f]) => `<button class="rowbtn ${extFilter === k ? 'on' : ''}" data-act="extFilter" data-f="${k}">${l} (${cnt(f)})</button>`).join(' ')}</div>
      ${bs.map((b) => b.profiles.map((p, pi) => {
        const rows = p.extensions.filter(pred);
        return `<div class="pc-section"><h3 class="pc-h3">${esc(b.name)} \u203A ${esc(p.name)} ${p.account ? `<span class="note">${esc(p.account)}</span>` : ''}</h3>
          <div class="note">Profile last used ${fmtAgo(p.lastUsed)} \u00b7 profile ${fmtBytes(p.profileSize)} \u00b7 caches ${fmtBytes(p.cacheSize)} \u00b7 ${p.extensions.length} extensions ${b.exe ? btn('manageExt', 'Open extensions page', { browser: b.id, profile: p.dir }) : ''}</div>
          ${table({ id: `ext-${b.id}-${pi}`, sortKey: 'name', sortDir: 'asc', rows, empty: 'No extensions match this filter', columns: [
            { key: 'name', label: 'Extension', render: (e) => `<b>${esc(e.name)}</b> <span class="note">${esc(e.version || '')}</span><div class="note clip" title="${esc(e.description)}">${esc(e.description)}</div>` },
            { key: 'status', label: 'Status', render: (e) => pill(st[e.status][0], st[e.status][1]) + (e.unpacked ? ' ' + pill('warn', 'unpacked/dev') : '') + (e.fromWebstore === false && !e.unpacked ? ' ' + pill('warn', 'not from store') : '') },
            { key: 'risk', label: 'Access', sort: (e) => ({ high: 3, medium: 2, low: 1 })[e.risk], render: (e) => pill(rk[e.risk], e.risk, e.riskWhy || 'Limited permissions') },
            { key: 'installTime', label: 'Installed', render: (e) => fmtDate(e.installTime) },
            { key: 'lastActivity', label: 'Last storage activity', render: (e) => fmtAgo(e.lastActivity) },
            { key: 'size', label: 'Size', render: (e) => fmtBytes(e.size) },
            { key: 'a', label: '', sortable: false, render: (e) => `${b.exe ? btn('manageExt', 'Manage', { browser: b.id, profile: p.dir, ext: b.engine === 'chromium' ? e.id : '' }) : ''} ${e.storeUrl ? `<a class="rowbtn" href="${esc(e.storeUrl)}" target="_blank" rel="noopener">Store \u2197</a>` : ''}` },
          ] })}</div>`;
      }).join('')).join('')}`;
  }
  actions.extFilter = (d) => { extFilter = d.f; Object.keys(tables).filter((k) => k.startsWith('ext-')).forEach((k) => delete tables[k]); show('browsers'); };
  actions.manageExt = async (d) => { try { await postJSON('/api/pc/browsers/manage', { browser: d.browser, profile: d.profile, extId: d.ext || undefined }); toast('Opened in browser', 'ok'); } catch (e) { toast(e.message, 'err'); } };

  // ================= SECURITY & NETWORK =================
  async function viewSecurity(root, token) {
    root.innerHTML = `<h2 class="pc-h">Security &amp; Network</h2>${loading('Collecting firewall, accounts, tasks, services and connections\u2026')}`;
    const [s, n, o] = await Promise.all([getJSON('/api/pc/security'), getJSON('/api/pc/network'), getJSON('/api/pc/overview')]);
    if (!current(token)) return;
    const yes = (ok, good, bad) => ok ? pill('ok', good) : pill('bad', bad);
    const listen = n.filter((c) => c.state === 'Listen');
    const exposed = listen.filter((c) => !['127.0.0.1', '::1'].includes(c.local));
    const est = n.filter((c) => c.state === 'Established' && !['127.0.0.1', '::1'].includes(c.remote));
    const byProc = {};
    for (const c of est) { const k = c.process || '?'; (byProc[k] = byProc[k] || { process: k, path: c.path, count: 0, remotes: new Set() }).count++; byProc[k].remotes.add(c.remote); }
    root.innerHTML = `<h2 class="pc-h">Security &amp; Network</h2>
      <div class="pc-cards">
        <div class="card"><div class="k">Antivirus</div>${o.antivirus.map((a) => `<div>${esc(a.name)} ${pill(a.state === 'on' ? 'ok' : a.state === 'off' ? 'info' : 'bad', a.state)} ${a.upToDate ? '' : pill('bad', 'outdated')}</div>`).join('')}</div>
        <div class="card"><div class="k">Firewall</div>${s.firewall.map((f) => `<div>${esc(f.name)} ${yes(f.enabled, 'on', 'OFF')}</div>`).join('')}</div>
        <div class="card"><div class="k">Account protection</div><div>UAC ${yes(s.uacEnabled, 'on', 'OFF')}</div><div>Remote Desktop ${s.rdpEnabled ? pill('warn', 'enabled') : pill('ok', 'disabled')}</div></div>
        <div class="card"><div class="k">Administrators</div>${s.admins.map((a) => `<div class="mono">${esc(a)}</div>`).join('')}</div>
      </div>
      <h3 class="pc-h3">Local accounts</h3>
      ${table({ id: 'users', sortKey: 'enabled', rows: s.users, columns: [
        { key: 'name', label: 'Account', render: (u) => `<b>${esc(u.name)}</b><div class="note">${esc(u.description)}</div>` },
        { key: 'enabled', label: 'Enabled', sort: (u) => (u.enabled ? 1 : 0), render: (u) => u.enabled ? pill('ok', 'yes') : pill('info', 'no') },
        { key: 'lastLogon', label: 'Last logon', render: (u) => fmtAgo(u.lastLogon) },
        { key: 'passwordLastSet', label: 'Password set', render: (u) => fmtDate(u.passwordLastSet) },
      ] })}
      <h3 class="pc-h3">Listening on the network (reachable from other devices) \u00b7 ${exposed.length}</h3>
      ${table({ id: 'listen', sortKey: 'lport', sortDir: 'asc', rows: exposed, search: (c) => `${c.process} ${c.lport}`, columns: [
        { key: 'process', label: 'Process', render: (c) => `<b>${esc(c.process)}</b> <span class="note">PID ${c.pid}</span>` },
        { key: 'proto', label: 'Proto' }, { key: 'local', label: 'Address' }, { key: 'lport', label: 'Port' },
        { key: 'path', label: 'Program', render: (c) => `<span class="mono">${esc(c.path || '(system)')}</span>` },
      ] })}
      <h3 class="pc-h3">Apps with internet connections right now</h3>
      ${table({ id: 'est', sortKey: 'count', rows: Object.values(byProc).map((x) => ({ ...x, remotes: [...x.remotes] })), columns: [
        { key: 'process', label: 'Process', render: (x) => `<b>${esc(x.process)}</b><div class="mono note">${esc(x.path || '')}</div>` },
        { key: 'count', label: 'Connections' },
        { key: 'remotes', label: 'Remote addresses', sortable: false, render: (x) => `<span class="mono">${esc(x.remotes.slice(0, 6).join(', '))}${x.remotes.length > 6 ? ' \u2026' : ''}</span>` },
      ] })}
      <h3 class="pc-h3">Third-party scheduled tasks</h3>
      ${table({ id: 'tasks', sortKey: 'lastRun', rows: s.thirdPartyTasks, search: (t) => t.name + t.runs, columns: [
        { key: 'name', label: 'Task', render: (t) => `<b>${esc(t.name)}</b><div class="note">${esc(t.folder)}</div>` },
        { key: 'state', label: 'State' }, { key: 'lastRun', label: 'Last run', render: (t) => fmtAgo(t.lastRun) },
        { key: 'runs', label: 'Runs', render: (t) => `<span class="mono">${esc(t.runs)}</span>` },
      ] })}
      <h3 class="pc-h3">Third-party auto-start services</h3>
      ${table({ id: 'svcs', sortKey: 'display', sortDir: 'asc', rows: s.thirdPartyServices, search: (x) => x.display + x.path, columns: [
        { key: 'display', label: 'Service', render: (x) => `<b>${esc(x.display)}</b><div class="note">${esc(x.name)}</div>` },
        { key: 'state', label: 'State' }, { key: 'account', label: 'Runs as' },
        { key: 'path', label: 'Executable', render: (x) => `<span class="mono">${esc(x.path)}</span>` },
      ] })}
      <h3 class="pc-h3">Hosts file entries</h3>
      ${s.hosts.map((h) => `<div class="mono">${esc(h)}</div>`).join('') || '<div class="note">Default (no custom entries)</div>'}`;
  }

  // ================= PC TRASH =================
  async function viewTrash(root, token) {
    root.innerHTML = `<h2 class="pc-h">PC Trash</h2>${loading()}`;
    const d = await getJSON('/api/pc/trash');
    if (!current(token)) return;
    const total = d.items.reduce((a, x) => a + (x.size || 0), 0);
    root.innerHTML = `<h2 class="pc-h">PC Trash <span class="note">${d.items.length} item(s) \u00b7 ${fmtBytes(total)}</span> ${d.items.length ? btn('trEmpty', 'Delete everything forever') : ''}</h2>
      <p class="note">Items here are only moved, not deleted (stored in <span class="mono">${esc(d.root)}</span>). Restore puts them back exactly where they were. Space is freed only when you delete them forever.</p>
      ${table({ id: 'pctrash', sortKey: 'deletedAt', rows: d.items, empty: 'Trash is empty', columns: [
        { key: 'originalPath', label: 'Original location', render: (x) => `${x.isDir ? '\u{1F4C1}' : '\u{1F4C4}'} <span class="mono">${esc(x.originalPath)}</span>` },
        { key: 'size', label: 'Size', render: (x) => x.size === null ? '<span class="note">calculating\u2026</span>' : fmtBytes(x.size) },
        { key: 'deletedAt', label: 'Moved here', render: (x) => fmtAgo(x.deletedAt) },
        { key: 'a', label: '', sortable: false, render: (x) => `${btn('trRestore', 'Restore', { id: x.id })} ${btn('trDelete', 'Delete forever', { id: x.id, name: x.originalPath })}` },
      ] })}`;
  }
  actions.trRestore = async (d) => { try { const r = await postJSON(`/api/pc/trash/${d.id}/restore`); toast('Restored to ' + r.restoredTo, 'ok'); show('trash'); } catch (e) { toast(e.message, 'err'); } };
  actions.trDelete = async (d) => {
    if (!confirm(`Permanently delete ${d.name}?\n\nThis cannot be undone.`)) return;
    try { const r = await postJSON(`/api/pc/trash/${d.id}/delete`); toast(`Deleted forever (${fmtBytes(r.freed)} freed)`, 'ok'); show('trash'); } catch (e) { toast(e.message, 'err'); }
  };
  actions.trEmpty = async () => {
    if (!confirm('Permanently delete EVERYTHING in PC Trash?\n\nThis cannot be undone.')) return;
    try { const r = await postJSON('/api/pc/trash/empty'); toast(`Deleted ${r.count} item(s), ${fmtBytes(r.freed)} freed`, r.ok ? 'ok' : 'err'); r.errors.forEach((e) => toast(e, 'err')); show('trash'); } catch (e) { toast(e.message, 'err'); }
  };

  // ---------------- dispatch ----------------
  const VIEWS = { overview: viewOverview, storage: viewStorage, cleanup: viewCleanup, programs: viewPrograms, startup: viewStartup, processes: viewProcesses,
    runtimes: viewRuntimes, tools: viewTools, browsers: viewBrowsers, security: viewSecurity, trash: viewTrash };

  function show(view) {
    pc.timers.forEach(clearInterval); pc.timers = [];
    if (pc.view !== view) Object.keys(tables).forEach((k) => delete tables[k]);
    pc.view = view;
    const token = ++pc.token;
    const root = pane();
    root.scrollTop = 0;
    (VIEWS[view] || viewOverview)(root, token).catch((e) => { if (current(token)) root.innerHTML += `<div class="alert bad"><div><b>Failed to load</b><div class="desc">${esc(e.message)}</div></div></div>`; });
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.tagName === 'A') e.preventDefault();
    const fn = actions[el.dataset.act];
    if (fn) fn(el.dataset, el);
  }
  function onInput(e) {
    const t = e.target;
    if (t.classList.contains('pc-search') && t.dataset.table) { tables[t.dataset.table].q = t.value; rerenderTable(t.dataset.table); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const p = pane();
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr[data-dbl]');
      if (tr && !e.target.closest('button, input, a')) actions[tr.dataset.dbl]({ path: tr.dataset.path });
    });
    p.addEventListener('change', (e) => {
      const t = e.target;
      if (t.classList.contains('pc-startup')) return onStartupToggle(t);
      if (t.classList.contains('pc-chk')) {
        if (pc.view === 'storage') { if (t.checked) pc.sel.add(t.dataset.path); else pc.sel.delete(t.dataset.path); onSelChange(); }
        if (pc.view === 'cleanup') {
          if (t.dataset.group !== undefined) {
            const all = [...document.querySelectorAll(`#clBody .pc-chk[data-group="${t.dataset.group}"]`)];
            if (all.every((x) => x.checked)) { t.checked = false; toast('Keep at least one copy of each duplicate', 'err'); }
          }
          onCleanupSel();
        }
      }
    });
  });

  window.PC = {
    show,
    register: (name, fn) => { VIEWS[name] = fn; },
    actions,
    h: { getJSON, postJSON, fmtBytes, fmtAgo, fmtDate, pill, btn, loading, table, rerenderTable, modal, current, every, trashPaths, pane },
  };
})();
