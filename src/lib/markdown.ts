export const EXT_MAP: Record<string, string> = {
  js: 'js', javascript: 'js',
  ts: 'ts', typescript: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  md: 'md', markdown: 'md',
  html: 'html', css: 'css', scss: 'scss',
  py: 'py', python: 'py',
  json: 'json',
  sh: 'sh', bash: 'sh', shell: 'sh',
  sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml',
  c: 'c', cpp: 'cpp', java: 'java', rs: 'rs', go: 'go',
  // Plain text variants — always inline, never a project file
  text: 'txt', txt: 'txt', plain: 'txt', plaintext: 'txt', output: 'txt', log: 'txt',
};

const DEFAULT_NAMES: Record<string, string> = {
  js: 'index', javascript: 'index',
  ts: 'index', typescript: 'index',
  jsx: 'App', tsx: 'App',
  html: 'index', css: 'styles', scss: 'styles',
  py: 'main', python: 'main',
  json: 'data',
  sh: 'script', bash: 'script', shell: 'script',
  sql: 'query',
  md: 'README', markdown: 'README',
  yaml: 'config', yml: 'config',
  xml: 'config',
  go: 'main', rs: 'main', java: 'Main', c: 'main', cpp: 'main',
};

const FENCE_CONTAINING_LANGS = new Set(['md', 'markdown', 'text', 'txt', '']);

export const SHELL_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'fish', 'bat', 'cmd', 'powershell', 'ps1',
]);

/**
 * Langs that render as plain inline code (like markdown) rather than a
 * full collapsible file block. Shell langs plus plain text/output types.
 */
export const INLINE_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'fish', 'bat', 'cmd', 'powershell', 'ps1',
  'text', 'txt', 'plain', 'plaintext', 'output', 'log', '',
]);

export interface CodeBlock {
  id: string;
  lang: string;
  ext: string;
  code: string;
  suggestedFilename: string;
  isShell: boolean;
  /** Render as plain inline code block, not as a collapsible file block. */
  isInline: boolean;
}

export interface ParsedContent {
  parts: Array<{ type: 'text'; content: string } | { type: 'code'; block: CodeBlock }>;
}

let blockCounter = 0;

// Runtime/framework names that look like filenames but aren't file paths.
const FALSE_POSITIVE_NAMES = new Set([
  'Node.js', 'node.js', 'Vue.js', 'vue.js', 'React.js', 'react.js',
  'Express.js', 'express.js', 'Next.js', 'next.js', 'Nuxt.js', 'nuxt.js',
  'Angular.js', 'angular.js', 'Ember.js', 'ember.js', 'Backbone.js',
  'Socket.io', 'socket.io', 'Nest.js', 'nest.js', 'Fastify.js',
]);

function detectFilename(contextText: string, ext: string): string | null {
  const tail = contextText.slice(-300);
  const filenamePattern = /(?:^|[\s(`'"*([])([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,6})(?:[)`'"*\]\s:,]|$)/gm;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = filenamePattern.exec(tail)) !== null) matches.push(m[1]);
  if (!matches.length) return null;

  // Filter out known false positives and suspicious patterns:
  // - Known runtime/framework names (Node.js, Vue.js etc.)
  // - Names starting with a capital letter with no directory separator
  //   (e.g. "Response.ts", "Server.ts" — likely class names, not file paths)
  const isLikelyFilePath = (f: string): boolean => {
    if (FALSE_POSITIVE_NAMES.has(f)) return false;
    // Must contain a dot but not start with one
    if (!f.includes('.') || f.startsWith('.')) return false;
    // If no slash, reject capitalised names — they're almost always class/type names
    if (!f.includes('/') && /^[A-Z]/.test(f)) return false;
    return true;
  };

  const extNorm = ext.toLowerCase();
  const sameExt = matches.filter(f => isLikelyFilePath(f) && f.toLowerCase().endsWith(`.${extNorm}`));
  if (sameExt.length) return sameExt[sameExt.length - 1];
  const withDot = matches.filter(f => isLikelyFilePath(f));
  if (withDot.length) return withDot[withDot.length - 1];
  return null;
}

/**
 * Preprocess: convert inline single-line triple-backtick spans to proper fenced blocks,
 * and detect unfenced // FILE: blocks that the AI emitted without opening backticks.
 *
 * Handles both forms the AI produces:
 *   ```bash npm install```          — lang + space + content (original case)
 *   ``` DISCORD_TOKEN=... ```       — no lang, just spaces around content
 *   ```bash npm install discord```  — multi-word commands
 *
 * Bug 1 fix: detect bare `// FILE: path.ext` lines followed by code with no opening
 * fence and auto-wrap them in the correct typed fence block.
 *
 * Bug 2 fix: convert `\`\`\`lang filename.ext` fence openers (info string contains a
 * space + filename) into a proper fence with the filename embedded as a FILE: comment
 * inside the block, so the fence parser sees a clean `\`\`\`lang` opener and doesn't
 * treat the label as inline content.
 */
function preprocess(raw: string): string {
  // ── Bug 2 fix: ```lang filename.ext  (multiline fence with filename in info string)
  // Must run BEFORE the inline-fence replacements so Form 1 doesn't steal these.
  // Matches a fence opener whose info string is "lang filename" (word + space + non-space)
  // and rewrites it to a plain ```lang opener, injecting // FILE: on the first code line.
  raw = raw.replace(
    /^(`{3,})(\w+)[ \t]+([^\s`][^\n`]*)$/gm,
    (_m, fence, lang, filename) => {
      // Only rewrite when the trailing part looks like a filename (contains a dot)
      // or is a known filename pattern — this avoids false-positives on
      // ```bash npm install``` style inline fences (those are single-line and
      // handled below; this regex is multiline so it only fires on real openers).
      if (filename.includes('.') || /^[\w\-./]+$/.test(filename)) {
        const commentStyle = ['js','ts','jsx','tsx','java','c','cpp','cs','go','rs','swift','kt'].includes(lang)
          ? `// FILE: ${filename}`
          : ['py','rb','sh','bash','shell','yaml','yml'].includes(lang)
            ? `# FILE: ${filename}`
            : `// FILE: ${filename}`;
        return `${fence}${lang}\n${commentStyle}`;
      }
      return _m;
    }
  );

  // ── Bug 1 fix: bare `// FILE: path.ext` line with no opening fence
  // Detect a line matching `// FILE:` (or `# FILE:`) that is NOT already inside
  // a fenced block. We look for the pattern: the FILE line is followed immediately
  // by code lines (no blank line gap) and later ends at a blank line or another
  // FILE: marker or end-of-string. We infer the language from the file extension.
  raw = raw.replace(
    /^(\/\/\s*FILE:\s*(\S+)|#\s*FILE:\s*(\S+))\n([\s\S]+?)(?=\n\n|\n\/\/\s*FILE:|\n#\s*FILE:|$)/gm,
    (match, fileLine, extFromSlash, extFromHash) => {
      // If this FILE line is already preceded by a fence opener on the previous line,
      // do nothing — it's already inside a code block.
      // We detect this by checking if the match starts at pos 0 or the char before is \n
      // followed immediately by ``` — we can't check previous context in replace(), so
      // we use a sentinel: if fileLine appears right after a ``` line the preprocess
      // output will already have it in a fence.  The safest guard is: only wrap if
      // there is NO opening fence anywhere in the 200 chars before this match start.
      // Since replace() doesn't give us the offset easily we use a two-pass approach.
      return `\x00FILEWRAP:${fileLine}\n${match.slice(fileLine.length + 1)}`;
    }
  );

  // Second pass: resolve FILEWRAP sentinels. We scan the full string and wrap only
  // those that are NOT preceded by a fence opener line.
  const lines = raw.split('\n');
  const out: string[] = [];
  let insideFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fence state
    const fenceOpen = line.match(/^ {0,3}(`{3,}|~{3,})(\w*).*$/);
    if (!insideFence && fenceOpen) {
      insideFence = true;
      fenceChar = fenceOpen[1][0];
      fenceLen = fenceOpen[1].length;
      // Remove sentinel if somehow inside a fence (shouldn't happen but be safe)
      out.push(line.startsWith('\x00FILEWRAP:') ? line.slice('\x00FILEWRAP:'.length) : line);
      continue;
    }
    if (insideFence) {
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        insideFence = false;
      }
      // Strip any sentinel prefix that the first-pass applied to inside-fence FILE: lines
      out.push(line.startsWith('\x00FILEWRAP:') ? line.slice('\x00FILEWRAP:'.length) : line);
      continue;
    }

    // Not inside a fence — check for sentinel
    if (line.startsWith('\x00FILEWRAP:')) {
      const fileLine = line.slice('\x00FILEWRAP:'.length);

      // Peek ahead for a fence opener, skipping any blank lines.
      // Models sometimes emit:   // FILE: src/foo.ts
      //                          <blank line>
      //                          ```typescript
      // We need to find that fence even with blank lines in between.
      let peekIdx = i + 1;
      while (peekIdx < lines.length && lines[peekIdx].trim() === '') peekIdx++;
      const peekedLine = peekIdx < lines.length ? lines[peekIdx] : '';
      const nextIsFence = /^\s*`{3,}\w*\s*$/.test(peekedLine);

      if (nextIsFence) {
        // Skip the blank lines, emit the fence opener, inject FILE: comment inside it.
        // IMPORTANT: also update insideFence tracking so subsequent lines in this loop
        // are treated as fence-interior content (prevents double-sentinel processing of
        // an inner // FILE: comment that was also sentineled by the first pass).
        const fenceMatch = peekedLine.match(/^\s*(`{3,}|~{3,})(\w*)/);
        if (fenceMatch) {
          insideFence = true;
          fenceChar = fenceMatch[1][0];
          fenceLen = fenceMatch[1].length;
        }
        out.push(peekedLine);  // emit the ```lang opener
        out.push(fileLine);    // inject FILE: comment as first line inside the fence
        i = peekIdx + 1;       // skip sentinel + any blanks + fence opener
      } else {
        // No fence opener follows — wrap manually using inferred lang from extension
        const fnMatch = fileLine.match(/FILE:\s*(\S+)/i);
        const filename = fnMatch ? fnMatch[1] : '';
        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        const lang = Object.entries(EXT_MAP).find(([, v]) => v === ext)?.[0] ?? ext ?? 'text';
        out.push('```' + lang);
        out.push(fileLine);
        i++;
        while (i < lines.length) {
          const codeLine = lines[i];
          if (
            codeLine === '' ||
            codeLine.startsWith('\x00FILEWRAP:') ||
            /^(\/\/\s*FILE:|#\s*FILE:)/i.test(codeLine)
          ) {
            break;
          }
          out.push(codeLine);
          i++;
        }
        out.push('```');
        i--; // reprocess the line that broke the loop
      }
    } else {
      out.push(line);
    }
  }

  raw = out.join('\n');

  // ── Inline fence forms (single-line) ─────────────────────────────────────
  // Form 1: ```lang content```  (lang word immediately after fence, space before content)
  // Guard: only fire when content does NOT look like a filename (no dot) — filenames
  // with dots in info strings were already handled by the Bug 2 fix above.
  raw = raw.replace(/```(\w+)[ \t]+([^`\n]+?)[ \t]*```/g, (_m, lang, code) => {
    // If it looks like a filename (e.g. "package.json"), skip — already handled
    if (/^[\w\-./]+\.[a-zA-Z0-9]{1,6}$/.test(code.trim())) return _m;
    return `\n\`\`\`${lang.trim()}\n${code.trim()}\n\`\`\`\n`;
  });
  // Form 2: ``` content ```  (no lang, content wrapped in spaces)
  // Must have at least one space on each side to avoid matching real fence openers
  raw = raw.replace(/```[ \t]+([^`\n]+?)[ \t]*```/g, (_m, code) => {
    return `\n\`\`\`bash\n${code.trim()}\n\`\`\`\n`;
  });
  return raw;
}

export function parseContent(raw: string): ParsedContent {
  const parts: ParsedContent['parts'] = [];
  const lines = preprocess(raw).split('\n');
  let i = 0;
  let textBuffer = '';

  while (i < lines.length) {
    const line = lines[i];
    // Match fence openers — standard ```lang or ```lang filename.ext info strings
    const fenceMatch = line.match(/^ {0,3}(`{3,})(\w*)\s*([^\s`][^\n`]*)?\s*$/);

    if (fenceMatch) {
      const outerFence = fenceMatch[1];
      const outerFenceLen = outerFence.length;
      const lang = (fenceMatch[2] || '').toLowerCase();
      // fenceMatch[3] captures an optional filename in the info string, e.g. "package.json"
      const infoFilename = (fenceMatch[3] || '').trim();

      // Guard against stray close-fences that appear outside any open block.
      // This happens when a model emits the closing ``` of a fence-containing
      // block (like markdown) AFTER our parser has already closed that block
      // due to an earlier unindented ```. The stray ``` then looks like a new
      // opener with lang=''. If the very next line is blank or plain prose
      // (not another fence or code), it's almost certainly a stray closer —
      // skip it rather than opening a new empty block that will swallow content.
      const nextLine = lines[i + 1] ?? '';
      const nextIsFenceOrCode = /^\s*`{3,}/.test(nextLine) || nextLine.startsWith('//') || nextLine.startsWith('#!');
      if (lang === '' && !infoFilename && !nextIsFenceOrCode) {
        // Stray/orphan fence — treat as plain text, don't open a new code block
        textBuffer += (i === 0 || textBuffer === '' ? '' : '\n') + line;
        i++;
        continue;
      }
      const isFenceContaining = FENCE_CONTAINING_LANGS.has(lang);
      const codeLines: string[] = [];
      // If the fence had a filename in its info string, prepend a FILE: comment so
      // extractFilePath() and the file registry pick it up correctly.
      if (infoFilename) {
        const commentStyle = ['py','rb','sh','bash','shell','yaml','yml'].includes(lang)
          ? `# FILE: ${infoFilename}`
          : `// FILE: ${infoFilename}`;
        codeLines.push(commentStyle);
      }
      i++;

      if (isFenceContaining) {
        // For fence-containing langs (md, markdown) we use depth tracking so that
        // nested ``` fences inside the content (code examples in a README block)
        // do NOT prematurely close the outer block. We track open/close pairs:
        // a line matching /^```\w+/ is an inner opener (depth++);
        // a bare /^```\s*$/ line at depth=0 closes the outer block.
        let innerDepth = 0;
        while (i < lines.length) {
          const inner = lines[i];
          const innerOpen  = inner.match(/^(`{3,})\w+/);   // has lang tag → opener
          const innerClose = inner.match(/^(`{3,})\s*$/);  // bare backticks → closer
          if (innerClose) {
            if (innerDepth === 0) { i++; break; }          // closes outer block
            innerDepth--;
          } else if (innerOpen) {
            innerDepth++;
          }
          codeLines.push(inner);
          i++;
        }
      } else {
        while (i < lines.length) {
          const inner = lines[i];
          const closeMatch = inner.match(/^ {0,3}(`{3,})\s*$/);
          if (closeMatch && closeMatch[1].length >= outerFenceLen) { i++; break; }
          codeLines.push(inner);
          i++;
        }
      }

      if (textBuffer) {
        parts.push({ type: 'text', content: textBuffer });
        textBuffer = '';
      }

      const ext = EXT_MAP[lang] ?? (lang || 'txt');
      const contextSoFar = parts
        .filter(p => p.type === 'text')
        .map(p => (p as { type: 'text'; content: string }).content)
        .join('');
      const detected = infoFilename || detectFilename(contextSoFar, ext);
      const defaultStem = DEFAULT_NAMES[lang] ?? 'file';
      const suggestedFilename = detected ?? `${defaultStem}.${ext}`;

      parts.push({
        type: 'code',
        block: {
          id: `cb_${++blockCounter}`,
          lang, ext,
          code: codeLines.join('\n').replace(/\n$/, ''),
          suggestedFilename,
          isShell: SHELL_LANGS.has(lang),
          isInline: INLINE_LANGS.has(lang),
        },
      });
    } else {
      textBuffer += (i === 0 || textBuffer === '' ? '' : '\n') + line;
      i++;
    }
  }

  if (textBuffer) parts.push({ type: 'text', content: textBuffer });
  return { parts };
}

export function renderInlineMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Renders a markdown table string into an HTML <table>.
 * Input: the raw table lines (including separator row).
 */
function renderTable(lines: string[]): string {
  // Filter out the separator row (---|--- pattern)
  const rows = lines.filter(l => !/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?\s*$/.test(l));
  if (rows.length === 0) return '';

  const parseRow = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const [headerRow, ...bodyRows] = rows;
  const headers = parseRow(headerRow);

  const thead = '<thead><tr>' +
    headers.map(h => `<th>${renderInlineMarkdown(h)}</th>`).join('') +
    '</tr></thead>';

  const tbody = bodyRows.length
    ? '<tbody>' +
      bodyRows.map(row => {
        const cells = parseRow(row);
        return '<tr>' + cells.map(c => `<td>${renderInlineMarkdown(c)}</td>`).join('') + '</tr>';
      }).join('') +
      '</tbody>'
    : '';

  return `<table>${thead}${tbody}</table>`;
}

export function renderTextBlock(text: string): string {
  // ── Pre-clean AI artifacts ────────────────────────────────────────────────
  text = text.replace(/^(?:\/\/\s*|#\s*|<!--\s*)?FILE:\s*.+?(?:\s*-->)?\s*$/gm, '');
  text = text.replace(
    /`(bash|sh|shell|node|python|py|js|ts|npm|npx|yarn|pnpm|cmd|powershell)\s+([^`\n]+)`/g,
    '`$2`'
  );
  text = text.replace(/^`{1,2}\s*$/gm, '');

  // ── Extract tables BEFORE any escaping ───────────────────────────────────
  // We pull each table out of the text entirely, render it to HTML, store in
  // a map keyed by a safe placeholder token, then run all markdown processing
  // on the remaining text. The real HTML is spliced back in at the very end,
  // after all escaping is done, so angle brackets in table cells are safe.
  const tableMap = new Map<string, string>();
  let tableCounter = 0;

  const inputLines = text.split('\n');
  const processedLines: string[] = [];
  let i = 0;

  while (i < inputLines.length) {
    const line = inputLines[i];
    const isTableRow = /\|/.test(line);
    const nextIsSep = i + 1 < inputLines.length &&
      /^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?\s*$/.test(inputLines[i + 1]);

    if (isTableRow && nextIsSep) {
      const tableLines: string[] = [];
      while (i < inputLines.length && /\|/.test(inputLines[i])) {
        tableLines.push(inputLines[i]);
        i++;
      }
      const token = `TABLETOK${tableCounter++}END`;
      tableMap.set(token, renderTable(tableLines));
      processedLines.push(token);
    } else {
      processedLines.push(line);
      i++;
    }
  }

  const cleaned = processedLines.join('\n');

  // ── Standard markdown → HTML (only runs on non-table text) ───────────────
  let html = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headings — must go largest first so ##### isn't partially matched by ###
    .replace(/^#{5} (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#{4} (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr />')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[\*\-] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*<\/p>/g, '');
  // Unwrap block-level elements from paragraph tags (now includes h4/h5)
  html = html.replace(/<p>(<(?:h[1-5]|ul|ol|div|blockquote|hr|pre|table))/g, '$1');
  html = html.replace(/(<\/(?:h[1-5]|ul|ol|div|blockquote|hr|pre|table)>)<\/p>/g, '$1');

  // ── Splice table HTML back in (token placeholders were never escaped) ─────
  // Tokens may appear:
  //   a) alone:              <p>TABLETOK0END</p>
  //   b) after a heading:    <p>### Changes\nTABLETOK0END</p>  (single \n, not \n\n)
  //   c) bare (no wrapping): TABLETOK0END
  // We handle (b) by splitting the <p> at the token boundary so the heading
  // and the table both render correctly as separate block elements.
  for (const [token, tableHtml] of tableMap) {
    // Case (b): token shares a <p> with preceding content
    html = html.replace(
      new RegExp(`<p>((?:(?!${token})[\\s\\S])+?)\\n?${token}</p>`, 'g'),
      (_, before) => `<p>${before.trim()}</p>${tableHtml}`,
    );
    // Case (a): token is the only content in a <p>
    html = html.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), tableHtml);
    // Case (c): bare token left over
    html = html.replace(new RegExp(token, 'g'), tableHtml);
  }

  return html;
}

export function extractFilePath(code: string, suggestedFilename: string): string {
  const firstLine = code.split('\n')[0].trim();
  const patterns = [
    /^\/\/\s*FILE:\s*(.+)$/,
    /^#\s*FILE:\s*(.+)$/,
    /^<!--\s*FILE:\s*(.+?)\s*-->$/,
  ];
  for (const pat of patterns) {
    const m = firstLine.match(pat);
    if (m) {
      const p = m[1].trim();
      if (p && p.includes('.')) return p;
    }
  }
  return suggestedFilename;
}

/**
 * Returns true if the code block's first line contains an explicit FILE: path
 * declaration. Only these blocks are considered project files worth storing.
 */
export function hasFileComment(code: string): boolean {
  const first = code.split('\n')[0].trim();
  return (
    /^\/\/\s*FILE:/i.test(first) ||
    /^#\s*FILE:/i.test(first) ||
    /^<!--\s*FILE:/i.test(first)
  );
}

export function stripFileComment(code: string): string {
  const lines = code.split('\n');
  const first = lines[0].trim();
  if (
    /^\/\/\s*FILE:/.test(first) ||
    /^#\s*FILE:/.test(first) ||
    /^<!--\s*FILE:/.test(first)
  ) {
    return lines.slice(1).join('\n').replace(/^\n/, '');
  }
  return code;
}

export function extractCodeBlocksForRegistry(
  raw: string,
): Array<{ path: string; content: string; lang: string }> {
  const { parts } = parseContent(raw);
  return parts
    .filter((p): p is { type: 'code'; block: CodeBlock } => p.type === 'code')
    // Gate solely on FILE: comment — this naturally excludes shell commands,
    // inline snippets, and examples (none of which carry FILE: declarations).
    // We intentionally do NOT filter on isInline here because languages like
    // 'plaintext' are inline for display purposes but may carry a FILE: comment
    // for legitimate project files (.gitignore, .env.example, etc.).
    .filter(p => hasFileComment(p.block.code))
    .map(p => ({
      path: extractFilePath(p.block.code, p.block.suggestedFilename),
      content: stripFileComment(p.block.code),
      lang: p.block.lang,
    }))
    .filter(b => b.content.trim().length > 0 && b.path.includes('.'));
}
