import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl, safePublicFetch } from '../backend/net-guard.mjs';
import { executeToolCall } from '../backend/tools/registry.mjs';

test('assertPublicHttpUrl allows public http/https URLs and blocks private/loopback/IPv6/non-http hosts', () => {
  assert.equal(assertPublicHttpUrl('https://example.com/docs/SKILL.md').hostname, 'example.com');
  assert.equal(assertPublicHttpUrl('http://raw.githubusercontent.com/a/b').hostname, 'raw.githubusercontent.com');

  const blocked = [
    '',
    'not a url',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'http://localhost:11434/api/tags',
    'http://sub.localhost/secret',
    'http://printer.local/status',
    'http://127.0.0.1:11434/api/tags',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://172.16.5.10/',
    'http://172.31.255.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]:11434/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://2130706433/',
  ];

  for (const url of blocked) {
    assert.throws(() => assertPublicHttpUrl(url), `Expected blocked URL: ${url}`);
  }
});

test('safePublicFetch blocks redirects to private hosts and allows safe public redirects', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    if (url === 'https://example.com/redirect-private') {
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:11434/api/tags' } });
    }
    if (url === 'https://example.com/redirect-ok') {
      return new Response('', { status: 301, headers: { location: '/final.txt' } });
    }
    if (url === 'https://example.com/final.txt') {
      return new Response('public ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  await assert.rejects(
    () => safePublicFetch('https://example.com/redirect-private', { fetchFn: fakeFetch }),
    /local|private/i
  );

  const okRes = await safePublicFetch('https://example.com/redirect-ok', { fetchFn: fakeFetch });
  assert.equal(okRes.status, 200);
  assert.equal(await okRes.text(), 'public ok');
  assert.deepEqual(seen, [
    'https://example.com/redirect-private',
    'https://example.com/redirect-ok',
    'https://example.com/final.txt',
  ]);
});

test('fetch_url tool enforces SSRF guard on private and loopback URLs', async () => {
  let called = false;
  const res = await executeToolCall(
    { name: 'fetch_url', args: { url: 'http://127.0.0.1:11434/api/tags' } },
    {
      fetchFn: async () => {
        called = true;
        return new Response('should never run');
      },
    }
  );
  assert.equal(res.ok, false);
  assert.equal(called, false);
  assert.match(res.output, /local|private/i);
});
