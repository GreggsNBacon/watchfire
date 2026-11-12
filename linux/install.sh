#!/bin/sh
# Installs Watchfire for your user only (no sudo):
#   ~/.local/bin/watchfire                     the program
#   ~/.local/share/applications                a "Watchfire" entry in your apps menu
# Usage: ./install.sh          (./install.sh --remove to take it away again; your settings stay)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$BIN/watchfire" "$APPS/watchfire.desktop" "$ICONS/watchfire.svg"
  echo "Watchfire was removed. Its settings are still in ${XDG_DATA_HOME:-$HOME/.local/share}/Watchfire."
  exit 0
fi

mkdir -p "$BIN" "$APPS" "$ICONS"
install -m 755 "$HERE/watchfire" "$BIN/watchfire"
sed "s#^Exec=.*#Exec=$BIN/watchfire#" "$HERE/watchfire.desktop" > "$APPS/watchfire.desktop"
install -m 644 "$HERE/watchfire.svg" "$ICONS/watchfire.svg"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" || true

echo "Watchfire is installed: open it from your apps menu, or run: $BIN/watchfire"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "($BIN isn't on your PATH yet; it usually is after you log in again.)" ;; esac
