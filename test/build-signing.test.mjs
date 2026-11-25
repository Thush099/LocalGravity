import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildWithSigningMode(t, { adhoc = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-build-signing-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fsp.mkdir(bin);
  const securityLog = path.join(root, 'security.log');
  const codesignLog = path.join(root, 'codesign.log');

  await fsp.writeFile(
    path.join(bin, 'swiftc'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; mkdir -p "$(dirname "$1")"; printf "#!/bin/sh\\nexit 0\\n" > "$1"; chmod +x "$1"; exit 0; fi; shift; done\nexit 2\n',
    { mode: 0o755 },
  );
  await fsp.writeFile(
    path.join(bin, 'codesign'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${codesignLog}"\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    path.join(bin, 'security'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${securityLog}"\ncase "$*" in *"find-certificate"*) echo 'SHA-1 hash: FAKE-CI-IDENTITY'; exit 0;; esac\nexit 0\n`,
    { mode: 0o755 },
  );

  const appBundle = path.join(root, 'LocalGravity.app');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    APP_BUNDLE_OVERRIDE: appBundle,
    ...(adhoc ? { LOCALGRAVITY_ADHOC_SIGNING: '1' } : {}),
  };
  const result = spawnSync('bash', [path.join(repoRoot, 'scripts/build-app.sh')], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return {
    securityCalls: fs.existsSync(securityLog) ? fs.readFileSync(securityLog, 'utf8') : '',
    codesignCalls: fs.readFileSync(codesignLog, 'utf8'),
  };
}

test('CI ad-hoc signing skips local signing-identity setup', async (t) => {
  const { securityCalls, codesignCalls } = await buildWithSigningMode(t, { adhoc: true });
  assert.equal(securityCalls, '', 'CI build must not query or mutate the login keychain');
  assert.match(codesignCalls, /--force --deep --sign - /, 'CI output is still ad-hoc signed for verification');
});

test('normal local builds keep the stable signing-identity path', async (t) => {
  const { securityCalls, codesignCalls } = await buildWithSigningMode(t);
  assert.match(securityCalls, /find-certificate/, 'local build checks for its stable certificate');
  assert.match(codesignCalls, /--force --deep --sign FAKE-CI-IDENTITY /);
});
