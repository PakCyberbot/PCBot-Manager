'use strict';
// "AI Scan" view: pick an AI CLI, run a read-only scan, review the YAML findings and approve actions one by one.
(function () {
  const { getJSON, postJSON, fmtBytes, fmtAgo, pill, btn, loading, modal, current, every, trashPaths } = window.PC.h;
  const actions = window.PC.actions;
  const st = { agents: null, agent: null, mode: 'quick', model: '', custom: '', runId: null, run: null, verdict: 'all', category: 'all', hideHandled: true };

  const VERDICT = {
    safe_to_delete: ['ok', 'Safe to delete'], review: ['warn', 'Review'], uninstall: ['warn', 'Uninstall?'], disable: ['info', 'Disable at login?'],
    investigate: ['bad', 'Investigate'], keep: ['info', 'Keep'],
  };
  const PRIO = { high: 'bad', medium: 'warn', low: 'info' };

  async function view(root, token) {
    root.innerHTML = `<h2 class="pc-h">AI Scan</h2>${loading()}`;
    const [agents, status, runs] = await Promise.all([getJSON('/api/pc/ai/agents'), getJSON('/api/pc/ai/status'), getJSON('/api/pc/ai/runs')]);
    if (!current(token)) return;
    st.agents = agents;
    if (!st.agent) st.agent = (agents.find((a) => a.id === 'claude' && a.available) || agents.find((a) => a.available) || agents[0]).id;
    if (!st.custom) st.custom = (agents.find((a) => a.id === 'custom') || {}).command || '';
    if (!st.runId && runs.length) st.runId = (runs.find((r) => r.status === 'done') || runs[0]).id;
    root.innerHTML = `<h2 class="pc-h">AI Scan</h2>
      <p class="note">An AI agent of your choice audits the whole PC (processes, startup, programs, files and folders, registry autostart points, services, tasks, browsers, network, runtimes) and returns a YAML report. The agent runs <b>read-only</b>; it can't delete or change anything. Every suggested action shows up below as a button that <b>you</b> approve, and it goes through the same protections as the rest of the dashboard (PC Trash, the program's own uninstaller, startup switches).</p>
      <div id="aiSetup"></div><div id="aiRunning"></div><div id="aiHistory"></div><div id="aiResult"></div>`;
    renderSetup(status);
    renderHistory(runs);
    if (status.running) watch(token);
    if (st.runId) loadRun(token, st.runId);
  }

  function renderSetup(status) {
    const a = st.agents.find((x) => x.id === st.agent);
    const inline = st.agent === 'custom' || st.agent === 'ollama';
    const ol = st.agents.find((x) => x.id === 'ollama');
    if (st.agent === 'ollama' && !(a.models || []).some((m) => m.name === st.model)) st.model = (a.models[0] || {}).name || '';
    qs('#aiSetup').innerHTML = `<div class="pc-section ai-setup">
      <div class="ai-row"><b>Agent</b>${st.agents.map((x) => `<label class="ai-opt ${x.available ? '' : 'dim'}" title="${esc(x.note || '')}"><input type="radio" name="aiAgent" value="${x.id}" ${x.id === st.agent ? 'checked' : ''} ${x.available ? '' : 'disabled'}> ${esc(x.label)}${x.available ? '' : x.id === 'ollama' ? ' (not available)' : ' (not installed)'}</label>`).join('')}</div>
      ${ol && !ol.available && ol.note ? `<div class="note">Ollama: ${esc(ol.note)}</div>` : ''}
      <div class="note ai-ro">\u{1F512} ${esc(a.readOnly)}</div>
      ${st.agent === 'custom' ? `<div class="ai-row"><b>Command</b><input id="aiCustom" class="pc-search" style="width:520px" placeholder="any command that reads the prompt on stdin and prints the YAML" value="${esc(st.custom)}"></div>` : ''}
      ${inline ? `<div class="note">This option gets a condensed snapshot inside the prompt (~25k tokens) and can't inspect folders itself. Local models need a large context window (the Manager requests one automatically) and enough RAM/VRAM; models of ~14B parameters or more give far better reports.</div>` : `<div class="ai-row"><b>Depth</b>
        <label class="ai-opt"><input type="radio" name="aiMode" value="quick" ${st.mode === 'quick' ? 'checked' : ''}> Quick — analyse the snapshot (a few minutes)</label>
        <label class="ai-opt"><input type="radio" name="aiMode" value="deep" ${st.mode === 'deep' ? 'checked' : ''}> Deep — also inspect folders/files read-only (longer, more tokens)</label></div>`}
      ${st.agent === 'ollama'
        ? `<div class="ai-row"><b>Model</b><select id="aiModel" class="pc-search">${a.models.map((m) => `<option value="${esc(m.name)}" ${m.name === st.model ? 'selected' : ''}>${esc(m.name)} (${m.sizeGB} GB)</option>`).join('')}</select> <span class="note">local models only - cloud models are hidden</span></div>`
        : st.agent !== 'custom' ? `<div class="ai-row"><b>Model</b><input id="aiModel" class="pc-search" style="width:220px" placeholder="optional, agent default" value="${esc(st.model)}"></div>` : ''}
      <div class="ai-row">${btn('aiStart', '\u{1F916} Start AI scan', {}, status.running ? 'disabled' : '')}
        ${btn('aiImport', 'Import YAML from any AI…')}
        <a class="rowbtn" href="/api/pc/ai/bundle" title="One file with the full prompt + snapshot data - paste or upload it to any AI chat, then import the YAML it returns">Download prompt + snapshot for any AI</a></div>
    </div>`;
    qs('#aiSetup').querySelectorAll('input[name=aiAgent]').forEach((r) => r.addEventListener('change', () => { if (st.agent === 'ollama' || r.value === 'ollama') st.model = ''; st.agent = r.value; renderSetup(status); }));
    qs('#aiSetup').querySelectorAll('input[name=aiMode]').forEach((r) => r.addEventListener('change', () => { st.mode = r.value; }));
    const m = qs('#aiModel'); if (m) { m.addEventListener('input', () => { st.model = m.value.trim(); }); m.addEventListener('change', () => { st.model = m.value.trim(); }); }
    const c = qs('#aiCustom'); if (c) c.addEventListener('input', () => { st.custom = c.value; });
  }

  function renderHistory(runs) {
    if (!runs.length) { qs('#aiHistory').innerHTML = ''; return; }
    const sp = { done: 'ok', running: 'info', error: 'bad', cancelled: 'info' };
    qs('#aiHistory').innerHTML = `<h3 class="pc-h3">Scan history</h3><div class="ai-runs">${runs.slice(0, 12).map((r) => `
      <button class="ai-run ${r.id === st.runId ? 'on' : ''}" data-act="aiOpenRun" data-id="${esc(r.id)}">
        <b>${esc(r.agentLabel || r.agent)}</b> <span class="note">${esc(r.mode)}</span><br>
        ${pill(sp[r.status] || 'info', r.status)} ${r.findings !== undefined ? `<span class="note">${r.findings} findings</span>` : ''} ${r.healthScore !== undefined ? `<span class="note">· health ${r.healthScore}</span>` : ''}<br>
        <span class="note">${fmtAgo(r.startedAt)} · ${new Date(r.startedAt).toLocaleString()}</span></button>`).join('')}</div>`;
  }

  // ---------- running ----------
  function watch(token) {
    let finished = false;
    const tick = async () => {
      if (finished) return;
      const s = await getJSON('/api/pc/ai/status');
      if (!current(token) || finished) return;
      const el = qs('#aiRunning');
      if (!el) return;
      if (s.running) {
        el.innerHTML = `<div class="pc-scan running"><b>${esc(s.phase)}</b> · ${Math.round((Date.now() - s.startedAt) / 1000)}s ${btn('aiCancel', 'Cancel')}
          <pre class="ai-log">${esc((s.log || []).slice(-40).join('\n')) || 'Waiting for output…'}</pre></div>`;
        const pre = el.querySelector('.ai-log'); pre.scrollTop = pre.scrollHeight;
      } else {
        finished = true;
        el.innerHTML = s.phase && s.phase.startsWith('error') ? `<div class="alert bad"><div><b>AI scan failed</b><div class="desc">${esc(s.phase)}</div>${btn('aiShowLog', 'Show log', { id: s.id })}</div></div>` : '';
        const runs = await getJSON('/api/pc/ai/runs');
        st.runId = s.id; renderHistory(runs); renderSetup(s);
        if (s.phase === 'done') { toast('AI scan finished', 'ok'); loadRun(token, s.id); }
      }
    };
    every(2000, tick); // pc.js clears these timers whenever the view changes
    tick();
  }

  actions.aiStart = async () => {
    try {
      await postJSON('/api/pc/ai/scan', { agent: st.agent, mode: st.mode, model: st.model || undefined, customCommand: st.agent === 'custom' ? st.custom : undefined });
      toast('AI scan started', 'ok');
      window.PC.show('ai');
    } catch (e) { toast(e.message, 'err'); }
  };
  actions.aiCancel = async () => { try { await postJSON('/api/pc/ai/cancel'); toast('Cancelling…'); } catch (e) { toast(e.message, 'err'); } };
  actions.aiOpenRun = (d) => { st.runId = d.id; window.PC.show('ai'); };
  actions.aiShowLog = async (d) => {
    try { const r = await fetch(`/api/pc/ai/runs/${encodeURIComponent(d.id)}/file/agent.log`); modal('Agent log', `<pre class="ai-log tall">${esc(await r.text())}</pre>`); } catch (e) { toast(e.message, 'err'); }
  };
  actions.aiImport = () => {
    modal('Import YAML from any AI', `<p class="note">Paste the YAML report (or the AI's whole reply - the part between AI_SCAN_YAML_BEGIN / AI_SCAN_YAML_END is extracted), or choose a .yaml file. It must follow the manager.ai-scan/v1 schema from the downloadable prompt.</p>
      <input type="file" id="aiImportFile" accept=".yaml,.yml,.txt,.md"><textarea id="aiImportText" class="ai-textarea" placeholder="schema: manager.ai-scan/v1&#10;summary: ...&#10;findings: ..."></textarea>
      <input id="aiImportSource" class="pc-search" placeholder="Which AI produced it? (optional)"> ${btn('aiImportGo', 'Import')}`);
    qs('#aiImportFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) qs('#aiImportText').value = await f.text(); });
  };
  actions.aiImportGo = async () => {
    try {
      const r = await postJSON('/api/pc/ai/import', { yaml: qs('#aiImportText').value, source: qs('#aiImportSource').value });
      actions.closeModal(); toast('Imported', 'ok'); st.runId = r.id; window.PC.show('ai');
    } catch (e) { toast('Import failed: ' + e.message, 'err'); }
  };

  // ---------- results ----------
  async function loadRun(token, id) {
    const el = qs('#aiResult');
    el.innerHTML = loading('Loading report and matching findings to real items…');
    let data;
    try { data = await getJSON('/api/pc/ai/runs/' + encodeURIComponent(id)); } catch (e) { if (current(token)) el.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
    if (!current(token)) return;
    st.run = data;
    renderResult();
  }

  function renderResult() {
    const el = qs('#aiResult');
    const { meta, result } = st.run;
    const files = ['result.yaml', 'prompt.md', 'raw-output.txt', 'agent.log'].map((f) => `<a class="rowbtn" target="_blank" href="/api/pc/ai/runs/${encodeURIComponent(meta.id)}/file/${f}">${f}</a>`).join(' ');
    if (!result) {
      el.innerHTML = `<h3 class="pc-h3">Report</h3><div class="alert ${meta.status === 'error' ? 'bad' : 'info'}"><div><b>${esc(meta.agentLabel)} · ${esc(meta.status)}</b><div class="desc">${esc(meta.error || 'No report yet.')}</div>${files}</div></div>`;
      return;
    }
    const s = result.summary;
    const F = result.findings;
    const handled = (f) => f.decision && (f.decision.state === 'done' || f.decision.state === 'dismissed');
    const cats = [...new Set(F.map((f) => f.category))].sort();
    let rows = F.filter((f) => (st.verdict === 'all' || f.verdict === st.verdict) && (st.category === 'all' || f.category === st.category) && !(st.hideHandled && handled(f)));
    const prioN = { high: 0, medium: 1, low: 2 };
    rows = rows.sort((a, b) => prioN[a.priority] - prioN[b.priority] || (b.size_bytes || 0) - (a.size_bytes || 0));
    const count = (v) => F.filter((f) => (v === 'all' || f.verdict === v) && !(st.hideHandled && handled(f))).length;
    const bulk = rows.filter((f) => f.verdict === 'safe_to_delete' && f.action.kind === 'trash' && !handled(f));
    const scoreCls = s.health_score >= 75 ? '' : s.health_score >= 50 ? 'warn' : 'bad';
    el.innerHTML = `<h3 class="pc-h3">Report — ${esc(meta.agentLabel)} (${esc(meta.mode)}) · ${new Date(meta.finishedAt || meta.startedAt).toLocaleString()}</h3>
      <div class="pc-cards">
        <div class="card"><div class="k">Health score</div><div class="v">${s.health_score}/100</div><div class="pc-bar ${scoreCls}"><div style="width:${s.health_score}%"></div></div></div>
        <div class="card"><div class="k">Overall risk</div><div class="v sm">${pill(PRIO[s.overall_risk] || 'info', s.overall_risk)}</div></div>
        <div class="card"><div class="k">Safe to reclaim</div><div class="v">${fmtBytes(s.reclaimable_safe_bytes)}</div><div class="note">+ ${fmtBytes(s.reclaimable_review_bytes)} after review</div></div>
        <div class="card"><div class="k">Findings</div><div class="v">${F.length}</div><div class="note">${F.filter(handled).length} handled</div></div>
      </div>
      <div class="alert info"><div><b>${esc(s.headline)}</b>${s.key_points.length ? `<ul class="ai-points">${s.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}<div style="margin-top:6px">${files}</div></div></div>
      <div class="pc-roots">${['all', 'safe_to_delete', 'review', 'uninstall', 'disable', 'investigate', 'keep'].map((v) => `<button class="rowbtn ${st.verdict === v ? 'on' : ''}" data-act="aiVerdict" data-v="${v}">${v === 'all' ? 'All' : VERDICT[v][1]} (${count(v)})</button>`).join(' ')}
        <select id="aiCat" class="pc-search" style="width:auto;margin:0"><option value="all">All categories</option>${cats.map((c) => `<option value="${c}" ${st.category === c ? 'selected' : ''}>${c.replace(/_/g, ' ')}</option>`).join('')}</select>
        <label class="note"><input type="checkbox" id="aiHide" ${st.hideHandled ? 'checked' : ''}> hide done/dismissed</label>
        ${bulk.length ? btn('aiBulkTrash', `Move all ${bulk.length} visible "safe to delete" items to PC Trash (${fmtBytes(bulk.reduce((a, f) => a + (f.size_bytes || 0), 0))})`) : ''}</div>
      <div class="ai-findings">${rows.map(card).join('') || '<div class="note">No findings match these filters.</div>'}</div>
      ${result.purposes.length ? `<h3 class="pc-h3">Folder map — what everything is (${result.purposes.length})</h3>
        <p class="note">The AI's annotated map of this PC. These explanations also appear when you click "What is it" in Files &amp; Storage.</p>
        ${window.PC.h.table({ id: 'aiPurposes', sortKey: 'path', sortDir: 'asc', rows: result.purposes, search: (x) => `${x.path} ${x.short} ${x.created_by}`, columns: [
          { key: 'path', label: 'Path', render: (x) => `<a href="#" data-act="explain" data-path="${esc(x.path)}" class="mono">${esc(x.path)}</a>` },
          { key: 'short', label: 'What it is', render: (x) => `<span title="${esc(x.detail + (x.reasoning ? '\n\n' + x.reasoning : ''))}">${esc(x.short)}</span>` },
          { key: 'created_by', label: 'Created by' },
          { key: 'criticality', label: 'Criticality', render: (x) => pill({ critical: 'bad', important: 'warn', normal: 'info', disposable: 'ok' }[x.criticality], x.criticality) },
          { key: 'owner_installed', label: 'Owner installed', render: (x) => x.owner_installed === 'false' ? pill('warn', 'no') : x.owner_installed === 'true' ? pill('ok', 'yes') : '<span class="note">?</span>' },
          { key: 'cleanup', label: 'Cleanup', render: (x) => pill({ keep: 'info', review: 'warn', safe_to_delete: 'ok' }[x.cleanup], x.cleanup.replace(/_/g, ' ')) },
        ] })}` : ''}`;
    qs('#aiCat').addEventListener('change', (e) => { st.category = e.target.value; renderResult(); });
    qs('#aiHide').addEventListener('change', (e) => { st.hideHandled = e.target.checked; renderResult(); });
  }

  function card(f) {
    const v = VERDICT[f.verdict];
    const t = f.target;
    const where = t.path || t.registry_key || [t.name, t.pid ? `PID ${t.pid}` : '', t.browser, t.extension_id].filter(Boolean).join(' · ');
    const a = f.action;
    const data = { fid: f.id };
    let act = '';
    if (f.decision) act = `${pill(f.decision.state === 'done' ? 'ok' : 'info', f.decision.state)} ${btn('aiDecide', 'Undo', { ...data, state: '' })}`;
    else {
      if (a.kind === 'trash') act = btn('aiDoTrash', 'Move to PC Trash', { ...data, path: a.path, size: f.size_bytes || 0 });
      else if (a.kind === 'uninstall') act = btn('aiDoUninstall', a.programKind === 'store' ? 'Remove app' : 'Open uninstaller', { ...data, id: a.id, name: a.name, kind: a.programKind });
      else if (a.kind === 'disable_startup') act = btn('aiDoStartup', 'Disable at login', { ...data, source: a.source, name: a.name });
      else if (a.kind === 'end_process') act = btn('aiDoKill', 'End process', { ...data, pid: a.pid, name: a.name });
      else if (a.kind === 'extension') act = btn('aiDoExt', 'Open in browser to remove', { ...data, browser: a.browser, profile: a.profile, ext: a.extId });
      else if (a.kind === 'blocked') act = pill('info', 'Protected location', a.why);
      else if (a.kind === 'gone') act = pill('info', a.why);
      if (t.path && a.kind !== 'gone') act += ' ' + btn('reveal', 'Show in Explorer', { path: t.path });
      act += ` ${btn('aiDecide', f.verdict === 'keep' || a.kind === 'manual' ? 'Mark done' : 'Done', { ...data, state: 'done' })} ${btn('aiDecide', 'Dismiss', { ...data, state: 'dismissed' })}`;
    }
    return `<div class="ai-card ${f.decision ? 'handled' : ''}">
      <div class="ai-card-head">${pill(v[0], v[1])} ${pill(PRIO[f.priority], f.priority)} <span class="note">${esc(f.category.replace(/_/g, ' '))} · ${esc(f.id)}</span>
        ${f.size_bytes ? `<span class="ai-size">${fmtBytes(f.size_bytes)}</span>` : ''}</div>
      <div class="ai-title">${esc(f.title)}</div>
      ${where ? `<div class="mono note">${esc(where)}</div>` : ''}
      ${f.purpose ? `<div class="ai-purpose" title="${esc(f.purpose_detail || '')}"><b>What it is:</b> ${esc(f.purpose)}${f.created_by ? ` <span class="note">· created by ${esc(f.created_by)}</span>` : ''}${f.owner_installed === 'false' ? ' ' + pill('warn', 'owner uninstalled') : f.owner_installed === 'true' ? ' ' + pill('ok', 'owner installed') : ''}
        ${f.purpose_detail ? `<details><summary class="note">Why it exists</summary><div class="ai-reason">${esc(f.purpose_detail)}</div></details>` : ''}</div>` : ''}
      <div class="ai-reason">${esc(f.reason)}</div>
      ${f.why_flagged ? `<div class="ai-why"><b>Why flagged:</b> ${esc(f.why_flagged)}</div>` : ''}
      ${f.overridden ? `<div class="ai-why" style="color:var(--warn,#d29922)">⚠ ${esc(f.overridden)}</div>` : ''}
      ${f.action && f.action.kind === 'manual' && f.action.why ? `<div class="ai-why"><b>How to clean it:</b> ${esc(f.action.why)}</div>` : ''}
      ${f.evidence.length ? `<details><summary class="note">Evidence (${f.evidence.length})</summary><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
      ${f.manual_steps ? `<div class="ai-manual"><b>Steps:</b> ${esc(f.manual_steps)}</div>` : ''}
      <div class="ai-acts">${act}</div></div>`;
  }

  actions.aiVerdict = (d) => { st.verdict = d.v; renderResult(); };
  async function decide(fid, state) {
    await postJSON(`/api/pc/ai/runs/${encodeURIComponent(st.run.meta.id)}/decision`, { findingId: fid, state: state || null });
    const f = st.run.result.findings.find((x) => x.id === fid);
    f.decision = state ? { state, at: Date.now() } : null;
    renderResult();
  }
  actions.aiDecide = async (d) => { try { await decide(d.fid, d.state); } catch (e) { toast(e.message, 'err'); } };
  actions.aiDoTrash = async (d) => {
    const moved = await trashPaths([d.path], `${d.path} (${fmtBytes(Number(d.size))})`);
    if (moved && moved.length) await decide(d.fid, 'done');
  };
  actions.aiBulkTrash = async () => {
    const F = st.run.result.findings.filter((f) => f.verdict === 'safe_to_delete' && f.action.kind === 'trash' && !f.decision
      && (st.category === 'all' || f.category === st.category) && (st.verdict === 'all' || st.verdict === 'safe_to_delete'));
    const total = F.reduce((a, f) => a + (f.size_bytes || 0), 0);
    const moved = await trashPaths(F.map((f) => f.action.path), `${F.length} items the AI marked safe (${fmtBytes(total)}):\n${F.slice(0, 12).map((f) => '• ' + f.action.path).join('\n')}${F.length > 12 ? '\n…' : ''}`);
    if (!moved) return;
    const set = new Set(moved.map((p) => p.toLowerCase()));
    for (const f of F) if (set.has(f.action.path.toLowerCase())) await postJSON(`/api/pc/ai/runs/${encodeURIComponent(st.run.meta.id)}/decision`, { findingId: f.id, state: 'done' }).then(() => { f.decision = { state: 'done' }; });
    renderResult();
  };
  actions.aiDoUninstall = async (d) => {
    const msg = d.kind === 'store' ? `Remove the Store app "${d.name}" for your account?` : `Open the uninstaller for "${d.name}"? Nothing is removed until you confirm in its own window.`;
    if (!confirm(msg)) return;
    try { const r = await postJSON('/api/pc/programs/uninstall', { id: d.id }); toast(r.message, 'ok'); await decide(d.fid, 'done'); } catch (e) { toast(e.message, 'err'); }
  };
  actions.aiDoStartup = async (d) => {
    if (!confirm(`Stop "${d.name}" from starting at login? (Reversible in the Startup view.)`)) return;
    try { await postJSON('/api/pc/startup/toggle', { source: d.source, name: d.name, enabled: false }); toast(`${d.name} disabled at login`, 'ok'); await decide(d.fid, 'done'); } catch (e) { toast(e.message, 'err'); }
  };
  actions.aiDoKill = async (d) => {
    if (!confirm(`End ${d.name} (PID ${d.pid})? Unsaved work in it will be lost.`)) return;
    try { await postJSON(`/api/pc/processes/${d.pid}/kill`, {}); toast(`Ended ${d.name}`, 'ok'); await decide(d.fid, 'done'); } catch (e) { toast(e.message, 'err'); }
  };
  actions.aiDoExt = async (d) => {
    try { await postJSON('/api/pc/browsers/manage', { browser: d.browser, profile: d.profile, extId: d.ext || undefined }); toast('Opened in the browser - remove it there, then click Done', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };

  window.PC.register('ai', view);
})();
