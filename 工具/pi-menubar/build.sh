#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-$PWD/build/Pi Menu Bar.app}"
if [[ "$APP" != /* ]]; then APP="$PWD/$APP"; fi
if pgrep -f "^$APP/Contents/MacOS/PiMenuBar( |$)" >/dev/null; then
  echo "Refusing to overwrite a running app. Build to 'build/Pi Menu Bar.next.app' first." >&2
  exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macosx14.0 \
  -module-cache-path "$PWD/build/module-cache" \
  Sources/*.swift -o "$APP/Contents/MacOS/PiMenuBar" \
  -framework AppKit -framework SwiftUI -framework WebKit -framework UserNotifications -framework Carbon
cp Info.plist "$APP/Contents/Info.plist"
cp Resources/pi-logo.svg "$APP/Contents/Resources/pi-logo.svg"
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" Scripts/MakeIcon.swift -o build/make-icon -framework AppKit
build/make-icon Resources/pi-logo.svg build/PiIcon.iconset
iconutil -c icns build/PiIcon.iconset -o "$APP/Contents/Resources/PiIcon.icns"
codesign --force --sign - --identifier cn.pi.menubar "$APP"
printf '\nBuilt: %s\n' "$APP"
