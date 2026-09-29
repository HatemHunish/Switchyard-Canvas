#!/bin/bash
# Builds release/Agent Canvas.app and release/Agent-Canvas.dmg: a double-click
# Mac app that bundles Node, the server and the UI. No terminal needed to use it.
#   npm run package:mac
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NODE_BIN=$(command -v node)
APP="release/Agent Canvas.app"
RES="$APP/Contents/Resources"

# The bundled Node must only depend on macOS system libraries (the official nodejs.org build does).
if otool -L "$NODE_BIN" | tail -n +2 | grep -qv -E '^\s*/(System/Library|usr/lib)/'; then
  echo "This Node ($NODE_BIN) links to non-system libraries (e.g. Homebrew's). Use the official build from nodejs.org or nvm." >&2
  exit 1
fi

echo "› building"
npm run build >/dev/null

echo "› assembling $APP"
rm -rf release
mkdir -p "$APP/Contents/MacOS" "$RES/app/client"
cp -R dist package.json package-lock.json "$RES/app/"
cp -R client/dist "$RES/app/client/dist"
# Same node_modules as this build (native modules match the bundled Node), minus dev tools.
cp -R node_modules "$RES/app/node_modules"
(cd "$RES/app" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp "$NODE_BIN" "$RES/node"
cp build/AppIcon.icns "$RES/AppIcon.icns"
cp scripts/launcher.sh "$APP/Contents/MacOS/Agent Canvas"
chmod +x "$APP/Contents/MacOS/Agent Canvas" "$RES/node"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Canvas</string>
  <key>CFBundleDisplayName</key><string>Agent Canvas</string>
  <key>CFBundleIdentifier</key><string>com.agentcanvas.app</string>
  <key>CFBundleExecutable</key><string>Agent Canvas</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSAppleEventsUsageDescription</key><string>Agent Canvas uses the Mail app to prepare or send emails your automations produce.</string>
</dict>
</plist>
PLIST

echo "› making the disk image"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Agent Canvas" -srcfolder "$STAGE" -ov -format UDZO "release/Agent-Canvas-$VERSION.dmg" >/dev/null
rm -rf "$STAGE"

du -sh "$APP" "release/Agent-Canvas-$VERSION.dmg"
echo "✓ Done. Open the .dmg and drag Agent Canvas to Applications."
echo "  It isn't signed: the first time, right-click the app → Open → Open."
