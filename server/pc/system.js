'use strict';
const { psJson, arr } = require('./ps');

async function overview() {
  return psJson(`
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = @(Get-CimInstance Win32_Processor)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{ id=[string]$_.DeviceID; label=[string]$_.VolumeName; size=[double]$_.Size; free=[double]$_.FreeSpace } })
$av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction SilentlyContinue | ForEach-Object {
  # WSC productState: bits 12-15 = 0 off / 1 on / 2 snoozed / 3 expired; bits 4-7 = 0 definitions up to date
  $st = [int]$_.productState; $mode = ($st -shr 12) -band 0xF
  [pscustomobject]@{ name=[string]$_.displayName; enabled=($mode -eq 1); state=@('off','on','snoozed','expired')[[Math]::Min($mode,3)]; upToDate=((($st -shr 4) -band 0xF) -eq 0) } })
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.Name })
[pscustomobject]@{
  computer=[string]$cs.Name; manufacturer=[string]$cs.Manufacturer; model=[string]$cs.Model
  os=[string]$os.Caption; version=[string]$os.Version; build=[string]$os.BuildNumber
  installDate=(ToMs $os.InstallDate); lastBoot=(ToMs $os.LastBootUpTime)
  totalMem=[double]$os.TotalVisibleMemorySize*1024; freeMem=[double]$os.FreePhysicalMemory*1024
  cpu=[string]$cpu[0].Name.Trim()
  cores=[int](($cpu | Measure-Object NumberOfCores -Sum).Sum)
  logical=[int](($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
  cpuLoad=[double](($cpu | Measure-Object LoadPercentage -Average).Average)
  gpus=$gpus; disks=$disks; antivirus=$av
  user=[string]$env:USERNAME; home=[string]$env:USERPROFILE
} | ConvertTo-Json -Depth 4 -Compress`);
}

async function processes() {
  const data = await psJson(`
$list = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name
    path=[string]$_.ExecutablePath; cmd=[string]$_.CommandLine
    mem=[double]$_.WorkingSetSize; priv=[double]$_.PrivatePageCount
    cpu=[double](($_.KernelModeTime + $_.UserModeTime) / 1e7)
    threads=[int]$_.ThreadCount; start=(ToMs $_.CreationDate)
  } })
$desc = @{}
foreach ($p in ($list | Where-Object { $_.path } | Select-Object -ExpandProperty path -Unique)) {
  try { $fi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p); $desc[$p] = @([string]$fi.FileDescription, [string]$fi.CompanyName) } catch {}
}
foreach ($p in $list) { if ($p.path -and $desc.ContainsKey($p.path)) { $p | Add-Member description $desc[$p.path][0]; $p | Add-Member company $desc[$p.path][1] } }
ConvertTo-Json @($list) -Depth 3 -Compress`, { timeoutMs: 60000 });
  return arr(data);
}

const PROTECTED_PROCESS_NAMES = new Set([
  'system', 'idle', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
  'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'memory compression', 'msmpeng.exe',
]);

async function killProcess(pid, tree) {
  pid = parseInt(pid, 10);
  if (!Number.isInteger(pid) || pid <= 4) throw new Error('Refusing to kill this process');
  if (pid === process.pid) throw new Error('That is the PCBot Manager server itself');
  const info = await psJson(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ name=[string]$p.Name } | ConvertTo-Json -Compress }`);
  if (!info) throw new Error('Process no longer exists');
  if (PROTECTED_PROCESS_NAMES.has(info.name.toLowerCase())) throw new Error(`${info.name} is a core Windows process - killing it can crash or log out the system`);
  const result = await psJson(`
$out = & taskkill.exe /PID ${pid} /F ${tree ? '/T' : ''} 2>&1
[pscustomobject]@{ code=$LASTEXITCODE; text=($out -join ' ') } | ConvertTo-Json -Compress`);
  if (result.code !== 0) throw new Error(result.text || 'taskkill failed');
  return { ok: true, name: info.name, text: result.text };
}

async function network() {
  const data = await psJson(`
$names = @{}; Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }
$paths = @{}; Get-CimInstance Win32_Process | ForEach-Object { $paths[[int]$_.ProcessId] = [string]$_.ExecutablePath }
$tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.State -in 'Listen','Established' } | ForEach-Object {
  [pscustomobject]@{ proto='TCP'; state=[string]$_.State; local=[string]$_.LocalAddress; lport=[int]$_.LocalPort
    remote=[string]$_.RemoteAddress; rport=[int]$_.RemotePort; pid=[int]$_.OwningProcess
    process=[string]$names[[int]$_.OwningProcess]; path=$paths[[int]$_.OwningProcess] } })
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in '0.0.0.0','::' } | ForEach-Object {
  [pscustomobject]@{ proto='UDP'; state='Listen'; local=[string]$_.LocalAddress; lport=[int]$_.LocalPort
    remote=''; rport=0; pid=[int]$_.OwningProcess; process=[string]$names[[int]$_.OwningProcess]; path=$paths[[int]$_.OwningProcess] } })
ConvertTo-Json @($tcp + $udp) -Depth 3 -Compress`, { timeoutMs: 60000 });
  return arr(data);
}

async function security() {
  const d = await psJson(`
$fw = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=[string]$_.Name; enabled=[bool]$_.Enabled } })
$hostsFile = "$env:WINDIR\\System32\\drivers\\etc\\hosts"
$hosts = @(Get-Content $hostsFile -ErrorAction SilentlyContinue | Where-Object { $_ -and $_ -notmatch '^\\s*#' } | ForEach-Object { [string]$_.Trim() })
$users = @(Get-LocalUser -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=[string]$_.Name; enabled=[bool]$_.Enabled; lastLogon=(ToMs $_.LastLogon); passwordLastSet=(ToMs $_.PasswordLastSet); description=[string]$_.Description } })
$admins = @()
try { $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object { [string]$_.Name }) } catch { $admins = @('(could not enumerate: ' + $_.Exception.Message + ')') }
$sys = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue
$ts = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -ErrorAction SilentlyContinue
$def = $null
try { $m = Get-MpComputerStatus -ErrorAction Stop; $def = [pscustomobject]@{ realtime=[bool]$m.RealTimeProtectionEnabled; av=[bool]$m.AntivirusEnabled; sigAge=[int]$m.AntivirusSignatureAge } } catch {}
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  [pscustomobject]@{ name=[string]$_.TaskName; folder=[string]$_.TaskPath; state=[string]$_.State; author=[string]$_.Author
    runs=(($_.Actions | ForEach-Object { ([string]$_.Execute + ' ' + [string]$_.Arguments).Trim() }) -join ' | ')
    lastRun=(ToMs $i.LastRunTime); nextRun=(ToMs $i.NextRunTime) } })
$services = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -and $_.PathName -notmatch '(?i)\\\\windows\\\\(system32|syswow64)\\\\svchost' -and $_.PathName -notmatch '(?i)^"?c:\\\\windows\\\\' } | ForEach-Object {
  [pscustomobject]@{ name=[string]$_.Name; display=[string]$_.DisplayName; state=[string]$_.State; path=[string]$_.PathName; account=[string]$_.StartName } })
[pscustomobject]@{
  firewall=$fw; hosts=$hosts; users=$users; admins=$admins; defender=$def
  uacEnabled=([int]$sys.EnableLUA -eq 1); uacPromptAdmin=[int]$sys.ConsentPromptBehaviorAdmin
  rdpEnabled=([int]$ts.fDenyTSConnections -eq 0)
  thirdPartyTasks=$tasks; thirdPartyServices=$services
} | ConvertTo-Json -Depth 4 -Compress`, { timeoutMs: 120000 });
  d.firewall = arr(d.firewall); d.hosts = arr(d.hosts); d.users = arr(d.users); d.admins = arr(d.admins);
  d.thirdPartyTasks = arr(d.thirdPartyTasks); d.thirdPartyServices = arr(d.thirdPartyServices);
  return d;
}

module.exports = { overview, processes, killProcess, network, security };
