'use strict';
const fs = require('fs');
const path = require('path');
const { psJson, arr } = require('./ps');
const programs = require('./programs');

const HOME = require('os').homedir();
const FAV_FILE = path.join(__dirname, '..', '..', 'data', 'pc', 'favorites.json');
const LAUNCHABLE = /\.(exe|lnk|bat|cmd|jar|py|ps1|sh|url)$/i;

function readDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Best guess at the "main" entry point inside a tool folder (searches 2 levels deep).
function findEntryPoints(dir, toolName) {
  const found = [];
  const walk = (d, depth) => {
    for (const e of readDir(d)) {
      const full = path.join(d, e.name);
      const skipDir = /^(\.git|node_modules|__pycache__|\.?venv|.*-?env|scripts|site-packages|lib|libs|jre|docs?|tests?|resources|plugins)$/i.test(e.name)
        || fs.existsSync(path.join(full, 'pyvenv.cfg'));
      if (e.isDirectory() && depth < 2 && !skipDir) walk(full, depth + 1);
      else if (e.isFile() && LAUNCHABLE.test(e.name) && !/^(uninst|unins\d|setup|install|update)/i.test(e.name)) found.push({ path: full, depth });
    }
  };
  walk(dir, 0);
  const key = toolName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const score = (f) => {
    const n = path.basename(f.path).toLowerCase();
    let s = 10 - f.depth * 3;
    if (key && n.replace(/[^a-z0-9]/g, '').includes(key)) s += 10;
    if (/\.(exe|lnk)$/.test(n)) s += 4; else if (/\.(bat|cmd)$/.test(n)) s += 3; else if (/\.jar$/.test(n)) s += 2;
    if (/(cli|console|debug|helper|crash|test)/.test(n)) s -= 3;
    return s;
  };
  return found.sort((a, b) => score(b) - score(a)).slice(0, 4).map((f) => f.path);
}

async function startMenuApps() {
  const items = arr(await psJson(`
$shell = New-Object -ComObject WScript.Shell
$roots = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")
$out = foreach ($r in $roots) { Get-ChildItem -LiteralPath $r -Recurse -Include *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
  $t = $null; $a = $null; try { $sc = $shell.CreateShortcut($_.FullName); $t = $sc.TargetPath; $a = $sc.Arguments } catch {}
  [pscustomobject]@{ name=$_.BaseName; lnk=$_.FullName; target=[string]$t; args=[string]$a; group=[string]((Split-Path $_.DirectoryName -Leaf) -replace '^Programs$','') } } }
ConvertTo-Json @($out) -Compress`, { timeoutMs: 60000 }));
  const seen = new Set();
  return items
    .filter((i) => !/uninstall|readme|help|license|release notes|website|documentation|manual/i.test(i.name))
    .filter((i) => !i.target || !/\.(txt|chm|html?|pdf|url)$/i.test(i.target))
    .filter((i) => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((i) => ({ name: i.name, path: i.lnk, folder: i.target && fs.existsSync(i.target) ? path.dirname(i.target) : path.dirname(i.lnk),
      iconFile: i.target && fs.existsSync(i.target) ? i.target : i.lnk, source: 'Start menu', group: i.group || 'Apps', kind: 'app' }));
}

function cyberTools() {
  const root = path.join(HOME, 'CyberTools');
  return readDir(root).filter((e) => e.name !== 'desktop.ini').map((e) => {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const entries = findEntryPoints(full, e.name);
      return { name: e.name, path: entries[0] || full, entries, folder: full, iconFile: entries.find((x) => /\.exe$/i.test(x)) || null,
        source: 'CyberTools', group: 'CyberTools', kind: entries[0] && /\.(exe|lnk|bat|cmd|jar)$/i.test(entries[0]) ? 'app' : 'folder' };
    }
    return { name: e.name, path: full, entries: [full], folder: root, iconFile: null, source: 'CyberTools', group: 'CyberTools', kind: 'script' };
  });
}

function scoopApps() {
  const appsDir = path.join(HOME, 'scoop', 'apps');
  return readDir(appsDir).filter((e) => e.isDirectory() && e.name !== 'scoop').map((e) => {
    const cur = path.join(appsDir, e.name, 'current');
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(cur, 'manifest.json'), 'utf8')).version; } catch { /* no manifest */ }
    const entries = findEntryPoints(cur, e.name);
    return { name: e.name, version, path: entries[0] || cur, entries, folder: cur, iconFile: entries.find((x) => /\.exe$/i.test(x)) || null,
      source: 'scoop', group: 'CLI tools (scoop)', kind: 'cli', command: e.name };
  });
}

function shimDir(dir, source, group) {
  const names = new Map();
  for (const e of readDir(dir)) {
    if (!e.isFile() || !/\.(exe|cmd|bat|ps1)$/i.test(e.name)) continue;
    const base = e.name.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (!names.has(base.toLowerCase())) names.set(base.toLowerCase(), { name: base, path: path.join(dir, e.name), entries: [path.join(dir, e.name)],
      folder: dir, iconFile: /\.exe$/i.test(e.name) ? path.join(dir, e.name) : null, source, group, kind: 'cli', command: base });
  }
  return [...names.values()];
}

function scripts() {
  const dir = path.join(HOME, 'SCRIPTS');
  return readDir(dir).filter((e) => e.isFile()).map((e) => ({ name: e.name, path: path.join(dir, e.name), entries: [path.join(dir, e.name)], folder: dir,
    iconFile: null, source: 'SCRIPTS', group: 'My scripts (on PATH)', kind: /\.(bat|cmd)$/i.test(e.name) ? 'cli' : 'script', command: e.name.replace(/\.(bat|cmd)$/i, '') }));
}

function loadFavs() { try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { return []; } }

async function catalog() {
  const [start] = await Promise.all([startMenuApps()]);
  const all = [...start, ...cyberTools(), ...scoopApps(), ...scripts(),
    ...shimDir(path.join(HOME, '.local', 'bin'), '.local/bin', 'CLI tools (.local/bin)'),
    ...shimDir(path.join(process.env.APPDATA, 'npm'), 'npm global', 'CLI tools (npm global)')];
  await programs.ensureIcons(all.map((t) => t.iconFile)).catch(() => {});
  const favs = new Set(loadFavs().map((f) => f.toLowerCase()));
  for (const t of all) {
    t.iconKey = t.iconFile ? programs.iconKey(t.iconFile) : null;
    t.favorite = favs.has(t.path.toLowerCase());
    delete t.iconFile;
  }
  return all;
}

function toggleFavorite(p, on) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Bad path');
  const favs = loadFavs().filter((f) => f.toLowerCase() !== p.toLowerCase());
  if (on) favs.push(p);
  fs.writeFileSync(FAV_FILE, JSON.stringify(favs, null, 2));
  return { ok: true, favorites: favs };
}

module.exports = { catalog, toggleFavorite };
