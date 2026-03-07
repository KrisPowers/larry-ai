// FILE: src/lib/deepPlanner.ts
/**
 * deepPlanner.ts — Two-phase orchestration engine for the Code preset.
 *
 * Phase 1 (planning): One non-streaming call. The model returns a JSON
 *   checklist — every file the project needs, with purpose/imports/exports
 *   described in detail. No code is written here.
 *
 * Phase 2 (execution): One streaming call per step. Each call is given a
 *   tight, code-first system prompt — the model's only job is to output
 *   the single file it has been assigned, immediately, with no preamble.
 *   The Code preset's prose rules (Rule 8) are intentionally excluded from
 *   step prompts; verbose explanation causes small models to fill their
 *   output budget with text and skip the code entirely.
 */

import { chatOnce } from './ollama';
import type { Message } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DeepStep {
  stepNumber: number;
  label: string;
  filePath: string;
  purpose: string;
  imports: string[];
  exports: string[];
  isSupport: boolean;
}

export interface DeepPlan {
  projectSummary: string;
  steps: DeepStep[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — planning prompt (JSON only, no code)
// ─────────────────────────────────────────────────────────────────────────────

const DEEP_PLANNER_SYSTEM = `You are a senior software architect. Your ONLY job is to
analyse a coding request and produce a thorough, atomic implementation checklist.

You must respond with ONLY valid JSON — no markdown fences, no explanation, nothing else.

Return this exact shape:
{
  "projectSummary": "A paragraph describing what will be built, the architecture, and key design decisions.",
  "steps": [
    {
      "stepNumber": 1,
      "filePath": "src/types/index.ts",
      "purpose": "Defines all shared TypeScript interfaces and types. Contains RequestHandler, Request, Response, NextFunction, RouteParams, Middleware, RouterOptions. Imported by every other source file, so it must be written first.",
      "imports": [],
      "exports": ["RequestHandler", "Request", "Response", "NextFunction", "RouteParams", "Middleware", "RouterOptions"],
      "isSupport": false
    }
  ]
}

Rules:
- Every file the project needs must be a step: source files AND support files.
- isSupport: true for package.json, tsconfig.json, .gitignore, README.md, .env.example.
- isSupport: false for all actual source code.
- Order: types → utilities → core logic → entry points → support files.
- "purpose": a full paragraph naming every important function/class/interface and why the file exists separately.
- "imports": files or npm packages that must exist before this step.
- "exports": every symbol other files will import from here.
- One file per step. Be exhaustive. Respond with JSON only.`;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — step execution system prompt
//
// This is intentionally separate from the Code preset system prompt.
// The Code preset's Rule 8 ("write 3-5 paragraphs before the first code
// block") causes small models to produce only prose and no code when given
// a focused single-file task. The step executor has ONE job: output the file.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_EXECUTOR_SYSTEM = `You are a senior software engineer implementing one file at a time.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 0 — FILE PATH DECLARATION (MANDATORY, NO EXCEPTIONS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The VERY FIRST LINE inside every code block MUST be the file path comment.
This is not optional. A code block without a file path comment is broken.

  JS / TS / CSS:   // FILE: src/lib/router.ts
  Python / Shell:  # FILE: src/server.py
  HTML / XML / MD: <!-- FILE: README.md -->
  JSON / YAML:     \`\`\`json package.json   ← path in the fence label

Example of a correct block:
\`\`\`typescript
// FILE: src/lib/router.ts
import { Request, Response } from './types';
...
\`\`\`

A block that starts with code instead of a FILE comment will cause the file
to be saved under a wrong name. Always write the FILE comment first.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 1 — CODE FIRST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your response must begin with the fenced code block. No preamble.
No explanation before the code. Write the FILE comment, then the code.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 2 — IMPLEMENTATION COMPLETENESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Write the complete file. No stubs. No placeholders. No "// TODO" comments.
- Every function has a real body that does what it says.
- Every import refers to something that actually exists.
- TypeScript: strict mode, no "any", explicit return types.
- Do not write any file other than the one you are assigned.

After the code block, you may write a brief explanation (2-4 sentences).`;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — per-step user message
//
// Rather than injecting context into the system prompt, we pass it as the
// user turn. This keeps the system prompt short and focused, and gives the
// model a clear, specific instruction to respond to.
// ─────────────────────────────────────────────────────────────────────────────

export function buildStepUserMessage(
  plan: DeepPlan,
  step: DeepStep,
  alreadyWritten: Array<{ path: string; exports: string[] }>,
): string {
  const total = plan.steps.length;

  const writtenBlock = alreadyWritten.length > 0
    ? `\nFiles already written (you may import from these):\n` +
      alreadyWritten.map(f =>
        `  ${f.path}${f.exports.length ? `  →  exports: ${f.exports.join(', ')}` : ''}`
      ).join('\n') + '\n'
    : '';

  const importsBlock = step.imports.length > 0
    ? `\nThis file imports from:\n${step.imports.map(i => `  - ${i}`).join('\n')}\n`
    : '';

  const exportsBlock = step.exports.length > 0
    ? `\nThis file must export:\n${step.exports.map(e => `  - ${e}`).join('\n')}\n`
    : '';

  const finalNote = step.stepNumber === total
    ? `\nThis is the FINAL step. After the code block, write a plain-text Overview (4-6 paragraphs) covering what was built, how the pieces connect, and how to run it.`
    : `\nThis is step ${step.stepNumber} of ${total}. Do NOT write an Overview yet.`;

  // Derive the correct FILE comment syntax from the file extension
  const ext = step.filePath.split('.').pop()?.toLowerCase() ?? '';
  const jsonYaml = ['json', 'yaml', 'yml'].includes(ext);
  const pyShell  = ['py', 'sh', 'bash', 'shell'].includes(ext);
  const htmlXml  = ['html', 'xml', 'md', 'svg'].includes(ext);
  const fileComment = jsonYaml
    ? `\`\`\`${ext} ${step.filePath}  ← put the path in the fence label`
    : pyShell
      ? `# FILE: ${step.filePath}`
      : htmlXml
        ? `<!-- FILE: ${step.filePath} -->`
        : `// FILE: ${step.filePath}`;

  return (
    `Project: ${plan.projectSummary}\n` +
    writtenBlock +
    `\nStep ${step.stepNumber} of ${total}: Write the file ${step.filePath}\n` +
    `\nREMINDER: The very first line inside your code block MUST be:\n  ${fileComment}\n` +
    `\nWhat this file must do:\n${step.purpose}\n` +
    importsBlock +
    exportsBlock +
    finalNote
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 1: returns the structured deep plan (JSON, non-streaming).
 */
export async function buildDeepPlan(
  userMessage: string,
  conversationHistory: Message[],
  model: string,
  signal: AbortSignal,
): Promise<DeepPlan> {
  const raw = await chatOnce(
    model,
    [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ],
    DEEP_PLANNER_SYSTEM,
    signal,
  );

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: { projectSummary?: string; steps?: Partial<DeepStep>[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      projectSummary: userMessage,
      steps: [{
        stepNumber: 1,
        label: 'implementation',
        filePath: 'src/index.ts',
        purpose: userMessage,
        imports: [],
        exports: [],
        isSupport: false,
      }],
    };
  }

  const steps: DeepStep[] = (parsed.steps ?? []).map((s, i) => ({
    stepNumber: s.stepNumber ?? i + 1,
    label:      s.filePath ?? `step-${i + 1}`,
    filePath:   s.filePath ?? `src/step-${i + 1}.ts`,
    purpose:    s.purpose ?? '',
    imports:    s.imports ?? [],
    exports:    s.exports ?? [],
    isSupport:  s.isSupport ?? false,
  }));

  return {
    projectSummary: parsed.projectSummary ?? userMessage,
    steps,
  };
}

/**
 * Returns the system prompt to use for a step execution request.
 * This is the lean STEP_EXECUTOR_SYSTEM — NOT the Code preset prompt.
 */
export function getStepExecutorSystem(): string {
  return STEP_EXECUTOR_SYSTEM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — summary follow-up
//
// Sent automatically after all steps are complete. The model is given the full
// list of files it produced and asked to write a human-readable summary + guide.
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You are a senior software engineer who has just finished implementing a project. 
Your job is to write a clear, helpful summary for the developer who requested the work.

Write in plain prose — no code blocks. Structure your response as:
1. A concise overview of what was built and how it is architected (2-3 paragraphs).
2. A step-by-step install and run guide (numbered list, plain text commands in backtick inline code).
3. Any important notes, caveats, or next steps (1-2 paragraphs).

Be specific — reference actual file names and commands from the project.`;

/**
 * Builds the user message for the automatic post-completion summary request.
 * Includes the full list of files written so the model can reference them.
 */
export function buildSummaryUserMessage(
  originalRequest: string,
  projectSummary: string,
  filesWritten: Array<{ path: string; purpose?: string }>,
): string {
  const fileList = filesWritten
    .map(f => `  - ${f.path}${f.purpose ? `  (${f.purpose})` : ''}`)
    .join('\n');

  return (
    `Original request: ${originalRequest}\n\n` +
    `Project summary: ${projectSummary}\n\n` +
    `Files written:\n${fileList}\n\n` +
    `Please write the project overview and install/run guide now.`
  );
}

/**
 * Returns the system prompt to use for the summary follow-up request.
 */
export function getSummarySystem(): string {
  return SUMMARY_SYSTEM;
}
