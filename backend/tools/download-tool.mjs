/**
 * Media download via yt-dlp — SoundCloud, YouTube, Vimeo, direct media URLs, and
 * every other site yt-dlp supports.
 *
 * `fetch_url` only reads page text; this tool actually saves the media. Every
 * download is bounded (item count + hard timeout) and always written to one
 * explicit output directory, so it can never scatter files or run unbounded.
 * yt-dlp is invoked with an argv array (no shell), so a hostile URL cannot
 * inject commands. The URL must be http(s).
 *
 * yt-dlp can exit non-zero (e.g. a post-processing warning) even after a fully
 * successful download, so success is judged by the files actually produced --
 * not the exit code.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandUserPath } from './safety.mjs';

const MAX_ITEMS = 10;
const TIMEOUT_MS = 240_000;

function ytDlpBin() {
  if (process.env.LOCALGRAVITY_YTDLP) return process.env.LOCALGRAVITY_YTDLP;
  return process.platform === 'darwin' ? '/opt/homebrew/bin/yt-dlp' : 'yt-dlp';
}

function ytdlpEnv() {
  return { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
}

// Run yt-dlp without rejecting on a non-zero exit; we decide success from the
// output + created files. Still enforces the hard timeout via execFile.
function runYt(args) {
  return new Promise((resolve) => {
    execFile(
      ytDlpBin(),
      args,
      { env: ytdlpEnv(), timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

export async function downloadMediaTool(args = {}, { cwd } = {}) {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, output: 'download_media needs an http(s) url.' };
  }

  const audioOnly = args.audio_only === true;
  const maxItems = Math.min(MAX_ITEMS, Math.max(1, Number(args.max_items) || 1));

  const rawDir = String(args.output_dir || '').trim();
  const outDir = path.resolve(
    cwd || os.homedir(),
    rawDir ? expandUserPath(rawDir) : path.join(os.homedir(), 'Downloads'),
  );
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (err) {
    return { ok: false, output: `download_media could not create ${outDir}: ${err.message}` };
  }

  const ytArgs = [
    '--no-warnings',
    '--newline',
    '--playlist-end', String(maxItems),
    '--max-downloads', String(maxItems),
    '-o', path.join(outDir, '%(title)s [%(id)s].%(ext)s'),
    '--print', 'after_move:filepath',
  ];
  if (audioOnly) ytArgs.push('-x', '--audio-format', 'mp3');
  ytArgs.push(url);

  const { error, stdout, stderr } = await runYt(ytArgs);

  const files = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => existsSync(f));
  if (files.length) {
    return { ok: true, output: `Downloaded ${files.length} file(s) to ${outDir}:\n${files.join('\n')}` };
  }

  if (error && (error.killed || error.signal)) {
    return { ok: false, output: `download_media timed out after ${TIMEOUT_MS / 1000}s for ${url}.` };
  }
  const reason = (stderr || (error ? error.message : ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-3)
    .join(' · ');
  return { ok: false, output: `download_media failed for ${url}: ${reason || 'no file was produced'}` };
}
