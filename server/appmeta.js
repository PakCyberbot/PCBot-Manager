'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { execFileSync } = require('child_process');
const adb = require('./adb');

const DATA_DIR = path.join(__dirname, '..', 'data');
const META_FILE = path.join(DATA_DIR, 'app-metadata.json');
const ICON_DIR = path.join(__dirname, '..', 'cache', 'app-icons');
fs.mkdirSync(ICON_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function findAapt() {
  const sdkRoot = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'build-tools');
  if (!fs.existsSync(sdkRoot)) return null;
  const versions = fs.readdirSync(sdkRoot).sort().reverse();
  for (const v of versions) {
    const exe = path.join(sdkRoot, v, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
const AAPT_PATH = findAapt();

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

const DENSITY_ORDER = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'anydpi', 'nodpi'];

function pickBestDensity(entries, patternFn) {
  const matches = entries.filter((e) => patternFn(e.entryName));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const da = DENSITY_ORDER.findIndex((d) => a.entryName.includes(d));
    const db = DENSITY_ORDER.findIndex((d) => b.entryName.includes(d));
    return (da === -1 ? 999 : da) - (db === -1 ? 999 : db);
  });
  return matches[0];
}

function extractIcons(zip, pkg) {
  const entries = zip.getEntries();
  const bg = pickBestDensity(entries, (n) => /ic_launcher_background\.(png|webp)$/i.test(n));
  const fg = pickBestDensity(entries, (n) => /ic_launcher_foreground\.(png|webp)$/i.test(n));
  if (bg && fg) {
    fs.writeFileSync(path.join(ICON_DIR, `${pkg}-bg.png`), bg.getData());
    fs.writeFileSync(path.join(ICON_DIR, `${pkg}-fg.png`), fg.getData());
    return 'composite';
  }
  const flat = pickBestDensity(entries, (n) => /\/ic_launcher\.(png|webp)$/i.test(n) || /\/ic_launcher_round\.(png|webp)$/i.test(n));
  if (flat) {
    fs.writeFileSync(path.join(ICON_DIR, `${pkg}-flat.png`), flat.getData());
    return 'flat';
  }
  return 'none';
}

function extractLabel(apkPath) {
  if (!AAPT_PATH) return null;
  // aapt can exit non-zero on an unrelated resource-resolution warning (e.g. an icon
  // that lives in a split APK we didn't pull) while still having printed the label
  // we need to stdout first - so recover partial output from the thrown error too.
  let out = '';
  try {
    out = execFileSync(AAPT_PATH, ['dump', 'badging', apkPath], { maxBuffer: 1024 * 1024 * 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch (e) {
    out = e.stdout ? e.stdout.toString('utf8') : '';
  }
  const m = out.match(/^application-label:'([^']*)'/m);
  return m ? m[1] : null;
}

async function extractOne(pkg) {
  const pathsOut = await adb.shell(`pm path ${pkg}`);
  const lines = pathsOut.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('package:'));
  // Split APKs: pick base.apk. Some OEM-preloaded apps (e.g. /system/preloadapp/...) don't
  // use the base.apk/split_*.apk convention at all and just report a single APK path.
  const baseLine = lines.find((l) => l.includes('/base.apk')) || (lines.length === 1 ? lines[0] : null);
  if (!baseLine) throw new Error('No usable APK path found for ' + pkg);
  const remotePath = baseLine.replace(/^package:/, '').trim();
  const tmpApk = path.join(os.tmpdir(), `phone-manager-${pkg}.apk`);
  try {
    await adb.run(['pull', remotePath, tmpApk]);
    const label = extractLabel(tmpApk);
    let iconMode = 'none';
    try {
      const zip = new AdmZip(tmpApk);
      iconMode = extractIcons(zip, pkg);
    } catch { /* corrupt/odd zip - skip icon, keep label */ }
    return { label, iconMode, fetchedAt: Date.now(), error: null };
  } finally {
    fs.unlink(tmpApk, () => {});
  }
}

function getIconPath(pkg, layer) {
  const p = path.join(ICON_DIR, `${pkg}-${layer}.png`);
  return fs.existsSync(p) ? p : null;
}

function getAllMeta() {
  return loadMeta();
}

const job = { running: false, total: 0, done: 0, currentPkg: null, startedAt: null, lastError: null };

function getJobStatus() {
  return { ...job };
}

async function runRefreshJob(packages, force) {
  if (job.running) return;
  job.running = true;
  job.total = packages.length;
  job.done = 0;
  job.currentPkg = null;
  job.startedAt = Date.now();
  job.lastError = null;
  const meta = loadMeta();
  try {
    for (const pkg of packages) {
      job.currentPkg = pkg;
      if (!force && meta[pkg] && !meta[pkg].error) { job.done++; continue; }
      try {
        meta[pkg] = await extractOne(pkg);
      } catch (e) {
        meta[pkg] = { label: null, iconMode: 'none', fetchedAt: Date.now(), error: e.message };
        job.lastError = `${pkg}: ${e.message}`;
      }
      saveMeta(meta);
      job.done++;
    }
  } finally {
    job.running = false;
    job.currentPkg = null;
  }
}

module.exports = { getAllMeta, getIconPath, getJobStatus, runRefreshJob, AAPT_PATH };
