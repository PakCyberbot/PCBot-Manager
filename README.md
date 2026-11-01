# PCBot Manager

**PCBot Manager** is a local web dashboard to **understand, clean up and manage a Windows PC** - and optionally an
**Android phone** over USB - from one place. It explains what every folder is and who created it,
finds what's taking space and what's left over from uninstalled programs, shows what starts at
login, what's installed but unused, your browsers' extensions, dev runtimes and security posture,
and can hand the whole machine to an AI agent (Claude Code, Codex, Gemini or any other) for a
read-only audit.

Everything runs locally on your computer. Nothing is uploaded anywhere (unless you start an AI scan,
which sends a snapshot to the AI provider you chose). **Nothing is deleted without you clicking it**, and
"delete" means moving to a restorable trash first.

---

## Requirements

| | Required? | Notes |
|---|---|---|
| **Windows 10 or 11** | Yes | The PC features use Windows PowerShell 5.1 (built into Windows) and Windows APIs. |
| **Node.js 22.12+** (LTS) | Yes | https://nodejs.org or `winget install OpenJS.NodeJS.LTS`. Older Node versions can't load one of the dependencies; the app tells you if yours is too old. |
| **Git** | To clone | `winget install Git.Git` - or download the project as a ZIP instead. |
| Android Platform Tools (`adb`) | Only for the phone | `winget install Google.PlatformTools`, or the Android SDK from Android Studio. Must be on `PATH`. |
| Android SDK build-tools (`aapt`) | Optional | Shows real app names/icons for phone apps. Comes with Android Studio's SDK; auto-detected in `%LOCALAPPDATA%\Android\Sdk\build-tools`. |
| An AI CLI | Optional | For AI Scan: `npm i -g @anthropic-ai/claude-code`, `npm i -g @openai/codex`, `npm i -g @google/gemini-cli` (each needs its own login/subscription), or any command that reads a prompt on stdin. |

No admin rights are needed. Run it as your normal user. A few actions (toggling startup entries
registered "for all users", some uninstallers) ask Windows for elevation themselves.

---

## Install & run

```powershell
git clone <repository-url> PCBot-Manager
cd PCBot-Manager
npm install
npm start
```

Then open **http://127.0.0.1:4321**.

**Even easier:** double-click **`start.cmd`** in the project folder. It checks for Node.js, installs the
dependencies on first run, starts the server and opens your browser. Keep the window open while you
use the app; close it (or press Ctrl+C) to stop.

Use a different port if 4321 is taken:

```powershell
$env:PORT = 5000; npm start      # then open http://127.0.0.1:5000
```

### First steps

1. **Overview** loads right away (system, antivirus, attention list).
2. Click **Scan my profile** (any Overview/Storage/Cleanup page). It reads every file under your user
   profile once (about 1-3 minutes for a few million files) to get folder sizes, large files, duplicates and
   cleanup candidates. Results are saved, so later visits are instant. Rescan after big changes, or use
   **Scan whole C: drive** for everything.
3. Explore **Files & Storage** (hover or click "What is it"), **Cleanup**, **Programs**, **Startup**,
   **Browsers**, and so on.
4. Optional: **AI Scan** with your preferred AI CLI.

### Updating

```powershell
git pull
npm install
```

Your scan results, trash, favorites and AI reports live in `data/` and `cache/`, which are not tracked by
git, so updating never touches them.

---

## What it can do

### This PC

| View | What it does |
|---|---|
| **Overview** | CPU/RAM/disk/GPU/antivirus status, an "Attention" list (low disk, paused antivirus, reclaimable space, duplicates, unused programs, stale/disabled extensions, startup count), biggest folders, file-type breakdown, quick-launch favorites. |
| **AI Scan** | Let an AI agent audit the whole machine read-only and return a YAML report you act on (see below). |
| **Files & Storage** | Browse any folder with sizes for every subfolder, a **"What is it"** explanation per item, sort by size, open / show in Explorer / terminal here, move items to PC Trash. |
| **Cleanup** | Leftovers from uninstalled programs & games, build artifacts in your projects (node_modules, venvs, Rust/Gradle/.NET output), caches & temp, large files, duplicates (always keeps one copy), old downloads, and big folders to clean from their own app (Docker, Ollama, emulators, VMs). Every item says what it is and **why it was suggested**, labeled Safe / Review / Info only. |
| **Programs** | Desktop + Store apps with icons, size, install date, **last launched** (from Windows' own launch history) or "running now", status filters (not used 90d+, idle, active, no record, runtimes/drivers). Uninstall opens the program's own uninstaller. |
| **Startup** | Everything that starts at login with an on/off switch - the same mechanism as Task Manager's Startup tab, so nothing is deleted. |
| **Processes** | Live CPU %, memory and full command line; top apps by memory; End / End tree (core Windows processes are refused). |
| **Dev Runtimes** | Every Python interpreter and project venv (versions, sizes, `pip list`), Node versions (nvm) + global npm packages, Java installs, ~40 dev tools with versions and which copy wins on PATH. |
| **Tools & Launcher** | Start menu apps, scoop apps, `~/.local/bin`, npm global CLIs, plus optional personal folders `~/CyberTools` and `~/SCRIPTS` if you have them: launch, open folder, terminal there, copy command, star favorites. |
| **Browsers** | Chrome / Edge / Brave / Avast / Vivaldi / Firefox profiles and extensions: enabled/disabled, possibly unused, access risk, install date, size; "Manage" opens that extension's page in the right profile. |
| **Security & Network** | Antivirus/firewall/UAC/RDP state, admins and local accounts, ports reachable from the network, apps with internet connections, third-party scheduled tasks and services, hosts file. |
| **PC Trash** | Items you "delete" are only **moved** to `%USERPROFILE%\.manager_trash` (instant, any size; unlike the Recycle Bin, which permanently deletes items over its size limit). **Restore** puts them back; space is freed only on **Delete forever**. Drive roots, Windows, Program Files, ProgramData, your main user folders and the app's own folder are refused. |

### "What is it?" - the purpose of every file and folder

Hover an item for the explanation; click it for the full breakdown: who created it, whether the owning
program is still installed, size, last activity, cleanup verdict with reasoning, and **"How this was worked
out"** (the evidence chain), so you can learn your system like a forensic investigator. The engine
(`server/pc/purpose.js`) combines:

- a knowledge base of Windows/profile locations and ~150 well-known app, game, dev-tool and security folder
  names and file types (e.g. `skylot` = jadx cache, `Sun` = Java, `IO Interactive` = Hitman);
- the folder's contents: project markers (package.json, pyproject, Cargo.toml, .git...), the first line of its
  README, Python venvs, Unity/Unreal/Steam game installs, portable tools, dominant file types;
- an owner check against installed programs, Store apps, Steam/Epic libraries, the Start menu, scoop, commands
  on PATH, running processes (and `~/GAMES`, `~/CyberTools` if present);
- for your own folders, the intent suggested by the folder name and its subfolders.

**Leftovers:** an app-data folder (AppData, ProgramData, Documents, Saved Games, profile dot-folders) whose
owner can't be found anywhere and that hasn't changed for 120+ days appears in Cleanup › "Leftovers from
uninstalled programs & games", always as "review" (it may still hold game saves or settings you want).

### AI Scan (bring your own AI)

1. Choose **Claude Code**, **Codex CLI**, **Gemini CLI** (auto-detected on PATH) or a **custom command**
   (anything that reads a prompt on stdin and prints text, e.g. `ollama run qwen3`). Pick **Quick**
   (analyse the snapshot) or **Deep** (the agent may also inspect files read-only), and optionally a model.
2. The app collects a fresh snapshot (system, processes, startup, programs, security, network, registry
   autostart points, browsers, runtimes, disk-scan results, folder listings, built-in purpose hints) into
   `data/ai-scan/<run>/` and runs the agent there with a detailed prompt (`prompt.md`).
3. The agent returns YAML (schema `manager.ai-scan/v1`, defined in `server/pc/ai/prompt.js`): a health score,
   findings with verdict / evidence / why flagged / what the item is / who created it, plus a **folder map**
   explaining every notable folder. Each finding gets an approve button for the matching action.

**Agents can't change anything.** Claude runs with only the Read/Glob/Grep tools (no shell or edit tools),
Codex with `--sandbox read-only`, Gemini with `--approval-mode plan`. A custom command is your
responsibility. The YAML is treated as untrusted: fields are validated, and actions only happen when you
click them, through the same guarded operations as the rest of the app. Suggestions aimed at protected
locations show as "Protected location" with no button.

**No CLI?** Use **Download prompt + snapshot for any AI**, paste or upload the file into any chat AI, then
**Import YAML** with its answer.

Privacy: a snapshot contains file/folder names, program lists, command lines, browser extension lists and
similar metadata about your PC. Running an AI scan sends that to the AI provider you picked.

### Phone (Android, optional)

Plug the phone in with **USB debugging** enabled (Settings › About phone › tap *Build number* 7 times, then
Developer options › USB debugging) and accept the "Allow USB debugging?" prompt on the phone. Check with
`adb devices` (it must say `device`, not `unauthorized`). Then click **Check for phone again** in the sidebar.

- File browser (grid/list, search, quick folders for Photos, Videos, Downloads, WhatsApp...), in-browser
  preview, download (multiple files zipped), drag-and-drop upload, rename, new folder.
- Delete = move to a hidden trash on the phone (`/sdcard/.manager_trash`), with restore / delete forever.
- **Phone Apps:** every third-party app with install source, usage status (active / long unused / possibly
  unused), real names and icons (click "Fetch app names & icons" once; needs `aapt`), Play Store link,
  uninstall.
- **Phone Security:** root check, accessibility services, device admins, overlay permissions, sideloaded apps.
- One phone at a time; all phone paths are confined to `/sdcard`.

---

## Safety & security design

- Binds to `127.0.0.1` only. It is not reachable from your network.
- Rejects requests whose `Host` header isn't `127.0.0.1:<port>` / `localhost:<port>` (DNS-rebinding protection),
  and requires an `X-Manager: 1` header on every non-GET request, so other websites open in your browser
  can't trigger actions.
- No permanent deletion from normal views: PC and phone deletes go to a restorable trash; "Delete forever"
  needs a separate confirmation in the Trash view.
- Protected locations are refused server-side, regardless of what the UI or an AI suggests.
- Build artifacts are only flagged inside your own folders, never inside installed software (VS Code
  extensions, nvm/npm globals, scoop/conda installs, AppData program folders).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Node.js X is too old` | Install Node.js 22 LTS or newer, then `npm install` again. |
| `npm` is not recognized | Reopen the terminal after installing Node.js (PATH is updated for new windows). |
| Port already in use | Another copy is running, or use `$env:PORT = 5000; npm start`. |
| Page says "Forbidden host" | Open `http://127.0.0.1:<port>` exactly (not your PC's name or IP). |
| Folder sizes say "not scanned" | Click **Scan my profile** (or **Scan whole C: drive** for paths outside your profile). |
| A startup switch says it needs administrator rights | That entry is registered for all users. Use Task Manager › Startup apps, or start PCBot Manager from an elevated terminal. |
| "Phone not connected" | Check the cable, USB debugging, the RSA prompt on the phone, and that `adb devices` lists it; then click **Check for phone again**. |
| AI scan fails | Open the run's **agent.log** / **raw-output.txt** in AI Scan › history. Common causes: CLI not logged in, usage limit reached, model name not available. |
| PowerShell scripts blocked by policy | The app runs its PowerShell with `-ExecutionPolicy Bypass` per command; if a corporate policy still blocks it, the PC views will show an error and the phone part still works. |

---

## Where things are stored / uninstalling

| Path | What |
|---|---|
| `data/` | Scan results, AI reports, trash indexes, favorites, phone app metadata (local to this computer, not in git) |
| `cache/` | Thumbnails and icons (safe to delete; rebuilt automatically) |
| `%USERPROFILE%\.manager_trash` | Items in PC Trash. Empty it from the PC Trash view before removing the app. |
| `/sdcard/.manager_trash` on the phone | Items in Phone Trash |

To uninstall: empty both trashes in the app, stop the server, and delete the project folder.

---

## Project layout

```
start.cmd               Double-click launcher (installs dependencies on first run, opens the browser)
server/
  index.js              Express app, security middleware, phone routes
  adb.js, appmeta.js, trash.js, mime.js     Phone: adb bridge, app names/icons, trash, mime types
  pc/
    routes.js           All /api/pc/* endpoints
    ps.js               PowerShell bridge (-EncodedCommand, JSON out, bulk input via stdin)
    system.js           Overview, processes, network, security posture
    programs.js         Installed programs, launch history, icons, uninstall
    startup.js          Startup entries + on/off
    disk.js             Disk scan, folder sizes, cleanup candidates, duplicates
    purpose.js          "What is it?" engine + leftover detection
    pctrash.js          Reversible PC trash with protected paths
    shell.js            Open / show in Explorer / terminal here
    runtimes.js         Python / Node / Java / dev-tool inventory
    tools.js            Tools catalog + favorites
    browsers.js         Browser profiles and extensions
    ai/snapshot.js      Read-only system snapshot for AI agents
    ai/prompt.js        The audit prompt + YAML schema (manager.ai-scan/v1)
    ai/runner.js        Agent launch, log, YAML validation, action matching, history, import
public/
  index.html, style.css, app.js (shell + phone), pc.js (This PC views), ai.js (AI Scan) - no build step
```

---

<p align="center"><i>vibecoded by pakcyberbot</i></p>
