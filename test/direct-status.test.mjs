import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSystemStatusMetric, formatSystemStatus, detectWeatherQuery, formatWeather, detectOnDemandLookup, answerDirectSystemStatus, answerDirectLargeFiles } from '../backend/agent/direct-status.mjs';

test('detects direct system-status questions', () => {
  assert.equal(detectSystemStatusMetric('how much RAM is free'), 'memory');
  assert.equal(detectSystemStatusMetric('how much memory do I have'), 'memory');
  assert.equal(detectSystemStatusMetric('memory usage'), 'memory');
  assert.equal(detectSystemStatusMetric('free RAM'), 'memory');
  assert.equal(detectSystemStatusMetric('how much disk space is free'), 'disk');
  assert.equal(detectSystemStatusMetric('free disk space'), 'disk');
  assert.equal(detectSystemStatusMetric('storage usage'), 'disk');
  assert.equal(detectSystemStatusMetric('how much space do I have'), 'disk');
  assert.equal(detectSystemStatusMetric('battery level'), 'battery');
  assert.equal(detectSystemStatusMetric('how much battery'), 'battery');
  assert.equal(detectSystemStatusMetric('uptime'), 'uptime');
  assert.equal(detectSystemStatusMetric('how long has my mac been up'), 'uptime');
});

test('falls through to the model for diagnostic or ambiguous asks', () => {
  for (const msg of [
    'why is my RAM full',
    'how do I free up memory',
    'close apps to speed up my Mac',
    'should I upgrade my storage',
    'how much RAM is free and should I close Chrome',
    'what is the weather',
    'summarize my emails',
    'organize my desktop',
  ]) {
    assert.equal(detectSystemStatusMetric(msg), null, `should fall through: ${msg}`);
  }
});

test('ignores empty and over-long input', () => {
  assert.equal(detectSystemStatusMetric(''), null);
  assert.equal(detectSystemStatusMetric('how much RAM is free '.padEnd(120, 'x')), null);
});

test('formats each metric from a snapshot', () => {
  const snap = {
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 2 * 1024 ** 3,
      usedPercent: 87,
      swap: { freeBytes: 0.5 * 1024 ** 3 },
    },
    disks: [
      {
        filesystem: 'Macintosh HD',
        mount: '/System/Volumes/Data',
        totalBytes: 500 * 1024 ** 3,
        availableBytes: 100 * 1024 ** 3,
        usedPercent: 80,
      },
    ],
    battery: { percent: 64, state: 'discharging', minutesRemaining: 95 },
    uptimeSeconds: 90061,
  };
  assert.match(formatSystemStatus('memory', snap), /2\.0 GB free.*87% used.*0\.5 GB swap free/);
  assert.match(formatSystemStatus('disk', snap), /100\.0 GB free.*80% used/);
  assert.match(formatSystemStatus('battery', snap), /64%.*discharging.*1h 35m remaining/);
  assert.match(formatSystemStatus('uptime', snap), /1d 1h 1m/);
});

test('handles a desktop Mac with no battery', () => {
  assert.match(formatSystemStatus('battery', { battery: null }), /No battery/);
  assert.match(formatSystemStatus('disk', { disks: [] }), /No storage/);
});

test('detects direct local-weather questions', () => {
  assert.equal(detectWeatherQuery("what's the weather"), 'weather');
  assert.equal(detectWeatherQuery('how is the weather today'), 'weather');
  assert.equal(detectWeatherQuery('is it going to rain'), 'weather');
  assert.equal(detectWeatherQuery('temperature outside'), 'weather');
  assert.equal(detectWeatherQuery('weather in my area'), 'weather');
});

test('leaves named places, system temps, and diagnosis to the model', () => {
  assert.equal(detectWeatherQuery("what's the weather in London"), null); // needs geocoding
  assert.equal(detectWeatherQuery('weather in Paris tomorrow'), null);
  assert.equal(detectWeatherQuery('cpu temperature'), null); // system word
  assert.equal(detectWeatherQuery('why is the weather app slow'), null); // diagnostic
  assert.equal(detectWeatherQuery('how do I fix my AC'), null);
});

test('formats a local-weather answer with the real conditions', () => {
  const out = formatWeather({ ok: true, city: 'Colombo', temp: 25, feelsLike: 30, description: 'Light drizzle', high: 31, low: 24, wind: 11, icon: '🌦️' });
  assert.match(out, /25°C/);
  assert.match(out, /Colombo/);
  assert.match(out, /Light drizzle/);
  assert.match(out, /high 31° \/ low 24°/);
  assert.equal(formatWeather({ ok: false, error: 'offline' }), null);
  assert.equal(formatWeather({ ok: true, temp: null }), null);
});

test('detects running-process and resource-hog questions', () => {
  assert.equal(detectSystemStatusMetric('what apps are running'), 'processes');
  assert.equal(detectSystemStatusMetric("what's running right now"), 'processes');
  assert.equal(detectSystemStatusMetric('top processes'), 'processes');
  assert.equal(detectSystemStatusMetric('what is using my memory'), 'top_memory');
  assert.equal(detectSystemStatusMetric('memory hogs'), 'top_memory');
  assert.equal(detectSystemStatusMetric("what's eating my ram"), 'top_memory');
  assert.equal(detectSystemStatusMetric('top cpu processes'), 'top_cpu');
  assert.equal(detectSystemStatusMetric('what is using my cpu'), 'top_cpu');
});

test('process-hog questions stay with the model for diagnosis or advice', () => {
  assert.equal(detectSystemStatusMetric('why is my ram full'), null);
  assert.equal(detectSystemStatusMetric('how do I free up memory'), null);
  assert.equal(detectSystemStatusMetric('close some apps to save memory'), null);
});

test('formats running-process and resource-hog answers', () => {
  const snapshot = {
    processes: [
      { pid: 1, command: 'WindowServer', cpuPercent: 21.3, memPercent: 4.2, rssBytes: 800000000 },
      { pid: 2, command: 'Chrome', cpuPercent: 12.1, memPercent: 18.4, rssBytes: 3500000000 },
    ],
    processesByMemory: [
      { pid: 2, command: 'Chrome', cpuPercent: 12.1, memPercent: 18.4, rssBytes: 3500000000 },
      { pid: 1, command: 'WindowServer', cpuPercent: 21.3, memPercent: 4.2, rssBytes: 800000000 },
    ],
  };
  const proc = formatSystemStatus('processes', snapshot);
  assert.match(proc, /Top processes by CPU/);
  assert.match(proc, /WindowServer/);
  assert.match(proc, /21\.3% CPU/);
  const mem = formatSystemStatus('top_memory', snapshot);
  assert.match(mem, /Top memory users/);
  assert.match(mem, /Chrome/);
  assert.equal(formatSystemStatus('processes', { processes: [] }), 'No process information available.');
});

test('detects single-value system lookups that skip the model', () => {
  assert.equal(detectOnDemandLookup('what is my ip address'), 'ip');
  assert.equal(detectOnDemandLookup('my ip'), 'ip');
  assert.equal(detectOnDemandLookup('local ip'), 'ip');
  assert.equal(detectOnDemandLookup('what is the macos version'), 'os_version');
  assert.equal(detectOnDemandLookup('macos version'), 'os_version');
  assert.equal(detectOnDemandLookup('what is my computer name'), 'computer_name');
  assert.equal(detectOnDemandLookup('hostname'), 'computer_name');
});

test('leaves how-to and diagnosis questions to the model', async () => {
  // "how do I find my IP" wants instructions, not the value.
  assert.equal(await answerDirectSystemStatus('how do I find my ip address'), null);
  assert.equal(await answerDirectSystemStatus('why is my mac so slow'), null);
  // Not every noun phrase is a lookup request.
  assert.equal(detectOnDemandLookup('the server ip address is wrong'), null);
});

test('detects the connected wifi network lookup', () => {
  assert.equal(detectOnDemandLookup('what is my wifi'), 'wifi');
  assert.equal(detectOnDemandLookup('what network am i connected to'), 'wifi');
  assert.equal(detectOnDemandLookup('my wifi network'), 'wifi');
  assert.equal(detectOnDemandLookup('the wifi network is down'), null);
});

test('detects disk-usage lookups and leaves how-to to the model', async () => {
  // These are deterministic scans, not model questions.
  const hit = await answerDirectLargeFiles('what is using my disk space');
  assert.ok(hit && typeof hit.answer === 'string' && hit.answer.length > 0, 'returns a report');
  assert.equal(await answerDirectLargeFiles('how do I free up disk space'), null);
  assert.equal(await answerDirectLargeFiles('what is 2+2'), null);
});
