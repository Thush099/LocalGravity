export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Protect inline code spans first
  const slots = [];
  const stash = (html) => {
    const idx = slots.length;
    slots.push(html);
    return `\u0000SLOT${idx}\u0000`;
  };

  out = out.replace(/`([^`]+)`/g, (_m, code) => stash(`<code class="inline-code">${code}</code>`));
  out = out.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/)[^\s)]+)\)/g,
    (_m, label, url) => stash(`<a href="${url}" class="md-link" target="_blank" rel="noopener noreferrer">${label}</a>`)
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Auto-link bare http(s) URLs not inside stashed markdown links
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, prefix, url) => `${prefix}${stash(`<a href="${url}" class="md-link" target="_blank" rel="noopener noreferrer">${url}</a>`)}`
  );
  return out.replace(/\u0000SLOT(\d+)\u0000/g, (_m, idx) => slots[Number(idx)]);
}

function splitTableCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparatorLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line) {
  return splitTableCells(line).map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });
}

/**
 * Render Markdown safely to HTML with copyable fenced code blocks, GFM tables, and task lists.
 */
export function renderMarkdown(markdown) {
  const src = String(markdown || '');
  if (!src.trim()) return '';

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLang = fenceMatch[1] || 'text';
        codeLines = [];
      } else {
        const rawCode = codeLines.join('\n');
        html.push(
          `<div class="code-block"><div class="code-header"><span>${escapeHtml(codeLang)}</span><button type="button" class="copy-code-btn" data-code="${escapeHtml(rawCode)}">Copy</button></div><pre><code>${escapeHtml(rawCode)}</code></pre></div>`
        );
        inCode = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    // GFM pipe tables: header line with pipes followed by alignment separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      closeList();
      const headers = splitTableCells(line);
      const alignments = parseTableAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !/^```/.test(lines[i])) {
        bodyRows.push(splitTableCells(lines[i]));
        i++;
      }
      i--; // Step back so outer loop advances cleanly

      const thHtml = headers
        .map((cell, idx) => {
          const align = alignments[idx] || 'left';
          const alignAttr = align !== 'left' ? ` style="text-align:${align}"` : '';
          return `<th${alignAttr}>${renderInline(cell)}</th>`;
        })
        .join('');
      const tbodyHtml = bodyRows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => {
                const align = alignments[idx] || 'left';
                const alignAttr = align !== 'left' ? ` style="text-align:${align}"` : '';
                return `<td${alignAttr}>${renderInline(row[idx] ?? '')}</td>`;
              })
              .join('')}</tr>`
        )
        .join('');
      html.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table></div>`
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      html.push(`<h${level} class="md-h${level}">${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push('<hr class="md-hr" />');
      continue;
    }

    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      closeList();
      html.push(`<blockquote class="md-quote">${renderInline(bqMatch[1])}</blockquote>`);
      continue;
    }

    const taskMatch = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul class="md-list">');
      }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html.push(
        `<li class="md-task-item"><input type="checkbox" class="md-task-cb" disabled${checked ? ' checked' : ''} /><span>${renderInline(taskMatch[2])}</span></li>`
      );
      continue;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul class="md-list">');
      }
      html.push(`<li>${renderInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol class="md-list">');
      }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p class="md-p">${renderInline(line)}</p>`);
  }

  closeList();
  if (inCode && codeLines.length > 0) {
    const rawCode = codeLines.join('\n');
    html.push(
      `<div class="code-block"><div class="code-header"><span>${escapeHtml(codeLang)}</span><button type="button" class="copy-code-btn" data-code="${escapeHtml(rawCode)}">Copy</button></div><pre><code>${escapeHtml(rawCode)}</code></pre></div>`
    );
  }
  return html.join('');
}
