'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const YAML = require('yaml');
const snapshot = require('./snapshot');
const { buildPrompt, BEGIN, END } = require('./prompt');
const programs = require('../programs');
const startup = require('../startup');
const browsers = require('../browsers');
const system = require('../system');
const pctrash = require('../pctrash');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'ai-scan');
const SETTINGS = path.join(ROOT, 'settings.json');
fs.mkdirSync(ROOT, { recursive: true });
const HOME = os.homedir();
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

// Each agent runs headless in its own read-only mode; the prompt goes in on stdin.
const AGENTS = {
  claude: {
    label: 'Claude Code', bin: 'claude',
    readOnly: 'Only the Read, Glob and Grep tools exist in the session (no shell, no edit/write tools).',
    args: ({ mode, model }) => ['-p', '--output-format', 'text', '--tools', 'Read', 'Glob', 'Grep', '--allowedTools', 'Read', 'Glob', 'Grep',
      ...(mode === 'deep' ? ['--add-dir', HOME, 'C:\\'] : []), ...(model ? ['--model', model] : [])],
  },
  codex: {
    label: 'OpenAI Codex CLI', bin: 'codex',
    readOnly: 'Runs with --sandbox read-only: it can run inspection commands, but the OS sandbox blocks all writes.',
    args: ({ dir, outFile, model }) => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', dir, '-o', outFile, ...(model ? ['-m', model] : []), '-'],
    outputFile: true,
  },
  gemini: {
    label: 'Gemini CLI', bin: 'gemini',
    readOnly: 'Runs with --approval-mode plan (read-only tools only).',
    args: ({ mode, model }) => ['-p', 'Follow the instructions provided on stdin exactly.', '--approval-mode', 'plan', '-o', 'text',
      ...(mode === 'deep' ? ['--include-directories', HOME] : []), ...(model ? ['-m', model] : [])],
  },
  custom: {
    label: 'Custom command', bin: null,
    readOnly: 'You are responsible for making this command read-only. The prompt is sent on stdin; the YAML is read from stdout.',
  },
};

function whereExe(bin) {
  return new Promise((resolve) => execFile('where.exe', [bin], { windowsHide: true, timeout: 8000 }, (err, out) => {
    resolve(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }));
}

function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); }

async function agents() {
  const out = [];
  for (const [id, a] of Object.entries(AGENTS)) {
    if (id === 'custom') { out.push({ id, label: a.label, available: true, readOnly: a.readOnly, command: loadSettings().customCommand || '' }); continue; }
    const paths = await whereExe(a.bin);
    out.push({ id, label: a.label, available: paths.length > 0, path: paths.find((p) => /\.(exe|cmd|bat)$/i.test(p)) || paths[0] || null, readOnly: a.readOnly });
  }
  return out;
}

// .cmd/.bat shims (npm-installed CLIs) can only start through cmd.exe; args here are fixed strings, model names and our own paths.
function quoteArg(a) { return /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a; }
function spawnResolved(exe, args, opts) {
  if (/\.(cmd|bat)$/i.test(exe)) {
    return spawn('cmd.exe', ['/d', '/s', '/c', '"' + [exe, ...args].map(quoteArg).join(' ') + '"'], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(exe, args, opts);
}

// ---------------- run state ----------------
let current = null; // { id, dir, agent, mode, phase, startedAt, child, log: [] }

function newRunId() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + crypto.randomBytes(2).toString('hex'); }
function runDir(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Bad run id');
  return path.join(ROOT, id);
}
function pushLog(line) {
  if (!current) return;
  const text = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  current.log.push(...text.split(/\r?\n/).filter((l) => l.trim()));
  if (current.log.length > 400) current.log.splice(0, current.log.length - 400);
  fs.appendFile(path.join(current.dir, 'agent.log'), text.endsWith('\n') ? text : text + '\n', () => {});
}
function writeMeta(dir, meta) { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); }
function readMeta(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; } }

async function start({ agent, mode, model, customCommand }) {
  if (current && current.running) throw new Error('An AI scan is already running');
  const def = AGENTS[agent];
  if (!def) throw new Error('Unknown agent');
  mode = mode === 'deep' ? 'deep' : 'quick';
  if (model && !/^[\w.:\-/]{1,80}$/.test(model)) throw new Error('Model name contains unexpected characters');
  let exe = null;
  if (agent === 'custom') {
    if (typeof customCommand !== 'string' || !customCommand.trim()) throw new Error('Enter the command to run (it receives the prompt on stdin)');
    saveSettings({ ...loadSettings(), customCommand: customCommand.trim() });
  } else {
    const paths = await whereExe(def.bin);
    exe = paths.find((p) => /\.(exe|cmd|bat)$/i.test(p));
    if (!exe) throw new Error(`${def.label} (${def.bin}) was not found on PATH`);
  }
  const id = newRunId();
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  current = { id, dir, agent, mode, model: model || null, phase: 'collecting snapshot', startedAt: Date.now(), running: true, log: [] };
  const meta = { id, agent, agentLabel: def.label, mode, model: model || null, startedAt: current.startedAt, status: 'running' };
  writeMeta(dir, meta);

  (async () => {
    try {
      const snapDir = path.join(dir, 'snapshot');
      const index = await snapshot.build(snapDir, (p) => { current.phase = 'collecting snapshot: ' + p; });
      const prompt = buildPrompt({ mode, snapshotDir: snapDir, index, home: HOME });
      fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
      current.phase = `running ${def.label} (${mode})`;
      pushLog(`[manager] snapshot ready (${index.files.length} files). Starting ${def.label} in ${mode} mode. ${def.readOnly}`);
      const outFile = path.join(dir, 'last-message.txt');
      let child;
      if (agent === 'custom') {
        child = spawn('cmd.exe', ['/d', '/s', '/c', customCommand.trim()], { cwd: snapDir, windowsHide: true });
      } else {
        child = spawnResolved(exe, def.args({ mode, model, dir: snapDir, outFile }), { cwd: snapDir, windowsHide: true });
      }
      current.child = child;
      const stdout = [];
      child.stdout.on('data', (d) => { stdout.push(d); pushLog(d.toString('utf8')); });
      child.stderr.on('data', (d) => pushLog(d.toString('utf8')));
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      const timer = setTimeout(() => { pushLog('[manager] timed out - stopping agent'); killTree(child.pid); }, RUN_TIMEOUT_MS);
      const code = await new Promise((resolve) => { child.on('close', resolve); child.on('error', (e) => { pushLog('[manager] failed to start: ' + e.message); resolve(-1); }); });
      clearTimeout(timer);
      current.phase = 'parsing result';
      let text = Buffer.concat(stdout).toString('utf8');
      if (def.outputFile && fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8');
      fs.writeFileSync(path.join(dir, 'raw-output.txt'), text);
      if (current.cancelled) throw new Error('Cancelled by user');
      const yamlText = extractYaml(text);
      if (!yamlText) {
        const said = text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300);
        throw new Error(`The agent finished (exit ${code}) without a report.${said ? ' It said: "' + said + '"' : ''} See agent.log / raw-output.txt.`);
      }
      const result = normalize(YAML.parse(yamlText));
      fs.writeFileSync(path.join(dir, 'result.yaml'), yamlText);
      writeMeta(dir, { ...meta, status: 'done', finishedAt: Date.now(), exitCode: code, findings: result.findings.length, healthScore: result.summary.health_score });
      current.phase = 'done';
    } catch (e) {
      pushLog('[manager] ' + e.message);
      writeMeta(dir, { ...meta, status: current.cancelled ? 'cancelled' : 'error', finishedAt: Date.now(), error: e.message });
      current.phase = 'error: ' + e.message;
    } finally {
      current.running = false;
      current.child = null;
    }
  })();
  return { ok: true, id };
}

function killTree(pid) { if (pid) execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); }

function cancel() {
  if (!current || !current.running) throw new Error('No AI scan is running');
  current.cancelled = true;
  if (current.child) killTree(current.child.pid);
  return { ok: true };
}

function status() {
  if (!current) return { running: false };
  return { running: current.running, id: current.id, agent: current.agent, mode: current.mode, phase: current.phase, startedAt: current.startedAt, log: current.log.slice(-80) };
}

// ---------------- parsing & validation ----------------
function extractYaml(text) {
  const b = text.lastIndexOf(BEGIN);
  if (b >= 0) {
    const e = text.indexOf(END, b);
    let body = text.slice(b + BEGIN.length, e >= 0 ? e : undefined);
    body = body.replace(/^\s*```(?:ya?ml)?\s*\n/i, '').replace(/\n\s*```\s*$/i, '');
    return body.trim();
  }
  const fences = [...text.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)];
  if (fences.length) return fences[fences.length - 1][1].trim();
  if (/^\s*(schema:|summary:|findings:)/m.test(text)) return text.trim();
  return null;
}

const ENUMS = {
  category: ['storage', 'cleanup', 'startup', 'program', 'process', 'service', 'scheduled_task', 'browser_extension', 'registry', 'security', 'network', 'runtime', 'other'],
  verdict: ['safe_to_delete', 'review', 'keep', 'disable', 'uninstall', 'investigate'],
  priority: ['high', 'medium', 'low'],
  targetType: ['path', 'program', 'startup_entry', 'process', 'service', 'scheduled_task', 'browser_extension', 'registry', 'other'],
  action: ['move_to_trash', 'uninstall', 'disable_startup', 'end_process', 'open_extension_page', 'manual', 'none'],
};
const str = (v, max) => (v === undefined || v === null ? null : String(v).slice(0, max));
const pick = (v, list, dflt) => (list.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : dflt);
const int = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };

// Treat the agent's YAML as untrusted input: whitelist fields, clamp sizes, coerce enums.
function normalize(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('YAML did not contain a mapping');
  const s = doc.summary || {};
  const summary = {
    headline: str(s.headline, 400) || '', health_score: Math.min(100, int(s.health_score) ?? 0),
    overall_risk: pick(s.overall_risk, ['low', 'medium', 'high'], 'medium'),
    reclaimable_safe_bytes: int(s.reclaimable_safe_bytes), reclaimable_review_bytes: int(s.reclaimable_review_bytes),
    key_points: (Array.isArray(s.key_points) ? s.key_points : []).slice(0, 15).map((k) => str(k, 400)),
  };
  const seen = new Set();
  const findings = (Array.isArray(doc.findings) ? doc.findings : []).slice(0, 500).filter((f) => f && typeof f === 'object').map((f, i) => {
    let id = str(f.id, 40) || `F${String(i + 1).padStart(3, '0')}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    const t = f.target && typeof f.target === 'object' ? f.target : {};
    return {
      id, category: pick(f.category, ENUMS.category, 'other'), title: str(f.title, 300) || '(untitled)',
      verdict: pick(f.verdict, ENUMS.verdict, 'review'), priority: pick(f.priority, ENUMS.priority, 'medium'),
      target: {
        type: pick(t.type, ENUMS.targetType, 'other'), path: str(t.path, 1000), name: str(t.name, 300), pid: int(t.pid),
        browser: str(t.browser, 20), extension_id: str(t.extension_id, 100), registry_key: str(t.registry_key, 500),
      },
      size_bytes: int(f.size_bytes), reason: str(f.reason, 3000) || '',
      evidence: (Array.isArray(f.evidence) ? f.evidence : f.evidence ? [f.evidence] : []).slice(0, 20).map((e) => str(e, 600)),
      suggested_action: pick(f.suggested_action, ENUMS.action, 'manual'), manual_steps: str(f.manual_steps, 3000),
      purpose: str(f.purpose, 400), purpose_detail: str(f.purpose_detail, 3000), created_by: str(f.created_by, 200),
      owner_installed: pick(String(f.owner_installed), ['true', 'false', 'unknown'], 'unknown'), why_flagged: str(f.why_flagged, 2000),
    };
  });
  const purposes = (Array.isArray(doc.purposes) ? doc.purposes : []).slice(0, 1500).filter((x) => x && typeof x === 'object' && x.path).map((x) => ({
    path: str(x.path, 1000), short: str(x.short, 400) || '', detail: str(x.detail, 3000) || '', created_by: str(x.created_by, 200),
    category: pick(x.category, ['system', 'program', 'program_data', 'cache', 'temp', 'logs', 'user_files', 'dev_project', 'game', 'config', 'secrets', 'vm', 'unknown'], 'unknown'),
    criticality: pick(x.criticality, ['critical', 'important', 'normal', 'disposable'], 'normal'),
    owner_installed: pick(String(x.owner_installed), ['true', 'false', 'unknown'], 'unknown'),
    cleanup: pick(x.cleanup, ['keep', 'review', 'safe_to_delete'], 'keep'), reasoning: str(x.reasoning, 2000) || '',
  }));
  return { schema: str(doc.schema, 60), summary, findings, purposes };
}

// Per-path explanations from the most recent successful AI report, for the Storage/Cleanup views.
let purposeCache = { id: null, map: null };
function latestPurposes() {
  const run = listRuns().find((r) => r.status === 'done' && fs.existsSync(path.join(ROOT, r.id, 'result.yaml')));
  if (!run) return null;
  if (purposeCache.id === run.id) return purposeCache.map;
  const map = new Map();
  try {
    const res = normalize(YAML.parse(fs.readFileSync(path.join(ROOT, run.id, 'result.yaml'), 'utf8')));
    const src = { agent: run.agentLabel || run.agent, runId: run.id, at: run.finishedAt };
    for (const p of res.purposes) map.set(path.resolve(p.path).toLowerCase(), { ...p, ...src });
    for (const f of res.findings) {
      if (!f.target.path || !(f.purpose || f.why_flagged)) continue;
      const k = path.resolve(f.target.path).toLowerCase();
      const prev = map.get(k) || {};
      map.set(k, { path: f.target.path, short: prev.short || f.purpose || f.title, detail: prev.detail || f.purpose_detail || '', created_by: prev.created_by || f.created_by,
        criticality: prev.criticality, owner_installed: prev.owner_installed || f.owner_installed, cleanup: prev.cleanup || (f.verdict === 'safe_to_delete' ? 'safe_to_delete' : f.verdict === 'keep' ? 'keep' : 'review'),
        reasoning: [prev.reasoning, f.why_flagged || f.reason].filter(Boolean).join(' '), ...src });
    }
  } catch { /* unreadable report */ }
  purposeCache = { id: run.id, map };
  return map;
}

// ---------------- actions: map findings to real, guarded dashboard operations ----------------
async function resolveActions(findings) {
  const need = (a) => findings.some((f) => f.suggested_action === a);
  const [progs, start, brs, procs] = await Promise.all([
    need('uninstall') ? programs.programs(false).catch(() => null) : null,
    need('disable_startup') ? startup.list().catch(() => null) : null,
    need('open_extension_page') ? Promise.resolve(browsers.list()) : null,
    need('end_process') ? system.processes().catch(() => null) : null,
  ]);
  for (const f of findings) {
    const t = f.target;
    f.action = { kind: 'manual' };
    try {
      if (f.suggested_action === 'move_to_trash' && t.path && ['safe_to_delete', 'review'].includes(f.verdict)) {
        if (!fs.existsSync(t.path)) f.action = { kind: 'gone', why: 'Path no longer exists' };
        else { pctrash.assertTrashable(t.path); f.action = { kind: 'trash', path: path.resolve(t.path) }; }
      } else if (f.suggested_action === 'uninstall' && progs && t.name) {
        const n = t.name.toLowerCase();
        const p = progs.programs.find((x) => x.name.toLowerCase() === n) || progs.programs.find((x) => x.name.toLowerCase().includes(n) || n.includes(x.name.toLowerCase()));
        if (p && p.canUninstall) f.action = { kind: 'uninstall', id: p.id, name: p.name, programKind: p.kind };
      } else if (f.suggested_action === 'disable_startup' && start && t.name) {
        const e = start.items.find((x) => x.name.toLowerCase() === t.name.toLowerCase()) || start.items.find((x) => x.name.toLowerCase().includes(t.name.toLowerCase()));
        if (e) f.action = e.enabled ? { kind: 'disable_startup', source: e.source, name: e.name } : { kind: 'gone', why: 'Already disabled' };
      } else if (f.suggested_action === 'end_process' && procs && t.pid) {
        const p = procs.find((x) => x.pid === t.pid);
        if (!p) f.action = { kind: 'gone', why: 'Process is no longer running' };
        else if (!t.name || p.name.toLowerCase().startsWith(t.name.toLowerCase().replace(/\.exe$/, ''))) f.action = { kind: 'end_process', pid: p.pid, name: p.name };
      } else if (f.suggested_action === 'open_extension_page' && brs && t.extension_id) {
        for (const b of brs) for (const pr of b.profiles) if (pr.extensions.some((e) => e.id === t.extension_id)) {
          if (!t.browser || b.id === t.browser.toLowerCase() || b.name.toLowerCase().includes(t.browser.toLowerCase())) { f.action = { kind: 'extension', browser: b.id, profile: pr.dir, extId: b.engine === 'chromium' ? t.extension_id : '' }; }
        }
      }
    } catch (e) {
      f.action = { kind: 'blocked', why: e.message };
    }
  }
  return findings;
}

// ---------------- history / decisions / import ----------------
function listRuns() {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readMeta(path.join(ROOT, e.name))).filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function decisionsFile(id) { return path.join(runDir(id), 'decisions.json'); }
function loadDecisions(id) { try { return JSON.parse(fs.readFileSync(decisionsFile(id), 'utf8')); } catch { return {}; } }

async function getRun(id) {
  const dir = runDir(id);
  const meta = readMeta(dir);
  if (!meta) throw new Error('Run not found');
  if (!fs.existsSync(path.join(dir, 'result.yaml'))) return { meta, result: null };
  const result = normalize(YAML.parse(fs.readFileSync(path.join(dir, 'result.yaml'), 'utf8')));
  await resolveActions(result.findings);
  const decisions = loadDecisions(id);
  for (const f of result.findings) f.decision = decisions[f.id] || null;
  return { meta, result };
}

function setDecision(id, findingId, state) {
  if (!['done', 'dismissed', null].includes(state)) throw new Error('Bad state');
  const d = loadDecisions(id);
  if (state) d[findingId] = { state, at: Date.now() }; else delete d[findingId];
  fs.writeFileSync(decisionsFile(id), JSON.stringify(d, null, 2));
  return { ok: true };
}

function importYaml(text, source) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new Error('Paste the YAML (max 5 MB)');
  const yamlText = extractYaml(text) || text;
  const result = normalize(YAML.parse(yamlText));
  const id = newRunId();
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.yaml'), yamlText);
  writeMeta(dir, { id, agent: 'imported', agentLabel: source ? `Imported (${String(source).slice(0, 60)})` : 'Imported YAML', mode: 'import', startedAt: Date.now(), finishedAt: Date.now(), status: 'done', findings: result.findings.length, healthScore: result.summary.health_score });
  return { ok: true, id };
}

function readRunFile(id, name) {
  if (!['result.yaml', 'prompt.md', 'raw-output.txt', 'agent.log'].includes(name)) throw new Error('Not allowed');
  const p = path.join(runDir(id), name);
  if (!fs.existsSync(p)) throw new Error('Not available for this run');
  return fs.readFileSync(p, 'utf8');
}

// One self-contained text file (prompt + all snapshot data inline) for AIs without file access (web chat etc.).
async function bundle() {
  const dir = path.join(os.tmpdir(), 'manager-ai-bundle-' + Date.now());
  const index = await snapshot.build(dir);
  let text = buildPrompt({ mode: 'quick', snapshotDir: '(embedded below)', index, home: HOME })
    .replace('A system snapshot collected moments ago is in the current working directory ((embedded below)). Start by reading 00-INDEX.json, then the files you need:',
      'A system snapshot collected moments ago is embedded at the end of this message, one section per file:');
  text += '\n\n# Snapshot data\n';
  for (const f of ['00-INDEX.json', ...index.files.map((x) => x.name)]) text += `\n## ${f}\n\`\`\`json\n${fs.readFileSync(path.join(dir, f), 'utf8')}\n\`\`\`\n`;
  fs.rmSync(dir, { recursive: true, force: true });
  return text;
}

module.exports = { agents, start, cancel, status, listRuns, getRun, setDecision, importYaml, readRunFile, bundle, normalize, extractYaml, latestPurposes };
