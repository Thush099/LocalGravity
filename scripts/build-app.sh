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
ENTITLEMENTS="${REPO_ROOT}/native/LocalGravity.entitlements"

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
  <key>NSAppleEventsUsageDescription</key>
  <string>LocalGravity uses AppleScript to read your Mail and Calendar for the daily briefing.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo -n "APPL????" > "${CONTENTS}/PkgInfo"
# Sign with a stable identity when available: an ad-hoc signature changes on every
# build, so macOS treats each rebuild as a new app and forgets the folder access
# the user already granted (Downloads, Desktop, Documents).
SIGN_IDENTITY="$("${REPO_ROOT}/scripts/ensure-signing-identity.sh" 2>/dev/null || true)"
# Hardened Runtime (--options runtime) is required for notarization. The entitlements
# grant WKWebView JIT, AppleScript automation, and unsigned Node-module loading.
CODESIGN_FLAGS=(--force --deep --options runtime --entitlements "${ENTITLEMENTS}")
if [ -n "${SIGN_IDENTITY}" ]; then
  codesign "${CODESIGN_FLAGS[@]}" --sign "${SIGN_IDENTITY}" "${APP_BUNDLE}"
else
  echo "warning: no signing identity; folder permissions will need granting again after a rebuild" >&2
  codesign "${CODESIGN_FLAGS[@]}" --sign - "${APP_BUNDLE}" || true
fi

# Notarization needs a Developer ID Application certificate plus stored notary
# credentials (xcrun notarytool store-credentials <profile>). It runs only when
# APPLE_NOTARY_PROFILE names that keychain profile, so local builds stay
# credential-free and no secret is ever stored in the repo.
if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
  echo "Notarizing with keychain profile '${APPLE_NOTARY_PROFILE}'..."
  NOTARY_ZIP="${APP_BUNDLE}.zip"
  ditto -c -k --keepParent "${APP_BUNDLE}" "${NOTARY_ZIP}"
  xcrun notarytool submit "${NOTARY_ZIP}" --keychain-profile "${APPLE_NOTARY_PROFILE}" --wait
  xcrun stapler staple "${APP_BUNDLE}"
  rm -f "${NOTARY_ZIP}"
  echo "Notarization complete and stapled."
else
  echo "Skipping notarization (set APPLE_NOTARY_PROFILE to enable). Build is Hardened-Runtime signed."
fi

if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "${APP_BUNDLE}" 2>/dev/null || true
fi

echo "Installed: ${APP_BUNDLE}"
du -sh "${APP_BUNDLE}"
