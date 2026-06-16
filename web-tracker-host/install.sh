#!/usr/bin/env bash
#
# Build the native host and register it with installed Chromium-family
# browsers. Works on macOS and Linux.
#
# Usage:
#   ./install.sh <EXTENSION_ID>
#
# The extension ID is shown at chrome://extensions after loading the
# unpacked extension (Developer mode).

set -euo pipefail

HOST_NAME="com.webtracker.host"

EXTENSION_ID="${1:-}"
if [[ -z "$EXTENSION_ID" ]]; then
    echo "error: extension ID required" >&2
    echo "usage: $0 <EXTENSION_ID>" >&2
    exit 1
fi

# Absolute path to this script's directory (the crate root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$SCRIPT_DIR/target/release/web-tracker-host"

# --- 1. build ---------------------------------------------------------
echo "==> building release binary"
( cd "$SCRIPT_DIR" && cargo build --release )

if [[ ! -x "$BINARY" ]]; then
    echo "error: binary not found at $BINARY" >&2
    exit 1
fi

# --- 2. resolve per-OS NativeMessagingHosts directories ---------------
OS="$(uname -s)"
TARGET_DIRS=()

case "$OS" in
    Darwin)
        BASE="$HOME/Library/Application Support"
        TARGET_DIRS=(
            "$BASE/Google/Chrome/NativeMessagingHosts"
            "$BASE/Google/Chrome Beta/NativeMessagingHosts"
            "$BASE/Google/Chrome Canary/NativeMessagingHosts"
            "$BASE/Chromium/NativeMessagingHosts"
            "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
            "$BASE/Microsoft Edge/NativeMessagingHosts"
            "$BASE/com.operasoftware.Opera/NativeMessagingHosts"
            "$BASE/com.operasoftware.OperaGX/NativeMessagingHosts"
        )
        ;;
    Linux)
        BASE="$HOME/.config"
        TARGET_DIRS=(
            "$BASE/google-chrome/NativeMessagingHosts"
            "$BASE/google-chrome-beta/NativeMessagingHosts"
            "$BASE/chromium/NativeMessagingHosts"
            "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
            "$BASE/microsoft-edge/NativeMessagingHosts"
            "$BASE/opera/NativeMessagingHosts"
            "$BASE/opera-gx/NativeMessagingHosts"
        )
        ;;
    *)
        echo "error: unsupported OS '$OS' (use install steps in README)" >&2
        exit 1
        ;;
esac

# --- 3. write the host manifest to each existing browser profile ------
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Website Time Tracker native messaging host",
  "path": "$BINARY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

installed_any=0
for dir in "${TARGET_DIRS[@]}"; do
    # Only register for browsers whose parent config dir already exists.
    parent="$(dirname "$dir")"
    if [[ -d "$parent" ]]; then
        mkdir -p "$dir"
        printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
        echo "==> registered: $dir/$HOST_NAME.json"
        installed_any=1
    fi
done

if [[ "$installed_any" -eq 0 ]]; then
    echo "warning: no Chromium-family browser config dirs found." >&2
    echo "         install a browser, or copy the manifest manually (README)." >&2
    exit 1
fi

echo "==> done. Reload the extension to pick up the host."
