'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const disk = require('./disk');

const HOME = disk.HOME;
const TRASH_ROOT = disk.TRASH_ROOT;
const APP_DIR = path.resolve(__dirname, '..', '..');
const INDEX_FILE = path.join(APP_DIR, 'data', 'pc', 'trash-index.json');
fs.mkdirSync(TRASH_ROOT, { recursive: true });

const env = process.env;
// Exact folders that must never be trashed themselves (their contents are fine).
const PROTECTED_EXACT = [HOME, path.join(HOME, 'AppData'), env.LOCALAPPDATA, env.APPDATA, path.join(HOME, 'AppData', 'LocalLow'),
  path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads'), path.join(HOME, 'Pictures'),
  path.join(HOME, 'Videos'), path.join(HOME, 'Music'), path.join(HOME, 'OneDrive'), path.join(HOME, 'WORK'),
  path.join(env.LOCALAPPDATA || '', 'Temp')].filter(Boolean);
// Whole trees that are off limits (OS, installed programs, this app, the trash itself).
const PROTECTED_TREES = [env.WINDIR, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, TRASH_ROOT, APP_DIR,
  'C:\\$Recycle.Bin', 'C:\\System Volume Information', 'C:\\Recovery', 'C:\\Boot'].filter(Boolean);

function assertTrashable(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Expected an absolute path');
  const n = path.resolve(p);
  if (path.parse(n).root.toLowerCase() === n.toLowerCase()) throw new Error('Refusing to trash a drive root');
  for (const e of PROTECTED_EXACT) if (n.toLowerCase() === path.resolve(e).toLowerCase()) throw new Error(`${n} is a core user folder - trash what's inside it instead`);
  for (const t of PROTECTED_TREES) if (disk.isUnder(n, t)) throw new Error(`${n} is inside a protected location (${t})`);
  if (!fs.existsSync(n)) throw new Error('Not found: ' + n);
  return n;
}

function load() { try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return {}; } }
function save(idx) { fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2)); }

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else { try { total += (await fsp.lstat(full)).size; } catch { /* skip */ } }
    }
  }
  return total;
}

async function moveToTrash(paths) {
  const results = [];
  for (const p of paths) {
    try {
      const n = assertTrashable(p);
      const st = await fsp.lstat(n);
      const id = crypto.randomBytes(8).toString('hex');
      const holder = path.join(TRASH_ROOT, id);
      await fsp.mkdir(holder);
      const dest = path.join(holder, path.basename(n));
      try {
        await fsp.rename(n, dest);
      } catch (e) {
        await fsp.rmdir(holder).catch(() => {});
        if (e.code === 'EXDEV') throw new Error('This is on a different drive than the trash folder - nothing was moved');
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') throw new Error('In use or access denied - close the program using it and try again');
        throw e;
      }
      const known = st.isDirectory() ? disk.knownSize(n).size : st.size;
      const idx = load();
      idx[id] = { originalPath: n, trashPath: dest, deletedAt: Date.now(), isDir: st.isDirectory(), size: known };
      save(idx);
      disk.adjustForMove(n, known, true);
      if (known === null && st.isDirectory()) {
        dirSize(dest).then((size) => { const i2 = load(); if (i2[id]) { i2[id].size = size; save(i2); } });
      }
      results.push({ path: n, ok: true, id });
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  return results;
}

function list() {
  const idx = load();
  return Object.entries(idx).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.deletedAt - a.deletedAt);
}

async function restore(id) {
  const idx = load();
  const e = idx[id];
  if (!e) throw new Error('Not in trash');
  let dest = e.originalPath;
  if (fs.existsSync(dest)) {
    const ext = path.extname(dest);
    const base = ext && !e.isDir ? dest.slice(0, -ext.length) : dest;
    dest = `${base} (restored ${new Date().toISOString().slice(0, 10)})${e.isDir ? '' : ext}`;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(e.trashPath, dest);
  await fsp.rmdir(path.dirname(e.trashPath)).catch(() => {});
  delete idx[id];
  save(idx);
  disk.adjustForMove(dest, e.size, false);
  return { ok: true, restoredTo: dest };
}

async function deleteForever(id) {
  const idx = load();
  const e = idx[id];
  if (!e) throw new Error('Not in trash');
  const holder = path.dirname(e.trashPath);
  if (!disk.isUnder(holder, TRASH_ROOT) || path.resolve(holder) === path.resolve(TRASH_ROOT)) throw new Error('Refusing to delete outside the trash folder');
  await fsp.rm(holder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  delete idx[id];
  save(idx);
  return { ok: true, freed: e.size };
}

async function empty() {
  let freed = 0; let count = 0; const errors = [];
  for (const e of list()) {
    try { const r = await deleteForever(e.id); freed += r.freed || 0; count++; } catch (err) { errors.push(`${e.originalPath}: ${err.message}`); }
  }
  return { ok: errors.length === 0, count, freed, errors };
}

module.exports = { moveToTrash, list, restore, deleteForever, empty, assertTrashable, TRASH_ROOT };
