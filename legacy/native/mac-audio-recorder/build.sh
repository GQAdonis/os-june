#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/native/bin"
APP_DIR="$OUT_DIR/OS Notepad.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
mkdir -p "$OUT_DIR"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

swiftc \
  -target arm64-apple-macosx14.2 \
  -framework Foundation \
  -framework AVFoundation \
  -framework CoreAudio \
  -framework AudioToolbox \
  "$ROOT/native/mac-audio-recorder/main.swift" \
  -o "$OUT_DIR/os-notepad-recorder"

cp "$OUT_DIR/os-notepad-recorder" "$MACOS_DIR/os-notepad-recorder"
cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>OS Notepad</string>
  <key>CFBundleExecutable</key>
  <string>os-notepad-recorder</string>
  <key>CFBundleIdentifier</key>
  <string>ai.os-notepad.mac</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>OS Notepad</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.2</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAudioCaptureUsageDescription</key>
  <string>OS Notepad records system audio so your meeting notes include other meeting participants.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
