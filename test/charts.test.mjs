import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendlyAppName,
  renderMemoryDonut,
  renderMultiSeriesChart,
  renderNetworkDonut,
  renderSparkline,
  renderWeeklyScheduleChart,
  summarizeTelemetrySeries,
} from '../ui/lib/charts.js';

test('renderSparkline handles empty, single, multi-point, and out-of-range inputs safely', () => {
  const emptySvg = renderSparkline([], { label: 'CPU' });
  assert.match(emptySvg, /<svg/);
  assert.doesNotMatch(emptySvg, /NaN/);

  const singleSvg = renderSparkline([42], { label: 'CPU' });
  assert.match(singleSvg, /<circle/);
  assert.doesNotMatch(singleSvg, /NaN/);

  const multiSvg = renderSparkline([-10, 25, 68, 120], { label: 'Memory', color: '#34d399' });
  assert.match(multiSvg, /linearGradient id="lg-spark-memory"/);
  assert.match(multiSvg, /<path d="M/);
  assert.doesNotMatch(multiSvg, /NaN|Infinity/);
});

test('renderMultiSeriesChart and summarizeTelemetrySeries plot CPU/Mem/GPU and support filtering', () => {
  const empty = renderMultiSeriesChart([]);
  assert.match(empty.svg, /Waiting for first system sample/);
  assert.equal(empty.stats.samples, 0);

  const history = [
    { t: '2026-11-19T14:00:00Z', cpu: 20, mem: 60, gpu: 10 },
    { t: '2026-11-19T14:00:04Z', cpu: 50, mem: 64, gpu: 40 },
    { t: '2026-11-19T14:00:08Z', cpu: 35, mem: 62, gpu: 25 },
  ];
  const allChart = renderMultiSeriesChart(history, { activeSeries: 'all' });
  assert.equal(allChart.stats.cpu.peak, 50);
  assert.equal(allChart.stats.cpu.current, 35);
  assert.equal(allChart.stats.mem.avg, 62);
  assert.match(allChart.svg, /lg-tel-cpu/);
  assert.match(allChart.svg, /lg-tel-mem/);
  assert.match(allChart.svg, /lg-tel-gpu/);
  assert.doesNotMatch(allChart.svg, /NaN/);

  const cpuOnly = renderMultiSeriesChart(history, { activeSeries: 'cpu' });
  assert.match(cpuOnly.svg, /lg-tel-cpu/);
  assert.doesNotMatch(cpuOnly.svg, /lg-tel-mem/);
});

test('renderMemoryDonut computes segments, swap bar, Ollama VRAM highlight, and tolerates zeros', () => {
  const zero = renderMemoryDonut({});
  assert.match(zero.svg, /0%/);
  assert.doesNotMatch(zero.svg, /NaN/);

  const gb = 1024 ** 3;
  const full = renderMemoryDonut(
    {
      totalBytes: 16 * gb,
      activeBytes: 6 * gb,
      wiredBytes: 3 * gb,
      compressedBytes: 1.5 * gb,
      swap: { usedBytes: 1.2 * gb, totalBytes: 4 * gb, usedPercent: 30 },
    },
    4.1 * gb
  );
  assert.equal(full.usedPct, 66);
  assert.match(full.svg, /10\.5 GB/);
  assert.match(full.legendHtml, /Active App/);
  assert.match(full.legendHtml, /Ollama Model GPU/);
  assert.match(full.legendHtml, /4\.1 GB/);
  assert.match(full.legendHtml, /SSD Swap/);
});

test('renderWeeklyScheduleChart calculates weekday focus totals and highlights busiest day', () => {
  const entries = [
    { id: '1', title: 'Coding', time: '09:30', days: [1, 2, 3, 4, 5], durationMin: 90, enabled: true },
    { id: '2', title: 'Review', time: '14:00', days: [4], durationMin: 60, enabled: true },
    { id: '3', title: 'Paused', time: '18:00', days: [6], durationMin: 120, enabled: false },
    { id: '4', title: 'One-off Release', time: '16:30', date: '2026-11-20', durationMin: 60, enabled: true },
  ];
  const chart = renderWeeklyScheduleChart(entries, 4, new Date('2026-11-19T12:00:00'));
  // 5*90 + 60 + 60 (Friday Nov 20 in same Mon-Sun week) = 570 min = 9.5 hours
  assert.equal(chart.totalHours, 9.5);
  assert.equal(chart.busiestDayLabel, 'Thursday');
  assert.match(chart.svg, /Thu/);
  assert.match(chart.svg, /2\.5h/);
  assert.doesNotMatch(chart.svg, /NaN/);

  const emptyChart = renderWeeklyScheduleChart([], 1);
  assert.equal(emptyChart.totalHours, 0);
  assert.equal(emptyChart.busiestDayLabel, 'None');
});

test('friendlyAppName shortens raw process names to readable app labels', () => {
  assert.equal(friendlyAppName('Google Chrome Helper (Aperitif)'), 'Google Chrome');
  assert.equal(friendlyAppName('DeepAI Code Helper'), 'DeepAI Code');
  assert.equal(friendlyAppName('Antigravity Helper'), 'Antigravity');
  assert.equal(friendlyAppName('com.apple.WebKit.Networking'), 'WebKit');
  assert.equal(friendlyAppName('com.apple.Safari'), 'Safari');
  assert.equal(friendlyAppName('language_server'), 'Language Server');
  // conservative: no clear shortening -> unchanged
  assert.equal(friendlyAppName('mDNSResponder'), 'mDNSResponder');
  assert.equal(friendlyAppName('Other'), 'Other');
  assert.equal(friendlyAppName(''), 'Unknown');
});

test('network legend shows the short name but keeps the full name in the tooltip', () => {
  const { legendHtml } = renderNetworkDonut(
    [
      { name: 'Google Chrome Helper (Aperitif)', total: 500 },
      { name: 'com.apple.WebKit.Networking', total: 300 },
    ],
    { size: 132 }
  );
  assert.match(legendHtml, /Google Chrome<\/span>/); // short label rendered
  assert.match(legendHtml, /WebKit<\/span>/);
  assert.match(legendHtml, /title="Google Chrome Helper \(Aperitif\)"/); // full name kept as tooltip
  assert.match(legendHtml, /title="com\.apple\.WebKit\.Networking"/);
  // the visible label span is exactly the short form (raw name only lives in the tooltip)
  assert.match(legendHtml, /<span class="donut-legend-label">Google Chrome<\/span>/);
  assert.match(legendHtml, /<span class="donut-legend-label">WebKit<\/span>/);
});
