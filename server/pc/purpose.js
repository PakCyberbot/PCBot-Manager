'use strict';
// Explains what a file or folder is, who created it, how critical it is, whether its owning
// program is still installed, and what that means for cleanup. Knowledge base first, then
// evidence from the folder's own contents.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const programs = require('./programs');
const system = require('./system');
const disk = require('./disk');

const HOME = os.homedir();
const E = process.env;
const LOCAL = E.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = E.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALLOW = path.join(HOME, 'AppData', 'LocalLow');
const PDATA = E.ProgramData || 'C:\\ProgramData';
const WIN = E.WINDIR || 'C:\\Windows';
const PF = E.ProgramFiles || 'C:\\Program Files';
const PF86 = E['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const DAY = 86400000;
const ORPHAN_IDLE_DAYS = 120;

const L = (p) => String(p || '').toLowerCase().replace(/\\+$/, '');
const under = (p, root) => { const a = L(p), b = L(root); return a === b || a.startsWith(b + '\\'); };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------- knowledge base: well-known names inside app-data style locations ----------------
// [names, owner, kind, criticality, short, detail, installKeys]   kind: system|appdata|cache|temp|logs|game|dev|config|secret|vm
const SYS = 'Windows';
const APP_KB = [
  [['microsoft'], 'Microsoft / Windows', 'system', 'important', 'Windows & Microsoft app data', 'Settings, caches and state for Windows components and Microsoft apps (Edge, Office, Teams, OneDrive, Windows shell, Credentials, Vault...). Several subfolders are needed for sign-in, search and the Start menu. Clean specific caches inside only; never delete the whole folder.'],
  [['packages'], SYS, 'system', 'important', 'Microsoft Store app data', 'One subfolder per installed Store/UWP app (named <App>_<publisherhash>) holding its settings, local state and caches - e.g. WSL distros keep their virtual disk here. Removed automatically when you uninstall the app; deleting by hand breaks the app.'],
  [['temp'], SYS, 'temp', 'disposable', 'Temporary files (%TEMP%)', 'Scratch space every program uses for installers, extractions and short-lived files. Programs are supposed to clean up but often don\'t. Anything not in use can be deleted; files still open are simply skipped.'],
  [['crashdumps'], SYS, 'logs', 'disposable', 'Crash dumps', 'Memory dumps Windows Error Reporting writes when an app crashes. Only useful to a developer debugging that crash.'],
  [['d3dscache'], SYS, 'cache', 'disposable', 'Direct3D shader cache', 'Compiled GPU shaders Windows/DirectX keeps so games and apps start faster. Rebuilt automatically.'],
  [['connecteddevicesplatform'], SYS, 'system', 'normal', 'Connected Devices Platform', 'Windows service data for Phone Link, cross-device clipboard, "Continue on PC" and nearby sharing.'],
  [['comms'], SYS, 'system', 'normal', 'Windows communications data', 'Data store for the built-in Mail/Calendar/People sync (unistore).'],
  [['placeholdertilelogofolder'], SYS, 'cache', 'disposable', 'Start menu tile logo cache', 'Cached app logos for the Start menu.'],
  [['publishers'], SYS, 'system', 'normal', 'Store publisher cache', 'Shared data for Store apps from the same publisher.'],
  [['virtualstore'], SYS, 'system', 'normal', 'UAC VirtualStore', 'Old programs that try to write into Program Files or Windows without admin rights get silently redirected here (UAC file virtualization). Contents belong to those legacy apps.'],
  [['peerdistrepub'], SYS, 'cache', 'disposable', 'BranchCache data', 'Windows BranchCache/peer distribution data; normally tiny.'],
  [['toastnotificationmanagercompat'], SYS, 'cache', 'disposable', 'Notification icon cache', 'Icons that desktop apps registered for Windows notifications.'],
  [['package cache'], 'Installer engines (WiX/Visual Studio/MSI)', 'program', 'important', 'Cached installers', 'Copies of setup packages (Visual C++ runtimes, SDKs, .NET...) kept so those programs can repair, modify or uninstall themselves. Deleting breaks their uninstall/repair - remove the programs instead.'],
  [['squirreltemp'], 'Squirrel installer', 'temp', 'disposable', 'Squirrel installer temp', 'Temporary files from the Squirrel installer used by Electron apps (Discord, Slack, Teams...).'],
  [['softwaredistribution'], SYS, 'system', 'critical', 'Windows Update data', 'Windows Update download and state store.'],
  [['usoprivate', 'usoshared'], SYS, 'system', 'important', 'Update Orchestrator data', 'State and logs of the Windows Update orchestrator.'],
  [['regid.1991-06.com.microsoft'], SYS, 'system', 'normal', 'Software ID tags', 'ISO 19770-2 software identification tags for licensing/inventory.'],
  [['ssh'], 'OpenSSH (Windows)', 'secret', 'critical', 'OpenSSH server keys/config', 'Host keys and config of the OpenSSH server feature. Deleting changes the machine\'s SSH identity.'],
  [['whesvc'], SYS, 'system', 'normal', 'Windows Health & Optimized Experiences service', 'Data for the WHESvc service.'],
  [['.identityservice', 'identityservice'], SYS, 'system', 'important', 'Microsoft identity/sign-in cache', 'Token broker cache for Microsoft account / Entra sign-in.'],
  [['speech'], SYS, 'system', 'normal', 'Speech recognition data', 'Windows speech/voice typing models and data.'],
  [['nvidia', 'nvidia corporation'], 'NVIDIA graphics driver / NVIDIA App', 'cache', 'normal', 'NVIDIA driver data & shader caches', 'DXCache/GLCache hold compiled game shaders (rebuilt automatically, first game loads are slower afterwards); other folders hold NVIDIA App/ShadowPlay/Broadcast settings.', ['nvidia']],
  [['intel'], 'Intel drivers', 'program', 'normal', 'Intel driver data', 'Data for Intel graphics/audio/management drivers.', ['intel']],
  [['lenovo'], 'Lenovo Vantage / Legion Space', 'program', 'normal', 'Lenovo OEM software data', 'Settings and caches of Lenovo Vantage, Legion Space, Lenovo Now and driver tools.', ['lenovo', 'legion']],
  [['nahimic', 'a-volute'], 'Nahimic audio (A-Volute)', 'program', 'normal', 'Nahimic audio software data', 'OEM audio effects software bundled with gaming laptops.', ['nahimic']],
  [['google'], 'Google (Chrome, Drive, Updater)', 'appdata', 'important', 'Google apps data', 'Chrome profiles (bookmarks, passwords, history, extensions) under Chrome\\User Data, plus Google Drive and Google Updater. The Chrome profile is irreplaceable unless synced.', ['google', 'chrome']],
  [['bravesoftware'], 'Brave browser', 'appdata', 'important', 'Brave browser profile', 'Brave profiles: bookmarks, saved passwords, history, extensions, sessions. Caches inside (Cache, Code Cache, GPUCache) are disposable; the rest is your browsing data.', ['brave']],
  [['mozilla'], 'Mozilla Firefox', 'appdata', 'important', 'Firefox profiles/caches', 'Roaming holds Firefox profiles (bookmarks, passwords, extensions); Local holds caches.', ['firefox', 'mozilla']],
  [['discord'], 'Discord', 'appdata', 'normal', 'Discord app + cache', 'Local holds the installed Discord app (Squirrel); Roaming holds settings and a large media cache.', ['discord']],
  [['code'], 'Visual Studio Code', 'appdata', 'normal', 'VS Code settings & caches', 'User settings, keybindings, snippets, workspace storage and caches of VS Code. Extensions live in ~/.vscode.', ['visualstudiocode', 'vscode', 'code']],
  [['npm-cache'], 'npm (Node.js)', 'cache', 'disposable', 'npm download cache', 'Every package npm has downloaded, so reinstalls are faster/offline. Equivalent to `npm cache clean --force`.', ['npm', 'node']],
  [['npm'], 'npm (Node.js)', 'program', 'important', 'Global npm packages', 'Globally installed npm CLIs (claude, gemini, ...). Deleting removes those commands.', ['npm', 'node']],
  [['pip'], 'pip (Python)', 'cache', 'disposable', 'pip download cache', 'Downloaded Python wheels for faster reinstalls (`pip cache purge`).', ['python', 'pip']],
  [['uv'], 'uv (Python package manager)', 'cache', 'normal', 'uv cache & managed Pythons', 'Local\\uv\\cache is a disposable package cache (`uv cache clean`); Roaming\\uv\\python holds Python versions uv installed (needed by projects using them).', ['uv']],
  [['conda', 'conda-anaconda-tos', '.conda', '.anaconda', '.continuum'], 'Anaconda / conda', 'appdata', 'normal', 'conda settings & metadata', 'conda/Anaconda configuration, environment list and terms-of-service acceptance.', ['anaconda', 'conda']],
  [['python'], 'Python install manager', 'program', 'important', 'Python installations', 'Python versions installed by the Python install manager / python.org (pythoncore-3.x) plus the `py`/`python` shims.', ['python']],
  [['nvm'], 'nvm-windows', 'program', 'important', 'Node.js versions (nvm)', 'Each installed Node.js version with its global packages. `nvm uninstall <ver>` removes one cleanly.', ['nvm', 'node']],
  [['node-gyp'], 'node-gyp', 'cache', 'disposable', 'Node native-addon headers cache', 'Node.js headers downloaded to compile native modules; re-downloaded on demand.', ['node']],
  [['electron', 'electron-builder'], 'Electron tooling', 'cache', 'disposable', 'Electron download cache', 'Cached Electron binaries from building/running Electron apps.', ['node']],
  [['cef'], 'Chromium Embedded Framework apps', 'cache', 'disposable', 'CEF cache', 'Browser cache of an app embedding Chromium (games launchers, tools).'],
  [['docker', 'dockerdesktop', 'docker desktop', 'docker-secrets-engine', '.docker'], 'Docker Desktop', 'vm', 'important', 'Docker Desktop data', 'Settings and the WSL virtual disk holding all images, containers and volumes. Free space with `docker system prune -a` or Docker Desktop > Troubleshoot > Clean/Purge, never by deleting files.', ['docker']],
  [['wsl'], 'Windows Subsystem for Linux', 'vm', 'important', 'WSL data', 'WSL system distro/kernel state. Linux distros themselves live under Packages (Store) or custom locations.', ['wsl']],
  [['vmware'], 'VMware Workstation', 'appdata', 'normal', 'VMware settings', 'VMware Workstation preferences and inventory (VMs themselves are where you created them).', ['vmware']],
  [['.ld9virtualbox'], 'LDPlayer emulator', 'vm', 'normal', 'LDPlayer VirtualBox state', 'Leftover/active VirtualBox data from the LDPlayer Android emulator.', ['ldplayer']],
  [['ollama', 'ollama app.exe', '.ollama'], 'Ollama', 'appdata', 'normal', 'Ollama app data / models', '~/.ollama/models holds downloaded LLMs (manage with `ollama list` / `ollama rm`); AppData holds the app and logs.', ['ollama']],
  [['steam'], 'Steam', 'appdata', 'normal', 'Steam data', 'Steam client cache/web data.', ['steam']],
  [['epic games', 'epicgameslauncher', 'epic', 'epicinstallertemp', 'unrealengine', 'unrealenginelauncher'], 'Epic Games Launcher', 'appdata', 'normal', 'Epic Games / Unreal data', 'Epic launcher settings, webcache, install manifests and Unreal Engine shared caches.', ['epic', 'unreal']],
  [['rockstar games'], 'Rockstar Games Launcher / GTA / RDR2', 'game', 'normal', 'Rockstar games data', 'Rockstar launcher and game settings/shader caches.', ['rockstar', 'gta', 'grandtheftauto', 'reddeadredemption']],
  [['ubisoft'], 'Ubisoft Connect', 'game', 'normal', 'Ubisoft data', 'Ubisoft Connect client/game caches.', ['ubisoft', 'uplay']],
  [['electronic arts'], 'EA app / EA games', 'game', 'normal', 'EA games data', 'EA app and EA game settings/saves.', ['eaapp', 'battlefield', 'electronicarts', 'easports']],
  [['frostbite'], 'EA Frostbite engine (Battlefield, FC, Dragon Age...)', 'cache', 'normal', 'Frostbite engine cache', 'Shader/cache data written by games built on EA\'s Frostbite engine.', ['battlefield', 'electronicarts', 'eaapp', 'dragonage']],
  [['battlefield 6'], 'Battlefield 6 (EA)', 'game', 'important', 'Battlefield 6 settings & caches', 'Settings, shader cache and logs of Battlefield 6.', ['battlefield']],
  [['sun'], 'Java (Sun/Oracle)', 'cache', 'normal', 'Java deployment cache', 'Java Web Start/applet cache and Java control-panel settings - named after Sun Microsystems, Java\'s original creator.', ['java']],
  [['iisexpress', 'my web sites'], 'IIS Express (Visual Studio)', 'dev', 'normal', 'IIS Express web server data', 'Config and default sites folder of IIS Express, the local web server Visual Studio installs for ASP.NET development.', ['visualstudio', 'iisexpress']],
  [['io interactive'], 'IO Interactive (Hitman)', 'game', 'important', 'Hitman game data/saves', 'Settings, shader cache and possibly saves of IO Interactive games (Hitman World of Assassination).', ['hitman']],
  [['insomniac games', '.insomniac'], 'Insomniac Games (Spider-Man, Ratchet & Clank)', 'game', 'important', 'Insomniac game saves/settings', 'Saves and settings of Insomniac games on PC (Marvel\'s Spider-Man, Ratchet & Clank: Rift Apart).', ['spiderman', 'ratchet', 'insomniac']],
  [['sucker punch productions'], 'Sucker Punch (Ghost of Tsushima)', 'game', 'important', 'Ghost of Tsushima data', 'Settings/saves of Ghost of Tsushima.', ['tsushima']],
  [['machinegames'], 'MachineGames (Indiana Jones, Wolfenstein)', 'game', 'important', 'MachineGames saves', 'Saves of MachineGames titles (Indiana Jones and the Great Circle, Wolfenstein).', ['indiana', 'wolfenstein', 'machinegames']],
  [['daysgone', 'bendgame'], 'Days Gone (Bend Studio)', 'game', 'important', 'Days Gone saves/settings', 'Unreal Engine "Saved" folder of Days Gone: settings, logs and save games.', ['daysgone']],
  [['mgsdelta'], 'Metal Gear Solid Delta', 'game', 'important', 'MGS Delta saves/settings', 'Saved data of Metal Gear Solid Delta: Snake Eater.', ['metalgear', 'mgsdelta']],
  [['sparkingzero'], 'Dragon Ball: Sparking! ZERO', 'game', 'important', 'Sparking! ZERO saves/settings', 'Unreal "Saved" folder of Dragon Ball: Sparking! ZERO.', ['sparkingzero', 'dragonball']],
  [['forzahorizon5', 'forzahorizon6'], 'Forza Horizon', 'game', 'important', 'Forza Horizon saves/settings', 'Settings and local saves of Forza Horizon.', ['forza']],
  [['sekiro'], 'Sekiro: Shadows Die Twice', 'game', 'important', 'Sekiro saves', 'Save files of Sekiro (FromSoftware).', ['sekiro']],
  [['koeitecmo'], 'Koei Tecmo games', 'game', 'important', 'Koei Tecmo game data', 'Settings/saves of Koei Tecmo titles (Ninja Gaiden, Nioh, Dynasty Warriors...).', ['ninjagaiden', 'nioh', 'koeitecmo', 'dynasty']],
  [['flt'], 'Game crack group (FLT)', 'game', 'normal', 'Emulated-launcher game saves', 'Save data from a cracked game release (FLT). Holds that game\'s progress.'],
  [['ms-playwright-go', 'ms-playwright'], 'Playwright (browser automation)', 'cache', 'disposable', 'Playwright browser downloads', 'Chromium/Firefox/WebKit builds Playwright downloaded for automated browsing/testing; re-downloaded by `playwright install`.', ['playwright']],
  [['gitkrakencli', 'gk'], 'GitKraken CLI', 'appdata', 'normal', 'GitKraken CLI data', 'Binaries/config of the GitKraken `gk` command-line tool.', ['gitkraken']],
  [['minitoollimited'], 'MiniTool (Partition Wizard / Power Data Recovery)', 'appdata', 'normal', 'MiniTool app data', 'Settings/logs of MiniTool disk utilities.', ['minitool']],
  [['fanal'], 'Trivy (Aqua Security scanner)', 'cache', 'disposable', 'Trivy/fanal scan cache', 'Image/filesystem analysis cache of the Trivy vulnerability scanner ("fanal" is its analyzer library).', ['trivy']],
  [['changzhi2', 'lddownloader'], 'LDPlayer Android emulator', 'appdata', 'normal', 'LDPlayer data', 'Settings/downloader of LDPlayer (made by Changzhi).', ['ldplayer', 'dnplayer']],
  [['packer'], 'HashiCorp Packer', 'appdata', 'normal', 'Packer plugins/cache', 'Plugins and cache of HashiCorp Packer (machine image builder).', ['packer']],
  [['skylot'], 'jadx (Android decompiler by skylot)', 'cache', 'disposable', 'jadx decompiler cache', 'jadx stores decompiled-code caches here per opened APK; safe to clear, it re-decompiles on demand.', ['jadx']],
  [['ghidra'], 'Ghidra (NSA reverse engineering)', 'appdata', 'normal', 'Ghidra settings', 'Ghidra user preferences, plugin state and recent projects list (projects are stored elsewhere).', ['ghidra']],
  [['burpsuite'], 'Burp Suite', 'appdata', 'normal', 'Burp Suite settings', 'Burp user options, extensions and CA certificate.', ['burp']],
  [['frida'], 'Frida', 'appdata', 'normal', 'Frida data', 'Frida instrumentation toolkit cache/config.', ['frida']],
  [['apktool'], 'apktool', 'appdata', 'normal', 'apktool framework files', 'Android framework resources apktool needs to decode APKs.', ['apktool']],
  [['claude', 'claude-3p', 'claude-data', 'claude-cli-nodejs', 'claude code', '.claude'], 'Anthropic Claude (desktop app / Claude Code)', 'appdata', 'important', 'Claude app & Claude Code data', 'Desktop app data, Claude Code settings, project memory, session history and MCP configuration.', ['claude', 'anthropic']],
  [['openai', '.codex'], 'OpenAI (ChatGPT app / Codex CLI)', 'appdata', 'important', 'OpenAI apps data', 'ChatGPT desktop / Codex CLI configuration, sessions and sandbox binaries.', ['openai', 'codex', 'chatgpt']],
  [['.gemini'], 'Gemini CLI', 'appdata', 'normal', 'Gemini CLI settings', 'Gemini CLI config, auth and history.', ['gemini']],
  [['copilot', '.copilot'], 'GitHub/Microsoft Copilot', 'appdata', 'normal', 'Copilot data', 'Copilot app or CLI configuration.', ['copilot']],
  [['antigravity', 'antigravity-updater', 'agy'], 'Google Antigravity IDE', 'appdata', 'normal', 'Antigravity IDE data', 'Settings, extensions and updater for the Antigravity agentic IDE.', ['antigravity']],
  [['zcode', '.zcode', '@zcodedesktop-updater'], 'ZCode desktop', 'appdata', 'normal', 'ZCode app data', 'Data and updater of the ZCode desktop app.', ['zcode']],
  [['5ire', '5ire-updater'], '5ire (AI assistant)', 'appdata', 'normal', '5ire app data', 'Chats/settings of the 5ire AI desktop client.', ['5ire']],
  [['notion', 'notion-updater'], 'Notion', 'appdata', 'normal', 'Notion cache', 'Offline cache of your Notion workspace (re-synced from the cloud).', ['notion']],
  [['obsidian', 'obsidian-updater'], 'Obsidian', 'appdata', 'normal', 'Obsidian app settings', 'Obsidian app config; your vaults are separate folders.', ['obsidian']],
  [['obs-studio', 'obs-studio-hook'], 'OBS Studio', 'appdata', 'normal', 'OBS scenes & profiles', 'Scene collections, profiles and logs of OBS Studio (obs-studio-hook = the game-capture DLLs it injects).', ['obsstudio']],
  [['blender foundation', 'blendermcp'], 'Blender', 'appdata', 'normal', 'Blender preferences/add-ons', 'Per-version Blender config, add-ons and startup file.', ['blender']],
  [['adobe', 'adobe_systems_incorporate', 'com.adobe.dunamis'], 'Adobe (Creative Cloud apps)', 'appdata', 'normal', 'Adobe app data', 'Preferences, caches and logs of Photoshop/Premiere/Creative Cloud.', ['adobe', 'photoshop', 'premiere']],
  [['avast software'], 'Avast One / Avast browser', 'program', 'important', 'Avast antivirus data', 'Antivirus engine data, quarantine and logs, plus Avast Secure Browser data.', ['avast']],
  [['mcafee'], 'McAfee (WebAdvisor)', 'program', 'normal', 'McAfee data', 'Usually from WebAdvisor bundled with other installers.', ['mcafee']],
  [['everything'], 'Everything (voidtools)', 'appdata', 'normal', 'Everything search index', 'Settings and the file-name database of the Everything search tool.', ['everything']],
  [['powertoys'], 'Microsoft PowerToys', 'appdata', 'normal', 'PowerToys settings', 'Settings and logs of PowerToys modules.', ['powertoys']],
  [['qbittorrent'], 'qBittorrent', 'appdata', 'normal', 'qBittorrent state', 'Torrent list/resume data and settings.', ['qbittorrent']],
  [['vlc'], 'VLC media player', 'appdata', 'normal', 'VLC settings', 'VLC preferences and media library.', ['vlc']],
  [['winrar'], 'WinRAR', 'appdata', 'normal', 'WinRAR settings', 'WinRAR settings/license.', ['winrar']],
  [['wiztree3'], 'WizTree', 'appdata', 'normal', 'WizTree settings', 'WizTree disk analyzer settings.', ['wiztree']],
  [['veracrypt'], 'VeraCrypt', 'config', 'important', 'VeraCrypt config', 'VeraCrypt preferences, favorite volumes and keyfile settings.', ['veracrypt']],
  [['openvpn connect'], 'OpenVPN Connect', 'config', 'important', 'OpenVPN profiles', 'Imported VPN profiles (may contain credentials/certs).', ['openvpn']],
  [['foxit software'], 'Foxit PDF Reader', 'appdata', 'normal', 'Foxit settings', 'Foxit Reader preferences and caches.', ['foxit']],
  [['xpdf'], 'Xpdf', 'appdata', 'normal', 'Xpdf settings', 'Xpdf tools config.', ['xpdf']],
  [['visual studio setup', 'microsoft devdiv'], 'Visual Studio Installer', 'program', 'normal', 'Visual Studio setup data', 'Visual Studio installer state and logs.', ['visualstudio']],
  [['jupyter', '.jupyter', '.ipython', '.ipynb_checkpoints', '.virtual_documents'], 'Jupyter / IPython', 'appdata', 'normal', 'Jupyter config & runtime', 'Kernel specs, runtime files and notebook checkpoints.', ['jupyter', 'python']],
  [['nltk_data'], 'NLTK (Python)', 'cache', 'normal', 'NLTK corpora', 'Downloaded NLTK language datasets; re-downloadable with nltk.download().', ['python']],
  [['terraform.d'], 'Terraform', 'config', 'normal', 'Terraform CLI config/plugins', 'Terraform credentials and provider plugin cache.', ['terraform']],
  [['kotlin', 'main.kts.compiled.cache'], 'Kotlin tooling', 'cache', 'disposable', 'Kotlin script cache', 'Compiled Kotlin script cache.', ['kotlin', 'java', 'androidstudio']],
  [['android', '.android'], 'Android SDK / Android Studio', 'dev', 'important', 'Android SDK / emulators', 'Local\\Android\\Sdk holds the SDK, platform-tools (adb) and system images; ~/.android holds emulators (AVDs) and debug keys. Manage via Android Studio SDK/Device Manager.', ['android', 'adb']],
  [['.gradle'], 'Gradle', 'cache', 'normal', 'Gradle caches & wrapper', 'Downloaded Gradle distributions and dependency caches; re-downloaded by the next build.', ['gradle', 'androidstudio', 'java']],
  [['.m2'], 'Maven', 'cache', 'normal', 'Maven local repository', 'Downloaded Java libraries; re-downloaded by the next build.', ['maven', 'java']],
  [['.cache'], 'Various CLI tools (XDG cache)', 'cache', 'normal', 'Tool caches', 'Cache dir used by Linux-style tools: Hugging Face models, pip, pre-commit, etc. Check subfolders - model downloads can be large but re-downloadable.'],
  [['.local'], 'User-installed CLI tools', 'program', 'important', 'Local binaries (~/.local)', '~/.local/bin holds user-installed commands (claude, uv, hf...) and ~/.local/share their data.'],
  [['.config'], 'Various CLI tools', 'config', 'normal', 'Tool configuration', 'Linux-style config folder for CLI tools.'],
  [['.vscode', '.vscode-shared'], 'Visual Studio Code', 'program', 'normal', 'VS Code extensions', 'Installed VS Code extensions (each ships its own files). Remove extensions from inside VS Code.', ['code', 'vscode']],
  [['.ssh'], 'OpenSSH client', 'secret', 'critical', 'Your SSH keys', 'Private keys, known_hosts and SSH config. Losing private keys locks you out of servers/Git. Never delete; back up securely.'],
  [['.aws'], 'AWS CLI', 'secret', 'critical', 'AWS credentials', 'AWS access keys and profiles. Treat as secrets.'],
  [['.azure'], 'Azure CLI', 'secret', 'important', 'Azure CLI tokens', 'Azure CLI login tokens and config.'],
  [['.gitconfig'], 'Git', 'config', 'important', 'Your Git identity/config', 'Global Git settings (name, email, aliases, credential helper).'],
  [['.wslconfig'], 'WSL', 'config', 'important', 'WSL global settings', 'Memory/CPU/network limits for WSL2.'],
  [['.bash_history', '.python_history'], 'Shells', 'logs', 'normal', 'Command history', 'Commands you typed in Git Bash / Python REPL. May contain secrets typed on the command line.'],
  [['.thumbnails'], 'Linux-style apps', 'cache', 'disposable', 'Thumbnail cache', 'Thumbnail cache from cross-platform apps.'],
  [['.matplotlib'], 'matplotlib', 'cache', 'disposable', 'matplotlib font cache', 'Font cache rebuilt automatically.', ['python']],
  [['.u2net', '.rembg'], 'rembg (background removal)', 'cache', 'normal', 'rembg AI models', 'U2Net background-removal models downloaded by rembg; re-downloaded on use.', ['python']],
  [['.objection'], 'objection (Frida mobile toolkit)', 'appdata', 'normal', 'objection data', 'Config/history of the objection mobile pentest tool.', ['frida', 'objection']],
  [['.emulator_console_auth_token'], 'Android Emulator', 'secret', 'normal', 'Emulator console token', 'Auth token for the Android emulator telnet console.', ['android']],
  [['.manager_trash'], 'PCBot Manager', 'temp', 'normal', 'PCBot Manager PC Trash', 'Items you moved to PC Trash from this dashboard. Restore or delete them from the PC Trash view.'],
  [['goldberg socialclub emu saves', 'goldberg uplayemu saves', 'gse saves', 'empress'], 'Steam/Ubisoft/Rockstar emulator (game cracks)', 'game', 'normal', 'Emulated-launcher game saves', 'Save data written by launcher emulators (Goldberg/GSE/EMPRESS) that cracked or LAN copies of games use instead of the real Steam/Ubisoft/Rockstar client. These are your game saves for those copies - delete only if you no longer play them.'],
  [['my games', 'saved games'], 'Games', 'game', 'important', 'Game saves & settings', 'Standard locations where many PC games keep saves and config. Deleting loses progress for games without cloud saves.'],
];
APP_KB.push(
  [['anaconda3', 'miniconda3'], 'Anaconda / Miniconda installer', 'program', 'important', 'Anaconda Python distribution', 'A full Python distribution (conda, Python, hundreds of data-science packages; envs\\ holds conda environments, pkgs\\ is a re-downloadable package cache - `conda clean --all` shrinks it). Uninstall via its uninstaller, not by deleting.', ['anaconda', 'conda']],
  [['scoop'], 'Scoop package manager', 'program', 'important', 'Scoop apps', 'Command-line package manager: apps\\ holds installed tools, shims\\ puts them on PATH, cache\\ keeps downloaded installers (`scoop cache rm *`).', ['scoop']],
  [['pipx'], 'pipx', 'program', 'important', 'pipx-installed CLI tools', 'Each Python CLI installed with pipx lives in its own venv here.', ['pipx']],
);

// Intent of common user-made folder names (only used for folders you created in your own areas).
const USER_NAMES = [
  [/^games?$/i, 'game', 'Your game library', 'Games you installed yourself (outside Steam/Epic or as their library folder).'],
  [/^(vms?|virtual ?machines?)$/i, 'vm', 'Your virtual machines', 'Virtual machine folders (VMware/VirtualBox/Hyper-V disks and configs).'],
  [/^backups?$/i, 'user', 'Your backups', 'Copies you made to keep safe - check before deleting.'],
  [/^(learning|courses?|study|tutorials?)$/i, 'user', 'Learning material', 'Courses, tutorials and study notes you collected.'],
  [/^(tools|softwares?|cybertools|utilities)$/i, 'program', 'Your tools collection', 'Programs/installers/tools you downloaded and keep together.'],
  [/^scripts?$/i, 'dev', 'Your scripts', 'Scripts you wrote or collected (if it is on PATH, its commands are runnable anywhere).'],
  [/^(projects?|work|programming|code|dev|src|repos?)$/i, 'dev', 'Your work/projects area', 'Where you keep your projects and work.'],
  [/^(te?mp|scratch|tmp or research)$/i, 'temp', 'Your scratch folder', 'A personal temporary area - usually safe to review and empty.'],
  [/^(keys|secrets|credentials)$/i, 'secret', 'Keys / credentials (sensitive!)', 'By its name, sensitive material. Keep it backed up and protected; never share.'],
  [/^leaks?$/i, 'secret', 'Leak/dump research data (sensitive)', 'By its name, collected leak or dump data - sensitive, keep protected.'],
  [/^(ent|entertainment|movies|series|shows)$/i, 'media', 'Entertainment media', 'Movies/shows/media you keep for entertainment.'],
  [/^icons?$/i, 'media', 'Icons', 'Icon files you collected.'],
  [/^(androidstudioprojects)$/i, 'dev', 'Android Studio projects', 'Default folder where Android Studio creates new projects.'],
];
const KB_INDEX = new Map();
for (const e of APP_KB) for (const n of e[0]) KB_INDEX.set(n, e);

// Standard Windows / profile locations, matched by full path.
function pathRules() {
  const r = (p, owner, kind, crit, short, detail) => ({ p: L(p), owner, kind, crit, short, detail });
  return [
    r('C:\\', SYS, 'system', 'critical', 'System drive root', 'Top of the C: drive: Windows, Program Files, ProgramData, Users and a few hidden system folders (Recovery, System Volume Information, $Recycle.Bin, pagefile/hiberfil).'),
    r(WIN, SYS, 'system', 'critical', 'Windows operating system', 'The operating system itself. Never delete or move anything here manually; use Disk Cleanup / Storage Sense for its temp and update leftovers.'),
    r(path.join(WIN, 'System32'), SYS, 'system', 'critical', 'Core Windows binaries (64-bit)', 'Kernel, drivers, services and system DLLs. Touching this can make Windows unbootable.'),
    r(path.join(WIN, 'SysWOW64'), SYS, 'system', 'critical', '32-bit Windows binaries', 'System DLLs for 32-bit programs (Windows-on-Windows 64).'),
    r(path.join(WIN, 'WinSxS'), SYS, 'system', 'critical', 'Windows component store', 'Every version of every Windows component (for updates/rollback). Looks huge but is hard-linked; shrink only with `Dism /Online /Cleanup-Image /StartComponentCleanup`.'),
    r(path.join(WIN, 'Temp'), SYS, 'temp', 'disposable', 'System temp folder', 'Temp files of services and installers running as SYSTEM.'),
    r(path.join(WIN, 'Installer'), SYS, 'system', 'critical', 'MSI installer cache', 'Cached .msi/.msp packages needed to repair, update or uninstall programs. Never delete by hand.'),
    r(path.join(WIN, 'Prefetch'), SYS, 'cache', 'normal', 'Prefetch (app launch traces)', 'Windows records which files each program loads at start to speed up launches. A classic forensic source of program-execution history.'),
    r(PF, SYS, 'program', 'critical', 'Installed 64-bit programs', 'Where installers put 64-bit applications. Remove programs with their uninstaller (Programs view), not by deleting folders.'),
    r(PF86, SYS, 'program', 'critical', 'Installed 32-bit programs', 'Where installers put 32-bit applications.'),
    r(PDATA, SYS, 'system', 'important', 'Shared app data (all users)', 'Machine-wide settings, licenses, caches and installer data of programs and services. Hidden by default.'),
    r('C:\\Users', SYS, 'system', 'critical', 'User profiles', 'One folder per Windows account plus Public and Default (template for new accounts).'),
    r(HOME, 'Windows (your account)', 'user', 'critical', 'Your user profile', 'Everything that belongs to your account: documents, desktop, downloads, app settings (AppData) and tool folders (.ssh, .config, ...).'),
    r(path.join(HOME, 'AppData'), SYS, 'appdata', 'critical', 'Per-user application data', 'Hidden folder where programs keep your settings and data. Local = this PC only (caches, big data), Roaming = follows your account, LocalLow = sandboxed/low-integrity apps (browsers, games).'),
    r(LOCAL, SYS, 'appdata', 'critical', 'AppData\\Local', 'Machine-specific app data: caches, browser profiles, per-user installed programs (Programs), Temp. The biggest AppData folder.'),
    r(ROAMING, SYS, 'appdata', 'critical', 'AppData\\Roaming', 'App settings designed to roam with your account (and the Start menu, SendTo, recent items).'),
    r(LOCALLOW, SYS, 'appdata', 'important', 'AppData\\LocalLow', 'Data for low-integrity apps: sandboxed browser parts, Java, and many Unity games (saves/logs).'),
    r(path.join(LOCAL, 'Programs'), SYS, 'program', 'important', 'Per-user installed programs', 'Apps installed only for you without admin rights (VS Code, Discord, Notion, Python...). Uninstall them normally.'),
    r(path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu'), SYS, 'system', 'important', 'Your Start menu', 'Shortcuts shown in your Start menu, including the Startup folder (programs that run at login).'),
    r(path.join(ROAMING, 'Microsoft', 'Windows', 'Recent'), SYS, 'logs', 'normal', 'Recent items', 'Shortcuts to files you opened recently - a common forensic artifact for user activity.'),
    r(path.join(HOME, 'Desktop'), 'You', 'user', 'important', 'Desktop', 'Files and shortcuts on your desktop.'),
    r(path.join(HOME, 'Documents'), 'You + apps', 'user', 'important', 'Documents', 'Your documents; many apps and games also create their own subfolders here.'),
    r(path.join(HOME, 'Downloads'), 'You (browsers save here)', 'user', 'normal', 'Downloads', 'Everything browsers and apps downloaded. Usually the easiest place to reclaim space: installers you already ran, old archives, media you watched.'),
    r(path.join(HOME, 'Pictures'), 'You', 'user', 'important', 'Pictures', 'Your photos/screenshots.'),
    r(path.join(HOME, 'Videos'), 'You', 'user', 'important', 'Videos', 'Your videos and screen recordings (NVIDIA/Xbox captures land here).'),
    r(path.join(HOME, 'Music'), 'You', 'user', 'important', 'Music', 'Your music.'),
    r(path.join(HOME, 'OneDrive'), 'Microsoft OneDrive', 'user', 'important', 'OneDrive sync folder', 'Files synced with OneDrive; many may be online-only placeholders.'),
    r(path.join(HOME, 'Favorites'), SYS, 'user', 'normal', 'Internet Explorer favorites', 'Legacy IE/Edge favorites folder.'),
    r(path.join(HOME, 'Links'), SYS, 'user', 'normal', 'Explorer quick links', 'Legacy Explorer "Links" favorites.'),
    r(path.join(HOME, 'Contacts'), SYS, 'user', 'normal', 'Windows Contacts', 'Legacy Windows Contacts (.contact files).'),
    r(path.join(HOME, 'Searches'), SYS, 'user', 'normal', 'Saved searches', 'Saved Explorer searches.'),
    r(path.join(HOME, 'Saved Games'), 'Games', 'game', 'important', 'Saved Games', 'Windows standard folder for game saves.'),
    r(path.join(HOME, '3D Objects'), SYS, 'user', 'normal', '3D Objects', 'Legacy library folder for 3D files.'),
  ];
}
let PATH_RULES = null;

// ---------------- file-type knowledge ----------------
const EXT = {
  exe: ['program', 'Program or installer (Windows executable)'], msi: ['program', 'Windows Installer package - only needed to install/repair'], dll: ['program', 'Library used by a program'],
  lnk: ['config', 'Shortcut to another file/program'], url: ['config', 'Internet shortcut'], ini: ['config', 'Settings file'], json: ['config', 'Data/config (JSON)'], yaml: ['config', 'Data/config (YAML)'], yml: ['config', 'Data/config (YAML)'], toml: ['config', 'Config (TOML)'],
  log: ['logs', 'Log file - diagnostic text written by a program'], etl: ['logs', 'Windows event trace log'], dmp: ['logs', 'Crash/memory dump'], tmp: ['temp', 'Temporary file'], bak: ['temp', 'Backup copy'], old: ['temp', 'Old copy kept during an update'],
  crdownload: ['temp', 'Unfinished Chrome/Brave download'], part: ['temp', 'Unfinished download'], partial: ['temp', 'Unfinished download'],
  zip: ['archive', 'Compressed archive'], rar: ['archive', 'Compressed archive'], '7z': ['archive', 'Compressed archive'], tar: ['archive', 'Archive'], gz: ['archive', 'Compressed file'], torrent: ['download', 'Torrent metadata file (points to a download)'],
  iso: ['vm', 'Disk image (OS installer or game)'], img: ['vm', 'Disk image'], vhd: ['vm', 'Virtual hard disk'], vhdx: ['vm', 'Virtual hard disk (Hyper-V/WSL/Docker)'], vmdk: ['vm', 'VMware virtual disk'], vdi: ['vm', 'VirtualBox virtual disk'],
  gguf: ['dev', 'Quantized large language model (llama.cpp/Ollama format)'], safetensors: ['dev', 'AI model weights (safetensors)'], ckpt: ['dev', 'AI model checkpoint'], pt: ['dev', 'PyTorch model/tensor file'], pth: ['dev', 'PyTorch model weights'], onnx: ['dev', 'ONNX AI model'],
  apk: ['program', 'Android app package'], xapk: ['program', 'Android app bundle'], jar: ['program', 'Java program/library'], py: ['dev', 'Python script'], js: ['dev', 'JavaScript source'], ts: ['dev', 'TypeScript source'], ps1: ['dev', 'PowerShell script'], bat: ['dev', 'Batch script'], cmd: ['dev', 'Batch script'], sh: ['dev', 'Shell script'],
  pdf: ['user', 'PDF document'], docx: ['user', 'Word document'], xlsx: ['user', 'Excel spreadsheet'], pptx: ['user', 'PowerPoint deck'], txt: ['user', 'Text file'], md: ['user', 'Markdown notes/docs'],
  mp4: ['media', 'Video'], mkv: ['media', 'Video'], mov: ['media', 'Video'], avi: ['media', 'Video'], webm: ['media', 'Video'], mp3: ['media', 'Audio'], wav: ['media', 'Audio'], flac: ['media', 'Audio'],
  jpg: ['media', 'Image'], jpeg: ['media', 'Image'], png: ['media', 'Image'], gif: ['media', 'Image'], webp: ['media', 'Image'], psd: ['media', 'Photoshop project'], heic: ['media', 'Photo (HEIC)'],
  sqlite: ['appdata', 'SQLite database'], db: ['appdata', 'Database'], kdbx: ['secret', 'KeePass password database'], pem: ['secret', 'Certificate/key'], key: ['secret', 'Private key'], pfx: ['secret', 'Certificate with private key'], ovpn: ['secret', 'VPN profile (may hold credentials)'],
  pak: ['game', 'Game asset package'], bin: ['program', 'Binary data'], sav: ['game', 'Game save'],
};
const SPECIAL_FILES = {
  'desktop.ini': ['config', 'system', 'Folder appearance settings', 'Hidden file Explorer uses for a folder\'s custom icon/name. Harmless; recreated when you customize the folder.'],
  'thumbs.db': ['cache', 'disposable', 'Thumbnail cache', 'Old-style thumbnail cache. Safe to delete.'],
  'ntuser.dat': ['system', 'critical', 'Your registry hive', 'HKEY_CURRENT_USER: all your Windows and app settings. Loaded while you are signed in.'],
  'pagefile.sys': ['system', 'critical', 'Windows page file', 'Virtual memory. Manage size in System > Advanced > Performance.'],
  'hiberfil.sys': ['system', 'critical', 'Hibernation file', 'Saved RAM for hibernate/fast startup. Remove with `powercfg /h off` if you never hibernate.'],
  'swapfile.sys': ['system', 'critical', 'Store-app swap file', 'Used by Windows to suspend Store apps.'],
};

// ---------------- owner index: what is installed / present on this PC ----------------
const STOP = new Set(['software', 'games', 'game', 'studio', 'studios', 'inc', 'corporation', 'corp', 'llc', 'ltd', 'limited', 'systems', 'technologies', 'entertainment',
  'interactive', 'productions', 'foundation', 'team', 'desktop', 'app', 'apps', 'data', 'launcher', 'the', 'and', 'for', 'tools', 'tool', 'windows', 'microsoft', 'update', 'updater', 'cache', 'files', 'local', 'common',
  'player', 'media', 'reader', 'manager', 'service', 'services', 'server', 'client', 'helper', 'driver', 'drivers', 'runtime', 'center', 'centre', 'viewer', 'editor', 'studio', 'audio', 'video',
  'graphics', 'control', 'panel', 'settings', 'setup', 'installer', 'package', 'packages', 'framework', 'library', 'plugin', 'extension', 'browser', 'web', 'online', 'security', 'system',
  'edition', 'version', 'preview', 'beta', 'free', 'pro', 'professional', 'home', 'mobile', 'connect', 'cloud', 'sync', 'assistant', 'engine', 'support', 'network', 'components', 'redistributable']);
let ownerIndex = { at: 0, entries: null, building: null };

function addEntry(list, label, raw) { const n = norm(raw); if (n.length >= 3) list.push({ n, label }); }
function readDirNames(d) { try { return fs.readdirSync(d); } catch { return []; } }

async function buildOwnerIndex() {
  const list = [];
  const [progs, procs] = await Promise.all([programs.programs(false).catch(() => null), system.processes().catch(() => [])]);
  for (const p of (progs && progs.programs) || []) {
    addEntry(list, p.name, p.name);
    if (p.publisher) addEntry(list, `${p.name} (${p.publisher})`, p.publisher);
    if (p.location) { const loc = p.location.replace(/^"|"$/g, '').replace(/\\+$/, ''); addEntry(list, p.name, path.basename(loc)); }
    for (const w of p.name.split(/[\s\-_.()]+/)) if (w.length >= 4 && !STOP.has(w.toLowerCase())) addEntry(list, p.name, w);
  }
  for (const pr of procs) if (pr.path) {
    const parts = pr.path.split('\\');
    addEntry(list, `${pr.name} (running)`, path.basename(pr.path, '.exe'));
    for (const seg of parts.slice(1, -1)) if (!STOP.has(seg.toLowerCase()) && !/^(users|appdata|local|roaming|program files.*|programdata|windows|system32|bin|app.*|\d.*)$/i.test(seg)) addEntry(list, `${pr.name} (running)`, seg);
  }
  const startMenus = [path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(PDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const walkNames = (d, depth) => { for (const n of readDirNames(d)) { const f = path.join(d, n); addEntry(list, `${n.replace(/\.lnk$/i, '')} (Start menu)`, n.replace(/\.lnk$/i, '')); if (depth < 2 && !n.includes('.')) walkNames(f, depth + 1); } };
  for (const s of startMenus) walkNames(s, 0);
  for (const g of readDirNames(path.join(HOME, 'GAMES'))) addEntry(list, `${g} (GAMES folder)`, g);
  for (const t of readDirNames(path.join(HOME, 'CyberTools'))) addEntry(list, `${t} (CyberTools)`, t);
  for (const s of readDirNames(path.join(HOME, 'scoop', 'apps'))) addEntry(list, `${s} (scoop)`, s);
  // Steam libraries
  const steamRoots = [path.join(PF86, 'Steam')];
  try {
    const vdf = fs.readFileSync(path.join(PF86, 'Steam', 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) steamRoots.push(m[1].replace(/\\\\/g, '\\'));
  } catch { /* no steam */ }
  for (const r of steamRoots) for (const g of readDirNames(path.join(r, 'steamapps', 'common'))) addEntry(list, `${g} (Steam)`, g);
  // Epic manifests
  for (const f of readDirNames(path.join(PDATA, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(PDATA, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests', f), 'utf8')); addEntry(list, `${j.DisplayName} (Epic)`, j.DisplayName); if (j.InstallLocation) addEntry(list, `${j.DisplayName} (Epic)`, path.basename(j.InstallLocation)); } catch { /* skip */ }
  }
  // Commands on PATH (CLI tools that never register as "installed programs")
  for (const d of (E.PATH || '').split(';').filter(Boolean)) {
    for (const n of readDirNames(d)) if (/\.(exe|cmd|bat)$/i.test(n)) addEntry(list, `${n} (on PATH)`, n.replace(/\.(exe|cmd|bat)$/i, ''));
    for (const seg of d.split('\\').slice(1)) if (!STOP.has(seg.toLowerCase()) && !/^(users|appdata|local|roaming|program files.*|programdata|windows|system32|bin|\d.*)$/i.test(seg)) addEntry(list, `${seg} (PATH folder)`, seg);
  }
  return list;
}

async function getOwnerIndex() {
  if (ownerIndex.entries && Date.now() - ownerIndex.at < 10 * 60 * 1000) return ownerIndex.entries;
  if (!ownerIndex.building) {
    ownerIndex.building = buildOwnerIndex().then((e) => { ownerIndex = { at: Date.now(), entries: e, building: null }; return e; })
      .catch((err) => { ownerIndex.building = null; throw err; });
  }
  return ownerIndex.building;
}

function findOwner(index, keys) {
  const cands = [...new Set(keys.map(norm).filter((k) => k.length >= 3))];
  for (const c of cands) {
    const exact = index.find((e) => e.n === c);
    if (exact) return exact.label;
  }
  for (const c of cands) {
    if (c.length < 4) continue;
    // Substring matches only for distinctive tokens (generic words like "player" were already dropped).
    const hit = index.find((e) => e.n.length >= 4 && !STOP.has(e.n) && (e.n.includes(c) || (c.includes(e.n) && e.n.length >= 6)));
    if (hit) return hit.label;
  }
  return null;
}

// ---------------- content inspection ----------------
async function peekDir(p) {
  let names;
  try { names = await fsp.readdir(p, { withFileTypes: true }); } catch (e) { return { error: e.code }; }
  const lower = new Set(names.map((d) => d.name.toLowerCase()));
  const ext = {};
  let files = 0, dirs = 0;
  for (const d of names.slice(0, 600)) {
    if (d.isDirectory()) dirs++;
    else { files++; const x = path.extname(d.name).slice(1).toLowerCase(); if (x) ext[x] = (ext[x] || 0) + 1; }
  }
  let newest = null;
  const toStat = [p, ...names.slice(0, 40).map((d) => path.join(p, d.name))];
  for (const f of toStat) { try { const m = (await fsp.stat(f)).mtimeMs; if (!newest || m > newest) newest = m; } catch { /* locked */ } }
  const readSmall = async (f, n = 4096) => { try { const h = await fsp.open(path.join(p, f), 'r'); const b = Buffer.alloc(n); const { bytesRead } = await h.read(b, 0, n, 0); await h.close(); return b.slice(0, bytesRead).toString('utf8'); } catch { return null; } };
  let readme = null;
  const rn = names.find((d) => /^readme(\.(md|txt|rst))?$/i.test(d.name));
  if (rn) {
    const t = await readSmall(rn.name);
    if (t) {
      const line = t.split(/\r?\n/).map((s) => s.replace(/^[#>*\s-]+/, '').replace(/<[^>]+>/g, '').replace(/[*_`]{1,3}/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
        .find((s) => s.length > 3 && !/^(!\[|\[!\[|```|---|===)/.test(s));
      if (line) readme = line.slice(0, 200);
    }
  }
  let pkg = null;
  if (lower.has('package.json')) { try { const j = JSON.parse(await readSmall('package.json', 65536)); pkg = { name: j.name, description: j.description }; } catch { /* bad json */ } }
  let venv = null;
  if (lower.has('pyvenv.cfg')) { const t = await readSmall('pyvenv.cfg'); const m = t && t.match(/version(?:_info)?\s*=\s*([\d.]+)/i); venv = m ? m[1] : '?'; }
  return { lower, ext, files, dirs, newest, readme, pkg, venv, exes: names.filter((d) => /\.exe$/i.test(d.name)).map((d) => d.name).slice(0, 5) };
}

function dominant(ext) {
  const groups = { images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'], videos: ['mp4', 'mkv', 'mov', 'avi', 'webm'], audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg'],
    documents: ['pdf', 'docx', 'doc', 'xlsx', 'pptx', 'txt', 'md'], archives: ['zip', 'rar', '7z', 'gz', 'tar'], logs: ['log', 'etl'], dumps: ['dmp'] };
  const total = Object.values(ext).reduce((a, b) => a + b, 0);
  if (total < 3) return null;
  for (const [g, xs] of Object.entries(groups)) { const c = xs.reduce((a, x) => a + (ext[x] || 0), 0); if (c / total >= 0.6) return { group: g, count: c, total }; }
  return null;
}

function contentKind(peek, name) {
  const has = (n) => peek.lower.has(n);
  const anyExt = (x) => (peek.ext[x] || 0) > 0;
  const projectBits = [];
  if (has('package.json')) projectBits.push('Node.js');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) projectBits.push('Python');
  if (has('cargo.toml')) projectBits.push('Rust');
  if (has('go.mod')) projectBits.push('Go');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts') || has('settings.gradle')) projectBits.push('Java/Android (Gradle/Maven)');
  if (anyExt('sln') || anyExt('csproj')) projectBits.push('.NET');
  if (has('cmakelists.txt') || has('makefile')) projectBits.push('C/C++');
  if (has('dockerfile') || has('docker-compose.yml') || has('compose.yaml')) projectBits.push('Docker');
  if (peek.venv) return { kind: 'dev', crit: 'disposable', short: `Python virtual environment (Python ${peek.venv})`, detail: 'An isolated Python environment (created by `python -m venv` / uv / virtualenv) with its own installed packages. It can be recreated from the project\'s requirements file, so it is regenerable - but make sure the project has one.' };
  if (projectBits.length || has('.git')) {
    const what = projectBits.length ? `${projectBits.join(' + ')} project` : 'Git repository';
    const desc = (peek.pkg && peek.pkg.description) || peek.readme;
    return { kind: 'dev', crit: 'important', short: what + (desc ? ` \u2014 ${desc}` : ''), detail: `Looks like a software project${has('.git') ? ' under Git version control' : ''} (${[...['package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod', 'build.gradle', '.git'].filter(has)].join(', ')}).${peek.pkg && peek.pkg.name ? ` Package name: ${peek.pkg.name}.` : ''}${peek.readme ? ` README says: "${peek.readme}".` : ''} Source code is your work - only its build outputs (node_modules, target, build, .venv) are regenerable.` };
  }
  if ([...peek.lower].some((n) => n.endsWith('_data')) && (has('unityplayer.dll') || has('unitycrashhandler64.exe'))) return { kind: 'game', crit: 'normal', short: 'Unity game installation', detail: `A game built with the Unity engine (${peek.exes.join(', ')}). Portable/unregistered install - delete the folder to remove it.` };
  if (has('engine') && [...peek.lower].some((n) => n.endsWith('.exe'))) return { kind: 'game', crit: 'normal', short: 'Unreal Engine game installation', detail: `A game built with Unreal Engine (${peek.exes.join(', ')}).` };
  if (has('steam_api64.dll') || has('steam_api.dll') || has('steam_emu.ini') || has('steam_settings')) return { kind: 'game', crit: 'normal', short: 'Game installation (Steam API)', detail: `A game folder (contains the Steam API${has('steam_settings') || has('steam_emu.ini') ? ' and a Steam emulator config, i.e. not launched through the real Steam client' : ''}). ${peek.exes.length ? 'Executables: ' + peek.exes.join(', ') : ''}` };
  if (peek.exes.length && (peek.ext.dll || 0) >= 2) return { kind: 'program', crit: 'normal', short: `Portable/installed program (${peek.exes.slice(0, 2).join(', ')})`, detail: `Contains an application: ${peek.exes.join(', ')} with its libraries.${peek.readme ? ` README: "${peek.readme}".` : ''} If it isn't registered as installed, it is a portable app - deleting the folder removes it.` };
  const launchers = [...peek.lower].filter((n) => /\.(bat|cmd|jar|sh|ps1)$/.test(n) && !/^(install|setup|uninstall|build|test)/.test(n));
  if (launchers.length && (has('lib') || has('libs') || has('jre') || has('bin') || has('support') || anyExt('jar'))) {
    return { kind: 'program', crit: 'normal', short: `Portable tool (start with ${launchers.slice(0, 2).join(' / ')})`, detail: `A self-contained program that runs from its folder via ${launchers.join(', ')} (bundled libraries${has('jre') ? ' and its own Java runtime' : ''}). Not registered as installed: deleting the folder removes it completely.${peek.readme ? ` README: "${peek.readme}".` : ''}` };
  }
  if (/cache/i.test(name)) return { kind: 'cache', crit: 'disposable', short: 'Cache folder', detail: 'By name, a cache: data a program can re-download or rebuild. Close the program before clearing it.' };
  if (/^(logs?|crash ?reports?|crashpad)$/i.test(name)) return { kind: 'logs', crit: 'disposable', short: 'Logs / crash reports', detail: 'Diagnostic output of a program. Only useful for troubleshooting.' };
  const dom = dominant(peek.ext);
  if (dom) return { kind: dom.group === 'logs' || dom.group === 'dumps' ? 'logs' : 'user', crit: dom.group === 'logs' || dom.group === 'dumps' ? 'disposable' : 'normal', short: `Mostly ${dom.group} (${dom.count} of ${dom.total} files)`, detail: `A folder of ${dom.group}${peek.readme ? ` - README: "${peek.readme}"` : ''}.` };
  if (peek.readme) return { kind: 'user', crit: 'normal', short: peek.readme, detail: `Its README begins: "${peek.readme}".` };
  return null;
}

function locationClass(p) {
  const parent = path.dirname(p);
  if ([LOCAL, ROAMING, LOCALLOW, PDATA].some((r) => L(parent) === L(r))) return 'appdata';
  if (L(parent) === L(HOME) && path.basename(p).startsWith('.')) return 'dotfolder';
  if ([path.join(HOME, 'Documents'), path.join(HOME, 'Documents', 'My Games'), path.join(HOME, 'Saved Games')].some((r) => L(parent) === L(r))) return 'documents';
  return null;
}

// ---------------- main ----------------
async function explain(p, { peek = true, aiPurposes = null } = {}) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Expected an absolute path');
  p = path.resolve(p);
  if (!PATH_RULES) PATH_RULES = pathRules();
  const name = path.basename(p) || p;
  const nl = name.toLowerCase();
  let st = null;
  try { st = await fsp.lstat(p); } catch { /* missing or locked */ }
  const isDir = st ? st.isDirectory() : true;
  const sizeInfo = isDir ? disk.knownSize(p) : { size: st ? st.size : null };
  const out = { path: p, name, isDir, size: sizeInfo.size, short: null, detail: null, createdBy: null, kind: 'unknown', criticality: 'normal',
    owner: null, ownerInstalled: null, orphan: false, lastActivity: st ? st.mtimeMs : null, evidence: [], cleanup: { verdict: 'keep', why: '' }, ai: null };

  const rule = PATH_RULES.find((r) => r.p === L(p));
  if (rule) Object.assign(out, { short: rule.short, detail: rule.detail, createdBy: rule.owner, kind: rule.kind, criticality: rule.crit });

  if (!out.short && under(p, WIN)) Object.assign(out, { short: 'Part of Windows', detail: 'Inside the Windows folder: owned by the operating system and its updates. Never delete manually.', createdBy: SYS, kind: 'system', criticality: 'critical' });
  if (!out.short && (under(p, PF) || under(p, PF86)) && L(path.dirname(p)) !== L(PF) && L(path.dirname(p)) !== L(PF86)) {
    Object.assign(out, { short: `Inside the installation of "${path.relative(under(p, PF) ? PF : PF86, p).split('\\')[0]}"`, detail: 'Files of an installed program. Remove the program with its uninstaller instead of deleting files.', createdBy: path.relative(under(p, PF) ? PF : PF86, p).split('\\')[0], kind: 'program', criticality: 'important' });
  }

  const loc = locationClass(p);
  // Name-based knowledge only applies where programs create folders (AppData/ProgramData/Documents, dot-folders,
  // the top of your profile) - a project folder named "code" or "temp" inside WORK is not VS Code or Windows Temp.
  const kbAllowed = !!loc || L(path.dirname(p)) === L(HOME);
  const kb = kbAllowed ? KB_INDEX.get(nl) : null;
  if (!out.short && kb) {
    Object.assign(out, { short: kb[4], detail: kb[5], createdBy: kb[1], kind: kb[2], criticality: kb[3] });
  }

  if (!isDir && !out.short) {
    const sp = SPECIAL_FILES[nl];
    if (sp) Object.assign(out, { kind: sp[0], criticality: sp[1], short: sp[2], detail: sp[3], createdBy: SYS });
    else {
      const x = path.extname(nl).slice(1);
      if (/^(fg|setup)-\d+\.bin$/i.test(name) || /repack/i.test(p)) Object.assign(out, { kind: 'download', criticality: 'normal', short: 'Game repack installer part', detail: 'Compressed installer data from a repack (e.g. FitGirl). Only needed to install or reinstall the game - once installed, these parts are dead weight.', createdBy: 'Downloaded by you' });
      else if (EXT[x]) Object.assign(out, { kind: EXT[x][0], short: EXT[x][1], detail: `A .${x} file: ${EXT[x][1].toLowerCase()}.`, criticality: EXT[x][0] === 'secret' ? 'critical' : EXT[x][0] === 'temp' ? 'disposable' : 'normal' });
    }
  }

  let peekRes = null;
  if (isDir && peek && st) {
    peekRes = await peekDir(p);
    if (!peekRes.error) {
      out.lastActivity = peekRes.newest || out.lastActivity;
      const ck = contentKind(peekRes, name);
      if (ck && (!out.short || out.kind === 'unknown')) Object.assign(out, ck, { criticality: ck.crit });
      else if (ck && out.kind !== 'system' && !rule) out.evidence.push('Contents: ' + ck.short);
      out.evidence.push(`${peekRes.dirs} folders, ${peekRes.files} files directly inside`);
    } else out.evidence.push('Could not read contents (' + peekRes.error + ')');
  }

  // Ownership: app-data style folders are created by a program - is that program still here?
  // Known entries without install keys (installer caches, emulator saves, shared infrastructure) have no single owning
  // program to look for, so they are never judged "orphaned".
  const kbWithoutOwner = kb && !kb[6];
  if (isDir && !kbWithoutOwner && (loc === 'appdata' || loc === 'dotfolder' || loc === 'documents') && out.kind !== 'system' && out.createdBy !== SYS) {
    try {
      const index = await getOwnerIndex();
      const keys = kb && kb[6] ? kb[6] : [name, ...name.split(/[\s\-_.@]+/).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()))];
      const owner = findOwner(index, keys);
      out.owner = owner;
      out.ownerInstalled = !!owner;
      if (!out.createdBy) out.createdBy = owner ? owner.replace(/\s*\((running|Start menu|on PATH|PATH folder|scoop|Steam|Epic|GAMES folder|CyberTools)\)$/, '') : `An application named "${name}" (by the folder name)`;
      if (owner) out.evidence.push(`Owner found on this PC: ${owner}`);
      else out.evidence.push(`No installed program, running process, Start menu entry, game library or PATH command matches "${name}"`);
      const idle = out.lastActivity ? Math.floor((Date.now() - out.lastActivity) / DAY) : null;
      if (!owner && idle !== null && idle >= ORPHAN_IDLE_DAYS && !['secret', 'config'].includes(out.kind)) {
        out.orphan = true;
        out.evidence.push(`Nothing written here for ${idle} days`);
      } else if (!owner && idle !== null) out.evidence.push(`Still written to recently (${idle} days ago) - something uses it (portable app, CLI tool or background component)`);
      if (!out.short) out.short = loc === 'dotfolder' ? `Settings/data folder of "${name.replace(/^\./, '')}"` : loc === 'documents' ? `App or game folder "${name}" in Documents` : `App data folder of "${name}"`;
      if (!out.detail) out.detail = loc === 'dotfolder' ? 'Dot-folders in your profile are created by command-line tools and cross-platform apps for their settings, caches and credentials.' : 'Programs create a folder named after themselves (or their publisher) in AppData/ProgramData/Documents to keep settings, caches, saves and logs.';
      if (out.kind === 'unknown') out.kind = loc === 'documents' ? 'user' : 'appdata';
    } catch (e) { out.evidence.push('Owner lookup failed: ' + e.message); }
  }

  // Your own folders: infer intent from the name, and summarize what's inside so the label is meaningful.
  if (isDir && under(p, HOME) && !loc && (!out.short || /^Your folder/.test(out.short)) && (!out.kind || ['unknown', 'user'].includes(out.kind) || !out.short)) {
    const intent = USER_NAMES.find(([re]) => re.test(name));
    const subs = peekRes && !peekRes.error ? (await fsp.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name) : [];
    const listText = subs.length ? `contains ${subs.slice(0, 6).join(', ')}${subs.length > 6 ? ` +${subs.length - 6} more` : ''}` : '';
    if (intent && !out.short) {
      Object.assign(out, { kind: intent[1], short: `${intent[2]}${listText ? ' — ' + listText : ''}`, detail: `${intent[3]} Folder name "${name}" suggests this purpose${subs.length ? `; it holds ${subs.length} subfolders (${subs.slice(0, 15).join(', ')}${subs.length > 15 ? ', ...' : ''})` : ''}.`, createdBy: 'You', criticality: intent[1] === 'secret' ? 'critical' : 'normal' });
    } else if (!out.short) {
      Object.assign(out, { short: `Your folder "${name}"${listText ? ' — ' + listText : ''}`, detail: `A folder you created to organize your files${subs.length ? `. Its subfolders (${subs.slice(0, 15).join(', ')}${subs.length > 15 ? ', ...' : ''}) show what you keep here` : ''}. Click into it to see each item explained.`, createdBy: 'You', kind: 'user' });
    }
  }

  if (!out.short) {
    if (isDir && under(p, HOME)) Object.assign(out, { short: `Your folder "${name}"`, detail: 'A folder you (or a program) created inside your profile.', createdBy: 'You (probably)', kind: 'user' });
    else Object.assign(out, { short: isDir ? 'Folder' : 'File', detail: 'No specific knowledge about this item.' });
  }
  if (!out.createdBy) {
    out.createdBy = out.kind === 'user' ? 'You' : out.kind === 'dev' ? 'You (development work)'
      : (out.kind === 'program' || out.kind === 'game') && under(p, HOME) ? 'You (downloaded/portable, not installed through an installer)' : 'Unknown';
  }

  // Cleanup guidance derived from all of the above.
  if (out.criticality === 'critical') out.cleanup = { verdict: 'keep', why: 'Critical: removing it breaks Windows, your account or loses secrets.' };
  else if (out.orphan) {
    const idle = Math.floor((Date.now() - out.lastActivity) / DAY);
    out.cleanup = { verdict: 'review', why: out.kind === 'game'
      ? `Leftover game data: no installed game matches "${name}" and it hasn't changed in ${idle} days. It may hold your save progress - keep it if you might reinstall/replay (or the game has no cloud saves); otherwise it's dead weight.`
      : `Likely leftover: the program that created it (${out.createdBy}) is no longer installed and nothing has used it for ${idle} days. Glance at the contents for anything you want to keep, then it can go.` };
  }
  else if (out.criticality === 'disposable' || ['cache', 'temp'].includes(out.kind)) out.cleanup = { verdict: 'safe', why: 'Regenerated automatically by its program; close the program first.' };
  else if (out.kind === 'logs') out.cleanup = { verdict: 'safe', why: 'Diagnostic output only.' };
  else if (['dev', 'user', 'media', 'download', 'archive', 'vm'].includes(out.kind)) out.cleanup = { verdict: 'review', why: 'Your data or work - only you can decide.' };
  else out.cleanup = { verdict: 'keep', why: 'In use by an installed program or Windows.' };

  if (aiPurposes) out.ai = aiPurposes.get(L(p)) || null;
  return out;
}

// Short labels for directory listings (cheap: no owner lookup unless it's an app-data style location).
async function explainMany(paths, opts) {
  const results = {};
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
    while (i < paths.length) { const p = paths[i++]; try { results[p] = await explain(p, opts); } catch (e) { results[p] = { error: e.message }; } }
  }));
  return results;
}

// Possible leftovers: app-data folders whose owner is gone and that nothing has touched for months.
async function findOrphans() {
  const roots = [LOCAL, ROAMING, LOCALLOW, PDATA, path.join(HOME, 'Documents'), path.join(HOME, 'Documents', 'My Games'), path.join(HOME, 'Saved Games')];
  const cands = [];
  for (const r of roots) for (const n of readDirNames(r)) { const f = path.join(r, n); try { if (fs.statSync(f).isDirectory()) cands.push(f); } catch { /* skip */ } }
  for (const n of readDirNames(HOME)) if (n.startsWith('.')) { const f = path.join(HOME, n); try { if (fs.statSync(f).isDirectory()) cands.push(f); } catch { /* skip */ } }
  const res = await explainMany(cands, { peek: true });
  return Object.values(res).filter((x) => x && x.orphan).sort((a, b) => (b.size || 0) - (a.size || 0));
}

function prewarm() { getOwnerIndex().catch(() => {}); }

module.exports = { explain, explainMany, findOrphans, prewarm };
