'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { psJson, runPs, psQuote, arr } = require('./ps');

const ICON_DIR = path.join(__dirname, '..', '..', 'cache', 'pc-icons');
fs.mkdirSync(ICON_DIR, { recursive: true });

function iconKey(file) {
  return crypto.createHash('sha1').update(String(file).toLowerCase()).digest('hex');
}

function iconPath(key) {
  if (!/^[0-9a-f]{40}$/.test(key)) return null;
  const p = path.join(ICON_DIR, key + '.png');
  return fs.existsSync(p) ? p : null;
}

// Extract icons for any files we don't have cached yet, in one PowerShell call.
async function ensureIcons(files) {
  const missing = [...new Set(files.filter(Boolean))].filter((f) => !fs.existsSync(path.join(ICON_DIR, iconKey(f) + '.png')));
  if (missing.length === 0) return;
  const jobs = missing.map((f) => ({ f, out: path.join(ICON_DIR, iconKey(f) + '.png') }));
  await runPs(`
Add-Type -AssemblyName System.Drawing
$jobs = $STDIN | ConvertFrom-Json
foreach ($j in $jobs) {
  try {
    if (Test-Path -LiteralPath $j.f) {
      $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($j.f)
      if ($ico) { $bmp = $ico.ToBitmap(); $bmp.Save($j.out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $ico.Dispose() }
    }
  } catch {}
}`, { timeoutMs: 180000, input: JSON.stringify(jobs) });
}

// Explorer's per-user launch history: value names are ROT13'd paths (with known-folder
// GUID prefixes), data holds run count (offset 4) and last-run FILETIME (offset 60).
const USERASSIST_SCRIPT = `
function Rot13([string]$s) { -join ($s.ToCharArray() | ForEach-Object { $c=[int]$_
  if ($c -ge 65 -and $c -le 90) { [char](65 + (($c - 65 + 13) % 26)) } elseif ($c -ge 97 -and $c -le 122) { [char](97 + (($c - 97 + 13) % 26)) } else { [char]$c } }) }
$kf = @{
  '{6D809377-6AF0-444B-8957-A3773F02200E}'=$env:ProgramFiles; '{905E63B6-C1BF-494E-B29C-65B732D3D21A}'=$env:ProgramFiles
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}'=\${env:ProgramFiles(x86)}; '{F38BF404-1D43-42F2-9305-67DE0B28FC23}'=$env:WINDIR
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}'="$env:WINDIR\\System32"; '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}'="$env:WINDIR\\SysWOW64"
  '{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}'="$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
  '{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}'="$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
  '{9E3995AB-1F9C-4F13-B827-48B24B6C7174}'="$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned"
  '{374DE290-123F-4565-9164-39C4925E467B}'="$env:USERPROFILE\\Downloads"; '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}'="$env:USERPROFILE\\Desktop"
  '{FDD39AD0-238F-46AF-ADB4-6C85480369C7}'="$env:USERPROFILE\\Documents"; '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}'=$env:LOCALAPPDATA
  '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}'=$env:APPDATA; '{5E6C858F-0E22-4760-9AFE-EA3317B67173}'=$env:USERPROFILE
}
$shell = New-Object -ComObject WScript.Shell
$ua = @()
foreach ($g in '{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}','{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}') {
  $k = Get-Item "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\$g\\Count" -ErrorAction SilentlyContinue
  if (-not $k) { continue }
  foreach ($n in $k.GetValueNames()) {
    $d = $k.GetValue($n)
    if (-not ($d -is [byte[]]) -or $d.Length -lt 68) { continue }
    $name = Rot13 $n
    foreach ($key in $kf.Keys) { if ($name.StartsWith($key)) { $name = $kf[$key] + $name.Substring($key.Length); break } }
    $target = $null
    if ($name -like '*.lnk' -and (Test-Path -LiteralPath $name)) { try { $target = $shell.CreateShortcut($name).TargetPath } catch {} }
    $ft = [BitConverter]::ToInt64($d, 60)
    $last = $null; if ($ft -gt 0) { try { $last = ([DateTimeOffset][DateTime]::FromFileTimeUtc($ft)).ToUnixTimeMilliseconds() } catch {} }
    $ua += [pscustomobject]@{ name=[string]$name; target=[string]$target; runs=[int][BitConverter]::ToUInt32($d, 4); last=$last }
  }
}`;

async function userAssist() {
  return arr(await psJson(USERASSIST_SCRIPT + '\nConvertTo-Json @($ua) -Compress', { timeoutMs: 60000 }));
}

const COMPONENT_RE = /redistributable|runtime|\bsdk\b|driver|update helper|container|plugin|framework|\bkits?\b|diagnosticshub|icecap|application verifier|universal crt|msi development|physx|\.net |\bhost\b|resolver|clr types|setup configuration|wmi provider|extensibility|ota dependencies|nvcpl|telemetry|messagebus|backend|audio effects|frameview|nvdlisr|maintenance service|auto updater|watchdog|app installer|helper|webview2|virtual audio|broadcast voice|usbc|platform controllers|senetfilter|intellitrace/i;

async function listPrograms() {
  const [regApps, storeApps, ua, running] = await Promise.all([
    psJson(`
$roots = @(
  @{ hive='HKLM'; path='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='64-bit' },
  @{ hive='HKLM'; path='HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='32-bit' },
  @{ hive='HKCU'; path='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='user' })
$out = foreach ($r in $roots) {
  Get-ChildItem $r.path -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName -or $p.SystemComponent -eq 1 -or $p.ParentKeyName) { return }
    [pscustomobject]@{
      id = ($r.path + '\\' + $_.PSChildName); scope=$r.arch; name=[string]$p.DisplayName; version=[string]$p.DisplayVersion
      publisher=[string]$p.Publisher; installDate=[string]$p.InstallDate; sizeKB=[double]$p.EstimatedSize
      location=[string]$p.InstallLocation; icon=[string]$p.DisplayIcon; uninstall=[string]$p.UninstallString
      folderTime=$(try { $l = ([string]$p.InstallLocation).Trim('"'); if ($l -and (Test-Path -LiteralPath $l)) { ToMs (Get-Item -LiteralPath $l).CreationTime } } catch { $null })
    } } }
ConvertTo-Json @($out) -Compress`, { timeoutMs: 90000 }),
    psJson(`
$names = @{}; Get-StartApps | ForEach-Object { $pfn = ($_.AppID -split '!')[0]; if (-not $names.ContainsKey($pfn)) { $names[$pfn] = $_.Name } }
$out = Get-AppxPackage -PackageTypeFilter Main -ErrorAction SilentlyContinue | Where-Object { $_.SignatureKind -ne 'System' -and -not $_.IsFramework } | ForEach-Object {
  [pscustomobject]@{ id=('appx:' + $_.PackageFullName); fullName=[string]$_.PackageFullName; family=[string]$_.PackageFamilyName
    name=$(if ($names.ContainsKey($_.PackageFamilyName)) { [string]$names[$_.PackageFamilyName] } else { [string]$_.Name })
    version=[string]$_.Version; publisher=[string]($_.Publisher -replace '^CN=([^,]+).*$','$1'); location=[string]$_.InstallLocation
    nonRemovable=[bool]$_.NonRemovable; signature=[string]$_.SignatureKind; installTime=$(try { ToMs (Get-Item -LiteralPath $_.InstallLocation).CreationTime } catch { $null }) } }
ConvertTo-Json @($out) -Compress`, { timeoutMs: 90000 }),
    userAssist(),
    psJson('ConvertTo-Json @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { [string]$_.ExecutablePath } | Sort-Object -Unique) -Compress'),
  ]);
  const runningL = arr(running).map((p) => p.toLowerCase());

  const uaEntries = ua.map((u) => ({ ...u, nameL: u.name.toLowerCase(), targetL: (u.target || '').toLowerCase() }));
  const genericDirs = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, process.env.LOCALAPPDATA, process.env.APPDATA,
    path.join(process.env.ProgramFiles || '', 'Common Files'), path.join(process.env['ProgramFiles(x86)'] || '', 'Common Files'), process.env.WINDIR,
    path.join(process.env.WINDIR || '', 'System32'), path.join(process.env.WINDIR || '', 'SysWOW64'), path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    process.env.USERPROFILE].filter(Boolean).map((d) => d.toLowerCase().replace(/\\+$/, '')));

  function exeFromCommand(s) {
    if (!s) return null;
    s = s.trim();
    let m = s.match(/^"([^"]+)"/);
    if (m) return m[1];
    m = s.match(/^(.*?\.(exe|ico|dll))/i);
    return m ? m[1] : null;
  }
  function candidateDirs(p) {
    const dirs = [];
    const add = (d) => {
      if (!d) return;
      d = d.replace(/^"|"$/g, '').replace(/\\+$/, '').toLowerCase();
      if (d.length > 3 && !genericDirs.has(d) && !/\\package cache\\|\\installer\\|msiexec/i.test(d)) dirs.push(d);
    };
    add(p.location);
    const iconExe = exeFromCommand(p.icon);
    if (iconExe) add(path.dirname(iconExe));
    const unExe = exeFromCommand(p.uninstall);
    if (unExe && !/msiexec/i.test(unExe)) add(path.dirname(unExe));
    return [...new Set(dirs)];
  }

  const now = Date.now();
  const programs = arr(regApps).map((p) => {
    const dirs = candidateDirs(p);
    let last = null;
    let runs = 0;
    for (const u of uaEntries) {
      const hit = dirs.some((d) => u.nameL.startsWith(d + '\\') || (u.targetL && u.targetL.startsWith(d + '\\')));
      if (hit) { runs += u.runs; if (u.last && (!last || u.last > last)) last = u.last; }
    }
    // Apps started at login or in the background never appear in Explorer's launch history,
    // so a process currently running from the program's folder counts as "in use now".
    const runningNow = runningL.some((r) => dirs.some((d) => r.startsWith(d + '\\')));
    if (runningNow) last = Date.now();
    const iconFile = exeFromCommand(p.icon);
    const installMs = /^\d{8}$/.test(p.installDate) ? Date.UTC(+p.installDate.slice(0, 4), +p.installDate.slice(4, 6) - 1, +p.installDate.slice(6, 8))
      : (typeof p.folderTime === 'number' ? p.folderTime : null); // PS 5.1 serializes an empty $() as {} rather than null
    return {
      id: p.id, kind: 'desktop', scope: p.scope, name: p.name, version: p.version, publisher: p.publisher,
      installTime: installMs || null, sizeBytes: p.sizeKB ? p.sizeKB * 1024 : null, location: p.location || (iconFile ? path.dirname(iconFile) : ''),
      iconKey: iconFile ? iconKey(iconFile) : null, iconFile, lastUsed: last, runs, runningNow,
      isComponent: COMPONENT_RE.test(p.name), canUninstall: !!p.uninstall,
    };
  });

  for (const a of arr(storeApps)) {
    const famL = a.family.toLowerCase();
    let last = null;
    let runs = 0;
    for (const u of uaEntries) {
      if (u.nameL.startsWith(famL + '!')) { runs += u.runs; if (u.last && (!last || u.last > last)) last = u.last; }
    }
    programs.push({
      id: a.id, kind: 'store', scope: 'store', name: a.name, version: a.version, publisher: a.publisher,
      installTime: typeof a.installTime === 'number' ? a.installTime : null, sizeBytes: null, location: a.location, iconKey: null, iconFile: null,
      lastUsed: last, runs, isComponent: /^Microsoft\.(VCLibs|NET|UI\.Xaml|WindowsAppRuntime|Services\.Store)/i.test(a.fullName),
      canUninstall: !a.nonRemovable, fullName: a.fullName,
    });
  }

  for (const p of programs) {
    const days = p.lastUsed ? Math.floor((now - p.lastUsed) / 86400000) : null;
    p.daysSinceUse = days;
    if (p.isComponent) p.status = 'component';
    else if (days === null) p.status = 'no_record';
    else if (days <= 30) p.status = 'active';
    else if (days <= 90) p.status = 'idle';
    else p.status = 'unused';
  }

  await ensureIcons(programs.map((p) => p.iconFile)).catch(() => {});
  return { programs, launchRecords: ua.length };
}

let cache = { at: 0, data: null };
async function programs(force) {
  if (!force && cache.data && Date.now() - cache.at < 10 * 60 * 1000) return cache.data;
  const data = await listPrograms();
  cache = { at: Date.now(), data };
  return data;
}

// Runs the vendor's own uninstaller (it shows its own UI/UAC prompt); the user finishes it there.
async function uninstall(id) {
  if (typeof id !== 'string') throw new Error('Bad id');
  if (id.startsWith('appx:')) {
    const fullName = id.slice(5);
    if (!/^[\w.\-~ ]+$/.test(fullName)) throw new Error('Bad package name');
    await runPs(`Remove-AppxPackage -Package ${psQuote(fullName)} -ErrorAction Stop`);
    cache = { at: 0, data: null };
    return { ok: true, message: 'Store app removed' };
  }
  if (!/^HK(LM|CU):\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\]+$/i.test(id)) throw new Error('Unknown program id');
  const res = await psJson(`
$p = Get-ItemProperty -LiteralPath ${psQuote(id)} -ErrorAction Stop
$u = [string]$p.UninstallString
if (-not $u) { throw 'No uninstall command registered' }
if ($u -match '(?i)msiexec(\\.exe)?\\s+/[IX]\\s*(\\{[0-9A-F\\-]+\\})') { Start-Process msiexec.exe -ArgumentList "/x $($Matches[2])" }
elseif ($u -match '^\\s*"([^"]+)"\\s*(.*)$') { if ($Matches[2]) { Start-Process -FilePath $Matches[1] -ArgumentList $Matches[2] } else { Start-Process -FilePath $Matches[1] } }
else { $i = $u.ToLower().IndexOf('.exe'); if ($i -lt 0) { throw "Can't parse uninstall command: $u" }
  $exe = $u.Substring(0, $i + 4); $rest = $u.Substring($i + 4).Trim()
  if ($rest) { Start-Process -FilePath $exe -ArgumentList $rest } else { Start-Process -FilePath $exe } }
[pscustomobject]@{ ok=$true; name=[string]$p.DisplayName } | ConvertTo-Json -Compress`);
  cache = { at: 0, data: null };
  return { ok: true, message: `Opened the uninstaller for ${res.name}. Finish it in its own window, then refresh this list.` };
}

module.exports = { programs, uninstall, iconPath, ensureIcons, iconKey, userAssist };
