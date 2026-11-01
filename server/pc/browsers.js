'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const disk = require('./disk');

const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;
const PF = process.env.ProgramFiles;
const PF86 = process.env['ProgramFiles(x86)'];

const CHROMIUM = [
  { id: 'chrome', name: 'Google Chrome', dir: path.join(LOCAL, 'Google', 'Chrome', 'User Data'), scheme: 'chrome',
    exes: [path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe')] },
  { id: 'edge', name: 'Microsoft Edge', dir: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'), scheme: 'edge',
    exes: [path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] },
  { id: 'brave', name: 'Brave', dir: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'), scheme: 'brave',
    exes: [path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] },
  { id: 'avast', name: 'Avast Secure Browser', dir: path.join(LOCAL, 'AVAST Software', 'Browser', 'User Data'), scheme: 'chrome',
    exes: [path.join(PF, 'AVAST Software', 'Browser', 'Application', 'AvastBrowser.exe')] },
  { id: 'vivaldi', name: 'Vivaldi', dir: path.join(LOCAL, 'Vivaldi', 'User Data'), scheme: 'vivaldi', exes: [path.join(LOCAL, 'Vivaldi', 'Application', 'vivaldi.exe')] },
];

const STALE_DAYS = 90;
const HIGH_RISK_PERMS = ['debugger', 'webRequest', 'webRequestBlocking', 'proxy', 'nativeMessaging', 'cookies', 'history', 'declarativeNetRequestWithHostAccess', 'management', 'clipboardRead', 'downloads'];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } }
// Chromium stores times as microseconds since 1601-01-01 (as strings).
function chromeTime(v) {
  if (!v) return null;
  try { const ms = Number(BigInt(String(v)) / 1000n) - 11644473600000; return ms > 0 ? ms : null; } catch { return null; }
}
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }

function newestIn(dir) {
  let best = mtime(dir);
  try { for (const e of fs.readdirSync(dir)) { const m = mtime(path.join(dir, e)); if (m && (!best || m > best)) best = m; } } catch { /* missing */ }
  return best;
}

function folderSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { const f = path.join(d, e.name); if (e.isDirectory()) stack.push(f); else if (e.isFile()) { try { total += fs.statSync(f).size; } catch { /* skip */ } } }
  }
  return total;
}

function resolveMsg(value, extDir, manifest) {
  if (typeof value !== 'string' || !value.startsWith('__MSG_')) return value;
  const key = value.slice(6, -2).toLowerCase();
  const locales = [manifest.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const loc of locales) {
    const msgs = readJson(path.join(extDir, '_locales', loc, 'messages.json'));
    if (msgs) { const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === key); if (hit) return hit[1].message; }
  }
  return value;
}

function riskOf(perms, hosts) {
  const broadHost = hosts.some((h) => h === '<all_urls>' || /^\*:\/\/\*\//.test(h) || /^https?:\/\/\*\//.test(h));
  const risky = perms.filter((p) => HIGH_RISK_PERMS.includes(p));
  if (broadHost && risky.length) return { level: 'high', why: `Can read/modify every site + ${risky.join(', ')}` };
  if (broadHost) return { level: 'medium', why: 'Can read/modify data on every site' };
  if (risky.length) return { level: 'medium', why: risky.join(', ') };
  return { level: 'low', why: '' };
}

function statusOf(enabled, lastActivity) {
  if (!enabled) return 'disabled';
  if (!lastActivity) return 'no_data';
  return (Date.now() - lastActivity) / 86400000 > STALE_DAYS ? 'stale' : 'active';
}

function chromiumProfiles(b) {
  const localState = readJson(path.join(b.dir, 'Local State'));
  const cache = (localState && localState.profile && localState.profile.info_cache) || {};
  const dirs = Object.keys(cache).filter((d) => fs.existsSync(path.join(b.dir, d)));
  if (!dirs.length && fs.existsSync(path.join(b.dir, 'Default'))) dirs.push('Default');
  return dirs.map((dirName) => {
    const pdir = path.join(b.dir, dirName);
    const info = cache[dirName] || {};
    const prefs = readJson(path.join(pdir, 'Preferences')) || {};
    const secure = readJson(path.join(pdir, 'Secure Preferences')) || {};
    const settings = { ...((prefs.extensions || {}).settings || {}), ...((secure.extensions || {}).settings || {}) };
    const extensions = [];
    for (const [id, s] of Object.entries(settings)) {
      if ([5, 10].includes(s.location) || s.was_installed_by_default) continue; // component / bundled
      const extDir = s.path ? (path.isAbsolute(s.path) ? s.path : path.join(pdir, 'Extensions', s.path)) : null;
      const manifest = s.manifest || (extDir && readJson(path.join(extDir, 'manifest.json'))) || {};
      if (!manifest.name) continue;
      if (manifest.theme) continue;
      const perms = (manifest.permissions || []).filter((p) => typeof p === 'string');
      const hosts = [...(manifest.host_permissions || []), ...perms.filter((p) => p.includes('://') || p === '<all_urls>'),
        ...(manifest.content_scripts || []).flatMap((c) => c.matches || [])];
      const enabled = !(Array.isArray(s.disable_reasons) ? s.disable_reasons.length : s.disable_reasons) && s.state !== 0;
      const lastActivity = [path.join(pdir, 'Local Extension Settings', id), path.join(pdir, 'Sync Extension Settings', id),
        path.join(pdir, 'IndexedDB', `chrome-extension_${id}_0.indexeddb.leveldb`)].map(newestIn).filter(Boolean).sort((a, b2) => b2 - a)[0] || null;
      const risk = riskOf(perms, hosts);
      extensions.push({
        id, name: resolveMsg(manifest.name, extDir || '', manifest), version: manifest.version, description: resolveMsg(manifest.description || '', extDir || '', manifest),
        enabled, fromWebstore: !!s.from_webstore, unpacked: s.location === 4, installTime: chromeTime(s.first_install_time || s.install_time),
        updateTime: chromeTime(s.last_update_time), lastActivity, status: statusOf(enabled, lastActivity), permissions: perms,
        hostAccess: [...new Set(hosts)].slice(0, 12), risk: risk.level, riskWhy: risk.why, size: extDir && fs.existsSync(extDir) ? folderSize(extDir) : null,
        storeUrl: s.from_webstore ? `https://chromewebstore.google.com/detail/${id}` : null,
      });
    }
    const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')].map((c) => path.join(pdir, c));
    return {
      dir: dirName, name: info.name || dirName, account: info.user_name || info.gaia_name || null,
      lastUsed: info.active_time ? Math.round(info.active_time * 1000) : mtime(path.join(pdir, 'Preferences')),
      profileSize: disk.knownSize(pdir).size, cacheSize: cacheDirs.reduce((a, c) => a + (disk.knownSize(c).size || 0), 0) || null,
      extensions: extensions.sort((a, b2) => a.name.localeCompare(b2.name)),
    };
  });
}

function parseIni(text) {
  const out = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = { _section: sec[1] }; out.push(cur); continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  return out;
}

function firefoxProfiles() {
  const base = path.join(ROAMING, 'Mozilla', 'Firefox');
  let ini; try { ini = parseIni(fs.readFileSync(path.join(base, 'profiles.ini'), 'utf8')); } catch { return null; }
  return ini.filter((s) => /^Profile/.test(s._section) && s.Path).map((s) => {
    const pdir = s.IsRelative === '1' ? path.join(base, s.Path) : s.Path;
    const ext = readJson(path.join(pdir, 'extensions.json')) || { addons: [] };
    let uuids = {};
    try {
      const prefs = fs.readFileSync(path.join(pdir, 'prefs.js'), 'utf8');
      const m = prefs.match(/user_pref\("extensions\.webextensions\.uuids",\s*"(.*)"\);/);
      if (m) uuids = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    } catch { /* none */ }
    let storageDirs = [];
    try { storageDirs = fs.readdirSync(path.join(pdir, 'storage', 'default')); } catch { /* none */ }
    const extensions = (ext.addons || [])
      .filter((a) => a.type === 'extension' && a.location === 'app-profile') // user-installed only; skips Firefox's built-in system add-ons
      .map((a) => {
        const uuid = uuids[a.id];
        const acts = [path.join(pdir, 'browser-extension-data', a.id)];
        if (uuid) for (const d of storageDirs) if (d.startsWith(`moz-extension+++${uuid}`)) acts.push(path.join(pdir, 'storage', 'default', d));
        const lastActivity = acts.map(newestIn).filter(Boolean).sort((x, y) => y - x)[0] || null;
        const perms = (a.userPermissions && a.userPermissions.permissions) || [];
        const hosts = (a.userPermissions && a.userPermissions.origins) || [];
        const enabled = !!a.active && !a.userDisabled;
        const risk = riskOf(perms, hosts);
        return { id: a.id, name: (a.defaultLocale && a.defaultLocale.name) || a.id, version: a.version, description: (a.defaultLocale && a.defaultLocale.description) || '',
          enabled, fromWebstore: a.sourceURI ? /addons\.mozilla\.org/.test(a.sourceURI) : null, unpacked: false, installTime: a.installDate || null,
          updateTime: a.updateDate || null, lastActivity, status: statusOf(enabled, lastActivity), permissions: perms, hostAccess: hosts.slice(0, 12),
          risk: risk.level, riskWhy: risk.why, size: a.path && fs.existsSync(a.path) ? fs.statSync(a.path).size : null,
          storeUrl: `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(a.id)}/` };
      });
    return { dir: s.Path, name: s.Name, account: null, lastUsed: mtime(path.join(pdir, 'prefs.js')), profileSize: disk.knownSize(pdir).size,
      cacheSize: disk.knownSize(path.join(LOCAL, 'Mozilla', 'Firefox', s.Path)).size, extensions: extensions.sort((x, y) => x.name.localeCompare(y.name)) };
  });
}

function list() {
  const out = [];
  for (const b of CHROMIUM) {
    if (!fs.existsSync(b.dir)) continue;
    out.push({ id: b.id, name: b.name, exe: b.exes.find((e) => fs.existsSync(e)) || null, engine: 'chromium', profiles: chromiumProfiles(b) });
  }
  const ff = firefoxProfiles();
  if (ff) out.push({ id: 'firefox', name: 'Mozilla Firefox', exe: [path.join(PF, 'Mozilla Firefox', 'firefox.exe')].find((e) => fs.existsSync(e)) || null, engine: 'gecko', profiles: ff });
  return out;
}

// Opens the browser's own extensions page for that profile so removal happens through the browser itself.
function openManage(browserId, profileDir, extId) {
  const b = CHROMIUM.find((x) => x.id === browserId);
  if (browserId === 'firefox') {
    const exe = path.join(PF, 'Mozilla Firefox', 'firefox.exe');
    if (!fs.existsSync(exe)) throw new Error('Firefox not found');
    spawn(exe, ['about:addons'], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  if (!b) throw new Error('Unknown browser');
  const exe = b.exes.find((e) => fs.existsSync(e));
  if (!exe) throw new Error(`${b.name} executable not found`);
  if (typeof profileDir !== 'string' || !/^(Default|Profile \d+|Guest Profile|[\w .-]{1,40})$/.test(profileDir) || !fs.existsSync(path.join(b.dir, profileDir))) throw new Error('Unknown profile');
  if (extId && !/^[a-p]{32}$/.test(extId)) throw new Error('Bad extension id');
  const url = `${b.scheme}://extensions/${extId ? '?id=' + extId : ''}`;
  spawn(exe, [`--profile-directory=${profileDir}`, url], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

module.exports = { list, openManage };
