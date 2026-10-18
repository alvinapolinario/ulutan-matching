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

### Windows
1. Install Node.js 22 LTS. Copy the `ulutan` folder to e.g. `C:\ulutan`, then `npm install`.
2. Run `npm start`. Allow **Node.js** through Windows Firewall on *Private* networks when asked
   (or: `netsh advfirewall firewall add rule name="Ulutan" dir=in action=allow protocol=TCP localport=3080`).
3. Auto-start (optional): `npm install -g pm2 pm2-windows-startup` → `pm2 start server.js --name ulutan` →
   `pm2 save` → `pm2-startup install`.

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
4. Run it under a supervisor so it restarts by itself (pm2 or systemd above; Docker uses `restart: unless-stopped`).
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
