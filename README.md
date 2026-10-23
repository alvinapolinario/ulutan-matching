# Ulutan — Tapad-Tapad Matching System

Registration, legband matching, fight management and a real-time TV display for Tapad-Tapad / Ulutan events.
It runs on one computer on your local network (no internet needed). Data is kept in one JSON file.

- **Registration**: auto-numbered entries; legbands typed from management's pre-numbered bands (or automatic 001–500); entries may be saved without legbands and completed later; search, print, CSV.
- **Matching**: type Red legband → Enter → Blue legband → Enter → check the dialog → **Confirm Match**.
- **Fight list**: fight numbers assigned automatically; cancel, correct, renumber, reorder (admin), results 1 / 0 / ½.
- **TV display** (`/display`): current fight, next fight and upcoming queue, live over Socket.IO.
- **Reports**: 9 print-ready (A4) reports with CSV export that keeps leading zeros.

---

## 1. Install and run

Requires **Node.js 20 or newer** (22 LTS recommended) — https://nodejs.org

```bash
cd ulutan
npm install
npm start
```

The console shows the addresses, for example:

```
This computer:  http://localhost:3080
LAN:            http://192.168.1.10:3080   (TV: http://192.168.1.10:3080/display)
```

Open the address in Chrome or Edge. **The first time, you create the administrator account.**

Want sample data to try it? Stop the server and run `npm run demo` (creates a demo event with 12 entries;
if there are no users yet it also creates `admin/admin123`, `operator/operator123`, `tv/tv1234` — change these).

### First setup checklist
1. **Events → New event**: name, date, venue, first fight number, max legbands (default 500).
2. Change the event status: **REGISTRATION OPEN** → (later) **MATCHING OPEN** → **ACTIVE** → **COMPLETED**.
3. **Users**: add an *Operator* account for each station and a *Display* account for the TVs.

---

## 2. Daily operation (operator guide)

### Registration
1. Cursor starts in **Participant (owner) name**. Type the name → **Enter**.
2. Type the **Entry name** (or leave blank to use the owner's name) → **Enter** → **Address** → **Enter**.
3. Type **Legband 1** → **Enter** → **Legband 2** → **Enter** saves.
4. Same owner with another entry? Type the same name again (the list suggests it).
5. Only one chicken now? Choose **“1 — incomplete”**; later click **+ Legband** in the table.

**Legband numbers (default: typed in).** Type the numbers printed on the pre-numbered bands from management
in **Legband 1** and **Legband 2** (leave Legband 2 blank if the second chicken comes later). The screen shows
"✓ free" or "Taken: Entry #…" as you type, and a number can never be registered twice in an event. A mistyped
number can be corrected with **Edit** until that legband is used in a match. Events can instead be set to
*Automatic* legbands (001, 002, …) in Event Settings. The entry number is always automatic.

### Matching
1. Cursor starts in **RED CORNER**. Type the number (`7` is enough for `007`) → **Enter**.
2. Cursor jumps to **BLUE CORNER**. Type → **Enter**.
3. **Bunot (raffle) events** (the default): the cursor jumps to **FIGHT NO. (nabunot)**. Draw the number,
   type it → **Enter**. A number already used (even by a cancelled fight) is refused.
   Fights run in fight-number order (lowest first), whatever order they were matched.
   An admin can switch an event to *Automatic* numbering in Event Settings.
4. The **CONFIRM MATCHING** dialog shows both chickens and the fight number. Check them.
   - **CONFIRM MATCH** (click it, or press Enter once it is highlighted) → the fight number is assigned and the TV updates.
   - **Esc** or **CANCEL / EDIT** → back to the inputs with both numbers kept.
5. After confirming, the inputs clear and the cursor returns to Red for the next match.

The system refuses (with a clear message): unregistered legbands, the same legband twice, two chickens of the
same entry, **two entries of the same owner**, legbands already matched, legbands from a cancelled match,
withdrawn legbands, and matching while the event is not open. A repeated click or Enter never creates a duplicate.

### Running the fights (TV Control)
- **Next fight →** sets the current fight (the TV never advances by itself).
- Record the result: **Red wins 1–0**, **Draw ½–½**, **Blue wins 0–1** (optionally moves to the next fight).
- Toggle **Show fights on TV** off to show “Please stand by”.

### Admin corrections (Fight List → More)
| Action | Rule |
|---|---|
| Cancel match | Reason required. Both legbands become **unusable**. Fight number is not reused. |
| Correct legband | Reason required. Replaces one corner; the removed legband becomes available (it never fought). |
| Change fight number | Reason required. Cannot reuse any existing number, including cancelled ones. |
| Move ↑ ↓ | Changes the running order on the TV. |
| Change result | Admin only, reason required. |

Every change is in **Reports → Match Audit Report** (who, when, old → new, reason).

### TV screens
On each TV/mini-PC open `http://<server-ip>:3080/display` in Chrome, log in once with the *Display* account
(stays logged in for 30 days) and press **F11** for full screen. Designed for 1920×1080; scales to any screen.
If the network drops, the TV shows “Reconnecting…”, keeps the last fights on screen, and reloads the latest state
as soon as it reconnects.

---

## 3. Deployment on the LAN

Use a wired connection for the server if you can. Give the server a fixed IP (DHCP reservation in the router).

### Windows 11 — production deployment with PM2

PM2 keeps the server running in the background, restarts it if it ever crashes, and starts it again
after Windows reboots. Do every step below **in the same Windows user account** that will be logged in on
the event computer, using **Windows PowerShell** (or Windows Terminal). Only the steps marked *(admin)* need
*Run as administrator*.

> **Quick way:** steps 2, 3, 4, 5 and 7 are automated by `deploy/pm2-start.sh`. Install Node.js (step 1) and
> [Git for Windows](https://git-scm.com/download/win), copy the app to `C:\nodeapps\ulutan`, open **Git Bash** in that
> folder and run `bash deploy/pm2-start.sh`. It installs dependencies and PM2, starts the server, checks
> `/healthz`, saves the process list and registers the login autostart. Run it again after copying new
> app files. The firewall (step 6), automatic login and power settings (step 7) still need to be done by hand.

#### 1. Install Node.js
Download the **Node.js 22 LTS** Windows installer (`.msi`, 64-bit) from https://nodejs.org and run it with
the default options (it adds `node` and `npm` to the PATH). Close and reopen PowerShell, then check:
```powershell
node -v     # v22.x.x
npm -v
```

#### 2. Copy the app and install its dependencies
Copy the `ulutan` folder to **`C:\nodeapps\ulutan`**. Avoid *Desktop*, *Documents* or any OneDrive-synced folder:
OneDrive can lock `data\db.json` while it syncs.
```powershell
cd C:\nodeapps\ulutan
npm install --omit=dev
```

#### 3. Install PM2
```powershell
npm install -g pm2 pm2-windows-startup
pm2 -v
```
If PowerShell answers *"running scripts is disabled on this system"*, allow locally installed scripts once
and try again (or type `pm2.cmd` instead of `pm2`):
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

#### 4. Check the PM2 configuration file
The app reads its settings from **environment variables only** (there is no `.env` loader), so they live in
the PM2 *ecosystem* file **`ecosystem.config.js`** that ships in the app folder. It already contains the
production settings and works unchanged from any folder:

| Setting | Value | Why |
|---|---|---|
| `instances: 1`, `exec_mode: 'fork'` | fixed | only one server may open `data\db.json`; never use cluster mode |
| `PORT` | `3080` | the address everyone opens |
| `DATA_DIR` | `<app folder>\data` | `db.json`, sessions and backups |
| `TZ` | `Asia/Manila` | time zone used on printed reports |
| `autorestart`, `restart_delay: 2000`, `max_restarts: 10` | | restart after a crash, give up after 10 crashes in a minute |

To change a value, either edit the file or set the variable when starting, e.g.
`$env:PORT=3090; pm2 start ecosystem.config.js` (the value is remembered by `pm2 save`).

#### 5. Start the server and check it
```powershell
cd C:\nodeapps\ulutan
pm2 start ecosystem.config.js
pm2 status                 # ulutan should be "online"
pm2 logs ulutan --lines 30 # shows the addresses, press Ctrl+C to leave the log view
curl.exe http://localhost:3080/healthz    # should print {"ok":true}
```
Open `http://localhost:3080` in Chrome or Edge and **create the administrator account right away**
(until an admin exists, anyone who reaches the address can create one).

#### 6. Open the firewall *(admin)*
Make sure the network is set to **Private** (Settings → Network & internet → Ethernet/Wi-Fi →
*Network profile type* → **Private network**), then allow the port:
```powershell
netsh advfirewall firewall add rule name="Ulutan" dir=in action=allow protocol=TCP localport=3080 profile=private
```
From another device on the same network open `http://<server-ip>:3080` (the IP is in `pm2 logs ulutan`).

#### 7. Start automatically when Windows starts
```powershell
pm2 save              # remembers the "ulutan" process list
pm2-startup install   # makes PM2 restore that list when this user logs in
```
`pm2-windows-startup` runs when **this Windows user logs in**, not at the moment the PC boots. Choose one:

- **Simple (recommended for an event PC):** let Windows log in automatically. Press `Win+R`, run `netplwiz`,
  untick *Users must enter a user name and password to use this computer*, enter the password once.
  (If that checkbox is missing, turn off *Settings → Accounts → Sign-in options → "For improved security,
  only allow Windows Hello sign-in"*, or use Microsoft's **Autologon** tool from Sysinternals.)
  Then lock the screen with `Win+L` if you want; the server keeps running.
- **Run as a real Windows service (no login needed):** use **pm2-installer**
  (https://github.com/jessety/pm2-installer), which installs PM2 as a Windows service under the
  *Local Service* account. Follow its README (`npm run configure`, `npm run configure-policy`,
  `npm run setup`, all *(admin)*), then run **all** `pm2` commands from an administrator PowerShell
  (its `PM2_HOME` is `C:\ProgramData\pm2\home`). Give that account write access to the app folder:
  `icacls "C:\nodeapps\ulutan" /grant "LOCAL SERVICE:(OI)(CI)M" /T` *(admin)*. Do **not** also install
  `pm2-windows-startup` in that case.

Stop the PC from sleeping while plugged in *(admin)*:
```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```
(Settings → System → Power → *When plugged in, put my device to sleep after* → **Never**.)
Also set Windows Update *active hours* to cover event times, or **pause updates** for the event week, so the
PC never restarts in the middle of a fight list.

#### 8. Test the reboot
Restart Windows. After login, run `pm2 status` → `ulutan` must be **online**, and the TV address must open
from another device. If it is not online: `pm2 logs ulutan --err --lines 50` shows why.

#### 9. Everyday PM2 commands
| Command | What it does |
|---|---|
| `pm2 status` | Is the server running? uptime, restarts, memory |
| `pm2 logs ulutan` | Live log (Ctrl+C to leave). `--err` for errors only, `--lines 100` for history |
| `pm2 restart ulutan` | Restart (after updating app files) |
| `pm2 stop ulutan` / `pm2 start ulutan` | Stop / start without removing it from PM2 |
| `pm2 monit` | Live CPU/memory dashboard |
| `pm2 flush` | Empty the log files |
| `pm2 save` | Save the current process list (run after any `pm2 start` / `pm2 delete`) |

Log files are in `%USERPROFILE%\.pm2\logs\ulutan-out.log` and `ulutan-error.log`. To stop them growing
forever: `pm2 install pm2-logrotate` (keeps 10 MB × 30 files by default).

#### 10. Updating the app
```powershell
pm2 stop ulutan
# copy the new app files over C:\nodeapps\ulutan  (never replace or delete C:\nodeapps\ulutan\data)
cd C:\nodeapps\ulutan
npm install --omit=dev
pm2 restart ulutan --update-env
pm2 save
```
Or simply run `bash deploy/pm2-start.sh` again from Git Bash after copying the files — it does all of the
above and also re-reads `ecosystem.config.js`. Then press **Ctrl+Shift+R** on every operator screen and TV.
If you changed `ecosystem.config.js` by hand, use `pm2 delete ulutan` → `pm2 start ecosystem.config.js` →
`pm2 save` so the new settings are read (the script does this for you).

#### Good to know on Windows
- **Back up before stopping during an event.** On Windows PM2 ends the process by killing it instead of a
  polite `SIGINT`, so the "backup on shutdown" step may not run. The database itself can never be damaged by
  this (every save is an atomic file swap), and automatic backups continue every 5 minutes while running;
  just click **Back up now** (or `npm run backup`) before `pm2 stop` / `pm2 restart` on an event day.
- **Do not also run `npm start`** while PM2 runs the app: the second copy refuses to start (the data folder
  is locked and the port is taken). If the log says *"Database … is already in use by process …"*, check
  `pm2 status` and Task Manager for a second `node.exe`; locks left by a crash or power cut are cleared automatically.
- `pm2 startup` (the Linux command) does nothing on Windows — use `pm2-startup install` (or pm2-installer) as above.
- Exclude `C:\nodeapps\ulutan\data` from OneDrive / backup tools that sync files while they are open.
- Keep the PC on the private event network only; the app uses plain HTTP.

#### Removing PM2 autostart
```powershell
pm2 delete ulutan
pm2 save --force
pm2-startup uninstall
npm uninstall -g pm2 pm2-windows-startup
```

### Ubuntu
```bash
sudo apt install -y nodejs npm   # or install Node 22 from nodesource
cd /opt/ulutan && npm install --omit=dev
sudo ufw allow 3080/tcp
```
systemd service `/etc/systemd/system/ulutan.service`:
```ini
[Unit]
Description=Ulutan
After=network.target
[Service]
WorkingDirectory=/opt/ulutan
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3080
User=ulutan
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now ulutan`

### macOS
`npm install && npm start`. Allow incoming connections for Node when macOS asks.

### Docker Compose (optional)
```bash
docker compose up -d --build
```
Data is stored in `./data` on the host.

### Settings (environment variables, all optional)
`PORT` (3080) · `HOST` (all addresses, IPv4 and IPv6) · `DATA_DIR` (./data) · `SECURE_COOKIES` (true only behind HTTPS) · `SESSION_SECRET` · `TZ` (times on reports, e.g. `Asia/Manila`)

### Production checklist (before the first real event)
1. Start the server **before** anyone else is on the network and create the admin account right away
   (until an admin exists, anyone who opens the address can create one).
2. Use your own passwords. Accounts still on a demo/easy password (`admin123`, `tv1234`, …) are listed in a
   red banner for admins and in the server console until changed. Never run `npm run demo` / `npm run seed` on
   the real data folder.
3. Keep the server on the private event network only. Do not port-forward it to the internet; it uses plain HTTP.
4. Run it under a supervisor so it restarts by itself (PM2 on Windows 11 or systemd on Ubuntu, see above; Docker uses `restart: unless-stopped`).
5. Set the computer's clock and time zone correctly (report times use it); on Docker set `TZ`.
6. Click **Back up now** before and after the event and copy the backup to a USB drive (`npm run backup -- E:\`).
   Manual backups are never rotated away; automatic ones keep the last 50.
7. After updating the app files, restart the server (templates are cached) and press Ctrl+Shift+R on each screen.
8. `npm run audit` should report 0 vulnerabilities.

---

## 4. Data, backup and recovery

Everything is in the `data/` folder:

| File | What it is |
|---|---|
| `db.json` | The whole database (events, entries, legbands, matches, users, audit log) |
| `backups/` | Automatic copy every 5 minutes when something changed (keeps the last 50), plus manual backups (kept until you delete them) |
| `sessions.json`, `session-secret.txt` | Logins (safe to delete; everyone just logs in again) |
| `db.json.lock` | Stops two servers using the same file at once |

- **Back up now**: Events page → *Back up now*, or `npm run backup`, or `npm run backup -- E:\` to also copy to a USB drive.
  Do this before and after every event.
- **Restore**: stop the server → copy the backup over `data/db.json` → start the server.
- Only **one** server may use a data folder. If the server crashed and says the database is in use,
  check no other copy is running, then start again (stale locks, including ones left by a power cut, are cleared automatically).

### Why the JSON file is safe
- Every change runs as a transaction on a copy of the data; if any check fails nothing is saved.
- The new file is written to a temp file, flushed to disk, then swapped in one atomic rename — a power cut
  leaves either the old or the new file, never half of one.
- Node.js runs one transaction at a time, so two operators confirming the same legband at the same moment
  cannot both succeed: the second one sees the first one's result and is refused.
  (Tested with 30 simultaneous requests: exactly one match is created.)
- Success is only shown, and TVs only updated, **after** the file is on disk.
- Size: 500 legbands and a few hundred fights is well under 1 MB, so each save takes milliseconds.

---

## 5. Rules implemented

- Legbands: auto-numbered per event, `001`…max (default 500), stored as text so `001` stays `001`.
  Numbers can repeat across different events.
- Entry: exactly two legband slots; may be saved with one and completed later.
- One fight per legband (no rematches). A cancelled match makes its legbands unusable.
- Same owner can never be matched against themselves (even with different entries).
- Fight numbers: *Bunot* mode — the drawn number is typed and checked inside the transaction (unique per event, never reused, cancelled ones included); *Automatic* mode — a server counter. Running order follows fight number in Bunot mode.
- Results: winner 1, loser 0, draw ½ each. **Reports → Standings** totals points per entry.

### Event status
`DRAFT → REGISTRATION_OPEN → MATCHING_OPEN → ACTIVE → COMPLETED → ARCHIVED` (one step forward or back).
Registration: REGISTRATION_OPEN, MATCHING_OPEN, ACTIVE. Matching: MATCHING_OPEN, ACTIVE.

### Legband status
`AVAILABLE → MATCHED` (confirmed; stays MATCHED after the fight) · `MATCHED → INACTIVE` (match cancelled) ·
`AVAILABLE → WITHDRAWN` · `MATCHED → AVAILABLE` (only when an admin corrects a wrongly typed legband).
`RESERVED` and match status `DRAFT` are reserved for a future provisional-matching workflow.

### Roles
| | Admin | Operator | Display |
|---|---|---|---|
| Events, users, backups | ✔ | | |
| Register / edit entries (before matching) | ✔ | ✔ | |
| Edit an entry that has a match (with reason) | ✔ | | |
| Withdraw entry / legband | ✔ | | |
| Match, record results, TV control | ✔ | ✔ | |
| Cancel / correct / renumber / reorder / change result | ✔ | | |
| Audit report | ✔ | | |
| TV display | ✔ | ✔ | ✔ |

---

## 6. For developers

```
server.js                 start-up, LAN addresses, graceful shutdown
src/app.js                Express app, security headers, routes, Socket.IO
src/db/store.js           JSON store: transactions, atomic writes, lock, backups
src/db/schema.js          data shape + migrations (bump SCHEMA_VERSION and add a step)
src/services/             registration, matches (matching, fights, display), events, users, reports, audit
src/routes/api.js         REST API (JSON)       src/routes/pages.js   EJS pages
src/realtime/index.js     event bus + Socket.IO rooms (event:<id>), versioned display:refresh
views/, public/           EJS templates, vanilla JS, CSS (Bootstrap served locally from node_modules)
tests/                    node:test — store, registration, matching (incl. concurrency), realtime, reports, browser e2e
```

Run the tests: `npm test`. The browser tests use `playwright-core` with an installed Chrome/Chromium
(set `CHROMIUM_PATH` if it is not found; they are skipped if no browser is available).

Key API: `GET /api/events/:id/legbands/:number` (lookup) · `POST /api/events/:id/matches/check` ·
`POST /api/events/:id/matches` `{red, blue, idempotencyKey}` · `GET /api/events/:id/display-state`.
