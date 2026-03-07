// FILE: src/lib/planner.ts
import { chatOnce } from './ollama';
import type { Message } from '../types';

/** A single file the AI plans to produce. */
export interface PlannedFile {
  path: string;
  description: string;
  isSupport: boolean;
}

/** A named work step — one directory's worth of files, or support files. */
export interface PlanStep {
  /** Human-readable label shown in the UI, e.g. "src/lib (3 files)" */
  label: string;
  /** Step number shown in the indicator, 1-based */
  stepNumber: number;
  files: PlannedFile[];
}

/** The full plan returned from the planning phase. */
export interface ProjectPlan {
  summary: string;
  files: PlannedFile[];
  steps: PlanStep[];
  isComplex: boolean;
}

/**
 * Max files per step when a single directory has many files.
 * Keeps each LLM request focused and within a comfortable output budget.
 */
const MAX_FILES_PER_STEP = 4;

const PLANNER_SYSTEM = `You are a project planning assistant. Your only job is to
analyse a coding request and return a JSON plan. You must respond with ONLY
valid JSON — no markdown fences, no explanation, nothing else.

Return this exact shape:
{
  "summary": "one or two sentences describing what the project is",
  "files": [
    {
      "path": "src/lib/router.ts",
      "description": "Implements the core routing engine",
      "isSupport": false
    }
  ]
}

Rules:
- List every file the project needs: source files AND support files
  (package.json, tsconfig.json, .gitignore, README.md).
- Mark isSupport: true for package.json, tsconfig.json, .gitignore, README.md
  and any other config/tooling file that is not application source code.
- Mark isSupport: false for all actual source code files.
- Use full relative paths from the project root.
- Order source files by dependency: types first, utilities next, core logic,
  then entry points last. Support files always at the end.
- Be complete. Do not omit files. A missing file = a broken project.
- Respond with JSON only. No other text.`;

/**
 * Returns the top-level directory of a path, or "__root__" for root-level files.
 * e.g. "src/lib/router.ts" → "src/lib"
 *      "src/index.ts"      → "src"
 *      "package.json"      → "__root__"
 */
function dirKey(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '__root__';
  // Group by first two segments for deeper structures, first segment otherwise
  return parts.length >= 3 ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Groups files into ordered steps:
 *   1. One step per source directory (alphabetical), capped at MAX_FILES_PER_STEP
 *   2. Final step: all support files (package.json, tsconfig, .gitignore, README)
 *
 * This mirrors how a human engineer would build a project — directory by
 * directory — giving the model a narrow, focused context for each request.
 */
function buildSteps(files: PlannedFile[]): PlanStep[] {
  const sourceFiles = files.filter(f => !f.isSupport);
  const supportFiles = files.filter(f => f.isSupport);

  // Group source files by directory
  const byDir = new Map<string, PlannedFile[]>();
  for (const f of sourceFiles) {
    const key = dirKey(f.path);
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(f);
  }

  const steps: PlanStep[] = [];

  // Sorted directories → one or more steps per dir
  const sortedDirs = [...byDir.keys()].sort((a, b) => {
    // __root__ goes last among source dirs, just before support
    if (a === '__root__') return 1;
    if (b === '__root__') return -1;
    return a.localeCompare(b);
  });

  for (const dir of sortedDirs) {
    const dirFiles = byDir.get(dir)!;
    // Split oversized directories into sub-steps
    for (let i = 0; i < dirFiles.length; i += MAX_FILES_PER_STEP) {
      const batch = dirFiles.slice(i, i + MAX_FILES_PER_STEP);
      const dirLabel = dir === '__root__' ? 'root' : dir;
      const partSuffix = dirFiles.length > MAX_FILES_PER_STEP
        ? ` (part ${Math.floor(i / MAX_FILES_PER_STEP) + 1})`
        : '';
      steps.push({
        label: `${dirLabel}${partSuffix}`,
        stepNumber: steps.length + 1,
        files: batch,
      });
    }
  }

  // Support files always come last as a dedicated step
  if (supportFiles.length > 0) {
    steps.push({
      label: 'support files',
      stepNumber: steps.length + 1,
      files: supportFiles,
    });
  }

  return steps;
}

/**
 * Calls the model with the planning prompt and returns a structured ProjectPlan.
 */
export async function buildPlan(
  userMessage: string,
  conversationHistory: Message[],
  model: string,
  signal: AbortSignal,
): Promise<ProjectPlan> {
  const raw = await chatOnce(
    model,
    [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ],
    PLANNER_SYSTEM,
    signal,
  );

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: { summary: string; files: PlannedFile[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      summary: userMessage,
      files: [],
      steps: [{ label: 'writing', stepNumber: 1, files: [] }],
      isComplex: false,
    };
  }

  const files: PlannedFile[] = (parsed.files ?? []).map(f => ({
    path: f.path ?? 'unknown',
    description: f.description ?? '',
    isSupport: f.isSupport ?? false,
  }));

  const steps = buildSteps(files);

  return {
    summary: parsed.summary ?? '',
    files,
    steps,
    isComplex: steps.length > 1,
  };
}

/**
 * Builds the injected task block for a single implementation step.
 * Tells the model exactly which files to write, what has already been
 * written, and whether this is the final step.
 */
export function buildStepPrompt(
  baseSystemPrompt: string,
  plan: ProjectPlan,
  stepIndex: number,
  alreadyWritten: string[],
): string {
  const step = plan.steps[stepIndex];
  const isLast = stepIndex === plan.steps.length - 1;
  const total = plan.steps.length;

  const fileList = step.files
    .map(f => `  - ${f.path}  →  ${f.description}`)
    .join('\n');

  const writtenList = alreadyWritten.length > 0
    ? `\nAlready written in previous steps (do NOT re-output these):\n${alreadyWritten.map(p => `  - ${p}`).join('\n')}\n`
    : '';

  const stepNote = total > 1
    ? `\nYou are on step ${step.stepNumber} of ${total}: ${step.label}\n` +
      `Project: ${plan.summary}\n` +
      writtenList
    : '';

  return (
    baseSystemPrompt +
    `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `YOUR TASK FOR THIS STEP\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    stepNote +
    `\nWrite ONLY these files (${step.files.length} file${step.files.length !== 1 ? 's' : ''}):\n` +
    fileList +
    `\n\nDo not write any other files. Do not re-write files from earlier steps.` +
    (isLast
      ? `\nThis is the FINAL step — after all files, write the plain-text Overview section.`
      : `\nThis is NOT the final step — do NOT write an Overview or summary yet.`)
  );
}
