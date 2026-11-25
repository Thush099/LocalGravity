import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, rankNews } from '../backend/daily-briefing.mjs';

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