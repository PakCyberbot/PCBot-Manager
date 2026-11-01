'use strict';
const { psJson, runPs, psQuote, arr } = require('./ps');

// Each startup source and the StartupApproved key Windows (Task Manager) uses for its on/off state.
const SOURCES = [
  { id: 'hkcu-run', kind: 'registry', hive: 'HKCU', label: 'Registry (current user)', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', approved: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  { id: 'hklm-run', kind: 'registry', hive: 'HKLM', label: 'Registry (all users)', key: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', approved: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  { id: 'hklm-run32', kind: 'registry', hive: 'HKLM', label: 'Registry (all users, 32-bit)', key: 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', approved: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32' },
  { id: 'user-folder', kind: 'folder', hive: 'HKCU', label: 'Startup folder (current user)', folder: '$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', approved: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' },
  { id: 'common-folder', kind: 'folder', hive: 'HKLM', label: 'Startup folder (all users)', folder: '$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', approved: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' },
];

async function list() {
  const script = `
$sources = $STDIN | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$items = foreach ($s in $sources) {
  $approved = Get-Item -Path $s.approved -ErrorAction SilentlyContinue
  $entries = @()
  if ($s.kind -eq 'registry') {
    $k = Get-Item -Path $s.key -ErrorAction SilentlyContinue
    if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) { $entries += [pscustomobject]@{ name=$n; command=[string]$k.GetValue($n); file=$null } } } }
  } else {
    $dir = $ExecutionContext.InvokeCommand.ExpandString($s.folder)
    Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
      $cmd = $_.FullName; if ($_.Extension -eq '.lnk') { try { $sc = $shell.CreateShortcut($_.FullName); $cmd = ($sc.TargetPath + ' ' + $sc.Arguments).Trim() } catch {} }
      $entries += [pscustomobject]@{ name=$_.Name; command=$cmd; file=$_.FullName } }
  }
  foreach ($e in $entries) {
    $enabled = $true; $disabledAt = $null
    if ($approved) { $b = $approved.GetValue($e.name); if ($b -is [byte[]] -and $b.Length -ge 1) {
      $enabled = (($b[0] -band 1) -eq 0)
      if (-not $enabled -and $b.Length -ge 12) { $ft = [BitConverter]::ToInt64($b, 4); if ($ft -gt 0) { $disabledAt = ([DateTimeOffset][DateTime]::FromFileTimeUtc($ft)).ToUnixTimeMilliseconds() } } } }
    [pscustomobject]@{ source=$s.id; sourceLabel=$s.label; hive=$s.hive; name=[string]$e.name; command=[string]$e.command; file=$e.file; enabled=$enabled; disabledAt=$disabledAt }
  }
}
ConvertTo-Json @($items) -Compress`;
  const items = arr(await psJson(script, { input: JSON.stringify(SOURCES) }));

  const tasks = arr(await psJson(`
$t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' -and $_.State -ne 'Disabled' -and (@($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -match 'Logon|Boot') }
ConvertTo-Json @($t | ForEach-Object { [pscustomobject]@{ name=[string]$_.TaskName; folder=[string]$_.TaskPath; runs=(($_.Actions | ForEach-Object { ([string]$_.Execute + ' ' + [string]$_.Arguments).Trim() }) -join ' | ') } }) -Compress`));
  return { items, logonTasks: tasks };
}

async function setEnabled(sourceId, name, enabled) {
  const src = SOURCES.find((s) => s.id === sourceId);
  if (!src) throw new Error('Unknown startup source');
  if (typeof name !== 'string' || !name || name.length > 260) throw new Error('Bad entry name');
  try {
    await runPs(`
$key = ${psQuote(src.approved)}
if (-not (Test-Path $key)) { New-Item -Path $key -Force -ErrorAction Stop | Out-Null }
$bytes = New-Object byte[] 12
if (${enabled ? '$true' : '$false'}) { $bytes[0] = 2 } else { $bytes[0] = 3; [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()).CopyTo($bytes, 4) }
Set-ItemProperty -Path $key -Name ${psQuote(name)} -Value $bytes -Type Binary -ErrorAction Stop
'ok'`);
  } catch (e) {
    if (src.hive === 'HKLM' && /access|denied|unauthorized|permission/i.test(e.message)) {
      throw new Error('This entry is registered for all users (HKLM), which needs administrator rights. Toggle it from Task Manager > Startup apps, or run PCBot Manager as administrator.');
    }
    throw e;
  }
  return { ok: true };
}

module.exports = { list, setEnabled };
