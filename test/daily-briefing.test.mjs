import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, rankNews, weatherDescription, summarizeEmailDigest, weatherSummary } from '../backend/daily-briefing.mjs';

// Real BBC RSS shape: <item> with CDATA-wrapped <title>/<description>, plain <link>/<pubDate>.
const RSS_FIXTURE = `<rss version="2.0"><channel><title>World</title>
<item>
<title><![CDATA[Nvidia shares slide as Trump questioned]]></title>
<description><![CDATA[Shares <b>fell</b> in trading.]]></description>
<link>https://bbc.example/a?at_medium=RSS&amp;at_campaign=rss</link>
<pubDate>Tue, 24 Nov 2026 17:04:20 GMT</pubDate>
</item>
<item>
<title><![CDATA[For China, Jensen Huang Return to Nvidia Is Mixed]]></title>
<description><![CDATA[Analysis.]]></description>
<link>https://nyt.example/b</link>
<pubDate>Tue, 24 Nov 2026 16:00:00 GMT</pubDate>
</item>
</channel></rss>`;

test('parseRss extracts titles, links, and dates and strips CDATA/HTML/entities', () => {
  const items = parseRss(RSS_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Nvidia shares slide as Trump questioned');
  assert.equal(items[0].link, 'https://bbc.example/a?at_medium=RSS&at_campaign=rss', 'decodes &amp;');
  assert.equal(items[0].description, 'Shares fell in trading.', 'strips inline HTML');
  assert.ok(items[0].date.includes('2026'));
  assert.equal(items[1].link, 'https://nyt.example/b');
});

test('parseRss tolerates empty or malformed input', () => {
  assert.equal(parseRss('').length, 0);
  assert.equal(parseRss('<rss></rss>').length, 0);
  assert.equal(parseRss(null).length, 0);
});

test('rankNews clusters the same cross-outlet story and surfaces it first', () => {
  const items = [
    { title: 'Ukraine strikes Russian ships in Black Sea', source: 'BBC' },
    { title: 'Jensen Huang returns to Nvidia as chief', source: 'BBC' },
    { title: 'For China, Jensen Huang return to Nvidia is mixed', source: 'NYT' },
  ];
  const ranked = rankNews(items);
  // The Jensen Huang story spans two outlets -> merged into one and ranked first.
  assert.equal(ranked[0].title, 'Jensen Huang returns to Nvidia as chief');
  assert.equal(ranked[0].coverage, 2, 'merged two related headlines');
  assert.equal(ranked.length, 2, 'the distinct Ukraine story stays separate');
  assert.equal(ranked[1].title, 'Ukraine strikes Russian ships in Black Sea');
});

test('weatherDescription maps WMO codes and falls back safely', () => {
  assert.equal(weatherDescription(2), 'Partly cloudy');
  assert.equal(weatherDescription(63), 'Rain');
  assert.equal(weatherDescription(95), 'Thunderstorm');
  assert.equal(weatherDescription(999), 'Unknown');
  assert.equal(weatherDescription(undefined), 'Unknown');
});

test('summarizeEmailDigest summarises the inbox into threads and counts, not a list', () => {
  const digest = summarizeEmailDigest([
    { sender: 'Sarah Chen <sarah@acme.com>', subject: 'Q4 budget review — need your input' },
    { sender: 'Sarah Chen <sarah@acme.com>', subject: 'Re: Q4 budget review' },
    { sender: 'Sarah Chen <sarah@acme.com>', subject: 'Q4 budget review — final numbers' },
    { sender: 'John Park <john@acme.com>', subject: '1:1 tomorrow at 10' },
    { sender: 'Substack <noreply@substack.com>', subject: 'The Weekly Dispatch' },
    { sender: 'GitHub <noreply@github.com>', subject: '[security] Dependabot alert' },
  ]);
  assert.equal(digest.total, 6);
  assert.equal(digest.threads[0].name, 'Sarah Chen');
  assert.equal(digest.threads[0].count, 3, 'groups Sarah\'s three messages into one thread');
  assert.ok(digest.summary.includes('3 from Sarah Chen'), digest.summary);
  assert.ok(digest.summary.includes('newsletter'), digest.summary);
  assert.ok(digest.summary.includes('notification'), digest.summary);
  assert.ok(!digest.summary.includes('substack.com'), 'bulk senders are folded into counts, not listed');
  assert.equal(summarizeEmailDigest([]).summary, 'No new emails.');
});

test('summarizeEmailDigest keeps an all-bulk inbox out of the thread list', () => {
  const bulkOnly = summarizeEmailDigest([
    { sender: 'Substack <noreply@substack.com>', subject: 'Newsletter: AI roundup' },
  ]);
  assert.equal(bulkOnly.total, 1);
  assert.equal(bulkOnly.threads.length, 0, 'bulk-only senders are not surfaced as threads');
  assert.ok(bulkOnly.summary.includes('1 new email'), bulkOnly.summary);
});
test('weatherSummary caches the result so repeat lookups skip the network', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        current: { temperature_2m: 29, apparent_temperature: 32, weather_code: 0, wind_speed_10m: 10 },
        daily: { temperature_2m_max: [32], temperature_2m_min: [25] },
      }),
    };
  };
  try {
    const lat = 6.93;
    const lon = 79.85;
    const first = await weatherSummary({ lat, lon, city: 'Colombo' });
    const second = await weatherSummary({ lat, lon, city: 'Colombo' });
    assert.equal(first.ok, true);
    assert.equal(first.temp, 29);
    assert.equal(second.temp, 29);
    assert.equal(second.city, 'Colombo');
    assert.equal(fetchCalls, 1); // second call served from the cache, no network
  } finally {
    globalThis.fetch = originalFetch;
  }
});
