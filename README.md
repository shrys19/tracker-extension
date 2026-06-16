# Website Time Tracker

Chrome (MV3) extension that tracks time spent on selected websites. Time is held
live in `chrome.storage.local` for the popup UI and flushed durably to a local
SQLite database through a Rust native-messaging host.

## Components

| Path                   | Role                                                         |
| ---------------------- | ----------------------------------------------------------- |
| `manifest.json`        | Extension manifest (MV3)                                     |
| `background.js`        | Service worker: tracks active tab/domain, flushes sessions  |
| `popup.html/js/css`    | UI: add/remove tracked sites, view totals, export JSON      |
| `web-tracker-host/`    | Rust native host: receives sessions, writes SQLite          |

The background worker writes each time slice to **both** stores via `flushSlice`,
so the live cache and the SQLite archive stay consistent. The alarm flush (every
1 min) and session stop emit the same slices.

## Data flow

```
tab/window/idle events ──▶ background.js (active domain + start ts)
                              │  every 1 min  &  on stop
                              ▼
                       flushSlice(domain, start, end)
                         ├─▶ chrome.storage.local.siteTimes  (live, popup)
                         └─▶ native host  ─▶  SQLite sessions table  (durable)
```

The native host is cross-platform Rust — same binary logic on macOS (Intel +
Apple Silicon) and Linux. Paths and registration differ per OS; the install
script handles both automatically.

### 1. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the repo root.
4. Copy the **extension ID** Chrome assigns (needed below).

### 2. Build + register

Requires **Rust 1.85+** (the crate uses `edition = "2024"`; older toolchains
fail to build — run `rustup update` if needed). Platform extras:

- **macOS** — Xcode Command Line Tools (`xcode-select --install`) for the
  bundled SQLite C build.
- **Windows** — MSVC Build Tools (C compiler) for the bundled SQLite build.

**macOS / Linux:**

```sh
cd web-tracker-host
./install.sh <YOUR_EXTENSION_ID>
```

**Windows** (PowerShell):

```powershell
cd web-tracker-host
.\install.ps1 <YOUR_EXTENSION_ID>
```

Each script builds the release binary, writes `com.webtracker.host.json` (with
the resolved absolute binary path and your extension ID), and registers it for
every Chromium-family browser (Chrome, Chromium, Brave, Edge, Opera / Opera GX).
On macOS/Linux that means dropping the manifest into each `NativeMessagingHosts`
directory; on Windows it means writing the manifest path into the registry under
`HKCU\Software\<Browser>\NativeMessagingHosts\` (Opera reads Chrome's key):

| OS      | Where the host is registered                                              |
| ------- | ------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`        |
| Linux   | `~/.config/google-chrome/NativeMessagingHosts/`                            |
| Windows | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webtracker.host`     |

Reload the extension afterwards so it picks up the host.

> **Per-browser extension IDs:** each browser assigns its own ID to an unpacked
> extension. The host manifest pins one ID in `allowed_origins`, so pass the ID
> from the browser you actually use (e.g. `opera://extensions` for Opera). To
> support several browsers at once, re-run `install.sh` per browser, or add each
> `chrome-extension://<ID>/` to `allowed_origins` manually.

### Manual registration

If you prefer not to run the script, edit
`web-tracker-host/com.webtracker.host.json`:

- `path` → absolute path to `target/release/web-tracker-host`.
- `allowed_origins[0]` → `chrome-extension://<YOUR_EXTENSION_ID>/`
  (keep the trailing slash).

Copy it (filename must stay `com.webtracker.host.json`, matching the `name`
field) into the browser's `NativeMessagingHosts` directory from the table above.

**Windows** — place the JSON anywhere, then register it:

```
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webtracker.host" ^
  /ve /t REG_SZ /d "C:\path\to\com.webtracker.host.json" /f
```

### 4. Verify

1. Reload the extension after editing the host manifest.
2. Add a site in the popup, browse it, switch tabs.
3. Inspect the service worker console (`chrome://extensions` → **service worker**)
   for `Daemon response: { "status": "ok", ... }`.
4. Database lives at the platform data dir (via the `directories` crate), e.g.
   Linux: `~/.local/share/webtracker/tracker.db` (the `directories` crate
   lowercases the name on Linux; macOS keeps
   `~/Library/Application Support/com.WebTracker.WebTracker/tracker.db`).

```sh
sqlite3 ~/.local/share/webtracker/tracker.db \
  'SELECT site, SUM(duration_ms) FROM sessions GROUP BY site;'
```

## Reference: file & registry paths

### Native host registration

Where each `install` script writes `com.webtracker.host.json` (macOS/Linux) or
the registry entry pointing at it (Windows). `~` = the user's home directory.

**macOS** — under `~/Library/Application Support/`:

| Browser      | Path                                                         |
| ------------ | ------------------------------------------------------------ |
| Chrome       | `Google/Chrome/NativeMessagingHosts/`                        |
| Chrome Beta  | `Google/Chrome Beta/NativeMessagingHosts/`                   |
| Chrome Canary| `Google/Chrome Canary/NativeMessagingHosts/`                 |
| Chromium     | `Chromium/NativeMessagingHosts/`                             |
| Brave        | `BraveSoftware/Brave-Browser/NativeMessagingHosts/`          |
| Edge         | `Microsoft Edge/NativeMessagingHosts/`                       |
| Opera        | `com.operasoftware.Opera/NativeMessagingHosts/`              |
| Opera GX     | `com.operasoftware.OperaGX/NativeMessagingHosts/`            |

**Linux** — under `~/.config/`:

| Browser      | Path                                                  |
| ------------ | ----------------------------------------------------- |
| Chrome       | `google-chrome/NativeMessagingHosts/`                 |
| Chrome Beta  | `google-chrome-beta/NativeMessagingHosts/`            |
| Chromium     | `chromium/NativeMessagingHosts/`                      |
| Brave        | `BraveSoftware/Brave-Browser/NativeMessagingHosts/`   |
| Edge         | `microsoft-edge/NativeMessagingHosts/`                |
| Opera        | `opera/NativeMessagingHosts/`                          |
| Opera GX     | `opera-gx/NativeMessagingHosts/`                      |

**Windows** — registry value (HKCU), default value = path to the JSON manifest.
Append `\com.webtracker.host` to each key:

| Browser  | Registry key                                          |
| -------- | ----------------------------------------------------- |
| Chrome   | `HKCU\Software\Google\Chrome\NativeMessagingHosts`    |
| Chromium | `HKCU\Software\Chromium\NativeMessagingHosts`         |
| Edge     | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts`   |
| Brave    | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts` |
| Opera    | reads Chrome's key (`HKCU\Software\Google\Chrome\...`) |

### Database location

The daemon resolves this via the `directories` crate from the app id
`com` / `WebTracker` / `WebTracker` — **same DB regardless of which browser
spawned it**, so all browsers on one machine share it. Separate machines have
separate DBs (no sync).

| OS      | `tracker.db` path                                                            |
| ------- | --------------------------------------------------------------------------- |
| Linux   | `~/.local/share/webtracker/tracker.db` (name lowercased; honors `$XDG_DATA_HOME`) |
| macOS   | `~/Library/Application Support/com.WebTracker.WebTracker/tracker.db`         |
| Windows | `%APPDATA%\WebTracker\WebTracker\data\tracker.db`                            |

## Database schema

`sessions(id, site, start_time, end_time, duration_ms, source, created_at)` —
one row per flushed slice. Indexes: `site`, `start_time`, and a **`UNIQUE(site,
start_time)`** that rejects race-duplicate inserts. A session starts once per
millisecond, so that pair identifies a slice. Inserts use `INSERT OR IGNORE`;
on first open the daemon self-heals a DB containing legacy duplicates (dedupes,
keeping the lowest id, then builds the unique index).

## Usage

- **Add site** — track an exact domain or any subdomain of it (`youtube.com`
  matches `m.youtube.com`).
- **Remove** — stop tracking a site (history kept in SQLite).
- **Reset** — clears the live `siteTimes` cache only; the SQLite history (and
  therefore the displayed totals, which read from the daemon) is untouched.
- **Export** — downloads a JSON report built from the daemon's SQLite history
  (durable, survives Reset).

## Notes

- The popup list and export read durable totals from the daemon/SQLite; the live
  in-progress slice is added on top for the active site.
- Tracking pauses on idle/locked (60s detection). It deliberately does **not**
  stop on window-focus loss — on Linux the action popup steals focus, which would
  stop the very session the popup is displaying.
- All tracking mutations are serialized in the service worker so concurrent
  tab/window/idle/alarm events can't double-flush a slice.
- MV3 service workers offer no guaranteed async window on suspend, so the
  `onSuspend` flush is best-effort; the periodic alarm is the reliable path.
