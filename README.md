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

### 2. Build + register (macOS and Linux)

Requires **Rust 1.85+** (the crate uses `edition = "2024"`; older toolchains
fail to build — run `rustup update` if needed). macOS also needs the Xcode
Command Line Tools (`xcode-select --install`) for the bundled SQLite C build.

```sh
cd web-tracker-host
./install.sh <YOUR_EXTENSION_ID>
```

The script builds the release binary, then writes
`com.webtracker.host.json` (with the resolved absolute binary path and your
extension ID) into the `NativeMessagingHosts` directory of every installed
Chromium-family browser (Chrome, Chromium, Brave, Edge, Opera / Opera GX):

| OS    | Example directory                                                           |
| ----- | --------------------------------------------------------------------------- |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`          |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/`                             |

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

## Database schema

`sessions(id, site, start_time, end_time, duration_ms, source, created_at)` —
one row per flushed slice. Indexed on `site` and `start_time`.

## Usage

- **Add site** — track an exact domain or any subdomain of it (`youtube.com`
  matches `m.youtube.com`).
- **Remove** — stop tracking a site (history kept in SQLite).
- **Reset** — clears the live `siteTimes` cache only; SQLite is untouched.
- **Export** — downloads a JSON report of the live cache.

## Notes

- Tracking pauses on idle/locked (60s detection) and when no Chrome window has
  focus.
- The Rust host also implements a `report` request (aggregated per-site totals
  from SQLite); the extension does not call it yet.
- MV3 service workers offer no guaranteed async window on suspend, so the
  `onSuspend` flush is best-effort; the periodic alarm is the reliable path.
