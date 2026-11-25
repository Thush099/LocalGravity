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
 * Mail via AppleScript (permission-gated). WhatsApp is deliberately NOT scraped: its
 * stores are encrypted and it exposes no macOS automation API, so there is no reliable,
 * privacy-respecting way to read messages — see whatsappSummary() for the honest status.
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
  return { ok: true, messages, count: messages.length };
}

/**
 * WhatsApp is deliberately NOT scraped. Its message stores are encrypted and it exposes
 * no macOS AppleScript/automation API, so there is no reliable, privacy-respecting way to
 * read messages on a Mac. Return an honest status instead of pretending to read them.
 */
export function whatsappSummary() {
  return {
    ok: false,
    available: false,
    messages: [],
    note: "WhatsApp messages can't be read reliably on macOS — WhatsApp stores them encrypted and offers no automation API. I won't pretend otherwise. To summarize something from WhatsApp, paste it here, or read it in WhatsApp directly.",
  };
}

/**
 * Gather the raw material for a morning briefing (world news, today's email, WhatsApp
 * status) so the model can compose a friendly summary. The model turns this into prose.
 */
export async function dailyBriefingReport({ count = 3, emailLimit = 20 } = {}) {
  const news = await fetchWorldNews({ count });
  const email = await emailSummary({ limit: emailLimit });
  const whatsapp = whatsappSummary();

  const sections = [];
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

  sections.push(`WhatsApp: ${whatsapp.note}`);
  return sections.join('\n\n');
}