import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('entitlements grant exactly the capabilities the hardened runtime needs', () => {
  const ents = readFileSync(path.join(repoRoot, 'native/LocalGravity.entitlements'), 'utf8');
  // WKWebView page JavaScript runs its JIT.
  assert.match(ents, /com\.apple\.security\.cs\.allow-jit/);
  // AppleScript automation drives the Mail / Calendar briefing.
  assert.match(ents, /com\.apple\.security\.automation\.apple-events/);
  // The bundled Node backend loads its own unsigned native modules at runtime.
  assert.match(ents, /com\.apple\.security\.cs\.disable-library-validation/);
  // App Sandbox must stay OFF: the backend does broad file I/O and spawns node.
  assert.doesNotMatch(ents, /com\.apple\.security\.app-sandbox/);
});

test('build signs with hardened runtime and keeps notarization credential-free', () => {
  const script = readFileSync(path.join(repoRoot, 'scripts/build-app.sh'), 'utf8');
  // Hardened Runtime is a prerequisite for notarization.
  assert.match(script, /--options runtime/);
  assert.match(script, /--entitlements/);
  // Notarization is gated on a keychain profile name, never an inline secret.
  assert.match(script, /APPLE_NOTARY_PROFILE/);
  assert.match(script, /notarytool submit/);
  assert.match(script, /--keychain-profile/);
  assert.match(script, /stapler staple/);
  // Info.plist must describe why Apple Events are used (TCC prompt copy).
  assert.match(script, /NSAppleEventsUsageDescription/);
});

test('build wires launch-at-login and the deep-link URL scheme', () => {
  const script = readFileSync(path.join(repoRoot, 'scripts/build-app.sh'), 'utf8');
  // SMAppService (Start at Login) needs the ServiceManagement framework.
  assert.match(script, /-framework ServiceManagement/);
  // Deep links: the localgravity:// scheme must be declared in Info.plist.
  assert.match(script, /CFBundleURLTypes/);
  assert.match(script, /<string>localgravity<\/string>/);
});

test('host implements the launch-at-login and deep-link handlers', () => {
  const host = readFileSync(path.join(repoRoot, 'native/LocalGravityHost.swift'), 'utf8');
  assert.match(host, /SMAppService\.mainApp/);
  assert.match(host, /open urls: \[URL\]/);
  assert.match(host, /pendingDeepLinks/);
  assert.match(host, /localgravity/);
});
