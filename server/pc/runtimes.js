'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const disk = require('./disk');

const HOME = disk.HOME;
const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;

function exec(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err ? err.code : 0 });
    });
  });
}
// .cmd/.bat shims (npm, code, az...) can only be started through cmd.exe; command strings here are constants.
const cmd = (line, timeout) => exec('cmd.exe', ['/d', '/s', '/c', line], timeout);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; }
}

// ---------------- Python ----------------
async function discoverPythons() {
  const cands = []; // {exe, source, project?}
  const add = (exe, source, extra = {}) => { if (exe && fs.existsSync(exe)) cands.push({ exe: path.resolve(exe), source, ...extra }); };

  const py = await exec('py', ['-0p']);
  for (const line of py.out.split(/\r?\n/)) {
    const m = line.match(/-V:(\S+)\s+\*?\s*(.+\.exe)\s*$/i);
    if (m) add(m[2].trim(), 'Python launcher (py)', { tag: m[1] });
  }
  const where = await exec('where.exe', ['python']);
  const pathOrder = where.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const p of pathOrder) if (!/\\WindowsApps\\/i.test(p)) add(p, 'On PATH');

  add(path.join(HOME, 'anaconda3', 'python.exe'), 'Anaconda (base)');
  add(path.join(HOME, 'miniconda3', 'python.exe'), 'Miniconda (base)');
  for (const d of [...listDirs(path.join(HOME, 'anaconda3', 'envs')), ...listDirs(path.join(HOME, 'miniconda3', 'envs'))]) add(path.join(d, 'python.exe'), 'conda env');
  for (const d of [...listDirs(path.join(ROAMING, 'uv', 'python')), ...listDirs(path.join(LOCAL, 'uv', 'python'))]) add(path.join(d, 'python.exe'), 'uv-managed');
  for (const d of listDirs(path.join(LOCAL, 'Python'))) if (/pythoncore/i.test(d)) add(path.join(d, 'python.exe'), 'Python install manager');
  for (const d of listDirs(path.join(LOCAL, 'Programs', 'Python'))) add(path.join(d, 'python.exe'), 'python.org installer');
  for (const d of listDirs(path.join(HOME, '.pyenv', 'pyenv-win', 'versions'))) add(path.join(d, 'python.exe'), 'pyenv-win');
  for (const d of listDirs('C:\\')) if (/^python\d+/i.test(path.basename(d))) add(path.join(d, 'python.exe'), 'System-wide install');

  const scan = disk.results();
  if (scan) for (const a of scan.artifacts.filter((x) => x.kind === 'venv')) add(path.join(a.path, 'Scripts', 'python.exe'), 'venv', { project: a.project, venvSize: a.size });

  const seen = new Map();
  for (const c of cands) {
    const k = c.exe.toLowerCase();
    if (!seen.has(k)) seen.set(k, c); else if (!seen.get(k).project && c.project) Object.assign(seen.get(k), c);
  }
  const defaultExe = pathOrder.find((p) => !/\\WindowsApps\\/i.test(p));
  const probe = 'import sys,json;print(json.dumps({"v":sys.version.split()[0],"prefix":sys.prefix,"base":sys.base_prefix,"bits":64 if sys.maxsize>2**32 else 32}))';
  const list = await mapLimit([...seen.values()], 6, async (c) => {
    const r = await exec(c.exe, ['-c', probe], 15000);
    let info = null;
    try { info = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* broken interpreter */ }
    const prefix = info ? info.prefix : path.dirname(c.exe);
    const known = disk.knownSize(prefix);
    return {
      exe: c.exe, source: c.source, tag: c.tag || null, project: c.project || null,
      version: info ? info.v : null, prefix, basePrefix: info ? info.base : null, bits: info ? info.bits : null,
      isVenv: !!(info && info.prefix !== info.base) || c.source === 'venv',
      isDefault: defaultExe ? defaultExe.toLowerCase() === c.exe.toLowerCase() : false,
      broken: !info, size: c.venvSize || known.size,
    };
  });
  return {
    interpreters: list.sort((a, b) => (a.isVenv - b.isVenv) || String(b.version).localeCompare(String(a.version), undefined, { numeric: true })),
    aliasStubs: pathOrder.filter((p) => /\\WindowsApps\\/i.test(p)),
  };
}

async function pythonPackages(exe) {
  if (typeof exe !== 'string' || !/python(w)?(\d+(\.\d+)?)?\.exe$/i.test(exe) || !fs.existsSync(exe)) throw new Error('Not a python executable');
  const r = await exec(exe, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], 60000);
  if (!r.ok) throw new Error((r.err || r.out).trim().split(/\r?\n/).pop() || 'pip failed');
  return JSON.parse(r.out);
}

// ---------------- Node ----------------
async function discoverNode() {
  const nvm = await exec('nvm', ['list']);
  const versions = [];
  for (const line of nvm.out.split(/\r?\n/)) {
    const m = line.match(/(\*)?\s*(\d+\.\d+\.\d+)/);
    if (m) versions.push({ version: m[2], current: !!m[1] });
  }
  const root = (await exec('nvm', ['root'])).out.match(/:\s*(.+)$/m);
  const nvmRoot = root ? root[1].trim() : null;
  for (const v of versions) {
    const dir = nvmRoot ? path.join(nvmRoot, 'v' + v.version) : null;
    v.path = dir && fs.existsSync(dir) ? dir : null;
    v.size = v.path ? disk.knownSize(v.path).size : null;
  }
  const where = (await exec('where.exe', ['node'])).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { manager: versions.length ? 'nvm-windows' : null, nvmRoot, versions, activeNode: where[0] || null };
}

async function npmGlobals() {
  const r = await cmd('npm ls -g --depth=0 --json', 60000);
  const j = JSON.parse(r.out || '{}');
  return Object.entries(j.dependencies || {}).map(([name, v]) => ({ name, version: v.version }));
}

// ---------------- other toolchains ----------------
const TOOLS = [
  ['Git', 'git', '--version'], ['GitHub CLI', 'gh', '--version'], ['Node.js', 'node', '--version'], ['npm', 'npm', '--version'],
  ['pnpm', 'pnpm', '--version'], ['Yarn', 'yarn', '--version'], ['Bun', 'bun', '--version'], ['Deno', 'deno', '--version'],
  ['uv', 'uv', '--version'], ['pipx', 'pipx', '--version'], ['conda', 'conda', '--version'], ['Java', 'java', '-version'],
  ['javac', 'javac', '-version'], ['Maven', 'mvn', '-v'], ['Gradle', 'gradle', '--version'], ['Go', 'go', 'version'],
  ['Rust (rustc)', 'rustc', '--version'], ['Cargo', 'cargo', '--version'], ['.NET', 'dotnet', '--version'], ['GCC', 'gcc', '--version'],
  ['CMake', 'cmake', '--version'], ['PHP', 'php', '--version'], ['Ruby', 'ruby', '--version'], ['Perl', 'perl', '--version'],
  ['Docker', 'docker', '--version'], ['kubectl', 'kubectl', 'version --client'], ['Terraform', 'terraform', 'version'],
  ['AWS CLI', 'aws', '--version'], ['Azure CLI', 'az', 'version'], ['gcloud', 'gcloud', '--version'], ['adb', 'adb', 'version'],
  ['ffmpeg', 'ffmpeg', '-version'], ['Ollama', 'ollama', '--version'], ['VS Code', 'code', '--version'], ['Claude Code', 'claude', '--version'],
  ['Codex CLI', 'codex', '--version'], ['scoop', 'scoop', '--version'], ['winget', 'winget', '--version'], ['Chocolatey', 'choco', '--version'],
  ['WSL', 'wsl', '--version'], ['Nmap', 'nmap', '--version'], ['sqlmap', 'sqlmap', '--version'], ['Frida', 'frida', '--version'],
];

async function discoverTools() {
  return mapLimit(TOOLS, 8, async ([name, bin, args]) => {
    const w = await exec('where.exe', [bin], 5000);
    const paths = w.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!paths.length) return { name, bin, installed: false };
    const r = await cmd(`${bin} ${args}`, 15000);
    // wsl.exe prints UTF-16; strip NULs so the version regex can match.
    const text = (r.out + '\n' + r.err).replace(/\u0000/g, '');
    const m = text.match(/version\s+"(\d[\w.\-+]*)"/i) || text.match(/\d+\.\d+(\.\d+)?([.\-+][\w.]+)?/);
    if (m && m[1] && /^version/i.test(m[0])) m[0] = m[1];
    return { name, bin, installed: true, version: m ? m[0] : null, path: paths[0], allPaths: paths, firstLine: text.trim().split(/\r?\n/)[0].slice(0, 160) };
  });
}

let cache = { at: 0, data: null };
async function inventory(force) {
  if (!force && cache.data && Date.now() - cache.at < 10 * 60 * 1000) return cache.data;
  const [python, node, tools] = await Promise.all([discoverPythons(), discoverNode(), discoverTools()]);
  const javaHomes = [...listDirs(path.join(process.env.ProgramFiles, 'Java')), ...listDirs(path.join(process.env.ProgramFiles, 'Eclipse Adoptium')),
    path.join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr')].filter((d) => fs.existsSync(path.join(d, 'bin', 'java.exe')));
  const data = { python, node, java: javaHomes.map((d) => ({ path: d, size: disk.knownSize(d).size })), tools, generatedAt: Date.now() };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { inventory, pythonPackages, npmGlobals };
