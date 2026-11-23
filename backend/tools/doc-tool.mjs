import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandUserPath } from './safety.mjs';

const execFileAsync = promisify(execFile);

// macOS `textutil` converts these to plain text without any third-party dependency.
const TEXTUTIL_EXTS = new Set(['docx', 'doc', 'odt', 'rtf', 'rtfd', 'html', 'htm', 'webarchive', 'wordml']);
const PLAIN_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl',
  'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'rtf.txt',
]);
const SUPPORTED_LABEL = [...TEXTUTIL_EXTS, ...PLAIN_EXTS, 'pdf (needs poppler)'].join(', ');

async function runTextutil(file) {
  const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', file], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20000,
  });
  return stdout;
}

/**
 * Extract readable text from a document (Word, RTF, ODT, HTML, webarchive, plain
 * text, and PDF when a local extractor is available). read_file only handles UTF-8
 * text, so this fills the gap for binary/word-processor documents.
 */
export async function readDocumentTool({ path: docPath, max_chars = 12000 }, opts = {}) {
  const resolved = expandUserPath(String(docPath || ''), opts.cwd);

  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    return { ok: false, output: `File not found: ${resolved}` };
  }
  if (st.isDirectory()) {
    return { ok: false, output: `That path is a folder, not a document: ${resolved}` };
  }

  const limit = Math.min(Math.max(Number(max_chars) || 12000, 200), 60000);
  const ext = path.extname(resolved).slice(1).toLowerCase();

  let text;
  if (PLAIN_EXTS.has(ext)) {
    text = await fs.readFile(resolved, 'utf8');
  } else if (ext === 'pdf') {
    // PDF text extraction needs an external extractor; use poppler's pdftotext when present.
    try {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', resolved, '-'], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 25000,
      });
      text = stdout;
    } catch {
      return {
        ok: false,
        output: `PDF text extraction needs \`pdftotext\` (install with \`brew install poppler\`), which is not available here. Currently supported: ${SUPPORTED_LABEL}.`,
      };
    }
  } else if (TEXTUTIL_EXTS.has(ext) || ext === '') {
    try {
      text = await runTextutil(resolved);
    } catch (err) {
      return { ok: false, output: `Could not extract text from ${resolved}: ${err.message}` };
    }
  } else {
    // Unknown extension: try textutil first, fall back to a plain read.
    try {
      text = await runTextutil(resolved);
    } catch {
      try {
        text = await fs.readFile(resolved, 'utf8');
      } catch {
        return { ok: false, output: `Unsupported document type ".${ext}". Supported: ${SUPPORTED_LABEL}.` };
      }
    }
  }

  const cleaned = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  const trimmed =
    cleaned.length > limit
      ? `${cleaned.slice(0, limit)}\n… (truncated; document has ${cleaned.length} characters)`
      : cleaned;

  return {
    ok: true,
    output: `Document: ${resolved} (${st.size} bytes, extracted ${cleaned.length} characters)\n\n${trimmed}`,
  };
}