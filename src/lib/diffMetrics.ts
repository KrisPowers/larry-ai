/**
 * diffMetrics.ts — computes line-level diff metrics between two versions of a file.
 *
 * Uses a simple LCS-based diff. Returns added/removed line counts.
 * These are displayed in CodeBlock headers and in the Codex-style change summary.
 */

export interface DiffMetrics {
  added: number;
  removed: number;
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed' | 'spacer';
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
  hiddenLineCount?: number;
}

interface ComputeLineDiffOptions {
  contextLines?: number;
}

/** Compare old content to new content and return +/- line counts. */
export function computeDiff(oldContent: string, newContent: string): DiffMetrics {
  return computeDiffInternal(oldContent, newContent).metrics;
}

export function computeLineDiff(
  oldContent: string,
  newContent: string,
  options: ComputeLineDiffOptions = {},
): DiffLine[] {
  const { lines } = computeDiffInternal(oldContent, newContent, options);
  return lines ?? [];
}

function computeDiffInternal(
  oldContent: string,
  newContent: string,
  options: ComputeLineDiffOptions = {},
): { metrics: DiffMetrics; lines?: DiffLine[] } {
  if (!oldContent && !newContent) {
    return {
      metrics: { added: 0, removed: 0 },
      lines: [],
    };
  }

  if (!oldContent) {
    // Brand new file — every line is an addition
    const normalizedNew = newContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalizedNew.split('\n');
    return {
      metrics: {
        added: lines.filter((line) => line.trim()).length,
        removed: 0,
      },
      lines: collapseContextLines(
        lines.map((line, index) => ({
          type: 'added' as const,
          oldNumber: null,
          newNumber: index + 1,
          content: line,
        })),
        options.contextLines ?? 3,
      ),
    };
  }

  const normalizedOld = oldContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normalizedNew = newContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const oldLines = normalizedOld.split('\n');
  const newLines = normalizedNew.split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  // For large files, fall back to a fast approximation to avoid O(m*n) memory
  if (m * n > 200_000) {
    return {
      metrics: fastApprox(oldLines, newLines),
      lines: collapseContextLines(
        [
          ...oldLines.map((line, index) => ({
            type: 'removed' as const,
            oldNumber: index + 1,
            newNumber: null,
            content: line,
          })),
          ...newLines.map((line, index) => ({
            type: 'added' as const,
            oldNumber: null,
            newNumber: index + 1,
            content: line,
          })),
        ],
        options.contextLines ?? 3,
      ),
    };
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[m][n];
  const lines: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lines.push({
        type: 'context',
        oldNumber: i,
        newNumber: j,
        content: newLines[j - 1],
      });
      i -= 1;
      j -= 1;
      continue;
    }

    if (dp[i - 1][j] >= dp[i][j - 1]) {
      lines.push({
        type: 'removed',
        oldNumber: i,
        newNumber: null,
        content: oldLines[i - 1],
      });
      i -= 1;
      continue;
    }

    lines.push({
      type: 'added',
      oldNumber: null,
      newNumber: j,
      content: newLines[j - 1],
    });
    j -= 1;
  }

  while (i > 0) {
    lines.push({
      type: 'removed',
      oldNumber: i,
      newNumber: null,
      content: oldLines[i - 1],
    });
    i -= 1;
  }

  while (j > 0) {
    lines.push({
      type: 'added',
      oldNumber: null,
      newNumber: j,
      content: newLines[j - 1],
    });
    j -= 1;
  }

  lines.reverse();

  return {
    metrics: {
      added: n - lcs,
      removed: m - lcs,
    },
    lines: collapseContextLines(lines, options.contextLines ?? 3),
  };
}

function fastApprox(oldLines: string[], newLines: string[]): DiffMetrics {
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!oldSet.has(l)) added++;
  for (const l of oldLines) if (!newSet.has(l)) removed++;
  return { added, removed };
}

function collapseContextLines(lines: DiffLine[], contextLines: number): DiffLine[] {
  if (contextLines < 0) return [...lines];

  const changedIndexes = lines
    .map((line, index) => (line.type === 'context' ? -1 : index))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) return lines;

  const keep = new Set<number>();
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - contextLines);
    const end = Math.min(lines.length - 1, changedIndex + contextLines);
    for (let index = start; index <= end; index += 1) {
      keep.add(index);
    }
  }

  const collapsed: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (keep.has(index)) {
      collapsed.push(lines[index]);
      index += 1;
      continue;
    }

    let hidden = 0;
    while (index < lines.length && !keep.has(index)) {
      hidden += 1;
      index += 1;
    }

    collapsed.push({
      type: 'spacer',
      oldNumber: null,
      newNumber: null,
      content: '',
      hiddenLineCount: hidden,
    });
  }

  return collapsed;
}

/** Format metrics as a compact "+N / -N" string. */
export function formatMetrics(m: DiffMetrics): string {
  if (m.added === 0 && m.removed === 0) return '';
  const parts: string[] = [];
  if (m.added > 0) parts.push(`+${m.added}`);
  if (m.removed > 0) parts.push(`−${m.removed}`);
  return parts.join(' / ');
}
