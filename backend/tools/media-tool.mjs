import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expandUserPath } from './safety.mjs';

const execFileAsync = promisify(execFile);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.tiff', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const mediaInspectionCache = new Map();
const MAX_MEDIA_CACHE_ENTRIES = 24;

function getCachedMedia(key) {
  if (!mediaInspectionCache.has(key)) return null;
  const val = mediaInspectionCache.get(key);
  mediaInspectionCache.delete(key);
  mediaInspectionCache.set(key, val);
  return val;
}

function setCachedMedia(key, val) {
  if (mediaInspectionCache.has(key)) mediaInspectionCache.delete(key);
  mediaInspectionCache.set(key, val);
  if (mediaInspectionCache.size > MAX_MEDIA_CACHE_ENTRIES) {
    const oldestKey = mediaInspectionCache.keys().next().value;
    if (oldestKey !== undefined) mediaInspectionCache.delete(oldestKey);
  }
}

async function probeImage(resolvedPath) {
  const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', resolvedPath]);
  const width = stdout.match(/pixelWidth:\s*(\d+)/)?.[1] || '?';
  const height = stdout.match(/pixelHeight:\s*(\d+)/)?.[1] || '?';
  const format = stdout.match(/format:\s*(\S+)/)?.[1] || '?';
  return { width, height, format };
}

async function probeVideo(resolvedPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    resolvedPath,
  ]);
  let parsed = {};
  try {
    parsed = JSON.parse(stdout || '{}');
  } catch {
    // Corrupt or truncated probe output: degrade to unknown metadata like probeImage instead of failing.
  }
  const vStream = (parsed.streams || []).find((s) => s.codec_type === 'video') || {};
  const duration = Number(parsed.format?.duration || vStream.duration || 0);
  return {
    width: vStream.width || '?',
    height: vStream.height || '?',
    codec: vStream.codec_name || '?',
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

/**
 * Inspect an image or extract a video frame / contact sheet so multimodal models can view media cleanly.
 * Uses an MTime-validated LRU cache so previewing + attaching the same file does not spawn duplicate sips/ffmpeg processes.
 */
export async function inspectMediaTool({ path: mediaPath, timestamp_sec, max_edge = 1280 }) {
  const resolved = expandUserPath(mediaPath);
  const ext = path.extname(resolved).toLowerCase();
  const edge = Math.min(Math.max(64, Number(max_edge) || 1280), 2048);
  const tmpPng = path.join(os.tmpdir(), `localgravity-inspect-${crypto.randomUUID()}.png`);

  try {
    const st = await fs.stat(resolved);
    const cacheKey = `${resolved}:${st.mtimeMs}:${st.size}:${timestamp_sec ?? 'auto'}:${edge}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) return cached;

    if (IMAGE_EXTS.has(ext)) {
      const [meta] = await Promise.all([
        probeImage(resolved),
        execFileAsync('sips', ['-s', 'format', 'png', '-Z', String(edge), resolved, '--out', tmpPng]),
      ]);
      const base64 = (await fs.readFile(tmpPng)).toString('base64');
      const result = {
        ok: true,
        output: `Image: ${resolved} (${meta.width}x${meta.height}, format=${meta.format}). Attached visual frame for inspection.`,
        images: [base64],
        meta,
      };
      setCachedMedia(cacheKey, result);
      return result;
    }

    if (VIDEO_EXTS.has(ext)) {
      const meta = await probeVideo(resolved);
      const seekSec =
        typeof timestamp_sec === 'number' && timestamp_sec >= 0
          ? timestamp_sec
          : meta.duration > 0.5
            ? Number((meta.duration * 0.25).toFixed(2))
            : 0;
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(seekSec),
        '-i',
        resolved,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${edge},iw)':-2`,
        tmpPng,
      ]);
      const base64 = (await fs.readFile(tmpPng)).toString('base64');
      const result = {
        ok: true,
        output: `Video: ${resolved} (${meta.width}x${meta.height}, codec=${meta.codec}, duration=${meta.duration.toFixed(2)}s). Extracted frame at ${seekSec}s for visual inspection.`,
        images: [base64],
        meta,
      };
      setCachedMedia(cacheKey, result);
      return result;
    }

    return { ok: false, output: `Unsupported media extension "${ext}" for ${resolved}` };
  } catch (err) {
    return { ok: false, output: `inspect_media failed for ${resolved}: ${err.message}` };
  } finally {
    await fs.rm(tmpPng, { force: true }).catch(() => {});
  }
}
