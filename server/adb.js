'use strict';
const { spawn } = require('child_process');
const posix = require('path').posix;

const ROOT = '/sdcard';
const TRASH_ROOT = '/sdcard/.manager_trash';

let cachedSerial = null;

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = cachedSerial ? ['-s', cachedSerial, ...args] : args;
    const child = spawn('adb', fullArgs, { windowsHide: true, ...opts });
    let stdout = [];
    let stderr = [];
    if (child.stdout) child.stdout.on('data', (d) => stdout.push(d));
    if (child.stderr) child.stderr.on('data', (d) => stderr.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`adb ${args.join(' ')} exited ${code}: ${err.trim()}`));
      } else {
        resolve({ stdout: out, stderr: err });
      }
    });
  });
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

async function shell(cmd) {
  const { stdout } = await run(['shell', cmd]);
  return stdout.toString('utf8').replace(/\r\n/g, '\n');
}

async function detectDevice() {
  const { stdout } = await run(['devices', '-l']);
  const lines = stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const deviceLines = lines.slice(1).filter((l) => / device /.test(l) || l.endsWith(' device'));
  if (deviceLines.length === 0) throw new Error('No authorized Android device found via adb. Plug in the phone, enable USB debugging, and accept the RSA prompt on the device.');
  const serial = deviceLines[0].split(/\s+/)[0];
  cachedSerial = serial;
  return serial;
}

function safeDevicePath(p) {
  if (!p || typeof p !== 'string') throw new Error('Invalid path');
  let norm = posix.normalize('/' + p.replace(/^\/+/, ''));
  if (norm !== ROOT && !norm.startsWith(ROOT + '/')) {
    throw new Error('Path must be inside /sdcard');
  }
  return norm;
}

// List immediate children of a directory. Returns [{name, path, isDir, isLink, size, mtime}]
async function listDirTyped(dirPath) {
  const p = safeDevicePath(dirPath);
  const q = shellQuote(p);
  const cmd = `find -L ${q} -maxdepth 1 -mindepth 1 -type f -printf 'F|%s|%T@|%p\\n' 2>/dev/null; find -L ${q} -maxdepth 1 -mindepth 1 -type d -printf 'D|0|%T@|%p\\n' 2>/dev/null`;
  const out = await shell(cmd);
  const items = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const kind = parts[0];
    const size = parseInt(parts[1], 10) || 0;
    const mtimeEpoch = parseFloat(parts[2]);
    const fullPath = parts.slice(3).join('|');
    items.push({
      name: posix.basename(fullPath),
      path: fullPath,
      isDir: kind === 'D',
      isLink: kind === 'L',
      size,
      mtime: isFinite(mtimeEpoch) ? Math.round(mtimeEpoch * 1000) : null,
    });
  }
  return items;
}

async function mkdirp(dirPath) {
  const p = safeDevicePath(dirPath);
  await shell(`mkdir -p ${shellQuote(p)}`);
}

async function move(srcPath, destPath) {
  const s = safeDevicePath(srcPath);
  const d = safeDevicePath(destPath);
  await mkdirp(posix.dirname(d));
  await shell(`mv ${shellQuote(s)} ${shellQuote(d)}`);
}

async function removeRecursive(targetPath) {
  const p = safeDevicePath(targetPath);
  if (p === ROOT) throw new Error('Refusing to remove storage root');
  await shell(`rm -r ${shellQuote(p)}`);
}

async function exists(targetPath) {
  const p = safeDevicePath(targetPath);
  const out = await shell(`[ -e ${shellQuote(p)} ] && echo 1 || echo 0`);
  return out.trim() === '1';
}

function pullStream(devicePath) {
  const p = safeDevicePath(devicePath);
  const args = cachedSerial ? ['-s', cachedSerial, 'exec-out', 'cat', p] : ['exec-out', 'cat', p];
  const child = spawn('adb', args, { windowsHide: true });
  return child; // caller uses child.stdout, and should listen for 'error'/exit code on child
}

async function pushFile(localPath, devicePath) {
  const p = safeDevicePath(devicePath);
  await mkdirp(posix.dirname(p));
  await run(['push', localPath, p]);
}

async function getDeviceInfo() {
  const props = {};
  const keys = {
    manufacturer: 'ro.product.manufacturer',
    model: 'ro.product.model',
    androidVersion: 'ro.build.version.release',
    sdk: 'ro.build.version.sdk',
    securityPatch: 'ro.build.version.security_patch',
    buildId: 'ro.build.display.id',
  };
  const names = Object.keys(keys);
  const out = await shell(names.map((k) => `getprop ${keys[k]}`).join('; echo __SEP__; '));
  const parts = out.split('__SEP__').map((s) => s.trim());
  names.forEach((k, i) => { props[k] = parts[i] || ''; });

  const dfOut = await shell('df /sdcard');
  const dfLines = dfOut.trim().split('\n');
  let storage = null;
  if (dfLines.length >= 2) {
    const cols = dfLines[1].trim().split(/\s+/);
    const totalKB = parseInt(cols[1], 10);
    const usedKB = parseInt(cols[2], 10);
    const availKB = parseInt(cols[3], 10);
    storage = {
      totalGB: +(totalKB / 1024 / 1024).toFixed(1),
      usedGB: +(usedKB / 1024 / 1024).toFixed(1),
      freeGB: +(availKB / 1024 / 1024).toFixed(1),
      usedPct: Math.round((usedKB / totalKB) * 100),
    };
  }
  return { ...props, storage, serial: cachedSerial };
}

async function getApps() {
  const out = await shell('pm list packages -3 -i');
  const apps = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^package:(\S+)\s+installer=(\S+)/);
    if (m) apps.push({ package: m[1], installer: m[2] === 'null' ? null : m[2] });
  }
  return apps;
}

// ---------- app usage / staleness ----------
const STALE_DAYS = 180; // installed this long ago + never opened in the tracked window => "stale"
let appsUsageCache = { time: 0, data: null };
const APPS_CACHE_TTL_MS = 5 * 60 * 1000;

async function getInstallTimes() {
  const out = await shell(
    `for p in $(pm list packages -3 | sed 's/^package://'); do t=$(dumpsys package "$p" | grep -m1 firstInstallTime); echo "$p|$t"; done 2>/dev/null`
  );
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\|\s*firstInstallTime=(.+)$/);
    if (m) {
      const t = Date.parse(m[2].trim().replace(' ', 'T'));
      if (!isNaN(t)) map[m[1]] = t;
    }
  }
  return map;
}

// Android's "yearly" in-memory usagestats bucket can be shorter than the "monthly" one
// (it reflects whatever is still resident in RAM, not true calendar-yearly history), so
// we use whichever in-memory bucket covers the longest span - this is the best per-app
// "last opened" signal available without root (older history lives in on-disk interval
// files the adb shell user can't read).
async function getUsageMap() {
  const out = await shell('dumpsys usagestats');
  const sections = ['In-memory daily stats', 'In-memory weekly stats', 'In-memory monthly stats', 'In-memory yearly stats'];
  const indices = sections.map((s) => out.indexOf(s)).filter((i) => i >= 0);
  let bestChunk = '';
  let bestSpanMs = -1;
  let bestRange = null;
  for (let i = 0; i < sections.length; i++) {
    const start = out.indexOf(sections[i]);
    if (start < 0) continue;
    const nextIdx = sections.slice(i + 1).map((s) => out.indexOf(s, start + 1)).find((x) => x >= 0);
    const chunk = out.slice(start, nextIdx && nextIdx > start ? nextIdx : start + 200000);
    const rangeMatch = chunk.match(/timeRange="([^"]+)"/);
    if (rangeMatch) {
      const parts = rangeMatch[1].split(/\s*[–-]\s*/);
      const t0 = Date.parse(parts[0]);
      const t1 = Date.parse(parts[1]);
      const span = (!isNaN(t0) && !isNaN(t1)) ? (t1 - t0) : 0;
      if (span > bestSpanMs) { bestSpanMs = span; bestChunk = chunk; bestRange = rangeMatch[1]; }
    }
  }
  const map = {};
  const re = /package=(\S+) totalTimeUsed="([^"]*)"[^\n]*?lastTimeUsed="([^"]+)"[^\n]*?appLaunchCount=(\d+)/g;
  let m;
  while ((m = re.exec(bestChunk))) {
    const [, pkg, totalTimeUsed, lastTimeUsedStr, launchCountStr] = m;
    const t = Date.parse(lastTimeUsedStr.replace(' ', 'T'));
    map[pkg] = {
      totalTimeUsed,
      lastUsed: (!isNaN(t) && t > 0) ? t : null,
      launchCount: parseInt(launchCountStr, 10) || 0,
    };
  }
  return { map, range: bestRange, spanMs: bestSpanMs };
}

async function getAppsWithUsage(forceRefresh) {
  if (!forceRefresh && appsUsageCache.data && (Date.now() - appsUsageCache.time < APPS_CACHE_TTL_MS)) {
    return appsUsageCache.data;
  }
  const apps = await getApps();
  const [installMap, usage] = await Promise.all([getInstallTimes(), getUsageMap()]);
  const now = Date.now();
  const list = apps.map((a) => {
    const installTime = installMap[a.package] ?? null;
    const u = usage.map[a.package];
    const lastUsed = u ? u.lastUsed : null;
    const launchCount = u ? u.launchCount : 0;
    const daysSinceInstall = installTime !== null ? Math.floor((now - installTime) / 86400000) : null;
    const daysSinceUse = lastUsed !== null ? Math.floor((now - lastUsed) / 86400000) : null;
    let category;
    if (lastUsed !== null) category = 'active';
    else if (daysSinceInstall !== null && daysSinceInstall >= STALE_DAYS) category = 'stale';
    else category = 'unused_recent';
    return {
      package: a.package,
      installer: a.installer,
      installTime,
      daysSinceInstall,
      lastUsed,
      daysSinceUse,
      launchCount,
      category,
    };
  });
  const data = { apps: list, usageWindow: usage.range, usageWindowDays: Math.round(usage.spanMs / 86400000), generatedAt: now };
  appsUsageCache = { time: now, data };
  return data;
}

async function uninstallApp(pkg) {
  if (!/^[a-zA-Z0-9_.]+$/.test(pkg)) throw new Error('Invalid package name');
  const apps = await getApps();
  if (!apps.some((a) => a.package === pkg)) throw new Error('Refusing to uninstall: package is not in the third-party app list (system apps are not uninstallable here)');
  await run(['uninstall', pkg]);
  appsUsageCache = { time: 0, data: null };
}

async function getSecurityReport() {
  const [accessibility, admins, suCheck, overlayOut, apps] = await Promise.all([
    shell('settings get secure enabled_accessibility_services').catch(() => ''),
    shell('dpm list-owners').catch(() => ''),
    shell("which su >/dev/null 2>&1 && echo FOUND || (test -e /system/bin/su -o -e /system/xbin/su && echo FOUND || echo NOTFOUND)").catch(() => 'NOTFOUND'),
    shell('cmd appops query-op SYSTEM_ALERT_WINDOW allow').catch(() => ''),
    getApps(),
  ]);
  const sideloaded = apps.filter((a) => !a.installer || (a.installer !== 'com.android.vending' && a.installer !== 'com.google.android.packageinstaller' && a.installer !== 'com.facebook.system'));
  const manualInstalls = apps.filter((a) => a.installer === 'com.google.android.packageinstaller');
  return {
    accessibilityServicesEnabled: accessibility.trim() !== 'null' && accessibility.trim() !== '' ? accessibility.trim() : null,
    deviceAdminOwners: admins.trim(),
    rootIndicatorsFound: suCheck.includes('FOUND') && !suCheck.includes('NOTFOUND'),
    overlayGrantedTo: overlayOut.split('\n').map((s) => s.trim()).filter(Boolean),
    thirdPartyAppCount: apps.length,
    sideloadedApps: sideloaded,
    manuallyInstalledApps: manualInstalls,
  };
}

module.exports = {
  ROOT,
  TRASH_ROOT,
  run,
  shell,
  shellQuote,
  detectDevice,
  safeDevicePath,
  listDir: listDirTyped,
  mkdirp,
  move,
  removeRecursive,
  exists,
  pullStream,
  pushFile,
  getDeviceInfo,
  getApps,
  getAppsWithUsage,
  uninstallApp,
  getSecurityReport,
};
