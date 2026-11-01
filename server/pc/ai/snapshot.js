'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { psJson } = require('../ps');
const system = require('../system');
const programs = require('../programs');
const startup = require('../startup');
const disk = require('../disk');
const runtimes = require('../runtimes');
const browsers = require('../browsers');

// Persistence/config points beyond the Run keys that malware, adware and leftovers commonly use.
const AUTORUNS_SCRIPT = String.raw`
function Props($p) { $o = [ordered]@{}; $k = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue; if ($k) { foreach ($n in $k.GetValueNames()) { $o[$(if ($n) { $n } else { '(default)' })] = [string]$k.GetValue($n) } }; $o }
$winlogon = Props 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$ifeo = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options' -ErrorAction SilentlyContinue | ForEach-Object {
  $d = $_.GetValue('Debugger'); if ($d) { [pscustomobject]@{ image=$_.PSChildName; debugger=[string]$d } } })
$appinit = foreach ($p in 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows') {
  $k = Get-Item $p -ErrorAction SilentlyContinue; if ($k) { [pscustomobject]@{ key=$p; AppInit_DLLs=[string]$k.GetValue('AppInit_DLLs'); LoadAppInit_DLLs=[string]$k.GetValue('LoadAppInit_DLLs') } } }
$activeSetup = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Active Setup\Installed Components' -ErrorAction SilentlyContinue | ForEach-Object {
  $s = [string]$_.GetValue('StubPath'); if ($s -and $s -notmatch '(?i)\\windows\\') { [pscustomobject]@{ id=$_.PSChildName; name=[string]$_.GetValue(''); stub=$s } } })
$runOnce = foreach ($p in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce','HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce','HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run') {
  [pscustomobject]@{ key=$p; values=(Props $p) } }
$extPolicies = foreach ($p in 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist','HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\ExtensionInstallForcelist','HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist') {
  $v = Props $p; if ($v.Count) { [pscustomobject]@{ key=$p; values=$v } } }
$inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
$proxy = [pscustomobject]@{ enabled=[int]$inet.ProxyEnable; server=[string]$inet.ProxyServer; autoConfigUrl=[string]$inet.AutoConfigURL; bypass=[string]$inet.ProxyOverride }
$pathEntries = foreach ($scope in 'User','Machine') { foreach ($e in ([Environment]::GetEnvironmentVariable('Path', $scope) -split ';' | Where-Object { $_ })) {
  $x = [Environment]::ExpandEnvironmentVariables($e); [pscustomobject]@{ scope=$scope; entry=$e; exists=(Test-Path -LiteralPath $x) } } }
$psProfiles = @($PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost) | Where-Object { Test-Path $_ } | ForEach-Object { [pscustomobject]@{ path=$_; size=(Get-Item $_).Length } }
$wmi = $null; try { $wmi = @(Get-CimInstance -Namespace root/subscription -ClassName __EventConsumer -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ class=$_.CimClass.CimClassName; name=[string]$_.Name; command=[string]$_.CommandLineTemplate; script=[string]$_.ScriptText } }) } catch { $wmi = 'not readable without admin' }
[pscustomobject]@{ winlogon=$winlogon; ifeoDebuggers=$ifeo; appInit=@($appinit); activeSetupNonWindows=$activeSetup; runOnceAndPolicyRun=@($runOnce);
  forcedBrowserExtensions=@($extPolicies); proxy=$proxy; pathEntries=@($pathEntries); powershellProfiles=@($psProfiles); wmiEventConsumers=$wmi } | ConvertTo-Json -Depth 5 -Compress`;

function compactProcesses(list) {
  const groups = {};
  for (const p of list) {
    const k = (p.path || p.name).toLowerCase();
    const g = groups[k] || (groups[k] = { name: p.name, path: p.path || null, description: p.description || null, company: p.company || null, count: 0, memBytes: 0, cpuSeconds: 0, pids: [], sampleCommandLines: [] });
    g.count++; g.memBytes += p.mem; g.cpuSeconds += p.cpu;
    if (g.pids.length < 8) g.pids.push(p.pid);
    if (p.cmd && g.sampleCommandLines.length < 3 && !g.sampleCommandLines.includes(p.cmd)) g.sampleCommandLines.push(p.cmd.slice(0, 400));
  }
  return Object.values(groups).sort((a, b) => b.memBytes - a.memBytes);
}

async function folderListing(dir, limit = 300) {
  try {
    const l = await disk.listDir(dir);
    return l.items.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, limit)
      .map((i) => ({ name: i.name, isDir: i.isDir, sizeBytes: i.size, under1MB: i.sizeSmall || undefined, modified: i.mtime ? new Date(i.mtime).toISOString().slice(0, 10) : null }));
  } catch (e) { return { error: e.message }; }
}

// Writes the snapshot as separate JSON files (so agents can read only what they need) and returns the file index.
async function build(dir, onProgress = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const home = os.homedir();
  const files = [];
  const write = (name, desc, data) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
    files.push({ name, desc, bytes: fs.statSync(path.join(dir, name)).size });
  };
  const step = async (label, fn) => { onProgress(label); try { return await fn(); } catch (e) { return { error: e.message }; } };

  write('01-system.json', 'Hardware, OS, memory, disks, antivirus state (state: on/off/snoozed/expired), GPU', await step('system overview', () => system.overview()));
  const procs = await step('processes', () => system.processes());
  write('02-processes.json', 'Running processes grouped by executable: count, total memory, CPU seconds, sample command lines', Array.isArray(procs) ? compactProcesses(procs) : procs);
  write('03-startup.json', 'Login startup entries with enabled/disabled state (Task Manager StartupApproved) + third-party logon/boot scheduled tasks', await step('startup', () => startup.list()));
  const progs = await step('programs', () => programs.programs(false));
  write('04-programs.json', 'Installed desktop + Store programs. lastUsed = last launch via Explorer (UserAssist) in epoch ms; runningNow; status; isComponent = runtime/driver dependency', progs.programs
    ? progs.programs.map(({ iconKey, iconFile, runs, ...p }) => ({ ...p, lastUsed: p.lastUsed ? new Date(p.lastUsed).toISOString().slice(0, 10) : null, installTime: p.installTime ? new Date(p.installTime).toISOString().slice(0, 10) : null }))
    : progs);
  write('05-security.json', 'Firewall profiles, UAC, RDP, local users, administrators, Defender, hosts entries, third-party scheduled tasks and auto-start services', await step('security posture', () => system.security()));
  const net = await step('network', () => system.network());
  write('06-network.json', 'Listening sockets (non-loopback = reachable from network) and established external connections with owning process', Array.isArray(net)
    ? { listening: net.filter((c) => c.state === 'Listen'), establishedExternal: net.filter((c) => c.state === 'Established' && !['127.0.0.1', '::1'].includes(c.remote)) } : net);
  write('07-autoruns-registry.json', 'Extra persistence/config points: Winlogon, IFEO debuggers, AppInit DLLs, Active Setup, RunOnce/policy Run keys, forced browser extensions, proxy, PATH entries (exists=false means broken), PowerShell profiles, WMI consumers',
    await step('registry autoruns', () => psJson(AUTORUNS_SCRIPT, { timeoutMs: 120000 })));
  write('08-browsers.json', 'Browser profiles and extensions: enabled, status (active/stale/disabled/no_data), risk, permissions, install/update dates, last storage activity', await step('browsers', () => browsers.list()));
  write('09-runtimes.json', 'Python interpreters and venvs, Node versions (nvm), Java homes, dev tools with versions and PATH resolution', await step('dev runtimes', () => runtimes.inventory(false)));
  const scan = disk.results();
  write('10-disk-scan.json', scan ? 'Last full disk scan of the profile: file-type totals, regenerable build artifacts, app caches, known big locations with safety hints, large files, duplicates, old downloads (all sizes in bytes)' : 'No disk scan available yet',
    scan || { note: 'Ask the user to run "Scan my profile" in the dashboard for folder sizes.' });
  onProgress('folder listings');
  const listings = {};
  for (const d of [home, path.join(home, 'WORK'), path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'),
    path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local', 'Temp')]) {
    if (fs.existsSync(d)) listings[d] = await folderListing(d);
  }
  write('11-folder-listings.json', 'Top-level contents of key folders with sizes (from the disk scan) and modified dates', listings);

  onProgress('purpose hints');
  const purpose = require('../purpose');
  const hintRoots = [home, path.join(home, 'WORK'), path.join(home, 'Documents'), path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'),
    path.join(home, 'AppData', 'LocalLow'), process.env.ProgramData || 'C:\\ProgramData'];
  const targets = [];
  for (const r of hintRoots) { try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) targets.push(path.join(r, e.name)); } catch { /* unreadable */ } }
  const hints = await step('purpose hints', () => purpose.explainMany(targets, { peek: true }));
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
  write('12-purpose-hints.json', 'Built-in heuristic explanation of every top-level folder in the profile, WORK, Documents, AppData (Local/Roaming/LocalLow) and ProgramData: what it is, who created it, criticality, whether the owning program was found installed (ownerInstalled), orphan = owner not found AND untouched 120+ days, sizeBytes, lastActivity. Verify, correct and extend these - they are heuristics.',
    hints.error ? hints : Object.values(hints).filter((x) => !x.error).map((x) => ({ path: x.path, short: x.short, kind: x.kind, criticality: x.criticality, createdBy: x.createdBy, owner: x.owner,
      ownerInstalled: x.ownerInstalled, orphan: x.orphan, sizeBytes: x.size, lastActivity: day(x.lastActivity), evidence: x.evidence, suggestedCleanup: x.cleanup })));

  const index = { createdAt: new Date().toISOString(), computer: os.hostname(), user: os.userInfo().username, home, files };
  fs.writeFileSync(path.join(dir, '00-INDEX.json'), JSON.stringify(index, null, 1));
  return index;
}

// A condensed copy of the snapshot (~20-30k tokens) for models that get the data inline instead of reading
// files themselves - local LLMs via Ollama and custom stdin commands.
function buildCompact(dir) {
  const read = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
  const mb = (b) => (typeof b === 'number' ? Math.round(b / 1048576) : null);
  const cut = (s, n) => (s ? String(s).slice(0, n) : s);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const procs = arr(read('02-processes.json')).slice(0, 40).map((p) => ({ name: p.name, path: p.path, count: p.count, memMB: mb(p.memBytes), cmd: cut(p.sampleCommandLines && p.sampleCommandLines[0], 160) }));
  const st = read('03-startup.json') || {};
  const progs = arr(read('04-programs.json')).map((p) => ({ name: p.name, publisher: p.publisher, status: p.status, lastUsed: p.lastUsed, runningNow: p.runningNow || undefined, installed: p.installTime, sizeMB: mb(p.sizeBytes), component: p.isComponent || undefined }));
  const sec = read('05-security.json') || {};
  const net = read('06-network.json') || {};
  const auto = read('07-autoruns-registry.json') || {};
  const brs = arr(read('08-browsers.json'));
  const rt = read('09-runtimes.json') || {};
  const ds = read('10-disk-scan.json') || {};
  const hints = arr(read('12-purpose-hints.json'));
  const byProcess = {};
  for (const c of arr(net.establishedExternal)) byProcess[c.process] = (byProcess[c.process] || 0) + 1;
  return {
    system: read('01-system.json'),
    topProcessesByMemory: procs,
    startup: { items: arr(st.items).map((i) => ({ name: i.name, enabled: i.enabled, runs: cut(i.command, 160), source: i.sourceLabel })), logonTasks: st.logonTasks },
    programs: progs,
    security: { firewall: sec.firewall, uac: sec.uacEnabled, rdp: sec.rdpEnabled, defender: sec.defender, admins: sec.admins,
      users: arr(sec.users).map((u) => ({ name: u.name, enabled: u.enabled, lastLogon: u.lastLogon })), hosts: sec.hosts,
      thirdPartyTasks: arr(sec.thirdPartyTasks).map((t) => ({ name: t.name, state: t.state, runs: cut(t.runs, 150) })),
      thirdPartyServices: arr(sec.thirdPartyServices).map((s) => ({ name: s.display, state: s.state, path: cut(s.path, 150) })) },
    network: { listeningBeyondLocalhost: arr(net.listening).filter((c) => !['127.0.0.1', '::1'].includes(c.local)).map((c) => `${c.process}:${c.lport}/${c.proto}`), externalConnectionsByProcess: byProcess },
    registryAutoruns: { ...auto, pathEntries: arr(auto.pathEntries).filter((e) => !e.exists) },
    browserExtensions: brs.flatMap((b) => arr(b.profiles).flatMap((p) => arr(p.extensions).map((e) => ({ browser: b.name, name: e.name, enabled: e.enabled, status: e.status, risk: e.risk, lastActivity: e.lastActivity ? new Date(e.lastActivity).toISOString().slice(0, 10) : null })))),
    runtimes: { python: arr(rt.python && rt.python.interpreters).map((p) => ({ v: p.version, source: p.source, exe: p.exe, venv: p.isVenv, sizeMB: mb(p.size) })), node: rt.node && rt.node.versions,
      tools: arr(rt.tools).filter((t) => t.installed).map((t) => `${t.name} ${t.version || ''}`.trim()) },
    disk: { totalScannedGB: ds.bytes ? Math.round(ds.bytes / 1073741824) : null, types: ds.types,
      artifacts: arr(ds.artifacts).slice(0, 25).map((a) => ({ path: a.path, kind: a.kind, sizeMB: mb(a.size) })),
      caches: [...arr(ds.known), ...arr(ds.appCaches)].sort((a, b) => b.size - a.size).slice(0, 25).map((c) => ({ path: c.path, what: c.label || c.app, sizeMB: mb(c.size), safety: c.safety })),
      largeFiles: arr(ds.largeFiles).slice(0, 30).map((f) => ({ path: f.path, sizeMB: mb(f.size), type: f.type, modified: f.mtime ? new Date(f.mtime).toISOString().slice(0, 10) : null })),
      duplicates: arr(ds.duplicates).slice(0, 12).map((g) => ({ sizeMB: mb(g.size), files: g.files.map((f) => f.path) })),
      oldDownloads: arr(ds.oldDownloads).slice(0, 15).map((f) => ({ path: f.path, sizeMB: mb(f.size) })) },
    purposeHints: hints.filter((h) => h.orphan || (h.sizeBytes || 0) >= 100 * 1048576 || h.criticality === 'critical')
      .map((h) => ({ path: h.path, is: h.short, by: h.createdBy, ownerInstalled: h.ownerInstalled, orphan: h.orphan || undefined, sizeMB: mb(h.sizeBytes), lastActivity: h.lastActivity })),
  };
}

module.exports = { build, buildCompact };
