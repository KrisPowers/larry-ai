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

/** Compare old content to new content and return +/- line counts. */
export function computeDiff(oldContent: string, newContent: string): DiffMetrics {
  if (!oldContent) {
    // Brand new file — every line is an addition
    return { added: newContent.split('\n').filter(l => l.trim()).length, removed: 0 };
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  // For large files, fall back to a fast approximation to avoid O(m*n) memory
  if (m * n > 200_000) {
    return fastApprox(oldLines, newLines);
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
  return {
    added: n - lcs,
    removed: m - lcs,
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

/** Format metrics as a compact "+N / -N" string. */
export function formatMetrics(m: DiffMetrics): string {
  if (m.added === 0 && m.removed === 0) return '';
  const parts: string[] = [];
  if (m.added > 0) parts.push(`+${m.added}`);
  if (m.removed > 0) parts.push(`−${m.removed}`);
  return parts.join(' / ');
}
