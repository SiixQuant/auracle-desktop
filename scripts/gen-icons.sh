#!/usr/bin/env bash
# Generate Tauri icon set from a single source SVG / PNG.
#
# The icons currently checked into src-tauri/icons/ are 1×1
# transparent PNG placeholders that exist only so `cargo tauri build`
# doesn't fail on missing files. Before the first signed release,
# replace them with real branding using this script.
#
# Usage:
#   ./scripts/gen-icons.sh path/to/source.svg     # SVG → all sizes
#   ./scripts/gen-icons.sh path/to/source.png     # PNG (≥1024x1024) → all sizes
#
# Requires: ImageMagick (`brew install imagemagick`) OR
# `cargo tauri icon` if you have the Tauri CLI installed.
#
# Recommended approach (Tauri's own tool, handles .icns + .ico
# correctly without ImageMagick gotchas):
#
#   cargo tauri icon path/to/source.png
#
# That writes the full set into src-tauri/icons/ matching the
# tauri.conf.json `bundle.icon` list.

set -euo pipefail

SOURCE="${1:-}"
if [ -z "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
  echo "Usage: $0 <source.svg or source.png>"
  echo
  echo "Recommended: cargo tauri icon $SOURCE"
  exit 1
fi

cd "$(dirname "$0")/.."

if command -v cargo-tauri >/dev/null 2>&1 || (command -v cargo >/dev/null 2>&1 && cargo tauri --version >/dev/null 2>&1); then
  echo "Using Tauri CLI to generate icons (recommended path)"
  cargo tauri icon "$SOURCE"
  exit 0
fi

if command -v magick >/dev/null 2>&1; then
  IM=magick
elif command -v convert >/dev/null 2>&1; then
  IM=convert
else
  echo "No ImageMagick found. Install with: brew install imagemagick"
  echo "Or: cargo install tauri-cli && cargo tauri icon $SOURCE"
  exit 1
fi

ICONS=src-tauri/icons
echo "Generating icons → $ICONS/"

$IM "$SOURCE" -resize 32x32   "$ICONS/32x32.png"
$IM "$SOURCE" -resize 128x128 "$ICONS/128x128.png"
$IM "$SOURCE" -resize 256x256 "$ICONS/128x128@2x.png"
$IM "$SOURCE" -resize 22x22   "$ICONS/tray.png"
$IM "$SOURCE" -resize 256x256 "$ICONS/icon.ico"

# .icns generation requires iconutil (macOS only) — best done via
# `cargo tauri icon`. Falls back to a single-resolution placeholder
# here if the user doesn't have the Tauri CLI installed.
if command -v iconutil >/dev/null 2>&1; then
  iconset_dir=$(mktemp -d)/icon.iconset
  mkdir -p "$iconset_dir"
  $IM "$SOURCE" -resize 16x16   "$iconset_dir/icon_16x16.png"
  $IM "$SOURCE" -resize 32x32   "$iconset_dir/icon_16x16@2x.png"
  $IM "$SOURCE" -resize 32x32   "$iconset_dir/icon_32x32.png"
  $IM "$SOURCE" -resize 64x64   "$iconset_dir/icon_32x32@2x.png"
  $IM "$SOURCE" -resize 128x128 "$iconset_dir/icon_128x128.png"
  $IM "$SOURCE" -resize 256x256 "$iconset_dir/icon_128x128@2x.png"
  $IM "$SOURCE" -resize 256x256 "$iconset_dir/icon_256x256.png"
  $IM "$SOURCE" -resize 512x512 "$iconset_dir/icon_256x256@2x.png"
  $IM "$SOURCE" -resize 512x512 "$iconset_dir/icon_512x512.png"
  $IM "$SOURCE" -resize 1024x1024 "$iconset_dir/icon_512x512@2x.png"
  iconutil -c icns -o "$ICONS/icon.icns" "$iconset_dir"
  rm -rf "$(dirname "$iconset_dir")"
fi

echo "Done. Verify with: ls -la $ICONS/"
