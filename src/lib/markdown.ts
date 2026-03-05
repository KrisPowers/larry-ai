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

export interface CodeBlock {
  id: string;
  lang: string;
  ext: string;
  code: string;
  suggestedFilename: string;
}

export interface ParsedContent {
  parts: Array<{ type: 'text'; content: string } | { type: 'code'; block: CodeBlock }>;
}

let blockCounter = 0;

function detectFilename(contextText: string, ext: string): string | null {
  const tail = contextText.slice(-300);
  const filenamePattern = /(?:^|[\s(`'"*([])([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,6})(?:[)`'"*\]\s:,]|$)/gm;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = filenamePattern.exec(tail)) !== null) matches.push(m[1]);
  if (!matches.length) return null;
  const extNorm = ext.toLowerCase();
  const sameExt = matches.filter(f => f.toLowerCase().endsWith(`.${extNorm}`));
  if (sameExt.length) return sameExt[sameExt.length - 1];
  const withDot = matches.filter(f => f.includes('.') && !f.startsWith('.'));
  if (withDot.length) return withDot[withDot.length - 1];
  return null;
}

/**
 * Pre-processes raw AI output before line-by-line fence parsing.
 *
 * Converts inline single-line triple-backtick spans into proper fenced blocks:
 *   ```bash npm install```   →   a real fenced block on its own lines
 *
 * This is the primary source of stray backticks in rendered text — the AI
 * writes commands as inline spans rather than proper fenced blocks.
 */
function preprocess(raw: string): string {
  // Match: ```lang<space>content``` all on one line (no newline inside the content)
  // Must have at least one space between lang/fence and content so we don't
  // accidentally collapse a real opening fence that has trailing spaces.
  return raw.replace(/```(\w*)[ \t]+([^`\n]+?)```/g, (_match, lang, code) => {
    const l = lang.trim() || 'bash';
    return `\n\`\`\`${l}\n${code.trim()}\n\`\`\`\n`;
  });
}

export function parseContent(raw: string): ParsedContent {
  const parts: ParsedContent['parts'] = [];
  const lines = preprocess(raw).split('\n');
  let i = 0;
  let textBuffer = '';

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,})(\w*)\s*$/);

    if (fenceMatch) {
      const outerFence = fenceMatch[1];
      const outerFenceLen = outerFence.length;
      const lang = (fenceMatch[2] || '').toLowerCase();
      const isFenceContaining = FENCE_CONTAINING_LANGS.has(lang);
      const codeLines: string[] = [];
      i++;

      while (i < lines.length) {
        const inner = lines[i];
        const closeMatch = inner.match(/^(`{3,})\s*$/);
        if (isFenceContaining) {
          if (closeMatch && closeMatch[1] === outerFence) { i++; break; }
        } else {
          if (closeMatch && closeMatch[1].length >= outerFenceLen) { i++; break; }
        }
        codeLines.push(inner);
        i++;
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
      const detected = detectFilename(contextSoFar, ext);
      const defaultStem = DEFAULT_NAMES[lang] ?? 'file';
      const suggestedFilename = detected ?? `${defaultStem}.${ext}`;

      parts.push({
        type: 'code',
        block: {
          id: `cb_${++blockCounter}`,
          lang, ext,
          code: codeLines.join('\n').replace(/\n$/, ''),
          suggestedFilename,
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

export function renderTextBlock(text: string): string {
  // ── Pre-clean AI artifacts before HTML conversion ─────────────────────────

  // 1. Strip FILE: annotation lines — already consumed by extractFilePath,
  //    showing them in rendered text is just noise.
  text = text.replace(/^(?:\/\/\s*|#\s*|<!--\s*)?FILE:\s*.+?(?:\s*-->)?\s*$/gm, '');

  // 2. Strip lang-prefixed single-backtick spans the AI emits, e.g.:
  //    `bash npm install discord.js`  →  `npm install discord.js`
  //    `node src/index.js`            →  `src/index.js`  (node is the runner, not content)
  //    We remove the leading lang keyword so the content renders as clean <code>.
  text = text.replace(
    /`(bash|sh|shell|node|python|py|js|ts|npm|npx|yarn|pnpm|cmd|powershell)\s+([^`\n]+)`/g,
    '`$2`'
  );

  // 3. Remove stray lone backticks sitting on their own line (malformed fence remnants).
  text = text.replace(/^`{1,2}\s*$/gm, '');

  // ── Standard markdown → HTML ──────────────────────────────────────────────
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr />')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Inline code — allow anything except newlines inside backticks
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[\*\-] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:h[123]|ul|ol|div|blockquote|hr|pre))/g, '$1');
  html = html.replace(/(<\/(?:h[123]|ul|ol|div|blockquote|hr|pre)>)<\/p>/g, '$1');

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
    .map(p => ({
      path: extractFilePath(p.block.code, p.block.suggestedFilename),
      content: stripFileComment(p.block.code),
      lang: p.block.lang,
    }))
    .filter(b => b.content.trim().length > 0);
}
