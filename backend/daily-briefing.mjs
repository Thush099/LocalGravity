import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The Jarvis-style daily briefing: gather what matters today from on-device sources and
 * public feeds, so the dashboard can surface a morning digest. World news comes from the
 * BBC and NYT world RSS feeds (editor-curated leads). Email is read on-device from Apple
 * Mail via AppleScript (permission-gated). Weather comes from Open-Meteo (free, no key)
 * using an approximate, IP-derived location — it replaces the old WhatsApp slot, which
 * was never readable on macOS.
 */

const NEWS_FEEDS = [
  { source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'NYT', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
];
const FETCH_TIMEOUT_MS = 8000;

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Parse an RSS 2.0 document into { title, link, date, description } items. Pure. */
export function parseRss(xml) {
  const items = [];
  const blocks = String(xml ?? '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const grab = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return decodeEntities(m?.[1] ?? '');
    };
    const title = grab('title');
    if (!title) continue;
    items.push({ title, link: grab('link'), date: grab('pubDate'), description: grab('description') });
  }
  return items;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'being', 'between', 'could', 'every', 'from', 'have', 'here',
  'into', 'just', 'more', 'most', 'other', 'over', 'said', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'what',
  'when', 'where', 'which', 'while', 'who', 'will', 'with', 'would', 'your', 'been', 'before',
  'news', 'world', 'video', 'photos', 'update', 'updates', 'analysis', 'report',
]);

function keywords(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

/**
 * Rank items so a story covered by several outlets (a major global event) rises above
 * single-source stories, while each outlet's editorial order breaks ties. Pure.
 */
/**
 * Group items about the same story (two or more shared keywords) and rank the clusters
 * so a global event covered by several outlets surfaces once, at the top. Pure. Returns
 * one representative headline per distinct story, annotated with how many related
 * headlines it merged.
 */
export function rankNews(items) {
  const clusters = [];
  for (const [index, item] of items.entries()) {
    const kw = keywords(item.title);
    let target = null;
    for (const cluster of clusters) {
      let shared = 0;
      for (const w of kw) if (cluster.keywords.has(w)) shared += 1;
      if (shared >= 2) {
        target = cluster;
        break;
      }
    }
    if (target) {
      target.items.push(item);
      for (const w of kw) target.keywords.add(w);
    } else {
      clusters.push({ items: [item], keywords: new Set(kw), firstIndex: index });
    }
  }
  const sourceCount = (c) => new Set(c.items.map((i) => i.source)).size;
  // Covered by more outlets first (bigger global story), then more related headlines,
  // then each outlet's editorial order.
  clusters.sort((a, b) => sourceCount(b) - sourceCount(a) || b.items.length - a.items.length || a.firstIndex - b.firstIndex);
  return clusters.map((c) => ({ ...c.items[0], coverage: c.items.length }));
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, { signal: controller.signal });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml).map((item) => ({ ...item, source: feed.source }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gather the top world-news stories from the BBC and NYT world feeds. Stories that
 * appear in both outlets are treated as the biggest global events and rank first.
 */
export async function fetchWorldNews({ count = 6 } = {}) {
  const results = await Promise.all(NEWS_FEEDS.map(fetchFeed));
  const ranked = rankNews(results.flat());
  return { ok: ranked.length > 0, items: ranked.slice(0, Math.max(1, Number(count) || 6)) };
}

/** Render a numbered top-news list. */
export async function worldNewsReport({ count = 3 } = {}) {
  const { ok, items } = await fetchWorldNews({ count });
  if (!ok) {
    return 'World news is unavailable right now (the BBC/NYT feeds could not be reached).';
  }
  const lines = items.map((item, i) => {
    const link = item.link ? ` — ${item.link}` : '';
    return `${i + 1}. ${item.title} (${item.source})${link}`;
  });
  return `Top ${items.length} world news right now:\n${lines.join('\n')}`;
}

/**
 * Run an AppleScript from a temp file (never through a shell) and return its stdout.
 * Temp-file execution keeps multi-line scripts and embedded quotes safe.
 */
async function runOsascript(script) {
  const file = path.join(os.tmpdir(), `lg-brief-${process.pid}-${Date.now()}.applescript`);
  await fs.writeFile(file, script);
  try {
    const { stdout } = await execFileAsync('osascript', [file], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err) };
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

// Reads today's messages from Apple Mail (newest first), entirely on-device. Requires the
// user to grant LocalGravity control of Mail under System Settings -> Privacy & Security
// -> Automation. Only the newest 30 messages are inspected so a huge inbox stays fast.
const MAIL_TODAY_SCRIPT = `tell application "Mail"
  set todayStart to (current date) - (time of (current date))
  set inboxCount to count of messages of inbox
  set limitCount to 30
  if inboxCount < limitCount then set limitCount to inboxCount
  set outputText to ""
  if limitCount > 0 then
    set recentMessages to messages 1 thru limitCount of inbox
    repeat with m in recentMessages
      if (date received of m) is greater than or equal to todayStart then
        set senderText to (sender of m as string)
        set subjectText to (subject of m as string)
        set outputText to outputText & senderText & " ||| " & subjectText & linefeed
      end if
    end repeat
  end if
  return outputText
end tell`;

/** Read today's emails from Apple Mail. Permission-gated; degrades to a clear message. */
// Deterministic inbox digest: group real conversations by sender and summarise bulk
// mail into counts, so the briefing reads as a summary instead of a message list.
const MEETING_RE = /\b(meeting|invite|invitation|calendar|zoom|teams|standup|1:1|sync|appointment|interview|reminder|rsvp|schedule|agenda)\b/i;
const NEWSLETTER_RE = /\b(newsletter|digest|weekly|monthly|roundup|unsubscribe|promo|offer|sale|edition)\b/i;
const NOTICE_RE = /\b(no-?reply|do-?not-?reply|alert|notification|notify|automated|daemon|monitor|security|postmaster|noreply|build|github)\b/i;

function senderName(raw) {
  const s = String(raw || '').trim();
  const angle = s.match(/^(.*?)\s*<[^>]*>$/);
  const name = (angle ? angle[1] : s).replace(/^["']|["']$/g, '').trim();
  return name || s.split('@')[0] || 'Unknown';
}

function threadTopic(subjects) {
  const list = (subjects || []).map((s) => String(s).replace(/^(re|fwd?):\s*/i, '').trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0].slice(0, 42);
  const stop = new Set(['the','a','an','of','for','to','and','or','in','on','at','is','your','you','our','update','updates','v2','final','new','today','please','thanks','thank','request','question','draft','copy','file','files','report','reports','meeting','agenda','call','re','fw','fwd','review']);
  const sets = list.map((s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w))));
  const shared = [...sets[0]].filter((w) => sets.every((set) => set.has(w)));
  return (shared.slice(0, 4).join(' ') || list[0].slice(0, 42)).trim();
}

export function summarizeEmailDigest(messages = []) {
  const list = (messages || []).filter((m) => m && (m.sender || m.subject));
  const total = list.length;
  if (!total) return { ok: true, total: 0, summary: 'No new emails.', threads: [] };

  const bySender = new Map();
  let meeting = 0;
  let newsletter = 0;
  let notice = 0;
  for (const m of list) {
    const subject = String(m.subject || '').trim();
    const from = String(m.sender || '');
    const isNews = NEWSLETTER_RE.test(subject) || NEWSLETTER_RE.test(from);
    const isNotice = NOTICE_RE.test(from);
    if (MEETING_RE.test(subject)) meeting += 1;
    else if (isNews) newsletter += 1;
    else if (isNotice) notice += 1;
    if (!isNews && !isNotice) {
      const name = senderName(from);
      const g = bySender.get(name) || { name, count: 0, subjects: [] };
      g.count += 1;
      if (subject) g.subjects.push(subject);
      bySender.set(name, g);
    }
  }

  const threads = [...bySender.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((g) => ({ name: g.name, count: g.count, topic: threadTopic(g.subjects) }));

  const parts = threads.map((t) =>
    t.count > 1
      ? `${t.count} from ${t.name}${t.topic ? ` about ${t.topic}` : ''}`
      : `${t.name}${t.topic ? ` · ${t.topic}` : ''}`
  );
  if (meeting) parts.push(`${meeting} meeting invite${meeting > 1 ? 's' : ''}`);
  if (newsletter) parts.push(`${newsletter} newsletter${newsletter > 1 ? 's' : ''}`);
  if (notice) parts.push(`${notice} notification${notice > 1 ? 's' : ''}`);
  const summary = `${total} new email${total > 1 ? 's' : ''} — ${parts.join(', ')}.`;
  return { ok: true, total, summary, threads, counts: { meeting, newsletter, notice } };
}

export async function emailSummary({ limit = 25 } = {}) {
  let result = await runOsascript(MAIL_TODAY_SCRIPT);
  // Mail can be slow to answer on first access (cold launch) or when it is busy; a single
  // retry turns that transient hiccup into a success instead of a false failure.
  if (!result.ok) result = await runOsascript(MAIL_TODAY_SCRIPT);
  if (!result.ok) {
    const denied = /-1743|-1728|not authorized|not allowed|1002|access|1743/i.test(result.error);
    return {
      ok: false,
      messages: [],
      count: 0,
      error: denied
        ? 'Mail access is not authorized yet. Enable LocalGravity under System Settings → Privacy & Security → Automation → Mail, then ask again.'
        : `Could not read Mail: ${result.error}`,
    };
  }
  const messages = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sender, subject] = line.split('|||');
      return { sender: (sender || '').trim(), subject: (subject || '').trim() };
    })
    .slice(0, limit);
  return { ok: true, messages, count: messages.length, summary: summarizeEmailDigest(messages).summary };
}

/**
 * Weather for the daily briefing. Sourced from Open-Meteo (free, no API key) using an
 * approximate, city-level location derived from the public IP, so no account or key is
 * needed and the answer is honest about its precision. Fails soft to a clear status.
 */
const WMO_CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

export function weatherDescription(code) {
  return WMO_CODES[Number(code)] || 'Unknown';
}

const WMO_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌧️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '🌧️', 85: '🌨️', 86: '🌨️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

export function weatherIcon(code) {
  return WMO_ICONS[Number(code)] || '🌡️';
}

let cachedLocation = null;
export async function fetchApproxLocation() {
  if (cachedLocation) return cachedLocation;
  try {
    const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    // ipinfo.io returns `loc` as a "lat,lon" string.
    const [latStr, lonStr] = String(data.loc || '').split(',');
    const loc = { lat: Number(latStr), lon: Number(lonStr), city: String(data.city || '') };
    if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
      cachedLocation = loc;
      return loc;
    }
    return null;
  } catch {
    return null;
  }
}

export async function weatherSummary({ lat, lon, city } = {}) {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const loc = await fetchApproxLocation();
      if (!loc) return { ok: false, error: 'Could not determine an approximate location for weather.' };
      ({ lat, lon } = loc);
      city = city || loc.city;
    }
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, error: `Weather lookup failed (HTTP ${res.status}).` };
    const data = await res.json();
    const cur = data.current || {};
    const daily = data.daily || {};
    return {
      ok: true,
      city: city || '',
      temp: Number.isFinite(Number(cur.temperature_2m)) ? Math.round(Number(cur.temperature_2m)) : null,
      feelsLike: Number.isFinite(Number(cur.apparent_temperature)) ? Math.round(Number(cur.apparent_temperature)) : null,
      description: weatherDescription(cur.weather_code),
      icon: weatherIcon(cur.weather_code),
      high: Number.isFinite(Number(daily.temperature_2m_max?.[0])) ? Math.round(Number(daily.temperature_2m_max[0])) : null,
      low: Number.isFinite(Number(daily.temperature_2m_min?.[0])) ? Math.round(Number(daily.temperature_2m_min[0])) : null,
      wind: Number.isFinite(Number(cur.wind_speed_10m)) ? Math.round(Number(cur.wind_speed_10m)) : null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Gather the raw material for a morning briefing (weather, world news, today's email)
 * so the model can compose a friendly summary. The model turns this into prose.
 */
export async function dailyBriefingReport({ count = 3, emailLimit = 20 } = {}) {
  const [news, email, weather] = await Promise.all([
    fetchWorldNews({ count }),
    emailSummary({ limit: emailLimit }),
    weatherSummary(),
  ]);

  const sections = [];
  if (weather.ok) {
    const where = weather.city ? ` in ${weather.city}` : '';
    sections.push(`Weather${where}: ${weather.temp}°C, ${weather.description.toLowerCase()} (high ${weather.high}°, low ${weather.low}°).`);
  } else {
    sections.push(`Weather: ${weather.error}`);
  }

  if (news.ok && news.items.length) {
    sections.push(
      `World news (top ${Math.min(count, news.items.length)} important):\n` +
        news.items.map((item, i) => `${i + 1}. ${item.title} (${item.source})`).join('\n')
    );
  } else {
    sections.push('World news: unavailable right now.');
  }

  if (email.ok) {
    sections.push(
      email.count
        ? `Email today (${email.count} message${email.count === 1 ? '' : 's'}):\n` +
            email.messages.map((m) => `- ${m.sender} — ${m.subject}`).join('\n')
        : 'Email today: no new messages.'
    );
  } else {
    sections.push(`Email today: ${email.error}`);
  }

  return sections.join('\n\n');
}