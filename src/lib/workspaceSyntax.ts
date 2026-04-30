type SyntaxMode =
  | 'javascript'
  | 'json'
  | 'markup'
  | 'css'
  | 'python'
  | 'shell'
  | 'markdown'
  | 'yaml'
  | 'sql'
  | 'clike'
  | 'generic';

interface HighlightState {
  blockCommentEnd?: string;
  stringDelimiter?: string;
}

interface GenericLanguageConfig {
  lineComments: string[];
  blockComments: Array<{ start: string; end: string }>;
  keywords: Set<string>;
  constants: Set<string>;
  multilineStrings?: string[];
}

interface LinePrefixParts {
  prefix: string;
  rest: string;
}

const JS_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor',
  'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'new', 'null', 'of', 'package', 'private',
  'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'type', 'typeof', 'undefined', 'using', 'var', 'void', 'while', 'with', 'yield',
]);

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'match', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True',
  'try', 'while', 'with', 'yield',
]);

const SHELL_KEYWORDS = new Set([
  'alias', 'break', 'case', 'cd', 'continue', 'declare', 'do', 'done', 'elif', 'else', 'esac', 'eval',
  'exec', 'exit', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'readonly', 'return',
  'select', 'set', 'shift', 'source', 'then', 'time', 'trap', 'typeset', 'unset', 'until', 'while',
]);

const SQL_KEYWORDS = new Set([
  'add', 'all', 'alter', 'and', 'as', 'asc', 'begin', 'between', 'by', 'case', 'check', 'column',
  'commit', 'constraint', 'create', 'database', 'default', 'delete', 'desc', 'distinct', 'drop', 'else',
  'end', 'exists', 'foreign', 'from', 'group', 'having', 'in', 'index', 'inner', 'insert', 'into', 'is',
  'join', 'key', 'left', 'like', 'limit', 'not', 'null', 'on', 'or', 'order', 'outer', 'primary',
  'procedure', 'references', 'right', 'rollback', 'select', 'set', 'table', 'then', 'top', 'truncate',
  'union', 'unique', 'update', 'values', 'view', 'when', 'where',
]);

const CLIKE_KEYWORDS = new Set([
  'auto', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'default', 'defer', 'do',
  'else', 'enum', 'explicit', 'export', 'extern', 'false', 'final', 'fn', 'for', 'func', 'goto', 'if',
  'implements', 'import', 'inline', 'interface', 'let', 'loop', 'match', 'mutable', 'namespace', 'new',
  'null', 'override', 'package', 'private', 'protected', 'pub', 'public', 'register', 'return', 'self',
  'sizeof', 'static', 'struct', 'super', 'switch', 'template', 'this', 'throw', 'trait', 'true', 'try',
  'typedef', 'typename', 'union', 'unsafe', 'use', 'using', 'var', 'virtual', 'void', 'volatile', 'while',
]);

const GENERIC_KEYWORDS = new Set([
  ...JS_KEYWORDS,
  ...PYTHON_KEYWORDS,
  ...SHELL_KEYWORDS,
  ...SQL_KEYWORDS,
  ...CLIKE_KEYWORDS,
]);

const GENERIC_CONSTANTS = new Set([
  'false', 'true', 'null', 'undefined', 'none', 'yes', 'no', 'on', 'off',
]);

const GENERIC_CONFIGS: Record<Exclude<SyntaxMode, 'json' | 'markup' | 'css' | 'markdown' | 'yaml'>, GenericLanguageConfig> = {
  javascript: {
    lineComments: ['//'],
    blockComments: [{ start: '/*', end: '*/' }],
    keywords: JS_KEYWORDS,
    constants: GENERIC_CONSTANTS,
    multilineStrings: ['`'],
  },
  python: {
    lineComments: ['#'],
    blockComments: [],
    keywords: PYTHON_KEYWORDS,
    constants: GENERIC_CONSTANTS,
    multilineStrings: ['"""', '\'\'\''],
  },
  shell: {
    lineComments: ['#'],
    blockComments: [],
    keywords: SHELL_KEYWORDS,
    constants: GENERIC_CONSTANTS,
  },
  sql: {
    lineComments: ['--'],
    blockComments: [{ start: '/*', end: '*/' }],
    keywords: SQL_KEYWORDS,
    constants: GENERIC_CONSTANTS,
  },
  clike: {
    lineComments: ['//'],
    blockComments: [{ start: '/*', end: '*/' }],
    keywords: CLIKE_KEYWORDS,
    constants: GENERIC_CONSTANTS,
    multilineStrings: ['`'],
  },
  generic: {
    lineComments: ['//', '#', '--'],
    blockComments: [{ start: '/*', end: '*/' }],
    keywords: GENERIC_KEYWORDS,
    constants: GENERIC_CONSTANTS,
    multilineStrings: ['`', '"""', '\'\'\''],
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapToken(value: string, className: string): string {
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function detectSyntaxMode(lang: string): SyntaxMode {
  const normalized = (lang || 'text').trim().toLowerCase();

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript'].includes(normalized)) {
    return 'javascript';
  }
  if (['json', 'jsonc'].includes(normalized)) {
    return 'json';
  }
  if (['html', 'xml', 'svg', 'tsx-markup', 'jsx-markup'].includes(normalized)) {
    return 'markup';
  }
  if (['css', 'scss', 'less'].includes(normalized)) {
    return 'css';
  }
  if (['py', 'python'].includes(normalized)) {
    return 'python';
  }
  if (['sh', 'bash', 'shell', 'zsh'].includes(normalized)) {
    return 'shell';
  }
  if (['md', 'markdown'].includes(normalized)) {
    return 'markdown';
  }
  if (['yaml', 'yml', 'toml', 'ini'].includes(normalized)) {
    return 'yaml';
  }
  if (['sql'].includes(normalized)) {
    return 'sql';
  }
  if (['go', 'rs', 'rust', 'java', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'swift', 'kt'].includes(normalized)) {
    return 'clike';
  }

  return 'generic';
}

function findFirstMatch(source: string, index: number, values: string[]): string | null {
  for (const value of values) {
    if (source.startsWith(value, index)) return value;
  }
  return null;
}

function consumeQuotedString(source: string, start: number, delimiter: string): { token: string; end: number; closed: boolean } {
  let index = start + delimiter.length;

  while (index < source.length) {
    if (source.startsWith(delimiter, index)) {
      return {
        token: source.slice(start, index + delimiter.length),
        end: index + delimiter.length,
        closed: true,
      };
    }

    if (delimiter.length === 1 && source[index] === '\\') {
      index += 2;
      continue;
    }

    index += 1;
  }

  return {
    token: source.slice(start),
    end: source.length,
    closed: false,
  };
}

function readWord(source: string, start: number): { word: string; end: number } {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_$:-]/.test(source[index])) {
    index += 1;
  }
  return {
    word: source.slice(start, index),
    end: index,
  };
}

function readNumber(source: string, start: number): { value: string; end: number } {
  let index = start;
  while (index < source.length && /[0-9a-fA-F_xobXOB.]/.test(source[index])) {
    index += 1;
  }
  return {
    value: source.slice(start, index),
    end: index,
  };
}

function classifyWord(
  word: string,
  line: string,
  start: number,
  end: number,
  config: GenericLanguageConfig,
): string | null {
  const lowerWord = word.toLowerCase();
  const nextNonWhitespace = line.slice(end).match(/\S/)?.[0] ?? '';
  const previousNonWhitespace = line.slice(0, start).match(/\S(?=\s*$)/)?.[0] ?? '';

  if (config.keywords.has(word) || config.keywords.has(lowerWord)) return 'workspace-token-keyword';
  if (config.constants.has(word) || config.constants.has(lowerWord)) return 'workspace-token-constant';
  if (previousNonWhitespace === '.') return 'workspace-token-property';
  if (nextNonWhitespace === '(') return 'workspace-token-function';
  if (/^[A-Z]/.test(word)) return 'workspace-token-type';

  return null;
}

function splitLinePrefix(line: string): LinePrefixParts {
  const match = line.match(/^[\t ]+/);
  if (!match) {
    return { prefix: '', rest: line };
  }

  return {
    prefix: match[0],
    rest: line.slice(match[0].length),
  };
}

function countIndentColumns(prefix: string): number {
  let columns = 0;

  for (const char of prefix) {
    columns += char === '\t' ? 2 : 1;
  }

  return columns;
}

const INDENT_GUIDE_COLUMNS = 2;

function expandIndentPrefix(prefix: string): string {
  const columns = countIndentColumns(prefix);
  return columns > 0 ? ' '.repeat(columns) : '';
}

function renderLinePrefix(prefix: string): string {
  if (!prefix) {
    return '';
  }

  const slotCount = Math.floor(prefix.length / INDENT_GUIDE_COLUMNS);
  const remainder = prefix.length % INDENT_GUIDE_COLUMNS;
  let html = '';

  for (let index = 0; index < slotCount; index += 1) {
    html += `<span class="workspace-file-editor-indent">${' '.repeat(INDENT_GUIDE_COLUMNS)}</span>`;
  }
  if (remainder > 0) {
    html += escapeHtml(' '.repeat(remainder));
  }

  return html;
}

function renderLineHtml(innerHtml: string): string {
  return `<span class="workspace-file-editor-render-line">${innerHtml || '<span class="workspace-file-editor-render-placeholder"> </span>'}</span>`;
}

function highlightGenericLine(
  line: string,
  state: HighlightState,
  config: GenericLanguageConfig,
): { html: string; state: HighlightState } {
  let html = '';
  let index = 0;
  const nextState: HighlightState = { ...state };

  while (index < line.length) {
    if (nextState.blockCommentEnd) {
      const endIndex = line.indexOf(nextState.blockCommentEnd, index);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + nextState.blockCommentEnd.length), 'workspace-token-comment');
      index = endIndex + nextState.blockCommentEnd.length;
      delete nextState.blockCommentEnd;
      continue;
    }

    if (nextState.stringDelimiter) {
      const token = consumeQuotedString(line, index, nextState.stringDelimiter);
      html += wrapToken(token.token, 'workspace-token-string');
      index = token.end;
      if (token.closed) {
        delete nextState.stringDelimiter;
      }
      continue;
    }

    const multilineDelimiter = config.multilineStrings?.find((value) => line.startsWith(value, index));
    if (multilineDelimiter) {
      const token = consumeQuotedString(line, index, multilineDelimiter);
      html += wrapToken(token.token, 'workspace-token-string');
      index = token.end;
      if (!token.closed) {
        nextState.stringDelimiter = multilineDelimiter;
      }
      continue;
    }

    const lineComment = findFirstMatch(line, index, config.lineComments);
    if (lineComment) {
      html += wrapToken(line.slice(index), 'workspace-token-comment');
      return { html, state: nextState };
    }

    const blockComment = config.blockComments.find((value) => line.startsWith(value.start, index));
    if (blockComment) {
      const endIndex = line.indexOf(blockComment.end, index + blockComment.start.length);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        nextState.blockCommentEnd = blockComment.end;
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + blockComment.end.length), 'workspace-token-comment');
      index = endIndex + blockComment.end.length;
      continue;
    }

    const quote = ['"', '\'', '`'].find((value) => line.startsWith(value, index));
    if (quote) {
      const token = consumeQuotedString(line, index, quote);
      html += wrapToken(token.token, 'workspace-token-string');
      index = token.end;
      if (!token.closed && config.multilineStrings?.includes(quote)) {
        nextState.stringDelimiter = quote;
      }
      continue;
    }

    if (line[index] === '$') {
      const variableMatch = line.slice(index).match(/^\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?/);
      if (variableMatch) {
        html += wrapToken(variableMatch[0], 'workspace-token-constant');
        index += variableMatch[0].length;
        continue;
      }
    }

    if (/[0-9]/.test(line[index])) {
      const token = readNumber(line, index);
      html += wrapToken(token.value, 'workspace-token-number');
      index = token.end;
      continue;
    }

    if (/[A-Za-z_$]/.test(line[index])) {
      const token = readWord(line, index);
      const className = classifyWord(token.word, line, index, token.end, config);
      html += className ? wrapToken(token.word, className) : escapeHtml(token.word);
      index = token.end;
      continue;
    }

    if (/[=+\-*/%<>!&|^~?:]/.test(line[index])) {
      html += wrapToken(line[index], 'workspace-token-operator');
      index += 1;
      continue;
    }

    if (/[()[\]{}.,;]/.test(line[index])) {
      html += wrapToken(line[index], 'workspace-token-punctuation');
      index += 1;
      continue;
    }

    html += escapeHtml(line[index]);
    index += 1;
  }

  return { html, state: nextState };
}

function highlightJsonLine(line: string): string {
  let html = '';
  let index = 0;

  while (index < line.length) {
    if (line[index] === '"' || line[index] === '\'') {
      const token = consumeQuotedString(line, index, line[index]);
      const remainder = line.slice(token.end);
      const className = /^\s*:/.test(remainder)
        ? 'workspace-token-property'
        : 'workspace-token-string';
      html += wrapToken(token.token, className);
      index = token.end;
      continue;
    }

    if (/[0-9-]/.test(line[index])) {
      const token = readNumber(line, index);
      html += wrapToken(token.value, 'workspace-token-number');
      index = token.end;
      continue;
    }

    const literalMatch = line.slice(index).match(/^(true|false|null)\b/);
    if (literalMatch) {
      html += wrapToken(literalMatch[0], 'workspace-token-constant');
      index += literalMatch[0].length;
      continue;
    }

    if (/[()[\]{}.,:]/.test(line[index])) {
      html += wrapToken(line[index], 'workspace-token-punctuation');
      index += 1;
      continue;
    }

    html += escapeHtml(line[index]);
    index += 1;
  }

  return html;
}

function highlightMarkupTag(tag: string): string {
  let html = '';
  let index = 0;

  if (tag.startsWith('</')) {
    html += wrapToken('</', 'workspace-token-punctuation');
    index = 2;
  } else {
    html += wrapToken('<', 'workspace-token-punctuation');
    index = 1;
  }

  const tagName = tag.slice(index).match(/^[A-Za-z][A-Za-z0-9:-]*/)?.[0];
  if (tagName) {
    html += wrapToken(tagName, 'workspace-token-tag');
    index += tagName.length;
  }

  while (index < tag.length) {
    if (tag.startsWith('/>', index)) {
      html += wrapToken('/>', 'workspace-token-punctuation');
      index += 2;
      continue;
    }

    if (tag[index] === '>') {
      html += wrapToken('>', 'workspace-token-punctuation');
      index += 1;
      continue;
    }

    if (tag[index] === '=') {
      html += wrapToken('=', 'workspace-token-operator');
      index += 1;
      continue;
    }

    if (tag[index] === '"' || tag[index] === '\'') {
      const token = consumeQuotedString(tag, index, tag[index]);
      html += wrapToken(token.token, 'workspace-token-attr-value');
      index = token.end;
      continue;
    }

    if (/[A-Za-z:@]/.test(tag[index])) {
      const token = readWord(tag, index);
      html += wrapToken(token.word, 'workspace-token-attr-name');
      index = token.end;
      continue;
    }

    html += escapeHtml(tag[index]);
    index += 1;
  }

  return html;
}

function highlightMarkupLine(line: string, state: HighlightState): { html: string; state: HighlightState } {
  let html = '';
  let index = 0;
  const nextState: HighlightState = { ...state };

  while (index < line.length) {
    if (nextState.blockCommentEnd) {
      const endIndex = line.indexOf(nextState.blockCommentEnd, index);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + nextState.blockCommentEnd.length), 'workspace-token-comment');
      index = endIndex + nextState.blockCommentEnd.length;
      delete nextState.blockCommentEnd;
      continue;
    }

    if (line.startsWith('<!--', index)) {
      const endIndex = line.indexOf('-->', index + 4);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        nextState.blockCommentEnd = '-->';
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + 3), 'workspace-token-comment');
      index = endIndex + 3;
      continue;
    }

    if (line[index] === '<') {
      const closeIndex = line.indexOf('>', index);
      if (closeIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-tag');
        return { html, state: nextState };
      }

      html += highlightMarkupTag(line.slice(index, closeIndex + 1));
      index = closeIndex + 1;
      continue;
    }

    html += escapeHtml(line[index]);
    index += 1;
  }

  return { html, state: nextState };
}

function highlightCssLine(line: string, state: HighlightState): { html: string; state: HighlightState } {
  let html = '';
  let index = 0;
  const nextState: HighlightState = { ...state };
  const propertyMatch = line.match(/^(\s*)([A-Za-z-]+)(\s*:)/);

  while (index < line.length) {
    if (nextState.blockCommentEnd) {
      const endIndex = line.indexOf(nextState.blockCommentEnd, index);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + nextState.blockCommentEnd.length), 'workspace-token-comment');
      index = endIndex + nextState.blockCommentEnd.length;
      delete nextState.blockCommentEnd;
      continue;
    }

    if (line.startsWith('/*', index)) {
      const endIndex = line.indexOf('*/', index + 2);
      if (endIndex === -1) {
        html += wrapToken(line.slice(index), 'workspace-token-comment');
        nextState.blockCommentEnd = '*/';
        return { html, state: nextState };
      }

      html += wrapToken(line.slice(index, endIndex + 2), 'workspace-token-comment');
      index = endIndex + 2;
      continue;
    }

    if (line[index] === '"' || line[index] === '\'') {
      const token = consumeQuotedString(line, index, line[index]);
      html += wrapToken(token.token, 'workspace-token-string');
      index = token.end;
      continue;
    }

    if (line[index] === '@') {
      const token = readWord(line, index + 1);
      html += wrapToken(`@${token.word}`, 'workspace-token-keyword');
      index = token.end;
      continue;
    }

    const hexColorMatch = line.slice(index).match(/^#[0-9a-fA-F]{3,8}\b/);
    if (hexColorMatch) {
      html += wrapToken(hexColorMatch[0], 'workspace-token-number');
      index += hexColorMatch[0].length;
      continue;
    }

    if (propertyMatch && index === propertyMatch[1].length) {
      html += wrapToken(propertyMatch[2], 'workspace-token-property');
      index += propertyMatch[2].length;
      continue;
    }

    if (/[0-9]/.test(line[index])) {
      const token = readNumber(line, index);
      html += wrapToken(token.value, 'workspace-token-number');
      index = token.end;
      continue;
    }

    if (/[.#A-Za-z_-]/.test(line[index])) {
      const token = readWord(line, index);
      const className = token.word.startsWith('.')
        ? 'workspace-token-function'
        : token.word.startsWith('#')
          ? 'workspace-token-constant'
          : 'workspace-token-tag';
      html += wrapToken(token.word, className);
      index = token.end;
      continue;
    }

    if (/[()[\]{}.,:;]/.test(line[index])) {
      html += wrapToken(line[index], 'workspace-token-punctuation');
      index += 1;
      continue;
    }

    if (/[=+\-*/%<>!&|^~]/.test(line[index])) {
      html += wrapToken(line[index], 'workspace-token-operator');
      index += 1;
      continue;
    }

    html += escapeHtml(line[index]);
    index += 1;
  }

  return { html, state: nextState };
}

function highlightMarkdownInline(text: string): string {
  let html = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] === '`') {
      const token = consumeQuotedString(text, index, '`');
      html += wrapToken(token.token, 'workspace-token-string');
      index = token.end;
      continue;
    }

    const linkMatch = text.slice(index).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      html += `${wrapToken(`[${linkMatch[1]}]`, 'workspace-token-function')}${wrapToken(`(${linkMatch[2]})`, 'workspace-token-string')}`;
      index += linkMatch[0].length;
      continue;
    }

    if (text.startsWith('**', index) || text.startsWith('__', index)) {
      html += wrapToken(text.slice(index, index + 2), 'workspace-token-operator');
      index += 2;
      continue;
    }

    if (text[index] === '*' || text[index] === '_' || text[index] === '~') {
      html += wrapToken(text[index], 'workspace-token-operator');
      index += 1;
      continue;
    }

    html += escapeHtml(text[index]);
    index += 1;
  }

  return html;
}

function highlightMarkdownLine(line: string): string {
  if (/^\s*(```|~~~)/.test(line)) {
    return wrapToken(line, 'workspace-token-keyword');
  }

  const headingMatch = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/);
  if (headingMatch) {
    return `${wrapToken(headingMatch[1], 'workspace-token-keyword')}${wrapToken(headingMatch[2], 'workspace-token-heading')}`;
  }

  const quoteMatch = line.match(/^(\s*>\s?)(.*)$/);
  if (quoteMatch) {
    return `${wrapToken(quoteMatch[1], 'workspace-token-operator')}${highlightMarkdownInline(quoteMatch[2])}`;
  }

  const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
  if (listMatch) {
    return `${wrapToken(listMatch[1], 'workspace-token-operator')}${highlightMarkdownInline(listMatch[2])}`;
  }

  return highlightMarkdownInline(line);
}

function highlightYamlLine(line: string): string {
  const commentIndex = line.indexOf('#');
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : '';
  const content = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  let html = '';

  const listPrefixMatch = content.match(/^(\s*-\s+)(.*)$/);
  const working = listPrefixMatch ? listPrefixMatch[2] : content;
  if (listPrefixMatch) {
    html += wrapToken(listPrefixMatch[1], 'workspace-token-operator');
  }

  const keyMatch = working.match(/^("?[\w.-]+"?)(\s*:\s*)(.*)$/);
  if (keyMatch) {
    html += wrapToken(keyMatch[1], 'workspace-token-property');
    html += wrapToken(keyMatch[2], 'workspace-token-punctuation');
    const valueTokens = highlightGenericLine(keyMatch[3], {}, {
      lineComments: [],
      blockComments: [],
      keywords: new Set(),
      constants: GENERIC_CONSTANTS,
    });
    html += valueTokens.html;
  } else {
    html += highlightGenericLine(working, {}, {
      lineComments: [],
      blockComments: [],
      keywords: new Set(),
      constants: GENERIC_CONSTANTS,
    }).html;
  }

  if (comment) {
    html += wrapToken(comment, 'workspace-token-comment');
  }

  return html;
}

export function highlightWorkspaceFileContent(content: string, lang: string): string {
  const mode = detectSyntaxMode(lang);
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const lineParts = lines.map(splitLinePrefix);
  const lineIndentColumns = lineParts.map(({ prefix }) => countIndentColumns(prefix));
  const previousContentIndentColumns = new Array<number | null>(lines.length).fill(null);
  const nextContentIndentColumns = new Array<number | null>(lines.length).fill(null);
  let state: HighlightState = {};

  let previousIndent: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    previousContentIndentColumns[index] = previousIndent;
    if (lines[index].trim().length > 0) {
      previousIndent = lineIndentColumns[index];
    }
  }

  let nextIndent: number | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextContentIndentColumns[index] = nextIndent;
    if (lines[index].trim().length > 0) {
      nextIndent = lineIndentColumns[index];
    }
  }

  return lines.map((line, index) => {
    const { prefix, rest } = lineParts[index];
    const inferredIndent = line.trim().length === 0 && prefix.length === 0
      ? (() => {
        const previous = previousContentIndentColumns[index];
        const next = nextContentIndentColumns[index];
        if (previous == null) return next ?? 0;
        if (next == null) return previous;
        return Math.min(previous, next);
      })()
      : 0;
    const indentHtml = renderLinePrefix(prefix ? expandIndentPrefix(prefix) : ' '.repeat(inferredIndent));
    let renderedLine = '';

    switch (mode) {
      case 'json':
        renderedLine = `${indentHtml}${highlightJsonLine(rest)}`;
        break;
      case 'markup': {
        const result = highlightMarkupLine(rest, state);
        renderedLine = `${indentHtml}${result.html}`;
        state = result.state;
        break;
      }
      case 'css': {
        const result = highlightCssLine(rest, state);
        renderedLine = `${indentHtml}${result.html}`;
        state = result.state;
        break;
      }
      case 'markdown':
        renderedLine = `${indentHtml}${highlightMarkdownLine(rest)}`;
        break;
      case 'yaml':
        renderedLine = `${indentHtml}${highlightYamlLine(rest)}`;
        break;
      default: {
        const result = highlightGenericLine(rest, state, GENERIC_CONFIGS[mode]);
        renderedLine = `${indentHtml}${result.html}`;
        state = result.state;
        break;
      }
    }

    return renderLineHtml(renderedLine);
  }).join('');
}
