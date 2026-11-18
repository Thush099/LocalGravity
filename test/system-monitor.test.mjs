import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCpuTimes,
  cpuPercentBetween,
  cpuPercentFromPs,
  partitionDisks,
  parseVmStat,
  parseGpuStats,
  parseDf,
  parsePs,
  summarizeSystemMetrics,
} from '../backend/system-monitor.mjs';

test('parseCpuTimes reads cumulative ticks and rejects malformed input', () => {
  const parsed = parseCpuTimes('1000 2000 6000 100');
  assert.deepEqual(parsed, { user: 1000, system: 2000, idle: 6000, nice: 100, total: 9100 });
  assert.equal(parseCpuTimes('1000 2000'), null);
  assert.equal(parseCpuTimes('a b c d'), null);
  assert.equal(parseCpuTimes(''), null);
});

test('cpuPercentBetween computes busy percentage and ignores bad deltas', () => {
  const a = parseCpuTimes('1000 2000 6000 100');
  const b = parseCpuTimes('1300 2400 6250 150');
  // busy +750 of +1000 total ticks => 75%
  assert.equal(cpuPercentBetween(a, b), 75);
  assert.equal(cpuPercentBetween(a, a), null);
  assert.equal(cpuPercentBetween(null, b), null);
  assert.equal(cpuPercentBetween(a, parseCpuTimes('0 0 0 0')), null);
});

test('parseVmStat converts page counts into used/free/wired bytes', () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                              2000.
Pages inactive:                            3000.
Pages speculative:                          500.
Pages wired down:                          1500.
Pages occupied by compressor:               700.
`;
  const mem = parseVmStat(text, 16384);
  assert.equal(mem.activeBytes, 2000 * 16384);
  assert.equal(mem.wiredBytes, 1500 * 16384);
  assert.equal(mem.compressedBytes, 700 * 16384);
  assert.equal(mem.usedBytes, (2000 + 1500 + 700) * 16384);
  assert.equal(mem.freeBytes, (1000 + 3000 + 500) * 16384);
});

test('parseGpuStats extracts utilization and memory, and tolerates missing stats', () => {
  const dump = `
    "IOClass"="AGXAcceleratorG13X"
    "PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=28,"In use system memory"=1073741824}
  `;
  const gpu = parseGpuStats(dump);
  assert.equal(gpu.name, 'AGXAcceleratorG13X');
  assert.equal(gpu.utilizationPercent, 37);
  assert.equal(gpu.inUseMemoryBytes, 1073741824);
  assert.equal(parseGpuStats('"nothing"=1'), null);
  assert.equal(parseGpuStats(''), null);
});

test('parseDf reads POSIX df rows and skips virtual filesystems', () => {
  const text = `Filesystem 1024-blocks      Used Available Capacity Mounted on
/dev/disk3s1s1  971350180 400000000 500000000    45% /
devfs                195       195         0   100% /dev
map auto_home          0         0         0   100% /System/Volumes/Data
/dev/disk3s6    10000000   5000000   4500000    53% /Volumes/Backup
`;
  const disks = parseDf(text);
  assert.equal(disks.length, 2);
  assert.equal(disks[0].mount, '/');
  assert.equal(disks[0].totalBytes, 971350180 * 1024);
  assert.equal(disks[0].usedPercent, 45);
  assert.equal(disks[1].mount, '/Volumes/Backup');
});

test('parsePs reads top process rows and caps the list', () => {
  const header = '  PID %CPU %MEM    RSS COMM\n';
  const rows = Array.from({ length: 20 }, (_, i) => ` ${100 + i}  ${(20 - i).toFixed(1)}  1.0   2048 task${i}\n`).join('');
  const procs = parsePs(header + rows);
  assert.equal(procs.length, 12);
  assert.equal(procs[0].pid, 100);
  assert.equal(procs[0].command, 'task0');
  assert.equal(procs[0].rssBytes, 2048 * 1024);
});

test('cpuPercentFromPs sums per-process CPU and normalizes by core count', () => {
  const header = '  PID %CPU %MEM    RSS COMM\n';
  const rows = ' 1  50.0  1.0   2048 a\n 2  30.0  1.0   2048 b\n';
  assert.equal(cpuPercentFromPs(header + rows, 10), 8);
  assert.equal(cpuPercentFromPs(header + rows, 1), 80);
  assert.equal(cpuPercentFromPs('', 10), 0);
  assert.equal(cpuPercentFromPs(header + rows, 0), 0);
  // Sums above all cores clamp to 100.
  assert.equal(cpuPercentFromPs(header + ' 3  500.0  1.0   2048 c\n', 4), 100);
});

test('partitionDisks keeps user volumes and hides sealed-system helper volumes', () => {
  const disks = [
    { mount: '/System/Volumes/Preboot' },
    { mount: '/System/Volumes/Data' },
    { mount: '/' },
    { mount: '/Volumes/Backup' },
    { mount: '/System/Volumes/VM' },
  ];
  const { user, system } = partitionDisks(disks);
  assert.deepEqual(user.map((d) => d.mount), ['/', '/System/Volumes/Data', '/Volumes/Backup']);
  assert.deepEqual(system.map((d) => d.mount), ['/System/Volumes/Preboot', '/System/Volumes/VM']);
});

test('summarizeSystemMetrics renders a compact agent-facing report', () => {
  const report = summarizeSystemMetrics({
    cpu: { percent: 12.5 },
    loadAvg: [1.5, 1.2, 1.0],
    memory: {
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      wiredBytes: 2 * 1024 ** 3,
      compressedBytes: 1 * 1024 ** 3,
      usedPercent: 50,
    },
    gpu: { name: 'AGX', utilizationPercent: 37, inUseMemoryBytes: 1024 ** 3 },
    disks: [{ mount: '/', usedBytes: 400 * 1024 ** 3, totalBytes: 900 * 1024 ** 3, usedPercent: 45 }],
    processes: [{ command: 'node', pid: 7, cpuPercent: 9.1, memPercent: 2.2 }],
    uptimeSeconds: 7200,
  });
  assert.match(report, /CPU: 12\.5% busy \| load 1\.5 \/ 1\.2 \/ 1/);
  assert.match(report, /Memory: 8 GB used of 16 GB \(50%\)/);
  assert.match(report, /GPU \(AGX\): 37% utilization \| 1 GB in use/);
  assert.ok(report.includes('Storage /: 400 GB used of 900 GB (45%)'));
  assert.match(report, /node \(pid 7\): 9\.1% cpu/);
  assert.match(report, /Uptime: 2 hours/);
  assert.equal(summarizeSystemMetrics(null), 'System metrics unavailable.');
});
