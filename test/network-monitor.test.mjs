import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNettop, parseNetstat, emptyState, foldUsageSample } from '../backend/network-monitor.mjs';

// These fixtures are the real, unedited output of `nettop -P -L 1 -x -J bytes_in,bytes_out`
// and `netstat -ib` captured from macOS, so the parsers are pinned to actual formats.

const NETTOP_FIXTURE = `,bytes_in,bytes_out,
launchd.1,0,0,
apsd.583,17395,169214,
mDNSResponder.668,47408350,21873529,
airportd.677,0,0,
`;

const NETSTAT_FIXTURE = `Name       Mtu   Network       Address      Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      14383473     0 33035912167 14383473     0 33035912167     0
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#12>   7e:33:d1:ee:c5:89 54230988     0 49997564920 43571281     0 39940764834     0
en0        1500  172.20.10/28  172.20.10.4     54230988     - 49997564920 43571281     - 39940764834     -
`;

test('parseNettop reads per-process bytes and strips the .pid suffix', () => {
  const rows = parseNettop(NETTOP_FIXTURE);
  assert.equal(rows.length, 4);
  const dns = rows.find((r) => r.name === 'mDNSResponder');
  assert.ok(dns, 'process name is captured without its pid');
  assert.equal(dns.bytesIn, 47408350);
  assert.equal(dns.bytesOut, 21873529);
  assert.ok(!rows.some((r) => r.name.includes('.')), 'no .pid remains in any name');
  const apsd = rows.find((r) => r.name === 'apsd');
  assert.equal(apsd.bytesIn, 17395);
});

test('parseNettop ignores the header and empty input', () => {
  assert.equal(parseNettop('').length, 0);
  const onlyHeader = parseNettop(',bytes_in,bytes_out,\n');
  assert.equal(onlyHeader.length, 0);
});

test('parseNetstat reads link-level byte counters regardless of a MAC address', () => {
  const rows = parseNetstat(NETSTAT_FIXTURE);
  const en0 = rows.find((r) => r.interface === 'en0' && r.up);
  assert.ok(en0, 'en0 link row is captured');
  assert.equal(en0.bytesIn, 49997564920);
  assert.equal(en0.bytesOut, 39940764834);
  const lo0 = rows.find((r) => r.interface === 'lo0');
  assert.equal(lo0.bytesIn, 33035912167, 'loopback row parses (address-less) correctly');
});

test('parseNetstat flags down interfaces and drops the trailing *', () => {
  const rows = parseNetstat(NETSTAT_FIXTURE);
  const gif0 = rows.find((r) => r.interface === 'gif0');
  assert.ok(gif0, 'down interface is captured');
  assert.equal(gif0.up, false);
  assert.ok(!gif0.interface.includes('*'));
  // The IP-layer en0 row repeats the byte counters; only the <Link> row is counted, so
  // en0 appears exactly once in the parsed output.
  assert.equal(rows.filter((r) => r.interface === 'en0').length, 1);
});

test('foldUsageSample seeds a zero baseline so pre-existing bytes are not miscounted as new usage', () => {
  const now = new Date();
  let state = emptyState();
  // A long-running app already at 200 MB must not register 200 MB as this month's usage.
  state = foldUsageSample(state, { total: 1000, apps: [{ name: 'Safari', total: 200 }] }, now);
  assert.equal(state.monthTotal, 0, 'first sample seeds the interface baseline with zero delta');
  assert.equal(state.apps.Safari, 0, 'first sample seeds the app baseline with no inflation');
  // Real growth between samples is what counts.
  state = foldUsageSample(state, { total: 1500, apps: [{ name: 'Safari', total: 260 }] }, now);
  assert.equal(state.monthTotal, 500, 'interface delta accumulates across samples');
  assert.equal(state.apps.Safari, 60, 'app delta accumulates across samples');
});

test('foldUsageSample treats a backwards counter (reboot) as a reset and keeps counting', () => {
  const now = new Date();
  let state = emptyState();
  state = foldUsageSample(state, { total: 5000, apps: [{ name: 'Safari', total: 900 }] }, now);
  // After a reboot the kernel counter restarts near zero.
  state = foldUsageSample(state, { total: 40, apps: [{ name: 'Safari', total: 15 }] }, now);
  assert.equal(state.monthTotal, 40, 'post-reset value becomes the new interface delta');
  assert.equal(state.apps.Safari, 15, 'post-reset value becomes the new app delta');
});

test('foldUsageSample resets per-app month totals on month rollover', () => {
  const jan = new Date(2026, 0, 15);
  let state = emptyState();
  state = foldUsageSample(state, { total: 100, apps: [{ name: 'Safari', total: 50 }] }, jan);
  state = foldUsageSample(state, { total: 300, apps: [{ name: 'Safari', total: 120 }] }, jan);
  assert.equal(state.apps.Safari, 70);
  assert.equal(state.monthTotal, 200);
  // Roll into February: month and per-app buckets reset, baselines carry over.
  const feb = new Date(2026, 1, 2);
  state = foldUsageSample(state, { total: 350, apps: [{ name: 'Safari', total: 150 }] }, feb);
  assert.equal(state.month, '2026-02');
  assert.equal(state.monthTotal, 50, 'only the new-month delta counts');
  assert.equal(state.apps.Safari, 30, 'per-app bucket reset to just the new-month delta');
});