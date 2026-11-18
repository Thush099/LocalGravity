#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="LocalGravity"
DEFAULT_BUNDLE="/Applications/${APP_NAME}.app"
FALLBACK_BUNDLE="${REPO_ROOT}/build/${APP_NAME}.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [ -n "${APP_BUNDLE_OVERRIDE:-}" ]; then
  APP_BUNDLE="${APP_BUNDLE_OVERRIDE}"
elif mkdir -p "/Applications/.lg_write_test_$$" 2>/dev/null; then
  rmdir "/Applications/.lg_write_test_$$" 2>/dev/null || true
  APP_BUNDLE="${DEFAULT_BUNDLE}"
else
  APP_BUNDLE="${FALLBACK_BUNDLE}"
fi

# A previous fallback build can leave a second, older copy registered with
# LaunchServices. That makes Launchpad show LocalGravity twice, so prune it
# whenever we are installing the canonical /Applications bundle.
if [ "${APP_BUNDLE}" = "${DEFAULT_BUNDLE}" ] && [ -d "${FALLBACK_BUNDLE}" ]; then
  echo "Removing stale duplicate bundle: ${FALLBACK_BUNDLE}"
  if [ -x "${LSREGISTER}" ]; then
    "${LSREGISTER}" -u "${FALLBACK_BUNDLE}" 2>/dev/null || true
  fi
  rm -rf "${FALLBACK_BUNDLE}"
fi

CONTENTS="${APP_BUNDLE}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES_DIR="${CONTENTS}/Resources"

echo "Building ${APP_NAME}.app from ${REPO_ROOT} -> ${APP_BUNDLE}..."
mkdir -p "${REPO_ROOT}/build"
if [ ! -f "${REPO_ROOT}/build/AppIcon.icns" ]; then
  node "${REPO_ROOT}/scripts/generate-icon.mjs" "${REPO_ROOT}/build/AppIcon.icns"
fi

rm -rf "${APP_BUNDLE}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

swiftc -O \
  -target arm64-apple-macosx14.0 \
  -framework Cocoa \
  -framework WebKit \
  -framework Security \
  "${REPO_ROOT}/native/LocalGravityHost.swift" \
  -o "${MACOS_DIR}/${APP_NAME}"

cp "${REPO_ROOT}/build/AppIcon.icns" "${RESOURCES_DIR}/AppIcon.icns"
cp -R "${REPO_ROOT}/backend" "${RESOURCES_DIR}/backend"
cp -R "${REPO_ROOT}/ui" "${RESOURCES_DIR}/ui"
cp "${REPO_ROOT}/package.json" "${RESOURCES_DIR}/package.json"
cp "${REPO_ROOT}/scripts/uninstall.sh" "${RESOURCES_DIR}/uninstall.sh"
printf '%s\n' "${REPO_ROOT}" > "${RESOURCES_DIR}/repo-path.txt"
chmod +x "${RESOURCES_DIR}/uninstall.sh"

cat > "${CONTENTS}/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>LocalGravity</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.localgravity.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>LocalGravity</string>
  <key>CFBundleDisplayName</key>
  <string>LocalGravity</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo -n "APPL????" > "${CONTENTS}/PkgInfo"
codesign --force --deep --sign - "${APP_BUNDLE}" || true

if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "${APP_BUNDLE}" 2>/dev/null || true
fi

echo "Installed: ${APP_BUNDLE}"
du -sh "${APP_BUNDLE}"
