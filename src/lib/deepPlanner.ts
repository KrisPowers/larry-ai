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
 * Phase 3 (summary): Automatic prose summary after validation and repair complete.
 *
 * Additionally, before Phase 1, any npm/pip/etc. package names detected in
 * the user request or plan are resolved to their latest versions via the
 * respective registry APIs, so the model always uses current versions.
 */

import { chatOnce } from './ollama';
import { fetchJsonDirect, fetchUrl } from './fetcher';
import { appendSharedResponseStylePrompt } from './responseStyle';
import type { Message } from '../types';

const PLANNER_TIMEOUT_MS = 40_000;
const PLANNER_RETRY_TIMEOUT_MS = 15_000;
const PLANNER_HISTORY_USER_LIMIT = 4;
const PLANNER_HISTORY_ASSISTANT_LIMIT = 2;
const PLANNER_HISTORY_ITEM_MAX_CHARS = 320;
const PLANNER_PROMPT_MAX_CHARS = 12_000;
const PLANNER_PROMPT_RETRY_MAX_CHARS = 6_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RequestMode =
  | 'complete_project'    // Build a new project from scratch
  | 'feature_build'       // Add a new feature/component to an existing project
  | 'feature_integration' // Integrate/connect two existing systems or libraries
  | 'debug'               // Fix a bug, error, or unexpected behaviour
  | 'refactor'            // Restructure/improve existing code without changing behaviour
  | 'code_snippet'        // Return a focused example/snippet without project-wide file planning
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

function normalizePlannerText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function clampPlannerSnippet(value: string, maxChars = PLANNER_HISTORY_ITEM_MAX_CHARS): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function stripPlannerCodeNoise(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/(?:\/\/|#|<!--)\s*FILE:[^\n]+/gi, ' ')
    .replace(/\bFILE:\s*[^\n]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPlannerPrompt(value: string, maxChars: number): string {
  const compact = value.trim();
  if (compact.length <= maxChars) return compact;

  const headBudget = Math.max(1_500, Math.floor(maxChars * 0.62));
  const tailBudget = Math.max(700, maxChars - headBudget - 48);
  const head = compact.slice(0, headBudget).trimEnd();
  const tail = compact.slice(-tailBudget).trimStart();

  return `${head}\n\n[planner context compacted for speed]\n\n${tail}`;
}

function createTimedChildSignal(parentSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;

  const forwardAbort = () => {
    controller.abort();
  };

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutHandle = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      globalThis.clearTimeout(timeoutHandle);
      parentSignal.removeEventListener('abort', forwardAbort);
    },
  };
}

function buildPlanningConversationSummary(history: Message[]): string {
  if (!history.length) return '';

  const userLines = history
    .filter((message) => message.role === 'user')
    .slice(-PLANNER_HISTORY_USER_LIMIT)
    .map((message, index) => `Prior user request ${index + 1}: ${clampPlannerSnippet(stripPlannerCodeNoise(message.content))}`);

  const assistantLines = history
    .filter((message) => message.role === 'assistant')
    .map((message) => stripPlannerCodeNoise(message.content))
    .filter(Boolean)
    .slice(-PLANNER_HISTORY_ASSISTANT_LIMIT)
    .map((content, index) => `Prior assistant outcome ${index + 1}: ${clampPlannerSnippet(content)}`);

  const summaryLines = [...userLines, ...assistantLines];
  if (!summaryLines.length) return '';
  return summaryLines.join('\n');
}

function isWebsiteBuildPrompt(userMessage: string): boolean {
  const normalized = normalizePlannerText(userMessage);
  return /\b(website|web app|landing page|homepage|home page|marketing site|portfolio|hero|navbar|pricing|contact|calendar|frontend|react|vite|next)\b/.test(normalized);
}

function normalizeHeuristicPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function extractKnownWorkspacePathsFromPrompt(userMessage: string): string[] {
  const lines = userMessage.replace(/\r\n/g, '\n').split('\n');
  const paths = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const candidate = line.slice(2).split(' [')[0].trim();
    if (!candidate || /\s{2,}/.test(candidate)) continue;
    if (!/[/.]/.test(candidate) && !/^[A-Z][A-Za-z0-9_-]*file(?:\.[A-Za-z0-9]+)?$/i.test(candidate) && !/^[A-Za-z0-9_-]+file$/i.test(candidate)) {
      continue;
    }
    paths.add(normalizeHeuristicPath(candidate));
  }

  return [...paths];
}

function chooseKnownOrDefault(knownPaths: Set<string>, candidates: string[], fallback: string): string {
  const normalizedFallback = normalizeHeuristicPath(fallback);
  for (const candidate of candidates) {
    const normalized = normalizeHeuristicPath(candidate);
    if (knownPaths.has(normalized)) return normalized;
  }
  return normalizedFallback;
}

function inferWebsiteSectionsFromPrompt(userMessage: string): string[] {
  const normalized = normalizePlannerText(userMessage);
  const sections = new Set<string>(['header', 'hero']);

  if (/\b(about|company|team|story|mission)\b/.test(normalized)) sections.add('about');
  if (/\b(feature|features|benefit|benefits|service|services|product|products|solution|solutions)\b/.test(normalized)) sections.add('features');
  if (/\b(dashboard|analytics|data|stocks?|trading|market|finance|signals?|watchlist|portfolio tracker)\b/.test(normalized)) sections.add('dashboard');
  if (/\b(portfolio|gallery|work|projects?)\b/.test(normalized)) sections.add('portfolio');
  if (/\b(pricing|plans?|tiers?)\b/.test(normalized)) sections.add('pricing');
  if (/\b(calendar|booking|schedule|appointment|events?)\b/.test(normalized)) sections.add('calendar');
  if (/\b(contact|get in touch|reach out|lead form)\b/.test(normalized)) sections.add('contact');
  if (/\b(testimonials?|reviews?)\b/.test(normalized)) sections.add('testimonials');
  if (/\b(faq|questions?)\b/.test(normalized)) sections.add('faq');
  if (!sections.has('about') && !sections.has('dashboard') && !sections.has('portfolio')) sections.add('about');
  if (!sections.has('features') && !sections.has('dashboard') && !sections.has('portfolio')) sections.add('features');
  sections.add('footer');

  return [...sections];
}

function inferWebsiteExperienceFocus(userMessage: string): string {
  const cleaned = stripPlannerCodeNoise(userMessage)
    .replace(/^can you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^build\s+/i, '')
    .replace(/^create\s+/i, '')
    .replace(/^make\s+/i, '')
    .trim();

  if (!cleaned) return 'the main experience requested by the user';
  return clampPlannerSnippet(cleaned, 180);
}

function buildStep(
  stepNumber: number,
  filePath: string,
  purpose: string,
  imports: string[] = [],
  exports: string[] = [],
  isSupport = false,
): DeepStep {
  return {
    stepNumber,
    label: filePath,
    filePath,
    purpose,
    imports,
    exports,
    isSupport,
  };
}

function plannerBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function isPlannerDotfileLikePath(path: string): boolean {
  return plannerBasename(path).startsWith('.');
}

function buildHeuristicReactViteWebsitePlan(
  userMessage: string,
  classification: ClassificationResult,
): { projectSummary: string; steps: DeepStep[] } {
  const knownPaths = new Set(extractKnownWorkspacePathsFromPrompt(userMessage));
  const wantsTypeScript = /\btypescript|\btsx\b/i.test(userMessage) || knownPaths.has('tsconfig.json');
  const packagePath = chooseKnownOrDefault(knownPaths, ['package.json'], 'package.json');
  const tsconfigPath = chooseKnownOrDefault(knownPaths, ['tsconfig.json'], 'tsconfig.json');
  const viteConfigPath = chooseKnownOrDefault(
    knownPaths,
    ['vite.config.ts', 'vite.config.tsx', 'vite.config.js', 'vite.config.mjs'],
    wantsTypeScript ? 'vite.config.ts' : 'vite.config.js',
  );
  const indexHtmlPath = chooseKnownOrDefault(knownPaths, ['index.html'], 'index.html');
  const mainEntryPath = chooseKnownOrDefault(
    knownPaths,
    ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js'],
    wantsTypeScript ? 'src/main.tsx' : 'src/main.jsx',
  );
  const appPath = chooseKnownOrDefault(
    knownPaths,
    ['src/App.tsx', 'src/App.jsx', 'src/app.tsx', 'src/app.jsx'],
    wantsTypeScript ? 'src/App.tsx' : 'src/App.jsx',
  );
  const stylePath = chooseKnownOrDefault(
    knownPaths,
    ['src/styles.css', 'src/index.css', 'src/App.css'],
    'src/styles.css',
  );
  const hasExistingScaffold = knownPaths.has(packagePath) || knownPaths.has(mainEntryPath) || knownPaths.has(appPath);
  const sections = inferWebsiteSectionsFromPrompt(userMessage);
  const sectionSummary = sections.join(', ');
  const experienceFocus = inferWebsiteExperienceFocus(userMessage);
  const isFeatureLike = classification.mode === 'feature_build' && hasExistingScaffold;
  const appAction = isFeatureLike ? 'MODIFY' : 'Build';
  const styleAction = isFeatureLike ? 'MODIFY' : 'Create';

  const steps: DeepStep[] = [];
  let stepNumber = 1;
  const addStep = (
    include: boolean,
    filePath: string,
    purpose: string,
    imports: string[] = [],
    exports: string[] = [],
    isSupport = false,
  ) => {
    if (!include) return;
    steps.push(buildStep(stepNumber, filePath, purpose, imports, exports, isSupport));
    stepNumber += 1;
  };

  addStep(!isFeatureLike || !knownPaths.has(packagePath), packagePath,
    'Define the React + TypeScript + Vite workspace scripts, dependencies, and build metadata needed to install, develop, build, and preview the requested web application.',
    [],
    [],
    true,
  );
  addStep(wantsTypeScript && (!isFeatureLike || !knownPaths.has(tsconfigPath)), tsconfigPath,
    'Configure strict TypeScript compiler settings for the Vite React workspace so the source files build cleanly and editor tooling resolves TSX entrypoints correctly.',
    [packagePath],
    [],
    true,
  );
  addStep(!isFeatureLike || !knownPaths.has(viteConfigPath), viteConfigPath,
    'Configure the Vite React app entrypoints and plugin setup required to run and build the requested single-page web experience.',
    [packagePath],
    [],
    true,
  );
  addStep(!isFeatureLike || !knownPaths.has(indexHtmlPath), indexHtmlPath,
    'Provide the HTML shell, root mount element, and document metadata used to bootstrap the React single-page website.',
    [mainEntryPath],
    [],
    true,
  );
  addStep(!isFeatureLike || !knownPaths.has(mainEntryPath), mainEntryPath,
    'Bootstrap the React application, import the global stylesheet, and mount the main web experience at the root element.',
    [appPath, stylePath],
    [],
    false,
  );
  addStep(true, appPath,
    `${appAction}: render the requested React single-page experience with sections for ${sectionSummary}. Keep the main interface centered on ${experienceFocus}, and make the layout responsive across desktop and mobile.`,
    [stylePath],
    ['App'],
    false,
  );
  addStep(true, stylePath,
    `${styleAction}: define the visual system, responsive layout, navigation treatment, and section styling needed to support ${sectionSummary} around ${experienceFocus}.`,
    [appPath],
    [],
    false,
  );

  return {
    projectSummary: `Build a ${isFeatureLike ? 'React + TypeScript + Vite website feature update' : 'single-page React + TypeScript + Vite website/application'} for ${experienceFocus}, with sections for ${sectionSummary} and responsive navigation.`,
    steps,
  };
}

function buildHeuristicFallbackPlan(
  userMessage: string,
  classification: ClassificationResult,
): { projectSummary: string; steps: DeepStep[] } {
  const websiteLike = isWebsiteBuildPrompt(userMessage);
  if (websiteLike && (
    classification.mode === 'complete_project'
    || classification.mode === 'feature_build'
    || classification.mode === 'feature_integration'
  )) {
    return buildHeuristicReactViteWebsitePlan(userMessage, classification);
  }

  return {
    projectSummary: stripPlannerCodeNoise(userMessage) || 'Apply the requested workspace changes.',
    steps: [buildStep(
      1,
      'src/index.ts',
      stripPlannerCodeNoise(userMessage) || 'Apply the requested workspace changes in a single focused source file.',
      [],
      [],
      false,
    )],
  };
}

function buildWebsitePlannerGuidance(userMessage: string): string {
  const normalized = normalizePlannerText(userMessage);
  const wantsCalendar = /\b(calendar|booking|schedule|appointment|events?)\b/.test(normalized);
  const wantsPricing = /\b(pricing|plans?|tiers?|subscriptions?)\b/.test(normalized);
  const wantsContact = /\b(contact|lead form|reach out|get in touch)\b/.test(normalized);

  return [
    '',
    'Website planning rules:',
    '- Use a normal production website structure rather than abstract folders like coreLogic, entryPoints, or generic utility buckets unless the user explicitly asked for that architecture.',
    '- For React + TypeScript + Vite requests, the baseline file plan should usually include package.json, tsconfig.json, vite.config.ts when needed, index.html, src/main.tsx, the main app/page component files, and the stylesheet files actually used.',
    '- Keep the website subject, industry, and section themes grounded in the current request only. Do not carry over niche themes or content from unrelated earlier website prompts.',
    '- Ensure the file checklist is enough to install, build, start, and render the website immediately.',
    '- Include standard website sections when the prompt is broad or marketing-oriented: header, responsive navbar with a mobile menu, hero, supporting content sections, and footer.',
    `- ${wantsPricing ? 'Include a pricing section because the request signals pricing or plan information.' : 'Include a pricing section only if the request clearly benefits from it.'}`,
    `- ${wantsCalendar ? 'Include a calendar or scheduling section because the request explicitly mentions it.' : 'Include a calendar or scheduling section only if the request explicitly asks for booking, schedules, appointments, or events.'}`,
    `- ${wantsContact ? 'Include a contact section because the request explicitly asks for contact or lead capture.' : 'Include a contact section when the user expects outreach, forms, or business inquiries.'}`,
    '- Keep the step list grounded in real framework entrypoints and real component/file names.',
  ].join('\n');
}

function buildPlannerSystemPrompt(
  classification: ClassificationResult,
  userMessage: string,
): string {
  const base = PLANNER_BY_MODE[classification.mode] ?? PLANNER_COMPLETE_PROJECT;
  const guidance: string[] = [];

  if (classification.mode === 'complete_project') {
    guidance.push(
      '',
      'Project planning rules:',
      '- Plan only the files the project genuinely needs to build, run, and satisfy the request.',
      '- Prefer the standard scaffold shape for the requested language, framework, and build tool.',
      '- Do not invent placeholder-heavy architectures or generic folder names when the user asked for a straightforward app or website.',
      '- If a dependency manager or runtime is implied, include the files and scripts required to install and start the project successfully.',
    );
  }

  if (
    classification.mode === 'complete_project'
    || classification.mode === 'feature_build'
    || classification.mode === 'feature_integration'
  ) {
    guidance.push(
      '',
      'File path rules:',
      '- Use exact, real file paths and filenames with extensions.',
      '- Every new source, stylesheet, config, script, markup, and data file must use its real extension unless the filename is a conventional extensionless file like Dockerfile, Makefile, Procfile, or a dotfile.',
      '- Reuse existing workspace paths when the workspace already contains a matching file.',
      '- When planning a new file, pick the final exact path now and keep it stable across every later step.',
    );
  }

  if (isWebsiteBuildPrompt(userMessage)) {
    guidance.push(buildWebsitePlannerGuidance(userMessage));
  }

  return `${base}${guidance.join('\n')}`;
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
  "code_snippet"        — Return a focused example, snippet, utility, or explanation-sized block of code without planning a full project or editing real files. Signals: "show me a snippet", "give me an example", "how do I write", "one-liner", "sample code", "utility function".
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
function summariseHistoryForClassifier(
  history: Message[],
  options?: { hasExistingProject?: boolean; workspaceFilePaths?: string[]; workspaceContextSummary?: string },
): string {
  const userMessages = history
    .filter(m => m.role === 'user')
    .slice(-5) // last 5 user turns
    .map((m, i) => `Prior request ${i + 1}: ${m.content.slice(0, 200)}`);

  // Also note if prior assistant messages contained file paths (signals a project exists)
  const assistantHadCode = history
    .filter(m => m.role === 'assistant')
    .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));
  const projectExistsInWorkspace = Boolean(options?.hasExistingProject);
  const knownPaths = options?.workspaceFilePaths?.slice(0, 20) ?? [];

  const projectExists = assistantHadCode || projectExistsInWorkspace
    ? '\nIMPORTANT: A project already exists in this workspace/conversation. Do NOT classify as complete_project.'
    : '';
  const workspaceContext = knownPaths.length > 0
    ? `\nKnown workspace files:\n${knownPaths.map((path) => `- ${path}`).join('\n')}`
    : '';
  const workspaceSummary = options?.workspaceContextSummary
    ? `\nWorkspace file analysis:\n${options.workspaceContextSummary.trim()}`
    : '';

  return userMessages.join('\n') + projectExists + workspaceContext + workspaceSummary;
}

/**
 * Fast regex pre-classifier — catches obvious cases without burning an LLM call.
 * Returns a mode if confident, null if uncertain (falls through to LLM classifier).
 */
function preClassify(
  userMessage: string,
  history: Message[],
  options?: { hasExistingProject?: boolean },
): RequestMode | null {
  const msg = userMessage.toLowerCase().trim();

  // If prior assistant messages contained file code, this is NEVER complete_project
  const assistantHadCode = history
    .filter(m => m.role === 'assistant')
    .some(m => /\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:|```\w+\s+\S+\.\w+/.test(m.content));
  const hasExistingProject = assistantHadCode || Boolean(options?.hasExistingProject);

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

  const snippetSignals = /\b(snippet|sample code|sample snippet|example code|one-liner|utility function|show me an example|show me a snippet|give me a snippet|give me an example|just the code|standalone example|small example|sample implementation)\b/i;
  const snippetQuestionSignals = /^(how do i|how would you|what's a good way to|write me a function to|can you show me how to)\b/i;
  const workspaceMutationSignals = /\b(add|implement|integrate|wire|fix|debug|refactor|rename|modify|update|create file|edit file|in this project|in this workspace|in my app|in my repo|package\.json|tsconfig|src\/|app\/|components\/|workspace)\b/i;
  if ((snippetSignals.test(msg) || snippetQuestionSignals.test(msg)) && !workspaceMutationSignals.test(msg)) {
    return 'code_snippet';
  }

  // If code exists in history and request looks like adding something, feature_build
  if (hasExistingProject) {
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
  options?: {
    hasExistingProject?: boolean;
    workspaceFilePaths?: string[];
    workspaceContextSummary?: string;
  },
): Promise<ClassificationResult> {

  // Try fast regex pre-classifier first
  const preResult = preClassify(userMessage, conversationHistory, options);
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
  const historySummary = summariseHistoryForClassifier(conversationHistory, options);

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
    const hasExistingProject = assistantHadCode || Boolean(options?.hasExistingProject);

    let mode = (parsed.mode as RequestMode) ?? 'feature_build';
    if (hasExistingProject && mode === 'complete_project') {
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
    const hasExistingProject = assistantHadCode || Boolean(options?.hasExistingProject);
    return {
      mode: hasExistingProject ? 'feature_build' : 'complete_project',
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

async function resolveNpmFromRegistry(name: string): Promise<PackageVersion | null> {
  try {
    const data = await fetchJsonDirect<{
      description?: string;
      'dist-tags'?: Record<string, string>;
      versions?: Record<string, { description?: string; deprecated?: string }>;
    }>(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const normalizeVersion = (value: string) => value.trim().replace(/^v/i, '');
    const isStableVersion = (value: string) => !normalizeVersion(value).includes('-');
    const parseSemver = (value: string) => {
      const normalized = normalizeVersion(value);
      const [mainPart] = normalized.split('-', 1);
      const parts = mainPart.split('.').map((part) => Number.parseInt(part, 10));
      if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
      return {
        normalized,
        parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
      };
    };
    const compareSemverDesc = (left: string, right: string) => {
      const leftSemver = parseSemver(left);
      const rightSemver = parseSemver(right);
      if (!leftSemver && !rightSemver) return right.localeCompare(left);
      if (!leftSemver) return 1;
      if (!rightSemver) return -1;
      for (let index = 0; index < 3; index += 1) {
        const delta = rightSemver.parts[index] - leftSemver.parts[index];
        if (delta !== 0) return delta;
      }
      return rightSemver.normalized.localeCompare(leftSemver.normalized);
    };

    const versions = data.versions ?? {};
    const latestTag = data['dist-tags']?.latest?.trim() ?? '';
    const latestManifest = latestTag ? versions[latestTag] : undefined;
    if (latestTag && latestManifest && isStableVersion(latestTag) && !latestManifest.deprecated) {
      return {
        name,
        ecosystem: 'npm',
        version: normalizeVersion(latestTag),
        description: latestManifest.description ?? data.description,
      };
    }

    const stableVersions = Object.entries(versions)
      .filter(([version, manifest]) => isStableVersion(version) && !manifest?.deprecated)
      .map(([version]) => version)
      .sort(compareSemverDesc);
    const selectedVersion = stableVersions[0] ?? latestTag;
    if (!selectedVersion) return null;

    return {
      name,
      ecosystem: 'npm',
      version: normalizeVersion(selectedVersion),
      description: versions[selectedVersion]?.description ?? data.description,
    };
  } catch {
    return resolveNpm(name);
  }
}

function expandPackageResolutionTargets(
  packages: ClassificationResult['mentionedPackages'],
): ClassificationResult['mentionedPackages'] {
  if (!packages.length) return [];

  const expanded = [...packages];
  const seen = new Set(expanded.map((pkg) => `${pkg.ecosystem}:${pkg.name.toLowerCase()}`));
  const addPackage = (
    name: string,
    ecosystem: ClassificationResult['mentionedPackages'][number]['ecosystem'],
  ) => {
    const key = `${ecosystem}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push({ name, ecosystem });
  };

  const npmNames = new Set(
    expanded
      .filter((pkg) => pkg.ecosystem === 'npm')
      .map((pkg) => pkg.name.toLowerCase()),
  );
  const wantsReact = npmNames.has('react') || npmNames.has('react-dom');
  const wantsTypeScript = npmNames.has('typescript');
  const wantsVite = npmNames.has('vite');

  if (npmNames.has('react')) {
    addPackage('react-dom', 'npm');
  }
  if (wantsReact && wantsTypeScript) {
    addPackage('@types/react', 'npm');
    addPackage('@types/react-dom', 'npm');
  }
  if (wantsReact && wantsVite) {
    addPackage('@vitejs/plugin-react', 'npm');
  }

  return expanded;
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
  const targets = expandPackageResolutionTargets(packages);

  const results = await Promise.allSettled(
    targets.map(p => {
      switch (p.ecosystem) {
        case 'npm':      return resolveNpmFromRegistry(p.name);
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
    const desc = p.description ? ` - ${p.description.slice(0, 80)}` : '';
    return `  ${p.name} (${p.ecosystem}): stable latest = ${p.version}${desc}`;
  });
  return (
    `\n\n---\n## Live Package Versions (fetched from registries)\n` +
    `For npm packages, these versions come from https://registry.npmjs.org/<package> using the current stable release.\n` +
    `Use ONLY these versions in package.json / requirements.txt / Cargo.toml etc.\n` +
    `Do NOT infer matching versions for companion packages such as @types/*, react-dom, or framework plugins.\n\n` +
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
Be exhaustive, but stay concrete.
Choose the canonical scaffold shape for the requested stack.
Do NOT invent abstract buckets like src/types/index.ts, src/utils/index.ts, src/coreLogic/index.ts, or src/entryPoints/index.tsx unless the user explicitly asked for that structure.
Plan real entrypoints, real config files, and real component/module files that are enough to install, build, run, and render the project.` + PLANNER_BASE;

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
  code_snippet:        PLANNER_EDIT_FILE,
  explain:             PLANNER_EDIT_FILE,
  edit_file:           PLANNER_EDIT_FILE,
  docs_only:           PLANNER_DOCS_ONLY,
  add_files:           PLANNER_ADD_FILES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Step execution system prompt
// ─────────────────────────────────────────────────────────────────────────────

const STEP_EXECUTOR_SYSTEM = appendSharedResponseStylePrompt(`You are a senior software engineer implementing one file at a time.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 0 — FILE PATH DECLARATION (MANDATORY, NO EXCEPTIONS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The VERY FIRST LINE inside every code block MUST be the file path comment.
This is not optional. A code block without a file path comment is broken.

  JS / TS:         // FILE: src/lib/router.ts
  CSS / SCSS:      /* FILE: src/styles/app.css */
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
- Use documented framework conventions when a technical reference bundle is present.
- When you reference another file, match the exact provided path and filename, including extension.
- Never silently rename the target file, move it to a different folder, or switch to a different extension.
- Do not omit a file extension for source/config files unless the target is a conventional extensionless file like Dockerfile, Makefile, Procfile, or a dotfile.
- Do not invent missing imports. If a referenced file does not exist in the provided workspace or plan, either use the correct existing file or keep the implementation self-contained within the assigned file.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE 3 — PACKAGE VERSIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If a "Live Package Versions" section appears in your context, you MUST use
those exact version strings in package.json, requirements.txt, Cargo.toml,
Gemfile, go.mod, or composer.json. Do NOT use versions from your training data.

After the code block, you may write a brief explanation (2-4 sentences).`);

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
  const dotfileLike = isPlannerDotfileLikePath(step.filePath);
  const jsonYaml = ['json', 'yaml', 'yml'].includes(ext);
  const pyShell  = ['py', 'sh', 'bash', 'shell'].includes(ext);
  const htmlXml  = ['html', 'xml', 'md', 'svg'].includes(ext);
  const cssLike  = ['css', 'scss', 'sass', 'less'].includes(ext);
  const fileComment = jsonYaml
    ? `\`\`\`${ext} ${step.filePath}  ← put the path in the fence label`
    : (pyShell || dotfileLike)
      ? `# FILE: ${step.filePath}`
      : cssLike
        ? `/* FILE: ${step.filePath} */`
      : htmlXml
        ? `<!-- FILE: ${step.filePath} -->`
        : `// FILE: ${step.filePath}`;

  return (
    `Project: ${plan.projectSummary}\n` +
    modeHint +
    writtenBlock +
    `\nStep ${step.stepNumber} of ${total}: Write the file ${step.filePath}\n` +
    `\nTARGET PATH RULE: Return the complete file for exactly ${step.filePath}. Do not rename it, move it, or change its extension.\n` +
    `When you import another file, use the exact path and filename supplied by the workspace context or earlier completed steps.\n` +
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
  const plannerSystem = buildPlannerSystemPrompt(classification, userMessage);
  const plannerHistorySummary = buildPlanningConversationSummary(conversationHistory);
  const buildPlannerMessage = (prompt: string, includeHistorySummary: boolean): Message => ({
    role: 'user',
    content: includeHistorySummary && plannerHistorySummary
      ? [
          'Conversation context summary:',
          plannerHistorySummary,
          '',
          'Current request to plan:',
          prompt,
        ].join('\n')
      : prompt,
  });

  const requestPlan = async (prompt: string, timeoutMs: number, includeHistorySummary: boolean): Promise<string> => {
    const timed = createTimedChildSignal(signal, timeoutMs);
    try {
      return await chatOnce(
        model,
        [buildPlannerMessage(prompt, includeHistorySummary)],
        plannerSystem,
        timed.signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (timed.didTimeout()) {
        throw new Error(`Planner timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      timed.dispose();
    }
  };

  let raw: string;
  try {
    raw = await requestPlan(
      compactPlannerPrompt(userMessage, PLANNER_PROMPT_MAX_CHARS),
      PLANNER_TIMEOUT_MS,
      true,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      raw = await requestPlan(
        compactPlannerPrompt(userMessage, PLANNER_PROMPT_RETRY_MAX_CHARS),
        PLANNER_RETRY_TIMEOUT_MS,
        false,
      );
    } catch (retryError) {
      if (signal.aborted) throw retryError;
      return buildHeuristicFallbackPlan(userMessage, classification);
    }
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: { projectSummary?: string; steps?: Partial<DeepStep>[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return buildHeuristicFallbackPlan(userMessage, classification);
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

  const planned = {
    projectSummary: parsed.projectSummary ?? userMessage,
    steps,
  };
  return planned.steps.length > 0 ? planned : buildHeuristicFallbackPlan(userMessage, classification);
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

const SUMMARY_SYSTEM = appendSharedResponseStylePrompt(`You are a senior software engineer who has just finished a coding task.
Write a clear, helpful summary for the developer.

Write in plain prose — no code blocks. Adapt the structure to the type of work done:
- For a new project: overview of what was built, architecture, install/run guide.
- For a feature or integration: what was added, how it connects to the existing code, how to test it.
- For a debug fix: what the bug was, what caused it, what was changed to fix it, how to verify.
- For a refactor: what changed structurally, what stayed the same, any behaviour differences to watch for.
- For an edit: summary of the changes made and why.

Be specific — reference actual file names and commands. 3-5 paragraphs.`);

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
