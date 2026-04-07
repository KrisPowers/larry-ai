// FILE: src/lib/deepPlanner.ts
/**
 * deepPlanner.ts — Multi-mode orchestration engine for the Code preset.
 *
 * Phase 0 (classification): A fast, non-streaming call classifies the request
 *   into one of several modes. This determines whether we run the full
 *   multi-step planner or a lighter targeted response.
 *
 * Phase 1 (planning): One non-streaming call. The model returns a JSON
 *   checklist appropriate for the request mode. For full project builds this
 *   is every file needed. For debug/feature work it is only affected files.
 *
 * Phase 2 (execution): One streaming call per step (unchanged).
 *
 * Phase 3 (summary): Automatic prose summary after all steps (unchanged).
 *
 * Additionally, before Phase 1, any npm/pip/etc. package names detected in
 * the user request or plan are resolved to their latest versions via the
 * respective registry APIs, so the model always uses current versions.
 */

import { chatOnce } from './ollama';
import { fetchUrl } from './fetcher';
import type { Message } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RequestMode =
  | 'complete_project'    // Build a new project from scratch
  | 'feature_build'       // Add a new feature/component to an existing project
  | 'feature_integration' // Integrate/connect two existing systems or libraries
  | 'debug'               // Fix a bug, error, or unexpected behaviour
  | 'refactor'            // Restructure/improve existing code without changing behaviour
  | 'explain'             // Explain how existing code works (minimal file output)
  | 'edit_file'           // Targeted edits to specific files (user gave code to modify)
  | 'docs_only'           // Add/improve documentation files only (README, guides, comments)
  | 'add_files';          // Add specific new files to an existing project (config, scripts, etc.)

export interface ClassificationResult {
  mode: RequestMode;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  /** Package names the model/user mentioned that we should version-resolve */
  mentionedPackages: Array<{ name: string; ecosystem: 'npm' | 'pip' | 'cargo' | 'gem' | 'go' | 'composer' }>;
}

export interface PackageVersion {
  name: string;
  ecosystem: string;
  version: string;
  description?: string;
}

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
  mode: RequestMode;
  steps: DeepStep[];
  classification?: ClassificationResult;
  /** Resolved latest versions of packages mentioned in the request/plan */
  resolvedPackages?: PackageVersion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 — Request classifier
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a senior software architect. Your ONLY job is to classify a coding request.

You must respond with ONLY valid JSON — no markdown fences, no explanation, nothing else.

Return this exact shape:
{
  "mode": "<one of the modes below>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "One sentence explaining why you chose this mode.",
  "mentionedPackages": [
    { "name": "express", "ecosystem": "npm" }
  ]
}

CONTEXT AWARENESS — CRITICAL:
If the conversation history shows a project was already built or files already exist,
the user is ALWAYS making a follow-up request. In that case, NEVER choose "complete_project".
"complete_project" is ONLY for the very first message in a fresh conversation with no prior code.

MODES — pick exactly one:
  "complete_project"    — User wants a brand-new project from scratch. ONLY valid if no project exists yet in conversation history. Signals: "build me", "create a new app", "make me a", "write a program from scratch".
  "feature_build"       — Add a new feature, component, page, or endpoint to an EXISTING project. Signals: "add a", "create a new page", "add an endpoint", "build a feature", "implement X into my project".
  "feature_integration" — Connect/integrate two existing systems. Signals: "integrate", "connect", "wire up", "add X support to Y".
  "debug"               — Fix a bug, error, crash. Signals: error messages, stack traces, "it crashes", "broken", "not working", "fix this".
  "refactor"            — Restructure existing code without changing behaviour. Signals: "refactor", "clean up", "reorganise", "extract".
  "explain"             — Explain how existing code works. Signals: "explain", "how does this work", "walk me through".
  "edit_file"           — Targeted edits to specific files. Signals: pasted code + "change X", "update", "modify", "rename".
  "docs_only"           — Add or improve documentation files ONLY. No source code changes. Signals: "add a readme", "write a readme", "add install guide", "add contributing guide", "add changelog", "add license", "write docs", "document this", "add comments". Use this when the request is PURELY about documentation.
  "add_files"           — Add specific non-feature files to an existing project: config files, scripts, CI/CD, docker, env files. Signals: "add a dockerfile", "add github actions", "add eslint config", "add a makefile", "add .env".

mentionedPackages: list every package name mentioned. If none, return [].
Ecosystems: "npm" for JS/TS, "pip" for Python, "cargo" for Rust, "gem" for Ruby, "go" for Go, "composer" for PHP.`;

/**
 * Extract a compact summary of prior user requests from conversation history.
 * We deliberately AVOID sending raw code output to the classifier — it's noisy
 * and buries the signal. Instead we send only what the user asked for.
 */
function summariseHistoryForClassifier(history: Message[]): string {
  const userMessages = history
    .filter(m => m.role === 'user')
    .slice(-5) // last 5 user turns
    .map((m, i) => `Prior request ${i + 1}: ${m.content.slice(0, 200)}`);

  // Also note if prior assistant messages contained file paths (signals a project exists)
  const assistantHadCode = history
    .filter(m => m.role === 'assistant')
    .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));

  const projectExists = assistantHadCode
    ? '\nIMPORTANT: The assistant has already written code/files in this conversation. A project EXISTS. Do NOT classify as complete_project.'
    : '';

  return userMessages.join('\n') + projectExists;
}

/**
 * Fast regex pre-classifier — catches obvious cases without burning an LLM call.
 * Returns a mode if confident, null if uncertain (falls through to LLM classifier).
 */
function preClassify(userMessage: string, history: Message[]): RequestMode | null {
  const msg = userMessage.toLowerCase().trim();

  // If prior assistant messages contained file code, this is NEVER complete_project
  const assistantHadCode = history
    .filter(m => m.role === 'assistant')
    .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));

  // Docs-only signals — very reliable
  const docsSignals = /\b(add|write|create|generate|include|make)\b.{0,40}\b(readme|read me|install guide|installation guide|contributing|changelog|change log|license|documentation|docs|api docs|jsdoc|tsdoc|comments)\b/i;
  const docsSignals2 = /\b(readme|install guide|installation guide|contributing\.md|changelog\.md)\b/i;
  if (docsSignals.test(msg) || (assistantHadCode && docsSignals2.test(msg))) {
    return 'docs_only';
  }

  // Add config/infra files
  const addFilesSignals = /\b(add|create|write)\b.{0,40}\b(dockerfile|docker-compose|\.github|github actions|ci\/cd|eslint|prettier|makefile|\.env\.example|husky|lint-staged)\b/i;
  if (addFilesSignals.test(msg)) {
    return 'add_files';
  }

  // Debug signals — error messages or explicit fix requests
  const debugSignals = /error:|exception:|cannot find|is not defined|is not a function|undefined is not|null is not|typeerror|syntaxerror|referenceerror|uncaught|stack trace|it('s| is) (broken|not working|crashing|failing)|fix (this|the|my)|why (is|does|am i getting)/i;
  if (debugSignals.test(msg)) return 'debug';

  // If code exists in history and request looks like adding something, feature_build
  if (assistantHadCode) {
    const addFeatureSignals = /^(please )?(add|implement|build|create|include)\b/i;
    if (addFeatureSignals.test(msg)) return 'feature_build';

    // Generic requests in context of existing project — likely feature/edit, not new project
    // Default to feature_build rather than complete_project when project exists
    const newProjectSignals = /\b(from scratch|brand new|new project|new app|new program|start fresh|start over)\b/i;
    if (!newProjectSignals.test(msg)) {
      // Lean toward feature_build when project exists but we're not sure
      // Let LLM decide, but this signals to not use complete_project
      return null; // fall through but CLASSIFIER_SYSTEM will prevent complete_project
    }
  }

  return null; // uncertain — let LLM decide
}

export async function classifyRequest(
  userMessage: string,
  conversationHistory: Message[],
  model: string,
  signal: AbortSignal,
): Promise<ClassificationResult> {

  // Try fast regex pre-classifier first
  const preResult = preClassify(userMessage, conversationHistory);
  if (preResult) {
    // Extract mentioned packages from message text via simple heuristic
    const pkgMatches = userMessage.match(/\b(express|react|vue|svelte|next|nuxt|fastify|koa|axios|lodash|typescript|vite|webpack|rollup|esbuild|tailwind|prisma|drizzle|mongoose|sequelize|jest|vitest|playwright|cypress)\b/gi) ?? [];
    return {
      mode: preResult,
      confidence: 'high',
      reasoning: `Pre-classified as ${preResult} by pattern matching.`,
      mentionedPackages: [...new Set(pkgMatches)].map(name => ({ name: name.toLowerCase(), ecosystem: 'npm' as const })),
    };
  }

  // Build compact history summary — don't send raw code to the classifier
  const historySummary = summariseHistoryForClassifier(conversationHistory);

  try {
    const raw = await chatOnce(
      model,
      [
        { role: 'user', content: historySummary ? `Conversation context:\n${historySummary}\n\nNew request to classify: ${userMessage}` : userMessage },
      ],
      CLASSIFIER_SYSTEM,
      signal,
    );

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Partial<ClassificationResult>;

    // Safety: if project exists in history, never allow complete_project
    const assistantHadCode = conversationHistory
      .filter(m => m.role === 'assistant')
      .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));

    let mode = (parsed.mode as RequestMode) ?? 'feature_build';
    if (assistantHadCode && mode === 'complete_project') {
      mode = 'feature_build'; // hard override — never regenerate a whole project
    }

    return {
      mode,
      confidence: parsed.confidence ?? 'low',
      reasoning: parsed.reasoning ?? '',
      mentionedPackages: parsed.mentionedPackages ?? [],
    };
  } catch {
    const assistantHadCode = conversationHistory
      .filter(m => m.role === 'assistant')
      .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));
    return {
      mode: assistantHadCode ? 'feature_build' : 'complete_project',
      confidence: 'low',
      reasoning: 'Classification failed; using safe fallback.',
      mentionedPackages: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Package version resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the latest version of an npm package from the registry. */
async function resolveNpm(name: string): Promise<PackageVersion | null> {
  try {
    const ctx = await fetchUrl(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (ctx.error || !ctx.text) return null;
    // The text is JSON — parse it
    const data = JSON.parse(ctx.text) as Record<string, unknown>;
    const version = (data.version as string) ?? (data['dist-tags'] as Record<string, string>)?.latest;
    const description = data.description as string | undefined;
    if (!version) return null;
    return { name, ecosystem: 'npm', version, description };
  } catch {
    return null;
  }
}

/** Fetch the latest version of a pip package from PyPI. */
async function resolvePip(name: string): Promise<PackageVersion | null> {
  try {
    const ctx = await fetchUrl(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (ctx.error || !ctx.text) return null;
    const data = JSON.parse(ctx.text) as Record<string, unknown>;
    const info = data.info as Record<string, unknown> | undefined;
    const version = info?.version as string | undefined;
    const description = info?.summary as string | undefined;
    if (!version) return null;
    return { name, ecosystem: 'pip', version, description };
  } catch {
    return null;
  }
}

/** Fetch the latest version of a Cargo crate from crates.io. */
async function resolveCargo(name: string): Promise<PackageVersion | null> {
  try {
    const ctx = await fetchUrl(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
    if (ctx.error || !ctx.text) return null;
    const data = JSON.parse(ctx.text) as Record<string, unknown>;
    const crate = data.crate as Record<string, unknown> | undefined;
    const version = crate?.newest_version as string | undefined;
    const description = crate?.description as string | undefined;
    if (!version) return null;
    return { name, ecosystem: 'cargo', version, description };
  } catch {
    return null;
  }
}

/** Fetch the latest version of a RubyGem. */
async function resolveGem(name: string): Promise<PackageVersion | null> {
  try {
    const ctx = await fetchUrl(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`);
    if (ctx.error || !ctx.text) return null;
    const data = JSON.parse(ctx.text) as Record<string, unknown>;
    const version = data.version as string | undefined;
    const description = data.info as string | undefined;
    if (!version) return null;
    return { name, ecosystem: 'gem', version, description };
  } catch {
    return null;
  }
}

/** Fetch the latest version of a Composer/Packagist package. */
async function resolveComposer(name: string): Promise<PackageVersion | null> {
  try {
    const ctx = await fetchUrl(`https://packagist.org/packages/${encodeURIComponent(name)}.json`);
    if (ctx.error || !ctx.text) return null;
    const data = JSON.parse(ctx.text) as Record<string, unknown>;
    const pkg = data.package as Record<string, unknown> | undefined;
    const versions = pkg?.versions as Record<string, Record<string, unknown>> | undefined;
    if (!versions) return null;
    // Get the first (latest) non-dev version
    const latest = Object.keys(versions).find(v => !v.includes('dev') && v !== 'dev-master');
    if (!latest) return null;
    const description = pkg?.description as string | undefined;
    return { name, ecosystem: 'composer', version: latest.replace(/^v/, ''), description };
  } catch {
    return null;
  }
}

/**
 * Resolve a list of package references to their latest versions.
 * Runs all fetches in parallel; failures are silently skipped.
 */
export async function resolvePackageVersions(
  packages: ClassificationResult['mentionedPackages'],
): Promise<PackageVersion[]> {
  if (!packages.length) return [];

  const results = await Promise.allSettled(
    packages.map(p => {
      switch (p.ecosystem) {
        case 'npm':      return resolveNpm(p.name);
        case 'pip':      return resolvePip(p.name);
        case 'cargo':    return resolveCargo(p.name);
        case 'gem':      return resolveGem(p.name);
        case 'composer': return resolveComposer(p.name);
        default:         return Promise.resolve(null);
      }
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<PackageVersion | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is PackageVersion => v !== null);
}

/**
 * Format resolved package versions into a system-prompt injection block.
 */
export function packageVersionsToSystemInject(packages: PackageVersion[]): string {
  if (!packages.length) return '';
  const lines = packages.map(p => {
    const desc = p.description ? ` — ${p.description.slice(0, 80)}` : '';
    return `  ${p.name} (${p.ecosystem}): latest = ${p.version}${desc}`;
  });
  return (
    `\n\n---\n## Live Package Versions (fetched from registries)\n` +
    `Use ONLY these versions in package.json / requirements.txt / Cargo.toml etc.\n` +
    `Do NOT use older versions from your training data.\n\n` +
    lines.join('\n') +
    `\n---\n`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Planning prompts (mode-specific)
// ─────────────────────────────────────────────────────────────────────────────

/** Base planner instruction — appended to all mode-specific prompts. */
const PLANNER_BASE = `
You must respond with ONLY valid JSON — no markdown fences, no explanation, nothing else.

Return this exact shape:
{
  "projectSummary": "A paragraph describing what will be built/changed, the approach, and key decisions.",
  "steps": [
    {
      "stepNumber": 1,
      "filePath": "src/types/index.ts",
      "purpose": "Full description of what this file does and why it exists.",
      "imports": [],
      "exports": ["MyType"],
      "isSupport": false
    }
  ]
}

Rules:
- isSupport: true for package.json, tsconfig.json, .gitignore, README.md, .env.example.
- isSupport: false for all actual source code.
- "purpose": name every important function/class/interface in this file.
- "imports": files or packages that must exist before this step.
- "exports": every symbol other files will import.
- One file per step. Respond with JSON only.`;

const PLANNER_COMPLETE_PROJECT = `You are a senior software architect. Your ONLY job is to produce a complete file checklist for building a new project from scratch.

Include EVERY file the project needs: source files AND support files (package.json, README, etc.).
Order: types → utilities → core logic → entry points → support files.
Be exhaustive.` + PLANNER_BASE;

const PLANNER_FEATURE_BUILD = `You are a senior software architect. Your ONLY job is to plan the addition of a new feature to an existing project.

The user has an existing codebase. You are ONLY adding or creating new files for the new feature.
Do NOT re-list files that already exist unless they need to be modified.
If an existing file must be changed, include it with a purpose that says "MODIFY: [what changes]".
Keep the step list focused — only files directly involved in the new feature.` + PLANNER_BASE;

const PLANNER_FEATURE_INTEGRATION = `You are a senior software architect. Your ONLY job is to plan the integration of a library, service, or system into an existing project.

Focus ONLY on files that need to be created or changed to wire in the integration.
If an existing file must be changed, include it with a purpose that says "MODIFY: [what changes]".
Include any new config files, adapter files, or wiring code needed.` + PLANNER_BASE;

const PLANNER_DEBUG = `You are a senior software engineer. Your ONLY job is to plan the fix for a bug or error.

Analyse the error or problem described. Identify the minimal set of files that need to change.
Do NOT rewrite unrelated files. Do NOT add features.
If only one file needs changing, list only that file.
Purpose field must begin with "FIX: " and describe exactly what is wrong and what the fix is.` + PLANNER_BASE;

const PLANNER_REFACTOR = `You are a senior software architect. Your ONLY job is to plan a refactor of existing code.

List only the files that will change. For each file, the purpose must explain:
1. What is currently wrong or messy about it.
2. What the refactored version will look like.
If splitting a file, list each resulting file as a separate step.` + PLANNER_BASE;

const PLANNER_EDIT_FILE = `You are a senior software engineer. Your ONLY job is to plan targeted edits to specific files.

The user has given you code to modify. List only the files that need to change.
Purpose must begin with "EDIT: " and describe the exact changes needed.
Keep the step list minimal — often just 1-2 files.` + PLANNER_BASE;

const PLANNER_DOCS_ONLY = `You are a technical writer and senior software engineer. Your ONLY job is to plan documentation files.

The user wants documentation added to an existing project. List ONLY documentation files:
README.md, INSTALL.md, CONTRIBUTING.md, CHANGELOG.md, LICENSE, docs/*.md, etc.
Do NOT list any source code files. Do NOT list package.json or tsconfig.json.
Purpose field must describe exactly what the doc covers: overview, install steps, usage, API reference, etc.
isSupport: true for all documentation files.` + PLANNER_BASE;

const PLANNER_ADD_FILES = `You are a senior software engineer. Your ONLY job is to plan the addition of specific configuration or tooling files.

The user wants new config/tooling/infra files added to an existing project.
List ONLY the files being added. Do NOT regenerate existing source files.
Purpose must describe exactly what this file configures or enables.` + PLANNER_BASE;

const PLANNER_BY_MODE: Record<RequestMode, string> = {
  complete_project:    PLANNER_COMPLETE_PROJECT,
  feature_build:       PLANNER_FEATURE_BUILD,
  feature_integration: PLANNER_FEATURE_INTEGRATION,
  debug:               PLANNER_DEBUG,
  refactor:            PLANNER_REFACTOR,
  explain:             PLANNER_EDIT_FILE,
  edit_file:           PLANNER_EDIT_FILE,
  docs_only:           PLANNER_DOCS_ONLY,
  add_files:           PLANNER_ADD_FILES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Step execution system prompt
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
- When fixing a bug (FIX: steps): change ONLY what is broken. Do not refactor unrelated code.
- When editing a file (EDIT: steps): apply ONLY the requested changes. Preserve everything else.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 3 — PACKAGE VERSIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If a "Live Package Versions" section appears in your context, you MUST use
those exact version strings in package.json, requirements.txt, Cargo.toml,
Gemfile, go.mod, or composer.json. Do NOT use versions from your training data.

After the code block, you may write a brief explanation (2-4 sentences).`;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — per-step user message
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

  // Mode-specific instruction prefix
  const modeHint =
    plan.mode === 'debug'               ? `\nTASK TYPE: DEBUG — fix ONLY what is described. Do not change unrelated code.\n` :
    plan.mode === 'refactor'            ? `\nTASK TYPE: REFACTOR — restructure without changing behaviour. No new features.\n` :
    plan.mode === 'feature_build'       ? `\nTASK TYPE: FEATURE BUILD — implement the new feature. Integrate cleanly with existing code.\n` :
    plan.mode === 'feature_integration' ? `\nTASK TYPE: INTEGRATION — wire the new dependency/service into the existing system.\n` :
    plan.mode === 'edit_file'           ? `\nTASK TYPE: EDIT — apply only the requested changes. Preserve everything else.\n` :
    plan.mode === 'docs_only'           ? `\nTASK TYPE: DOCUMENTATION — write documentation files only. No source code changes whatsoever.\n` :
    plan.mode === 'add_files'           ? `\nTASK TYPE: ADD FILES — write only the specific files requested. Do not touch existing source code.\n` :
    '';

  const finalNote = step.stepNumber === total
    ? `\nThis is the FINAL step. After the code block, write a plain-text summary (3-5 paragraphs) covering what was changed, how the pieces connect, and how to run/test it.`
    : `\nThis is step ${step.stepNumber} of ${total}. Do NOT write a summary yet.`;

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
    modeHint +
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
 * Phase 1 only: build the file plan after request classification.
 */
export async function planRequest(
  userMessage: string,
  conversationHistory: Message[],
  classification: ClassificationResult,
  model: string,
  signal: AbortSignal,
): Promise<{ projectSummary: string; steps: DeepStep[] }> {
  const plannerSystem = PLANNER_BY_MODE[classification.mode] ?? PLANNER_COMPLETE_PROJECT;

  const raw = await chatOnce(
    model,
    [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ],
    plannerSystem,
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
 * Full Phase 0+1: classify the request, resolve package versions, then plan.
 * Returns a DeepPlan with mode + resolvedPackages attached.
 */
export async function buildDeepPlan(
  userMessage: string,
  conversationHistory: Message[],
  model: string,
  signal: AbortSignal,
): Promise<DeepPlan> {

  // Phase 0: classify
  const classification = await classifyRequest(userMessage, conversationHistory, model, signal);

  // Resolve package versions in parallel while we could be planning
  // (fire-and-forget — we await both before building the step executor prompt)
  const packagesPromise = resolvePackageVersions(classification.mentionedPackages);

  // Phase 1: plan
  const planningResult = await planRequest(
    userMessage,
    conversationHistory,
    classification,
    model,
    signal,
  );

  const resolvedPackages = await packagesPromise;

  return {
    projectSummary: planningResult.projectSummary,
    mode: classification.mode,
    classification,
    resolvedPackages,
    steps: planningResult.steps,
  };
}

export function getStepExecutorSystem(): string {
  return STEP_EXECUTOR_SYSTEM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — summary
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You are a senior software engineer who has just finished a coding task.
Write a clear, helpful summary for the developer.

Write in plain prose — no code blocks. Adapt the structure to the type of work done:
- For a new project: overview of what was built, architecture, install/run guide.
- For a feature or integration: what was added, how it connects to the existing code, how to test it.
- For a debug fix: what the bug was, what caused it, what was changed to fix it, how to verify.
- For a refactor: what changed structurally, what stayed the same, any behaviour differences to watch for.
- For an edit: summary of the changes made and why.

Be specific — reference actual file names and commands. 3-5 paragraphs.`;

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
    `What was done: ${projectSummary}\n\n` +
    `Files created or modified:\n${fileList}\n\n` +
    `Please write the summary now.`
  );
}

export function getSummarySystem(): string {
  return SUMMARY_SYSTEM;
}
