// FILE: src/lib/codeResearch.ts
import { fetchGlobalContext } from './fetcher';
import type { FetchContextDepth, FetchedContext } from './fetcher';
import type { ClassificationResult } from './deepPlanner';
import type { Message, WorkspaceCommandResult } from '../types';

interface CodeResearchOptions {
  classification?: ClassificationResult;
  workspaceFilePaths?: string[];
  depth?: FetchContextDepth;
  maxSources?: number;
  failureOutputs?: WorkspaceCommandResult[];
}

const CREDIBILITY_ORDER: Record<NonNullable<FetchedContext['credibility']>, number> = {
  official: 0,
  reference: 1,
  community: 2,
  search: 3,
  'major-news': 4,
};

const TOPIC_PATTERNS: Array<{ pattern: RegExp; topics: string[] }> = [
  { pattern: /\bcss\b|\bscss\b|\bsass\b|\bless\b|lightningcss|postcss|pseudo element/i, topics: ['CSS'] },
  { pattern: /\breact\b/i, topics: ['React'] },
  { pattern: /\bvite\b/i, topics: ['Vite'] },
  { pattern: /\btypescript\b|\btsx\b/i, topics: ['TypeScript'] },
  { pattern: /\bjavascript\b|\bjsx\b/i, topics: ['JavaScript'] },
  { pattern: /\bnode(?:\.js)?\b|\bnpm\b|\bpnpm\b|\byarn\b/i, topics: ['Node.js', 'npm'] },
  { pattern: /\bnext(?:\.js)?\b/i, topics: ['Next.js'] },
  { pattern: /\bvue\b/i, topics: ['Vue'] },
  { pattern: /\bsvelte\b/i, topics: ['Svelte'] },
  { pattern: /\bangular\b/i, topics: ['Angular'] },
  { pattern: /\btailwind\b/i, topics: ['Tailwind CSS'] },
  { pattern: /\bexpress\b/i, topics: ['Express'] },
  { pattern: /\bgo\b|\bgolang\b/i, topics: ['Go'] },
  { pattern: /\bpython\b|\bpytest\b|\bfastapi\b|\bdjango\b/i, topics: ['Python'] },
  { pattern: /\brust\b|\bcargo\b/i, topics: ['Rust'] },
];

const WEBSITE_RELEVANCE_TERMS = [
  'website',
  'frontend',
  'html',
  'css',
  'javascript',
  'typescript',
  'react',
  'vite',
  'navbar',
  'hero',
  'responsive',
  'landing page',
];

const FAILURE_FILE_RE = /\b(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html|md|go|py|rs)\b/g;
const FAILURE_QUOTED_TOKEN_RE = /['"`](@?[a-z0-9][\w./-]*[a-z0-9])['"`]/gi;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const FAILURE_PACKAGE_STOP_WORDS = new Set([
  'build',
  'dev',
  'dist',
  'error',
  'errors',
  'failed',
  'failure',
  'fix',
  'import',
  'module',
  'plugin',
  'preview',
  'run',
  'script',
  'src',
  'test',
  'tests',
  'type',
  'types',
  'vite.config.ts',
]);

const OFFICIAL_TECHNICAL_DOMAIN_PATTERNS: Array<{ pattern: RegExp; domains: string[] }> = [
  { pattern: /\bcss\b|\bscss\b|\bsass\b|\bless\b|lightningcss|postcss|pseudo element/i, domains: ['developer.mozilla.org'] },
  { pattern: /\bvite\b|@vitejs\//i, domains: ['vite.dev'] },
  { pattern: /\breact\b|react-dom|@types\/react/i, domains: ['react.dev'] },
  { pattern: /\btypescript\b|\btsx\b|\btsconfig\b|\bTS\d{4}\b/i, domains: ['typescriptlang.org'] },
  { pattern: /\bnode(?:\.js)?\b|\bnpm\b|\bpnpm\b|\byarn\b|\bpackage\.json\b|\bERESOLVE\b|\bETARGET\b/i, domains: ['nodejs.org', 'docs.npmjs.com', 'npmjs.com'] },
  { pattern: /\bnext(?:\.js)?\b/i, domains: ['nextjs.org'] },
  { pattern: /\bvue\b/i, domains: ['vuejs.org'] },
  { pattern: /\bsvelte\b/i, domains: ['svelte.dev'] },
  { pattern: /\bangular\b/i, domains: ['angular.dev'] },
  { pattern: /\btailwind\b/i, domains: ['tailwindcss.com'] },
  { pattern: /\bexpress\b/i, domains: ['expressjs.com'] },
  { pattern: /\bgo\b|\bgolang\b/i, domains: ['go.dev'] },
  { pattern: /\bpython\b|\bpytest\b|\bfastapi\b|\bdjango\b/i, domains: ['docs.python.org', 'packaging.python.org', 'fastapi.tiangolo.com', 'docs.djangoproject.com'] },
  { pattern: /\brust\b|\bcargo\b/i, domains: ['rust-lang.org', 'docs.rs', 'crates.io'] },
];

const DEBUG_COMMUNITY_DOMAINS = ['github.com', 'stackoverflow.com'];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trimContextText(value: string, maxLength: number): string {
  const compact = normalizeWhitespace(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, '');
}

function contextHostname(context: Pick<FetchedContext, 'url'>): string {
  try {
    return new URL(context.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeFailurePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
}

function extractFailureText(failures: WorkspaceCommandResult[] = []): string {
  return failures
    .flatMap((failure) => [failure.command, failure.stderr, failure.stdout, failure.combinedOutput])
    .map((value) => stripAnsi(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractFailureLines(failures: WorkspaceCommandResult[] = []): string[] {
  return uniqueStrings(
    extractFailureText(failures)
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(stripAnsi(line)))
      .filter((line) => line.length >= 12)
      .filter((line) => !/^(npm error|npm err!|at\s|> |\^|A complete log of this run|For a full report see)/i.test(line))
      .filter((line) => /\b(error|failed|cannot|can't|unexpected|resolve|export|import|property|module|vite|react|typescript|ts\d{4}|plugin)\b/i.test(line))
  ).slice(0, 8);
}

function isLikelyPackageName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || FAILURE_PACKAGE_STOP_WORDS.has(normalized)) return false;
  if (/\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html|md|go|py|rs)$/i.test(normalized)) return false;
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(normalized);
}

function extractFailureFocusTerms(failures: WorkspaceCommandResult[] = []): string[] {
  const failureText = extractFailureText(failures);
  if (!failureText) return [];

  const fileTerms = [...failureText.matchAll(FAILURE_FILE_RE)]
    .map((match) => normalizeFailurePath(match[0] ?? ''))
    .filter(Boolean);
  const packageTerms = [...failureText.matchAll(FAILURE_QUOTED_TOKEN_RE)]
    .map((match) => match[1] ?? '')
    .filter(isLikelyPackageName);
  const codeTerms = [...failureText.matchAll(/\b(?:TS\d{4}|ERR_[A-Z_]+|ERESOLVE|ETARGET|ENOENT|EACCES)\b/g)]
    .map((match) => match[0] ?? '');
  const phraseTerms = [
    /\bfailed to resolve import\b/i.test(failureText) ? 'failed to resolve import' : '',
    /\bdoes not provide an export named\b/i.test(failureText) ? 'does not provide an export named' : '',
    /\bcannot find module\b/i.test(failureText) ? 'cannot find module' : '',
    /\bproperty .* does not exist on type\b/i.test(failureText) ? 'property does not exist on type' : '',
    /\bis not assignable to type\b/i.test(failureText) ? 'is not assignable to type' : '',
    /\bsyntaxerror\b/i.test(failureText) ? 'syntax error' : '',
    /\binvalid token\b/i.test(failureText) ? 'invalid token' : '',
    /\bpseudo element\b/i.test(failureText) ? 'pseudo element' : '',
    /\bunexpected token\b/i.test(failureText) ? 'unexpected token' : '',
    /\bunknown (?:option|property|word)\b/i.test(failureText) ? 'unknown option' : '',
  ].filter(Boolean);
  const topicTerms = TOPIC_PATTERNS
    .filter((entry) => entry.pattern.test(failureText))
    .flatMap((entry) => entry.topics);

  return uniqueStrings([
    ...topicTerms,
    ...packageTerms,
    ...fileTerms,
    ...codeTerms,
    ...phraseTerms,
  ]).slice(0, 18);
}

function buildFailureDebugQueries(
  failures: WorkspaceCommandResult[] = [],
  topics: string[] = [],
): string[] {
  if (!failures.length) return [];

  const focusTerms = extractFailureFocusTerms(failures);
  const errorLines = extractFailureLines(failures);
  const topicLead = uniqueStrings([...focusTerms, ...topics]).slice(0, 6).join(' ');

  return uniqueStrings([
    ...errorLines.slice(0, 3).map((line) => `${trimContextText(line, 160)} ${topicLead} official docs GitHub StackOverflow`),
    topicLead ? `${topicLead} official docs error fix GitHub StackOverflow` : '',
    focusTerms.length > 0 ? `${focusTerms.slice(0, 4).join(' ')} configuration error fix GitHub StackOverflow` : '',
  ]).slice(0, 4);
}

function hasWorkspacePath(workspaceFilePaths: string[], path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  return workspaceFilePaths.some((workspacePath) => workspacePath.replace(/\\/g, '/').toLowerCase() === normalizedPath);
}

function inferTechnicalTopics(
  userMessage: string,
  classification?: ClassificationResult,
  workspaceFilePaths: string[] = [],
  failures: WorkspaceCommandResult[] = [],
): string[] {
  const combinedText = [
    userMessage,
    ...(classification?.mentionedPackages.map((pkg) => pkg.name) ?? []),
    extractFailureText(failures),
  ].join(' ');
  const topics = TOPIC_PATTERNS
    .filter((entry) => entry.pattern.test(combinedText))
    .flatMap((entry) => entry.topics);

  if (hasWorkspacePath(workspaceFilePaths, 'package.json')) {
    topics.push('Node.js', 'npm');
  }
  if (hasWorkspacePath(workspaceFilePaths, 'vite.config.ts') || hasWorkspacePath(workspaceFilePaths, 'vite.config.js')) {
    topics.push('Vite');
  }
  if (hasWorkspacePath(workspaceFilePaths, 'tsconfig.json')) {
    topics.push('TypeScript');
  }
  if (hasWorkspacePath(workspaceFilePaths, 'go.mod')) {
    topics.push('Go');
  }
  if (hasWorkspacePath(workspaceFilePaths, 'pyproject.toml') || hasWorkspacePath(workspaceFilePaths, 'requirements.txt')) {
    topics.push('Python');
  }
  if (hasWorkspacePath(workspaceFilePaths, 'Cargo.toml')) {
    topics.push('Rust');
  }

  return uniqueStrings([
    ...topics,
    ...(classification?.mentionedPackages.map((pkg) => pkg.name) ?? []),
    ...extractFailureFocusTerms(failures),
  ]).slice(0, 10);
}

function isWebsiteLikeRequest(userMessage: string, workspaceFilePaths: string[] = []): boolean {
  const combinedText = [userMessage, ...workspaceFilePaths].join(' ');
  return /\b(website|web app|landing page|homepage|home page|marketing site|portfolio|navbar|hero|pricing|contact|calendar|frontend|ui|react|vite|next)\b/i.test(combinedText);
}

function buildCodeResearchQueries(
  userMessage: string,
  classification?: ClassificationResult,
  workspaceFilePaths: string[] = [],
  failures: WorkspaceCommandResult[] = [],
): string[] {
  const topics = inferTechnicalTopics(userMessage, classification, workspaceFilePaths, failures);
  const promptLead = trimContextText(userMessage, 180);
  const packageTopics = uniqueStrings(classification?.mentionedPackages.map((pkg) => pkg.name) ?? []).join(' ');
  const topicLead = topics.join(' ');
  const websiteLike = isWebsiteLikeRequest(userMessage, workspaceFilePaths);
  const failureQueries = buildFailureDebugQueries(failures, topics);

  return uniqueStrings([
    ...failureQueries,
    `${promptLead} official docs documentation reference GitHub StackOverflow`,
    topicLead
      ? `${topicLead} official docs setup file structure configuration commands GitHub StackOverflow`
      : '',
    packageTopics
      ? `${packageTopics} package docs API reference installation GitHub StackOverflow`
      : '',
    websiteLike
      ? `${topicLead || 'website frontend'} header navbar mobile menu hero about pricing calendar contact responsive examples GitHub StackOverflow`
      : '',
  ]).slice(0, 4);
}

function compareContexts(left: FetchedContext, right: FetchedContext): number {
  const leftRank = left.credibility ? CREDIBILITY_ORDER[left.credibility] ?? 99 : 99;
  const rightRank = right.credibility ? CREDIBILITY_ORDER[right.credibility] ?? 99 : 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftSelected = left.promptSelected ? 1 : 0;
  const rightSelected = right.promptSelected ? 1 : 0;
  if (leftSelected !== rightSelected) return rightSelected - leftSelected;
  return (right.text?.length ?? 0) - (left.text?.length ?? 0);
}

function buildTechnicalRelevanceTerms(
  userMessage: string,
  classification?: ClassificationResult,
  workspaceFilePaths: string[] = [],
  failures: WorkspaceCommandResult[] = [],
): string[] {
  return uniqueStrings([
    ...inferTechnicalTopics(userMessage, classification, workspaceFilePaths, failures),
    ...(isWebsiteLikeRequest(userMessage, workspaceFilePaths) ? WEBSITE_RELEVANCE_TERMS : []),
  ]).map((value) => value.toLowerCase());
}

function buildPreferredTechnicalDomains(relevanceTerms: string[]): string[] {
  const combined = relevanceTerms.join(' ');
  const preferred = OFFICIAL_TECHNICAL_DOMAIN_PATTERNS
    .filter((entry) => entry.pattern.test(combined))
    .flatMap((entry) => entry.domains);
  return uniqueStrings([...preferred, ...DEBUG_COMMUNITY_DOMAINS]);
}

function matchesPreferredDomain(context: FetchedContext, preferredDomains: string[]): boolean {
  if (!preferredDomains.length) return false;
  const hostname = contextHostname(context);
  return preferredDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isRelevantTechnicalContext(
  context: FetchedContext,
  relevanceTerms: string[],
  preferredDomains: string[],
): boolean {
  if (!relevanceTerms.length && !preferredDomains.length) return true;
  if (matchesPreferredDomain(context, preferredDomains)) return true;

  const haystack = [
    context.title,
    context.url,
    context.provider,
    context.sourceType,
    context.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return relevanceTerms.some((term) => haystack.includes(term));
}

function scoreTechnicalContext(
  context: FetchedContext,
  relevanceTerms: string[],
  preferredDomains: string[],
): number {
  const haystack = [
    context.title,
    context.url,
    context.provider,
    context.sourceType,
    context.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const termHits = relevanceTerms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  const credibilityScore = context.credibility === 'official'
    ? 120
    : context.credibility === 'reference'
      ? 95
      : context.credibility === 'community'
        ? 70
        : context.credibility === 'search'
          ? 25
          : 10;
  const domainScore = matchesPreferredDomain(context, preferredDomains) ? 160 : 0;
  const promptScore = context.promptSelected ? 12 : 0;
  return domainScore + credibilityScore + (Math.min(termHits, 8) * 14) + promptScore;
}

function mergeContexts(
  contexts: FetchedContext[],
  relevanceTerms: string[],
  preferredDomains: string[],
): FetchedContext[] {
  const merged = new Map<string, FetchedContext>();

  for (const context of contexts) {
    const key = normalizeWhitespace(context.url || context.title).toLowerCase();
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing || compareContexts(context, existing) < 0) {
      merged.set(key, context);
    }
  }

  return [...merged.values()].sort((left, right) => {
    const scoreDiff = scoreTechnicalContext(right, relevanceTerms, preferredDomains) - scoreTechnicalContext(left, relevanceTerms, preferredDomains);
    if (scoreDiff !== 0) return scoreDiff;
    return compareContexts(left, right);
  });
}

function isDebugFriendlyTechnicalContext(context: FetchedContext, preferredDomains: string[]): boolean {
  if (matchesPreferredDomain(context, preferredDomains)) return true;
  const hostname = contextHostname(context);
  if (DEBUG_COMMUNITY_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return true;
  }
  return context.credibility === 'official' || context.credibility === 'reference' || context.credibility === 'community';
}

export async function fetchCodeResearchContext(
  userMessage: string,
  conversationHistory: Message[] = [],
  options: CodeResearchOptions = {},
): Promise<FetchedContext[]> {
  const workspaceFilePaths = options.workspaceFilePaths ?? [];
  const queries = buildCodeResearchQueries(
    userMessage,
    options.classification,
    workspaceFilePaths,
    options.failureOutputs,
  );
  if (!queries.length) return [];
  const relevanceTerms = buildTechnicalRelevanceTerms(
    userMessage,
    options.classification,
    workspaceFilePaths,
    options.failureOutputs,
  );
  const preferredDomains = buildPreferredTechnicalDomains(relevanceTerms);

  const contextGroups = await Promise.all(queries.map((query) =>
    fetchGlobalContext(query, conversationHistory, {
      depth: options.depth ?? 'standard',
      forceFetch: true,
      maxSources: options.maxSources ?? 6,
      includeLocalIndex: false,
    }).catch(() => []),
  ));

  const flattened = contextGroups.flat().filter((context) =>
    !context.error
    && normalizeWhitespace(context.text).length >= 80,
  );

  const relevantContexts = flattened.filter((context) => isRelevantTechnicalContext(context, relevanceTerms, preferredDomains));
  const merged = mergeContexts(relevantContexts.length > 0 ? relevantContexts : flattened, relevanceTerms, preferredDomains);
  const debugFriendlyContexts = options.failureOutputs?.length
    ? merged.filter((context) => isDebugFriendlyTechnicalContext(context, preferredDomains))
    : [];
  const finalContexts = debugFriendlyContexts.length > 0 ? debugFriendlyContexts : merged;
  return finalContexts.slice(0, options.failureOutputs?.length ? 10 : 14);
}

export function buildCodeResearchSystemInject(contexts: FetchedContext[]): string {
  if (!contexts.length) return '';

  const prioritized = contexts
    .filter((context) => !context.error && normalizeWhitespace(context.text))
    .sort(compareContexts)
    .slice(0, 8);
  if (!prioritized.length) return '';

  const blocks = prioritized.map((context) => {
    const metadata = [
      context.provider ? `Provider: ${context.provider}` : '',
      context.credibility ? `Credibility: ${context.credibility}` : '',
      context.sourceType ? `Type: ${context.sourceType}` : '',
      context.publishedAt ? `Published: ${context.publishedAt}` : '',
      context.url ? `URL: ${context.url}` : '',
    ].filter(Boolean).join(' | ');

    return [
      `### ${trimContextText(context.title || context.url, 140)}`,
      metadata,
      trimContextText(context.text, 1400),
    ].filter(Boolean).join('\n');
  });

  return [
    '',
    '---',
    '## Technical Reference Bundle',
    'The following technical references were fetched live for this coding request before planning or writing files.',
    'Use them to align package commands, framework file structure, config names, syntax, and implementation details with current documentation.',
    '',
    'Rules:',
    '- Prefer official documentation first for CLI commands, framework conventions, package setup, and configuration keys.',
    '- Use GitHub repository documentation and source examples next when official docs are incomplete.',
    '- Use StackOverflow or other community material only as secondary implementation guidance, never as the sole source of truth for required config or package commands.',
    '- When debugging a failed build, test, or install, treat the failing command output as the primary symptom and use references that explain that exact package, file path, config key, or error text.',
    '- When referencing another file, use the exact file path and filename provided by the workspace directory or plan. Do not invent alternate paths, rename files casually, or drop extensions.',
    '- Follow the documented framework entrypoints and expected scaffold shape instead of inventing abstract folder structures unless the user explicitly asked for a custom architecture.',
    '',
    blocks.join('\n\n'),
    '---',
  ].join('\n');
}
