import { execFile } from 'node:child_process';
import os from 'node:os';

const MAX_CAPTURE_BYTES = 1024 * 1024;

function runBinary(bin, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: MAX_CAPTURE_BYTES, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({ ok: false, error: err.message, stdout: '', stderr: stderr || '' });
          return;
        }
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

/**
 * Parse `sysctl -n kern.cp_time` output: cumulative ticks per CPU state.
 * Order: user, system, idle, nice.
 */
export function parseCpuTimes(text) {
  const parts = String(text || '')
    .trim()
    .split(/\s+/)
    .map((n) => Number(n));
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [user, system, idle, nice] = parts;
  return { user, system, idle, nice, total: user + system + idle + nice };
}

/**
 * CPU busy percentage between two cumulative tick samples (0..100).
 */
export function cpuPercentBetween(a, b) {
  if (!a || !b) return null;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return null;
  const busyDelta =
    b.user - a.user + (b.system - a.system) + (b.nice - a.nice);
  return round(Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100)));
}

/**
 * Parse `vm_stat` page counts into byte figures.
 */
export function parseVmStat(text, pageSize = 16384) {
  const counts = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(Pages\s+[^:]+):\s+(\d+)/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
      counts[key] = Number(m[2]);
    }
  }
  const page = (key) => (counts[key] || 0) * pageSize;
  const free = page('pages_free');
  const active = page('pages_active');
  const inactive = page('pages_inactive');
  const speculative = page('pages_speculative');
  const wired = page('pages_wired_down');
  const compressed = page('pages_occupied_by_compressor');
  return {
    freeBytes: free + inactive + speculative,
    activeBytes: active,
    wiredBytes: wired,
    compressedBytes: compressed,
    usedBytes: active + wired + compressed,
  };
}

/**
 * Extract GPU utilization from an `ioreg -r -c IOAccelerator` dump.
 * Returns null when the driver exposes no PerformanceStatistics.
 */
export function parseGpuStats(text) {
  const src = String(text || '');
  if (!src) return null;
  const pick = (label) => {
    const m = src.match(new RegExp(`"${label}"=([0-9]+)`));
    return m ? Number(m[1]) : null;
  };
  const utilization = pick('Device Utilization %');
  const rendererUtilization = pick('Renderer Utilization %');
  const inUseMemory = pick('In use system memory');
  const totalCores = pick('Total Power');
  if (utilization === null && rendererUtilization === null && inUseMemory === null) return null;
  const nameMatch =
    src.match(/"IOClass"="([^"]+)"/) ||
    src.match(/"([^"]*Accelerator[^"]*)"/);
  return {
    name: nameMatch ? nameMatch[1] : 'Apple GPU',
    utilizationPercent: utilization ?? rendererUtilization,
    rendererUtilizationPercent: rendererUtilization,
    inUseMemoryBytes: inUseMemory,
    totalPower: totalCores,
  };
}

/**
 * Estimate CPU busy percentage from summed per-process `ps` percentages
 * (0..100 across all cores). Used where kern.cp_time is unavailable (Apple Silicon).
 */
export function cpuPercentFromPs(text, ncpu = 1) {
  let sum = 0;
  const lines = String(text || '').split('\n').slice(1);
  for (const line of lines) {
    const m = line.trim().match(/^[0-9]+\s+([\d.]+)/);
    if (m) sum += Number(m[1]);
  }
  if (!Number.isFinite(sum) || sum <= 0 || !Number.isFinite(ncpu) || ncpu <= 0) return 0;
  return round(Math.min(100, sum / ncpu));
}

/**
 * Parse POSIX `df -kP` output into mounted-volume figures.
 */
export function parseDf(text) {
  const rows = [];
  const lines = String(text || '').split('\n').slice(1);
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [filesystem, blocks, used, avail, capacity, ...mountParts] = cols;
    if (!filesystem || filesystem === 'map' || filesystem === 'devfs') continue;
    const mount = mountParts.join(' ');
    const totalBytes = Number(blocks) * 1024;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    rows.push({
      filesystem,
      mount,
      totalBytes,
      usedBytes: Number(used) * 1024,
      availableBytes: Number(avail) * 1024,
      usedPercent: Number(String(capacity).replace('%', '')) || 0,
    });
  }
  return rows;
}

const USER_VOLUME_RE = /^\/(Volumes\/|System\/Volumes\/Data$)/;
const INTERNAL_VOLUME_RE = /^\/Volumes\/Recovery$/;

/**
 * Keep volumes a person cares about: the boot volume, the Data volume,
 * and external /Volumes mounts. Hide sealed-system helper volumes.
 */
export function partitionDisks(disks) {
  const user = [];
  const system = [];
  for (const d of disks) {
    if (!INTERNAL_VOLUME_RE.test(d.mount) && (d.mount === '/' || USER_VOLUME_RE.test(d.mount))) user.push(d);
    else system.push(d);
  }
  user.sort((a, b) => {
    if (a.mount === '/') return -1;
    if (b.mount === '/') return 1;
    return a.mount.localeCompare(b.mount);
  });
  return { user, system };
}

/**
 * Parse `ps -Aceo pid,pcpu,pmem,rss,comm -r` output (first line is the header).
 */
export function parsePs(text) {
  const rows = [];
  const lines = String(text || '').split('\n').slice(1);
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      cpuPercent: Number(m[2]),
      memPercent: Number(m[3]),
      rssBytes: Number(m[4]) * 1024,
      command: m[5].trim(),
    });
    if (rows.length >= 12) break;
  }
  return rows;
}

export async function sampleCpuTimes() {
  const res = await runBinary('/usr/sbin/sysctl', ['-n', 'kern.cp_time']);
  return res.ok ? parseCpuTimes(res.stdout) : null;
}

/**
 * Collect a full local-system snapshot: CPU, memory, GPU, storage, top processes.
 * Read-only; every collector degrades to null on failure instead of throwing.
 */
export async function collectSystemMetrics({ sampleMs = 250 } = {}) {
  const first = await sampleCpuTimes();
  if (first && sampleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  const [second, vmStat, gpuDump, dfDump, psDump, loadDump, memSizeDump, bootDump] =
    await Promise.all([
      sampleCpuTimes(),
      runBinary('/usr/bin/vm_stat', []),
      runBinary('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator']),
      runBinary('/bin/df', ['-kP']),
      runBinary('/bin/ps', ['-Aceo', 'pid,pcpu,pmem,rss,comm', '-r']),
      runBinary('/usr/sbin/sysctl', ['-n', 'vm.loadavg']),
      runBinary('/usr/sbin/sysctl', ['-n', 'hw.memsize']),
      runBinary('/usr/sbin/sysctl', ['-n', 'kern.boottime']),
    ]);

  const pageSize = 16384;
  const memBytes = parseVmStat(vmStat.stdout, pageSize);
  const totalRamBytes = Number(memSizeDump.stdout.trim()) || os.totalmem();
  const allDisks = dfDump.ok ? parseDf(dfDump.stdout) : [];
  const { user: disks, system: systemDisks } = partitionDisks(allDisks);
  const loadMatch = loadDump.stdout.trim().match(/\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const bootMatch = bootDump.stdout.match(/sec\s*=\s*(\d+)/);
  const ncpu = os.cpus()?.length || 1;

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      // Intel Macs expose kern.cp_time; Apple Silicon falls back to the ps sum.
      percent: cpuPercentBetween(first, second) ?? (psDump.ok ? cpuPercentFromPs(psDump.stdout, ncpu) : null),
      cores: ncpu,
      sampleMs: first ? sampleMs : 0,
    },
    memory: {
      totalBytes: totalRamBytes,
      usedBytes: memBytes?.usedBytes ?? null,
      freeBytes: memBytes?.freeBytes ?? null,
      activeBytes: memBytes?.activeBytes ?? null,
      wiredBytes: memBytes?.wiredBytes ?? null,
      compressedBytes: memBytes?.compressedBytes ?? null,
      usedPercent:
        memBytes && totalRamBytes
          ? round((memBytes.usedBytes / totalRamBytes) * 100)
          : null,
    },
    gpu: gpuDump.ok ? parseGpuStats(gpuDump.stdout) : null,
    disks,
    systemDisks,
    processes: psDump.ok ? parsePs(psDump.stdout) : [],
    loadAvg: loadMatch
      ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])]
      : null,
    uptimeSeconds: bootMatch ? Math.max(0, Math.floor(Date.now() / 1000) - Number(bootMatch[1])) : null,
    arch: os.arch(),
  };
}

/**
 * Compact plain-text summary for the agent's system_stats tool.
 */
export function summarizeSystemMetrics(metrics) {
  if (!metrics) return 'System metrics unavailable.';
  const lines = [];
  lines.push(
    `CPU: ${metrics.cpu.percent === null ? 'sampling unavailable' : `${metrics.cpu.percent}% busy`}` +
      (metrics.loadAvg ? ` | load ${metrics.loadAvg.join(' / ')}` : '')
  );
  if (metrics.memory.totalBytes) {
    const gb = (n) => `${round(n / 1024 ** 3)} GB`;
    lines.push(
      `Memory: ${gb(metrics.memory.usedBytes || 0)} used of ${gb(metrics.memory.totalBytes)}` +
        (metrics.memory.usedPercent !== null ? ` (${metrics.memory.usedPercent}%)` : '') +
        ` | wired ${gb(metrics.memory.wiredBytes || 0)} | compressed ${gb(metrics.memory.compressedBytes || 0)}`
    );
  }
  if (metrics.gpu) {
    lines.push(
      `GPU (${metrics.gpu.name}): ` +
        (metrics.gpu.utilizationPercent === null
          ? 'utilization unavailable'
          : `${metrics.gpu.utilizationPercent}% utilization`) +
        (metrics.gpu.inUseMemoryBytes
          ? ` | ${round(metrics.gpu.inUseMemoryBytes / 1024 ** 3)} GB in use`
          : '')
    );
  } else {
    lines.push('GPU: no utilization data exposed by the driver');
  }
  for (const d of metrics.disks.slice(0, 4)) {
    lines.push(
      `Storage ${d.mount}: ${round(d.usedBytes / 1024 ** 3)} GB used of ${round(d.totalBytes / 1024 ** 3)} GB (${d.usedPercent}%)`
    );
  }
  if (metrics.processes.length > 0) {
    lines.push('Top processes by CPU:');
    for (const p of metrics.processes.slice(0, 6)) {
      lines.push(`  ${p.command} (pid ${p.pid}): ${p.cpuPercent}% cpu, ${p.memPercent}% mem`);
    }
  }
  if (metrics.uptimeSeconds !== null) {
    lines.push(`Uptime: ${round(metrics.uptimeSeconds / 3600)} hours`);
  }
  return lines.join('\n');
}
