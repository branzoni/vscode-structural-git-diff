import * as Diff from 'diff';
import type { DiffLine } from '../diff/diffEngine';
import type { StructuralDiffResult } from '../diff/structuralBuilder';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function tokenizeCodeLine(str: string): string[] {
  const regex = /->|::|=>|===|==|!==|!=|\?\?|\+\+|--|&&|\|\||\+=|-=|\*=|(?:\.=)|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}]/gu;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(str)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

interface DiffChunk {
  added?: boolean;
  removed?: boolean;
  value: string[];
}

function mergeSpuriousSandwiches(chunks: DiffChunk[]): DiffChunk[] {
  const result: DiffChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const prev = result[result.length - 1];
    const curr = chunks[i];
    const next = chunks[i + 1];

    if (
      !curr.added &&
      !curr.removed &&
      prev &&
      next &&
      ((prev.added && next.removed) || (prev.removed && next.added))
    ) {
      const text = curr.value.join('');
      // If an unchanged chunk is purely punctuation or whitespace (<= 3 chars),
      // absorb it into the adjacent additions and deletions to avoid orphan delimiters
      if (/^[^\p{L}\p{N}]+$/u.test(text) && text.length <= 3) {
        prev.value.push(...curr.value);
        next.value.unshift(...curr.value);
        continue;
      }
    }
    result.push({
      added: curr.added,
      removed: curr.removed,
      value: [...curr.value],
    });
  }
  return result;
}

function renderWordDiff(delContent: string, insContent: string): { delHtml: string; insHtml: string } {
  try {
    const tDel = tokenizeCodeLine(delContent);
    const tIns = tokenizeCodeLine(insContent);
    const raw = Diff.diffArrays(tDel, tIns);
    const cleaned = mergeSpuriousSandwiches(raw);

    let commonLen = 0;
    for (const c of cleaned) {
      if (!c.added && !c.removed) {
        commonLen += c.value.join('').trim().length;
      }
    }
    const maxLen = Math.max(delContent.trim().length, insContent.trim().length);
    const similarity = maxLen === 0 ? 0 : commonLen / maxLen;

    // Only apply intra-line highlighting if there is substantial shared structure (>= 40%)
    if (similarity < 0.4 || commonLen < 4) {
      return { delHtml: escapeHtml(delContent), insHtml: escapeHtml(insContent) };
    }

    const delHtml = cleaned
      .filter((c) => !c.added)
      .map((c) => {
        const text = escapeHtml(c.value.join(''));
        return c.removed ? `<span class="char-delete">${text}</span>` : text;
      })
      .join('');

    const insHtml = cleaned
      .filter((c) => !c.removed)
      .map((c) => {
        const text = escapeHtml(c.value.join(''));
        return c.added ? `<span class="char-insert">${text}</span>` : text;
      })
      .join('');

    return { delHtml, insHtml };
  } catch {
    return { delHtml: escapeHtml(delContent), insHtml: escapeHtml(insContent) };
  }
}

function renderRow(l: DiffLine, customContentHtml?: string, extraClass = '', extraStyle = ''): string {
  const oldNum = l.oldLineNumber !== null ? l.oldLineNumber.toString() : '';
  const newNum = l.newLineNumber !== null ? l.newLineNumber.toString() : '';
  const prefix = l.type === 'insert' ? '+' : l.type === 'delete' ? '-' : ' ';
  const typeClass = l.type === 'insert' ? 'line-insert' : l.type === 'delete' ? 'line-delete' : 'line-unchanged';
  const codeHtml = customContentHtml !== undefined ? customContentHtml : escapeHtml(l.content);
  const idAttr = l.anchorId ? ` id="${escapeHtml(l.anchorId)}"` : '';
  const classAttr = extraClass ? `diff-row ${typeClass} ${extraClass}` : `diff-row ${typeClass}`;
  const styleAttr = extraStyle ? ` style="${extraStyle}"` : '';

  return `
    <tr class="${classAttr}"${idAttr}${styleAttr}>
      <td class="col-num col-old">${oldNum}</td>
      <td class="col-num col-new">${newNum}</td>
      <td class="col-sign">${prefix}</td>
      <td class="col-code"><code>${codeHtml}</code></td>
    </tr>`;
}

export function renderDiffParts(diff: StructuralDiffResult): { rowsHtml: string; summaryRowsHtml: string } {
  const { items, stats } = diff;

  let rowsHtml = '';
  let deleteQueue: DiffLine[] = [];
  let insertQueue: DiffLine[] = [];

  function flushQueues() {
    if (deleteQueue.length === 0 && insertQueue.length === 0) return;

    const delHtmls = new Map<number, string>();
    const insHtmls = new Map<number, string>();

    // Intra-line word diffing ONLY when line counts match (e.g. 1-to-1 or position-aligned 2-to-2)
    // Unequal blocks (e.g. 3 lines deleted vs 4 lines added) are multi-line block rewrites
    // where pairing causes chaotic shifted intra-line highlights.
    if (deleteQueue.length > 0 && insertQueue.length > 0 && deleteQueue.length === insertQueue.length) {
      for (let k = 0; k < deleteQueue.length; k++) {
        const { delHtml, insHtml } = renderWordDiff(deleteQueue[k].content, insertQueue[k].content);
        delHtmls.set(k, delHtml);
        insHtmls.set(k, insHtml);
      }
    }

    for (let d = 0; d < deleteQueue.length; d++) {
      rowsHtml += renderRow(deleteQueue[d], delHtmls.get(d));
    }
    for (let i = 0; i < insertQueue.length; i++) {
      rowsHtml += renderRow(insertQueue[i], insHtmls.get(i));
    }

    deleteQueue = [];
    insertQueue = [];
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.kind === 'line') {
      const l = item.line;

      if (l.type === 'delete') {
        if (insertQueue.length > 0) {
          flushQueues();
        }
        deleteQueue.push(l);
      } else if (l.type === 'insert') {
        insertQueue.push(l);
      } else {
        // Unchanged line
        flushQueues();
        rowsHtml += renderRow(l);
      }
    } else if (item.kind === 'expand') {
      flushQueues();
      const expandId = item.id;
      rowsHtml += `
        <tr class="diff-row-expand" id="bar_${expandId}" onclick="expandHunk('${expandId}')">
          <td colspan="4">
            <div class="expand-banner">
              <span class="expand-arrows">↕</span>
              <span class="expand-label">${escapeHtml(item.label)}</span>
              <span class="expand-hint">(click to expand)</span>
              <span class="expand-arrows">↕</span>
            </div>
          </td>
        </tr>`;

      for (const hl of item.hiddenLines) {
        rowsHtml += renderRow(hl, undefined, `hunk-hidden hunk_${expandId}`, 'display: none;');
      }
    }
  }

  flushQueues();

  const summary = diff.summary || {
    lines: { added: stats.added, deleted: stats.deleted },
    uses: { added: [], deleted: [] },
    containers: [],
    methods: [],
    constants: [],
    properties: [],
  };

  let summaryRowsHtml = '';

  // 1. Lines & Global actions
  summaryRowsHtml += `
    <div class="summary-row summary-row-lines">
      <span class="summary-label">Lines:</span>
      <div class="summary-items">
        <span class="stat-add">+${summary.lines.added}</span>
        <span class="stat-del">-${summary.lines.deleted}</span>
      </div>
      <div class="diff-actions">
        <button onclick="expandAll()">Expand all ↕</button>
        <button onclick="collapseAll()">Collapse all</button>
      </div>
    </div>`;

  // 2. Imports (uses) - Rule 1.A: only if changed, formatted as numbers + / -
  if (summary.uses.added.length > 0 || summary.uses.deleted.length > 0) {
    const addCount = summary.uses.added.length;
    const delCount = summary.uses.deleted.length;
    const tooltipParts: string[] = [];
    if (addCount > 0) tooltipParts.push(`Added: ${summary.uses.added.join(', ')}`);
    if (delCount > 0) tooltipParts.push(`Deleted: ${summary.uses.deleted.join(', ')}`);
    const tooltip = tooltipParts.join('\n');

    const addSpan = addCount > 0 ? `<span class="stat-add">+${addCount}</span>` : '';
    const delSpan = delCount > 0 ? `<span class="stat-del">-${delCount}</span>` : '';

    summaryRowsHtml += `
      <div class="summary-row" title="${escapeHtml(tooltip)}">
        <span class="summary-label">Imports:</span>
        <div class="summary-items">
          ${addSpan}
          ${delSpan}
        </div>
      </div>`;
  }

  // 3. Constants - Compact numbers only with hover tooltip (placed above methods)
  if (summary.constants.length > 0) {
    const addCount = summary.constants.filter((c) => c.changeType === 'added').length;
    const delCount = summary.constants.filter((c) => c.changeType === 'deleted').length;
    const modCount = summary.constants.filter((c) => c.changeType === 'modified').length;

    const sortOrder: Record<string, number> = { added: 1, deleted: 2, modified: 3 };
    const sortedConstants = [...summary.constants].sort(
      (a, b) => (sortOrder[a.changeType] ?? 99) - (sortOrder[b.changeType] ?? 99)
    );

    const tooltip = sortedConstants
      .map((c) => `${c.changeType === 'added' ? '+' : c.changeType === 'deleted' ? '-' : '~'} ${c.name}`)
      .join('\n');

    const addSpan = addCount > 0 ? `<span class="stat-add">+${addCount}</span>` : '';
    const delSpan = delCount > 0 ? `<span class="stat-del">-${delCount}</span>` : '';
    const modSpan = modCount > 0 ? `<span class="badge-mod">~${modCount}</span>` : '';

    summaryRowsHtml += `
      <div class="summary-row" title="${escapeHtml(tooltip)}">
        <span class="summary-label">Constants:</span>
        <div class="summary-items">
          ${addSpan}
          ${delSpan}
          ${modSpan}
        </div>
      </div>`;
  }

  // 4. Properties - Compact numbers only with hover tooltip (placed above methods)
  if (summary.properties.length > 0) {
    const addCount = summary.properties.filter((p) => p.changeType === 'added').length;
    const delCount = summary.properties.filter((p) => p.changeType === 'deleted').length;
    const modCount = summary.properties.filter((p) => p.changeType === 'modified').length;

    const sortOrder: Record<string, number> = { added: 1, deleted: 2, modified: 3 };
    const sortedProperties = [...summary.properties].sort(
      (a, b) => (sortOrder[a.changeType] ?? 99) - (sortOrder[b.changeType] ?? 99)
    );

    const tooltip = sortedProperties
      .map((p) => `${p.changeType === 'added' ? '+' : p.changeType === 'deleted' ? '-' : '~'} ${p.name}`)
      .join('\n');

    const addSpan = addCount > 0 ? `<span class="stat-add">+${addCount}</span>` : '';
    const delSpan = delCount > 0 ? `<span class="stat-del">-${delCount}</span>` : '';
    const modSpan = modCount > 0 ? `<span class="badge-mod">~${modCount}</span>` : '';

    summaryRowsHtml += `
      <div class="summary-row" title="${escapeHtml(tooltip)}">
        <span class="summary-label">Properties:</span>
        <div class="summary-items">
          ${addSpan}
          ${delSpan}
          ${modSpan}
        </div>
      </div>`;
  }

  // 5. Methods & functions - Rule 1.A: only if changed, stats (+ / - / ~) first, then method chips
  if (summary.methods.length > 0) {
    const addCount = summary.methods.filter((m) => m.changeType === 'added').length;
    const delCount = summary.methods.filter((m) => m.changeType === 'deleted').length;
    const modCount = summary.methods.filter((m) => m.changeType === 'modified').length;

    const addSpan = addCount > 0 ? `<span class="stat-add">+${addCount}</span>` : '';
    const delSpan = delCount > 0 ? `<span class="stat-del">-${delCount}</span>` : '';
    const modSpan = modCount > 0 ? `<span class="badge-mod">~${modCount}</span>` : '';

    const renderChip = (m: any) => {
      const badgeClass =
        m.changeType === 'added' ? 'badge-add' : m.changeType === 'deleted' ? 'badge-del' : 'badge-mod';
      const badgeSign = m.changeType === 'added' ? '+' : m.changeType === 'deleted' ? '-' : '~';
      const title = m.changeType === 'added' ? 'Added' : m.changeType === 'deleted' ? 'Deleted' : 'Modified';
      return `
        <a class="summary-chip summary-link" title="${title}: click to jump" href="javascript:void(0)" onclick="scrollToSymbol('${escapeHtml(m.anchorId)}')">
          <span class="${badgeClass}">${badgeSign}</span>
          <span>${escapeHtml(m.name)}()</span>
        </a>`;
    };

    const sortOrder: Record<string, number> = { added: 1, deleted: 2, modified: 3 };
    const sortedMethods = [...summary.methods].sort(
      (a, b) => (sortOrder[a.changeType] ?? 99) - (sortOrder[b.changeType] ?? 99)
    );

    let methodsItemsHtml = '';
    if (sortedMethods.length <= 4) {
      methodsItemsHtml = sortedMethods.map(renderChip).join('');
    } else {
      const visible = sortedMethods.slice(0, 4).map(renderChip).join('');
      const hidden = sortedMethods.slice(4).map(renderChip).join('');
      const remainingCount = sortedMethods.length - 4;
      methodsItemsHtml = `
        ${visible}
        <span id="more_methods" style="display: none;">${hidden}</span>
        <button class="more-btn" id="btn_toggle_methods" onclick="toggleMoreMethods(${remainingCount})">+${remainingCount} more ▾</button>`;
    }

    summaryRowsHtml += `
      <div class="summary-row">
        <span class="summary-label">Methods:</span>
        <div class="summary-items">
          ${addSpan}
          ${delSpan}
          ${modSpan}
          ${methodsItemsHtml}
        </div>
      </div>`;
  }

  return { rowsHtml, summaryRowsHtml };
}

export function renderBinaryNoticeHtml(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Structural Diff - ${escapeHtml(fileName)}</title>
  <style>
    body {
      background: #0d1117;
      color: #8b949e;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80vh;
      margin: 0;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    .msg { font-size: 15px; color: #c9d1d9; font-weight: 600; margin-bottom: 8px; }
    .hint { font-size: 13px; color: #6e7681; }
  </style>
</head>
<body>
  <div class="icon">📦</div>
  <div class="msg">Binary file: ${escapeHtml(fileName)}</div>
  <div class="hint">Binary files cannot be displayed in text diff view.</div>
</body>
</html>`;
}

export function renderDiffHtml(diff: StructuralDiffResult): string {
  const { filePath } = diff;
  const { rowsHtml, summaryRowsHtml } = renderDiffParts(diff);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Structural Diff - ${escapeHtml(filePath)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --text: #c9d1d9;
      --dimmed: #6e7681;
      --gutter-border: #21262d;
      --del-bg: rgba(248, 81, 73, 0.15);
      --del-text: #ff7b72;
      --ins-bg: rgba(46, 160, 67, 0.18);
      --ins-text: #7ee787;
      --expand-bg: rgba(110, 118, 129, 0.08);
      --expand-border: #30363d;
      --expand-text: #8b949e;
      --expand-hover-bg: rgba(110, 118, 129, 0.16);
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 13px;
      margin: 0;
      padding: 0;
    }

    .stat-add { color: var(--ins-text); font-weight: bold; }
    .stat-del { color: var(--del-text); font-weight: bold; }

    .diff-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .col-num {
      width: 48px;
      min-width: 48px;
      max-width: 48px;
      box-sizing: border-box;
      text-align: right;
      padding-right: 8px;
      user-select: none;
      color: var(--dimmed);
      background: transparent !important;
      font-size: 11px;
      vertical-align: top;
      line-height: 1.45;
    }

    .col-old { border-right: 1px solid var(--gutter-border); }
    .col-new { border-right: 1px solid var(--gutter-border); }

    .col-sign {
      width: 20px;
      min-width: 20px;
      max-width: 20px;
      box-sizing: border-box;
      text-align: center;
      user-select: none;
      font-weight: bold;
      vertical-align: top;
      line-height: 1.45;
    }

    .col-code {
      padding-left: 6px;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.45;
    }

    .col-code code,
    code {
      font-family: inherit;
      color: inherit;
      background: transparent !important;
    }

    .char-delete {
      background: rgba(248, 81, 73, 0.4);
      color: #ffdcd7 !important;
      border-radius: 2px;
      padding: 1px 2px;
      font-weight: 600;
    }

    .char-insert {
      background: rgba(46, 160, 67, 0.4);
      color: #aff5b4 !important;
      border-radius: 2px;
      padding: 1px 2px;
      font-weight: 600;
    }

    .line-unchanged {
      background: transparent !important;
      color: var(--dimmed) !important;
    }
    .line-unchanged td,
    .line-unchanged code,
    .line-unchanged .col-code,
    .line-unchanged .col-sign {
      background: transparent !important;
      color: var(--dimmed) !important;
    }

    .line-delete {
      background: var(--del-bg) !important;
      color: var(--del-text) !important;
    }
    .line-delete td,
    .line-delete code,
    .line-delete .col-code,
    .line-delete .col-sign {
      color: var(--del-text) !important;
    }
    .line-delete .col-num {
      color: rgba(255, 123, 114, 0.75) !important;
      background: rgba(248, 81, 73, 0.08) !important;
    }

    .line-insert {
      background: var(--ins-bg) !important;
      color: var(--ins-text) !important;
    }
    .line-insert td,
    .line-insert code,
    .line-insert .col-code,
    .line-insert .col-sign {
      color: var(--ins-text) !important;
    }
    .line-insert .col-num {
      color: rgba(126, 231, 135, 0.75) !important;
      background: rgba(46, 160, 67, 0.1) !important;
    }

    .diff-row-expand {
      cursor: pointer;
      background: var(--expand-bg);
      user-select: none;
      transition: background 0.15s;
    }

    .diff-row-expand:hover {
      background: var(--expand-hover-bg);
    }

    .expand-banner {
      color: var(--expand-text);
      text-align: center;
      padding: 5px 0;
      border-top: 1px dashed var(--expand-border);
      border-bottom: 1px dashed var(--expand-border);
      display: flex;
      justify-content: center;
      gap: 10px;
      align-items: center;
      font-size: 11px;
    }

    .expand-hint {
      color: #6e7681;
      font-size: 11px;
    }

    .diff-summary-card {
      position: sticky;
      top: 0;
      z-index: 10;
      background: #161b22;
      border-bottom: 1px solid var(--gutter-border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }

    .summary-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .summary-row-lines {
      display: flex;
      align-items: center;
      width: 100%;
    }

    .diff-actions {
      margin-left: auto;
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .diff-actions button {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid #30363d;
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }

    .diff-actions button:hover {
      background: #30363d;
      border-color: #8b949e;
      color: #f0f6fc;
    }

    .summary-label {
      color: var(--dimmed);
      font-weight: 600;
      min-width: 95px;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }

    .summary-items {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .summary-chip {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 11px;
      color: #c9d1d9;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s, border-color 0.15s;
    }

    .summary-link {
      cursor: pointer;
    }

    .summary-link:hover {
      background: #30363d;
      border-color: #8b949e;
      color: #f0f6fc;
      text-decoration: none;
    }

    .badge-mod {
      color: #e3b341;
      font-weight: bold;
    }

    .badge-add {
      color: #7ee787;
      font-weight: bold;
    }

    .badge-del {
      color: #ff7b72;
      font-weight: bold;
    }

    .more-btn {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #8b949e;
      cursor: pointer;
      font-size: 11px;
      padding: 2px 7px;
      transition: background 0.15s, color 0.15s;
    }

    .more-btn:hover {
      background: #30363d;
      color: #f0f6fc;
    }

    .flash-highlight {
      animation: flashRow 1.8s ease-out;
    }

    @keyframes flashRow {
      0% { background: rgba(56, 139, 253, 0.4) !important; }
      100% { background: transparent; }
    }
  </style>
</head>
<body>
  <div class="diff-summary-card" id="summary-card">
    ${summaryRowsHtml}
  </div>

  <table class="diff-table">
    <colgroup>
      <col style="width: 48px;">
      <col style="width: 48px;">
      <col style="width: 20px;">
      <col style="width: auto;">
    </colgroup>
    <tbody id="diff-tbody">
      ${rowsHtml}
    </tbody>
  </table>

  <script>
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'updateDiff') {
        const summaryEl = document.getElementById('summary-card');
        if (summaryEl) summaryEl.innerHTML = msg.summaryRowsHtml;
        const tbodyEl = document.getElementById('diff-tbody');
        if (tbodyEl) tbodyEl.innerHTML = msg.rowsHtml;
        if (msg.title) document.title = msg.title;
        window.scrollTo(0, 0);
      }
    });

    function expandHunk(id) {
      const bar = document.getElementById('bar_' + id);
      if (bar) bar.style.display = 'none';
      document.querySelectorAll('.hunk_' + id).forEach(r => r.style.display = '');
    }

    function expandAll() {
      document.querySelectorAll('.diff-row-expand').forEach(b => b.style.display = 'none');
      document.querySelectorAll('.hunk-hidden').forEach(h => h.style.display = '');
    }

    function collapseAll() {
      document.querySelectorAll('.diff-row-expand').forEach(b => b.style.display = '');
      document.querySelectorAll('.hunk-hidden').forEach(h => h.style.display = 'none');
    }

    function toggleMoreMethods(remainingCount) {
      const span = document.getElementById('more_methods');
      const btn = document.getElementById('btn_toggle_methods');
      if (!span || !btn) return;
      if (span.style.display === 'none') {
        span.style.display = 'inline-flex';
        span.style.gap = '6px';
        span.style.flexWrap = 'wrap';
        btn.textContent = 'collapse ▴';
      } else {
        span.style.display = 'none';
        btn.textContent = '+' + remainingCount + ' more ▾';
      }
    }

    function scrollToSymbol(id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.classList.contains('hunk-hidden') && el.style.display === 'none') {
        for (const cls of el.classList) {
          if (cls.startsWith('hunk_')) {
            expandHunk(cls.replace('hunk_', ''));
            break;
          }
        }
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 1800);
    }
  </script>
</body>
</html>`;
}
