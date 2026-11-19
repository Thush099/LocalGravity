import { escapeHtml } from './markdown.js';

function sanitizeId(raw) {
  return String(raw || 'series')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '') || 'series';
}

function clampPct(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (max <= min) return 0;
  return Math.max(min, Math.min(max, n));
}

function formatGb(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '0.0 GB';
  const gb = b / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(b / 1024 ** 2)} MB`;
}

/**
 * Render a compact, crisp SVG sparkline (with smooth gradient fill) for KPI cards.
 */
export function renderSparkline(
  values = [],
  { color = '#38bdf8', width = 148, height = 34, min = 0, max = 100, label = 'trend' } = {}
) {
  const w = Math.max(48, Number(width) || 148);
  const h = Math.max(20, Number(height) || 34);
  const padX = 4;
  const padY = 4;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const gradId = `lg-spark-${sanitizeId(label)}`;

  const pts = (Array.isArray(values) ? values : [])
    .map((v) => clampPct(v, min, max))
    .filter((v) => v !== null);

  if (pts.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="${escapeHtml(label)} sparkline">
      <line x1="${padX}" y1="${(h / 2).toFixed(1)}" x2="${w - padX}" y2="${(h / 2).toFixed(1)}" stroke="currentColor" stroke-opacity="0.16" stroke-dasharray="3 3" stroke-width="1.2" />
    </svg>`;
  }

  const toY = (val) => {
    const ratio = (val - min) / Math.max(1e-6, max - min);
    return padY + (1 - ratio) * innerH;
  };

  if (pts.length === 1) {
    const y = toY(pts[0]).toFixed(1);
    const xEnd = (w - padX).toFixed(1);
    return `<svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="${escapeHtml(label)} sparkline">
      <line x1="${padX}" y1="${y}" x2="${xEnd}" y2="${y}" stroke="${escapeHtml(color)}" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="3 3" />
      <circle cx="${xEnd}" cy="${y}" r="3" fill="${escapeHtml(color)}" />
    </svg>`;
  }

  const coords = pts.map((v, idx) => {
    const x = padX + (idx / (pts.length - 1)) * innerW;
    const y = toY(v);
    return { x, y };
  });

  const linePath = coords.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(h - 1).toFixed(1)} L${coords[0].x.toFixed(1)},${(h - 1).toFixed(1)} Z`;
  const last = coords[coords.length - 1];

  return `<svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="${escapeHtml(label)} sparkline">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${escapeHtml(color)}" stop-opacity="0.30" />
        <stop offset="100%" stop-color="${escapeHtml(color)}" stop-opacity="0.01" />
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#${gradId})" />
    <path d="${linePath}" fill="none" stroke="${escapeHtml(color)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.8" fill="${escapeHtml(color)}" />
  </svg>`;
}

function computeSeriesSummary(samples, key) {
  const nums = samples.map((s) => Number(s?.[key])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return { current: null, avg: null, peak: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    current: Math.round(nums[nums.length - 1] * 10) / 10,
    avg: Math.round((sum / nums.length) * 10) / 10,
    peak: Math.round(Math.max(...nums) * 10) / 10,
  };
}

export function summarizeTelemetrySeries(history = []) {
  const list = Array.isArray(history) ? history : [];
  return {
    cpu: computeSeriesSummary(list, 'cpu'),
    mem: computeSeriesSummary(list, 'mem'),
    gpu: computeSeriesSummary(list, 'gpu'),
    samples: list.length,
  };
}

/**
 * Render multi-series SVG telemetry line chart for System Monitor (CPU, Memory, GPU).
 */
export function renderMultiSeriesChart(
  history = [],
  { activeSeries = 'all', width = 820, height = 210 } = {}
) {
  const list = Array.isArray(history) ? history : [];
  const stats = summarizeTelemetrySeries(list);
  const w = Math.max(320, Number(width) || 820);
  const h = Math.max(140, Number(height) || 210);
  const padLeft = 14;
  const padRight = 40;
  const padTop = 14;
  const padBottom = 26;
  const innerW = w - padLeft - padRight;
  const innerH = h - padTop - padBottom;

  const seriesMeta = [
    { key: 'cpu', label: 'CPU', color: '#38bdf8' },
    { key: 'mem', label: 'Memory', color: '#34d399' },
    { key: 'gpu', label: 'GPU', color: '#f59e0b' },
  ].filter((s) => activeSeries === 'all' || s.key === activeSeries);

  const gridLevels = [0, 25, 50, 75, 100];
  const gridHtml = gridLevels
    .map((pct) => {
      const y = (padTop + (1 - pct / 100) * innerH).toFixed(1);
      return `
        <line x1="${padLeft}" y1="${y}" x2="${w - padRight}" y2="${y}" stroke="currentColor" stroke-opacity="${pct === 0 ? '0.18' : '0.09'}" ${pct > 0 && pct < 100 ? 'stroke-dasharray="4 4"' : ''} stroke-width="1" />
        <text x="${w - padRight + 6}" y="${Number(y) + 3.5}" class="chart-axis-text">${pct}%</text>
      `;
    })
    .join('');

  if (list.length === 0) {
    const svg = `<svg viewBox="0 0 ${w} ${h}" class="telemetry-svg" role="img" aria-label="Live telemetry chart">
      ${gridHtml}
      <text x="${(padLeft + innerW / 2).toFixed(1)}" y="${(padTop + innerH / 2).toFixed(1)}" text-anchor="middle" class="chart-empty-text">Waiting for first system sample...</text>
    </svg>`;
    return { svg, stats };
  }

  const xAt = (idx) => {
    if (list.length === 1) return padLeft + innerW;
    return padLeft + (idx / (list.length - 1)) * innerW;
  };
  const yAt = (pct) => padTop + (1 - clampPct(pct, 0, 100) / 100) * innerH;

  const defs = [];
  const layers = [];

  for (const s of seriesMeta) {
    const validPts = [];
    list.forEach((sample, idx) => {
      const val = clampPct(sample?.[s.key], 0, 100);
      if (val !== null) validPts.push({ x: xAt(idx), y: yAt(val), val });
    });
    if (validPts.length === 0) continue;

    if (validPts.length === 1) {
      const pt = validPts[0];
      layers.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4" fill="${s.color}" />`);
      continue;
    }

    const pathD = validPts
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
    const areaD = `${pathD} L${validPts[validPts.length - 1].x.toFixed(1)},${(padTop + innerH).toFixed(1)} L${validPts[0].x.toFixed(1)},${(padTop + innerH).toFixed(1)} Z`;
    const gradId = `lg-tel-${s.key}`;
    const fillOpacity = activeSeries === 'all' ? '0.14' : '0.24';
    defs.push(`
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="${fillOpacity}" />
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0.01" />
      </linearGradient>
    `);
    const last = validPts[validPts.length - 1];
    layers.push(`
      <path d="${areaD}" fill="url(#${gradId})" />
      <path d="${pathD}" fill="none" stroke="${s.color}" stroke-width="${activeSeries === s.key ? '2.4' : '2'}" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="${s.color}" stroke="#0b0d11" stroke-width="1.5" />
    `);
  }

  const firstTime = list[0]?.t ? new Date(list[0].t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }) : '';
  const lastTime = list[list.length - 1]?.t
    ? new Date(list[list.length - 1].t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })
    : 'Now';
  const spanLabel = list.length === 1 ? 'Collecting live history every 4s' : `${list.length} samples · ${firstTime} → ${lastTime}`;

  const svg = `<svg viewBox="0 0 ${w} ${h}" class="telemetry-svg" role="img" aria-label="Live CPU, Memory, and GPU telemetry chart">
    <defs>${defs.join('')}</defs>
    ${gridHtml}
    ${layers.join('')}
    <text x="${padLeft}" y="${h - 6}" class="chart-axis-text">${escapeHtml(spanLabel)}</text>
    <text x="${w - padRight}" y="${h - 6}" text-anchor="end" class="chart-axis-text">Now</text>
  </svg>`;

  return { svg, stats };
}

/**
 * Render an Apple Silicon Unified Memory SVG donut ring chart + segment breakdown legend.
 */
export function renderMemoryDonut(memory = {}, ollamaVramBytes = 0, { size = 152 } = {}) {
  const s = Math.max(100, Number(size) || 152);
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.36;
  const strokeW = Math.max(10, Math.round(s * 0.095));
  const circumference = 2 * Math.PI * r;

  const totalBytes = Math.max(0, Number(memory?.totalBytes) || 0);
  const activeBytes = Math.max(0, Number(memory?.activeBytes) || 0);
  const wiredBytes = Math.max(0, Number(memory?.wiredBytes) || 0);
  const compressedBytes = Math.max(0, Number(memory?.compressedBytes) || 0);
  const usedFallback = Math.max(0, Number(memory?.usedBytes) || 0);
  const accounted = activeBytes + wiredBytes + compressedBytes;
  const normActive = accounted > 0 ? activeBytes : usedFallback;
  const usedBytes = accounted > 0 ? accounted : usedFallback;
  const freeBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
  const denom = Math.max(1, totalBytes || usedBytes || 1);
  const usedPct = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;

  const segments = [
    { key: 'active', label: 'Active App', bytes: normActive, color: '#38bdf8' },
    { key: 'wired', label: 'Wired Kernel / GPU', bytes: wiredBytes, color: '#f59e0b' },
    { key: 'compressed', label: 'Compressed', bytes: compressedBytes, color: '#fb7185' },
  ];

  let offset = 0;
  const arcsHtml = segments
    .map((seg) => {
      const len = Math.max(0, (seg.bytes / denom) * circumference);
      if (len <= 0.5) return '';
      const arc = `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${seg.color}" stroke-width="${strokeW}" stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += len;
      return arc;
    })
    .join('');

  const svg = `<svg viewBox="0 0 ${s} ${s}" class="donut-svg" role="img" aria-label="Unified memory breakdown">
    <circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity="0.12" stroke-width="${strokeW}" />
    ${arcsHtml}
    <text x="${cx}" y="${(cy - 3).toFixed(1)}" text-anchor="middle" class="donut-pct">${usedPct}%</text>
    <text x="${cx}" y="${(cy + 14).toFixed(1)}" text-anchor="middle" class="donut-sub">${escapeHtml(formatGb(usedBytes))}</text>
  </svg>`;

  const swap = memory?.swap;
  const legendItems = [
    ...segments.map(
      (seg) => `<div class="donut-legend-row">
        <span class="donut-swatch" style="background:${seg.color}"></span>
        <span class="donut-legend-label">${escapeHtml(seg.label)}</span>
        <span class="donut-legend-val">${escapeHtml(formatGb(seg.bytes))}</span>
      </div>`
    ),
    `<div class="donut-legend-row">
      <span class="donut-swatch donut-swatch-free"></span>
      <span class="donut-legend-label">Available</span>
      <span class="donut-legend-val">${escapeHtml(formatGb(freeBytes))}</span>
    </div>`,
  ];

  if (ollamaVramBytes > 0) {
    legendItems.push(`<div class="donut-legend-row donut-legend-highlight">
      <span class="donut-swatch" style="background:#34d399"></span>
      <span class="donut-legend-label">Ollama Model GPU</span>
      <span class="donut-legend-val">${escapeHtml(formatGb(ollamaVramBytes))}</span>
    </div>`);
  }

  if (swap && swap.totalBytes > 0) {
    legendItems.push(`<div class="donut-swap-bar">
      <div class="donut-legend-row">
        <span class="donut-legend-label">SSD Swap</span>
        <span class="donut-legend-val">${escapeHtml(formatGb(swap.usedBytes))} / ${escapeHtml(formatGb(swap.totalBytes))} (${swap.usedPercent}%)</span>
      </div>
      <div class="usage-bar"><span style="width:${Math.min(100, swap.usedPercent || 0)}%" data-tone="${swap.usedPercent >= 75 ? 'high' : swap.usedPercent >= 45 ? 'warn' : 'ok'}"></span></div>
    </div>`);
  }

  return {
    svg,
    legendHtml: legendItems.join(''),
    segments,
    usedPct,
  };
}

/**
 * Render weekly timetable focus-hour distribution SVG bar chart (Mon -> Sun).
 */
export function renderWeeklyScheduleChart(entries = [], todayDay = new Date().getDay(), referenceDate = new Date()) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const shortNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.enabled !== false) : [];

  // Map YYYY-MM-DD for this Mon-Sun week so dated one-off items inside this week appear on the bar chart
  const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const offsetToMonday = ref.getDay() === 0 ? -6 : 1 - ref.getDay();
  const weekDateMap = new Map();
  for (let i = 0; i < 7; i++) {
    const d = new Date(ref);
    d.setDate(ref.getDate() + offsetToMonday + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    weekDateMap.set(iso, d.getDay());
  }

  const minutesByDay = new Map(order.map((d) => [d, 0]));
  let totalBlocks = 0;
  for (const entry of list) {
    const dur = Math.max(0, Number(entry.durationMin) || 30);
    if (entry.date) {
      const matchedDay = weekDateMap.get(String(entry.date));
      if (matchedDay !== undefined) {
        minutesByDay.set(matchedDay, (minutesByDay.get(matchedDay) || 0) + dur);
        totalBlocks++;
      }
    } else if (Array.isArray(entry.days)) {
      for (const day of entry.days) {
        if (minutesByDay.has(day)) {
          minutesByDay.set(day, (minutesByDay.get(day) || 0) + dur);
          totalBlocks++;
        }
      }
    }
  }

  const totals = order.map((day) => ({
    day,
    short: shortNames[day],
    full: fullNames[day],
    minutes: minutesByDay.get(day) || 0,
    hours: Math.round(((minutesByDay.get(day) || 0) / 60) * 10) / 10,
  }));

  const maxMinutes = Math.max(60, ...totals.map((t) => t.minutes));
  const totalMinutes = totals.reduce((acc, t) => acc + t.minutes, 0);
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const busiest = totals.reduce((best, cur) => (cur.minutes > best.minutes ? cur : best), totals[0]);

  const w = 640;
  const h = 132;
  const padTop = 22;
  const padBottom = 24;
  const barAreaH = h - padTop - padBottom;
  const colW = w / order.length;
  const barW = 36;

  const barsHtml = totals
    .map((item, idx) => {
      const cx = idx * colW + colW / 2;
      const barH = item.minutes > 0 ? Math.max(6, (item.minutes / maxMinutes) * barAreaH) : 4;
      const x = cx - barW / 2;
      const y = padTop + barAreaH - barH;
      const isToday = item.day === todayDay;
      const fill = item.minutes === 0 ? 'currentColor' : isToday ? '#38bdf8' : '#0ea5e9';
      const fillOpacity = item.minutes === 0 ? '0.12' : isToday ? '0.95' : '0.45';
      const hrsText = item.minutes > 0 ? `${item.hours}h` : '—';
      return `
        <g>
          <text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" class="chart-bar-val${isToday ? ' today' : ''}">${hrsText}</text>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" rx="6" fill="${fill}" fill-opacity="${fillOpacity}" />
          <text x="${cx.toFixed(1)}" y="${h - 6}" text-anchor="middle" class="chart-bar-day${isToday ? ' today' : ''}">${item.short}</text>
        </g>
      `;
    })
    .join('');

  const svg = `<svg viewBox="0 0 ${w} ${h}" class="week-chart-svg" role="img" aria-label="Weekly scheduled hours chart">
    <line x1="16" y1="${padTop + barAreaH}" x2="${w - 16}" y2="${padTop + barAreaH}" stroke="currentColor" stroke-opacity="0.14" stroke-width="1" />
    ${barsHtml}
  </svg>`;

  return {
    svg,
    totalHours,
    busiestDayLabel: totalMinutes > 0 ? busiest.full : 'None',
    busiestHours: busiest.hours,
    totalBlocks,
  };
}
