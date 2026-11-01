'use strict';
// archiver 8 is ESM-only and is loaded with require(), which Node supports from 22.12 (20.19 on the 20.x line).
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 19) || (maj === 21) || (maj === 22 && min < 12)) {
    console.error(`Node.js ${process.versions.node} is too old. Install Node.js 22.12 or newer (LTS): https://nodejs.org`);
    process.exit(1);
  }
}
// Disk scans stat millions of files; libuv's default 4-thread pool bottlenecks that.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';
const express = require('express');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = require('path').posix;
const crypto = require('crypto');

const adb = require('./adb');
const trash = require('./trash');
const appmeta = require('./appmeta');
const { mimeFor, kindFor } = require('./mime');

const PORT = process.env.PORT || 4321;
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'thumbs');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const upload = multer({ dest: path.join(os.tmpdir(), 'phone-manager-uploads') });
const app = express();

// Any website open in the browser can fire simple cross-origin form POSTs at localhost,
// and DNS rebinding can make a hostile domain resolve to 127.0.0.1. Rejecting foreign
// Host headers stops rebinding; requiring a custom header on mutating requests forces a
// CORS preflight that this server never approves, so cross-site POSTs are refused.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).send('Forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Manager') !== '1') {
    return res.status(403).json({ error: 'Missing X-Manager header' });
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function wrap(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message });
  });
}

// ---------- device ----------
app.post('/api/device/reconnect', wrap(async (req, res) => {
  const serial = await adb.detectDevice();
  await adb.mkdirp(adb.TRASH_ROOT).catch(() => {});
  res.json({ ok: true, serial });
}));

app.get('/api/device', wrap(async (req, res) => {
  const info = await adb.getDeviceInfo();
  res.json(info);
}));

// ---------- listing ----------
app.get('/api/list', wrap(async (req, res) => {
  const dirPath = req.query.path || adb.ROOT;
  const items = (await adb.listDir(dirPath)).filter((i) => i.path !== adb.TRASH_ROOT);
  items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  res.json({ path: adb.safeDevicePath(dirPath), items });
}));

// ---------- quick folders ----------
app.get('/api/quick-folders', wrap(async (req, res) => {
  const candidates = [
    { key: 'photos', label: 'Photos', paths: ['/sdcard/DCIM', '/sdcard/Pictures'] },
    { key: 'videos', label: 'Videos', paths: ['/sdcard/Movies', '/sdcard/DCIM/Camera'] },
    { key: 'downloads', label: 'Downloads', paths: ['/sdcard/Download'] },
    { key: 'audio', label: 'Audio', paths: ['/sdcard/Music', '/sdcard/Recordings'] },
    { key: 'documents', label: 'Documents', paths: ['/sdcard/Documents'] },
    { key: 'whatsapp', label: 'WhatsApp Media', paths: ['/sdcard/Android/media/com.whatsapp/WhatsApp/Media'] },
    { key: 'localsend', label: 'LocalSend', paths: ['/sdcard/Localsend'] },
  ];
  const results = [];
  for (const c of candidates) {
    for (const p of c.paths) {
      if (await adb.exists(p)) { results.push({ key: c.key, label: c.label, path: p }); break; }
    }
  }
  res.json(results);
}));

// ---------- thumbnail (images only; cached locally) ----------
app.get('/api/thumb', wrap(async (req, res) => {
  const p = adb.safeDevicePath(req.query.path);
  const kind = kindFor(p);
  if (kind !== 'image') return res.status(204).end();
  const mtime = req.query.mtime || '0';
  const key = crypto.createHash('sha1').update(p + '|' + mtime).digest('hex');
  const cachePath = path.join(CACHE_DIR, key + path.extname(p).toLowerCase());
  if (fs.existsSync(cachePath)) {
    res.setHeader('Content-Type', mimeFor(p));
    return fs.createReadStream(cachePath).pipe(res);
  }
  const child = adb.pullStream(p);
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.on('error', (e) => res.status(500).json({ error: e.message }));
  child.on('close', (code) => {
    if (code !== 0 || chunks.length === 0) return res.status(404).end();
    const buf = Buffer.concat(chunks);
    fs.writeFile(cachePath, buf, () => {});
    res.setHeader('Content-Type', mimeFor(p));
    res.end(buf);
  });
}));

// ---------- stream / download a single file ----------
app.get('/api/file', wrap(async (req, res) => {
  const p = adb.safeDevicePath(req.query.path);
  const name = posix.basename(p);
  const asDownload = req.query.download === '1';
  res.setHeader('Content-Type', mimeFor(name));
  if (asDownload) res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  const child = adb.pullStream(p);
  child.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  child.stdout.pipe(res);
}));

// ---------- zip download of multiple paths ----------
app.post('/api/download-zip', wrap(async (req, res) => {
  const paths = (req.body.paths || []).map(adb.safeDevicePath);
  if (paths.length === 0) return res.status(400).json({ error: 'No paths given' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="phone-files.zip"');
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(res);
  for (const p of paths) {
    const items = (await adb.listDir(posix.dirname(p)).catch(() => [])).filter((i) => i.path === p);
    const isDir = items[0]?.isDir;
    if (isDir) {
      await addDirToArchive(archive, p, posix.basename(p));
    } else {
      await addFileToArchive(archive, p, posix.basename(p));
    }
  }
  await archive.finalize();
}));

function addFileToArchive(archive, devicePath, entryName) {
  return new Promise((resolve) => {
    const child = adb.pullStream(devicePath);
    archive.append(child.stdout, { name: entryName });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

async function addDirToArchive(archive, devicePath, entryPrefix) {
  const items = await adb.listDir(devicePath).catch(() => []);
  for (const item of items) {
    const entryName = entryPrefix + '/' + item.name;
    if (item.isDir) {
      await addDirToArchive(archive, item.path, entryName);
    } else {
      await addFileToArchive(archive, item.path, entryName);
    }
  }
}

// ---------- upload ----------
app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  const destDir = adb.safeDevicePath(req.query.path || adb.ROOT);
  const results = [];
  for (const f of req.files || []) {
    const dest = posix.join(destDir, f.originalname);
    try {
      await adb.pushFile(f.path, dest);
      results.push({ name: f.originalname, ok: true });
    } catch (e) {
      results.push({ name: f.originalname, ok: false, error: e.message });
    } finally {
      fs.unlink(f.path, () => {});
    }
  }
  res.json({ results });
}));

// ---------- mkdir ----------
app.post('/api/mkdir', wrap(async (req, res) => {
  const parent = adb.safeDevicePath(req.body.path);
  const name = String(req.body.name || '').trim();
  if (!name || /[\/]/.test(name)) return res.status(400).json({ error: 'Invalid folder name' });
  await adb.mkdirp(posix.join(parent, name));
  res.json({ ok: true });
}));

// ---------- rename ----------
app.post('/api/rename', wrap(async (req, res) => {
  const p = adb.safeDevicePath(req.body.path);
  const newName = String(req.body.newName || '').trim();
  if (!newName || /[\/]/.test(newName)) return res.status(400).json({ error: 'Invalid name' });
  const dest = posix.join(posix.dirname(p), newName);
  await adb.move(p, dest);
  res.json({ ok: true, path: dest });
}));

// ---------- move ----------
app.post('/api/move', wrap(async (req, res) => {
  const paths = (req.body.paths || []).map(adb.safeDevicePath);
  const destDir = adb.safeDevicePath(req.body.destDir);
  for (const p of paths) {
    await adb.move(p, posix.join(destDir, posix.basename(p)));
  }
  res.json({ ok: true });
}));

// ---------- trash (soft delete) ----------
app.post('/api/trash', wrap(async (req, res) => {
  const paths = (req.body.paths || []).map(adb.safeDevicePath);
  const entries = [];
  for (const p of paths) {
    const items = await adb.listDir(posix.dirname(p)).catch(() => []);
    const meta = items.find((i) => i.path === p);
    const trashId = crypto.randomBytes(8).toString('hex');
    const trashPath = posix.join(adb.TRASH_ROOT, `${trashId}__${posix.basename(p)}`);
    await adb.move(p, trashPath);
    const entry = {
      originalPath: p,
      trashPath,
      deletedAt: Date.now(),
      size: meta?.size || 0,
      isDir: meta?.isDir || false,
    };
    const id = trash.addEntry(entry);
    entries.push({ id, ...entry });
  }
  res.json({ ok: true, entries });
}));

app.get('/api/trash', wrap(async (req, res) => {
  res.json(trash.listEntries());
}));

app.post('/api/trash/:id/restore', wrap(async (req, res) => {
  const entry = trash.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found in trash index' });
  let dest = entry.originalPath;
  if (await adb.exists(dest)) {
    const ext = posix.extname(dest);
    const base = ext ? dest.slice(0, -ext.length) : dest;
    dest = `${base} (restored ${Date.now()})${ext}`;
  }
  await adb.move(entry.trashPath, dest);
  trash.removeEntry(req.params.id);
  res.json({ ok: true, restoredTo: dest });
}));

app.post('/api/trash/:id/delete', wrap(async (req, res) => {
  const entry = trash.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found in trash index' });
  if (!entry.trashPath.startsWith(adb.TRASH_ROOT)) return res.status(400).json({ error: 'Refusing to delete outside trash root' });
  await adb.removeRecursive(entry.trashPath);
  trash.removeEntry(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/trash/empty', wrap(async (req, res) => {
  const entries = trash.listEntries();
  for (const e of entries) {
    if (e.trashPath.startsWith(adb.TRASH_ROOT)) {
      await adb.removeRecursive(e.trashPath).catch(() => {});
      trash.removeEntry(e.id);
    }
  }
  res.json({ ok: true, removed: entries.length });
}));

// ---------- apps + security ----------
app.get('/api/apps', wrap(async (req, res) => {
  res.json(await adb.getAppsWithUsage(req.query.refresh === '1'));
}));

app.post('/api/apps/:pkg/uninstall', wrap(async (req, res) => {
  await adb.uninstallApp(req.params.pkg);
  res.json({ ok: true });
}));

// ---------- app display name / icon metadata ----------
app.get('/api/apps/metadata', wrap(async (req, res) => {
  res.json(appmeta.getAllMeta());
}));

app.get('/api/apps/metadata/status', wrap(async (req, res) => {
  res.json(appmeta.getJobStatus());
}));

app.post('/api/apps/metadata/refresh', wrap(async (req, res) => {
  if (!appmeta.AAPT_PATH) return res.status(400).json({ error: 'aapt not found (Android SDK build-tools) - cannot extract app names/icons' });
  const status = appmeta.getJobStatus();
  if (status.running) return res.json({ ok: true, alreadyRunning: true });
  const data = await adb.getAppsWithUsage(false);
  const packages = data.apps.map((a) => a.package);
  appmeta.runRefreshJob(packages, req.body.force === true).catch((e) => console.error('metadata refresh job failed:', e));
  res.json({ ok: true, total: packages.length });
}));

app.get('/api/apps/:pkg/icon/:layer', wrap(async (req, res) => {
  const p = appmeta.getIconPath(req.params.pkg, req.params.layer);
  if (!p) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'max-age=86400');
  fs.createReadStream(p).pipe(res);
}));

app.get('/api/security', wrap(async (req, res) => {
  res.json(await adb.getSecurityReport());
}));

// ---------- This PC ----------
require('./pc/routes')(app, wrap);

// ---------- startup ----------
async function main() {
  try {
    const serial = await adb.detectDevice();
    console.log(`Phone connected (${serial}).`);
    await adb.mkdirp(adb.TRASH_ROOT).catch((e) => console.error('Could not create the trash folder on the phone:', e.message));
  } catch (e) {
    // The phone is optional; adb may not even be installed.
    console.log(e.code === 'ENOENT' ? 'No adb found - phone features are off (optional).' : 'No Android phone connected - phone features are off until you connect one (optional).');
  }
  require('./pc/purpose').prewarm();
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`PCBot Manager running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use - is PCBot Manager already running? Or start it on another port: $env:PORT=5000; npm start` : e.message);
    process.exit(1);
  });
}

main();
