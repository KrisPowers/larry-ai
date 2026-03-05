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

// Languages whose content commonly contains ``` fences of their own.
// When we open a block with one of these langs, inner ``` lines are treated
// as literal content — not new block openers — until the matching close fence.
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
  while ((m = filenamePattern.exec(tail)) !== null) {
    matches.push(m[1]);
  }
  if (!matches.length) return null;
  const extNorm = ext.toLowerCase();
  const sameExt = matches.filter(f => f.toLowerCase().endsWith(`.${extNorm}`));
  if (sameExt.length) return sameExt[sameExt.length - 1];
  const withDot = matches.filter(f => f.includes('.') && !f.startsWith('.'));
  if (withDot.length) return withDot[withDot.length - 1];
  return null;
}

/**
 * Line-by-line parser that correctly handles nested ``` inside md/text blocks.
 *
 * For normal code langs (js, ts, py, etc.): the first closing ``` ends the block.
 * For fence-containing langs (md, markdown, text, ''): we match the exact same
 * fence string that opened the block, so inner ``` for code examples are safe.
 */
export function parseContent(raw: string): ParsedContent {
  const parts: ParsedContent['parts'] = [];
  const lines = raw.split('\n');
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
          // For md/text: only close on the exact same fence string
          if (closeMatch && closeMatch[1] === outerFence) {
            i++;
            break;
          }
        } else {
          // For normal langs: close on any fence of >= outer length
          if (closeMatch && closeMatch[1].length >= outerFenceLen) {
            i++;
            break;
          }
        }

        codeLines.push(inner);
        i++;
      }

      // Flush text before this block
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
          lang,
          ext,
          code: codeLines.join('\n').replace(/\n$/, ''),
          suggestedFilename,
        },
      });
    } else {
      textBuffer += (i === 0 || textBuffer === '' ? '' : '\n') + line;
      i++;
    }
  }

  if (textBuffer) {
    parts.push({ type: 'text', content: textBuffer });
  }

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
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[\*\-] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:h[123]|ul|ol|div|blockquote|hr|pre))/g, '$1');
  html = html.replace(/(<\/(?:h[123]|ul|ol|div|blockquote|hr|pre)>)<\/p>/g, '$1');

  return html;
}
