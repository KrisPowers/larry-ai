// FILE: src/components/ChatPanel.tsx
import { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { ChatComposer, type ChatComposerOption } from './ChatComposer';
import { MessageBubble } from './MessageBubble';
import { FileRegistryPanel } from './FileRegistryPanel';
import { chatOnce, getModelProvider, resolveModelHandle, streamChat } from '../lib/ollama';
import { classifyRequest, resolvePackageVersions, planRequest, buildStepUserMessage, getStepExecutorSystem, buildSummaryUserMessage, getSummarySystem, packageVersionsToSystemInject } from '../lib/deepPlanner';
import type { ClassificationResult, DeepStep, PackageVersion, RequestMode } from '../lib/deepPlanner';
import { registryToSystemPrompt, updateRegistry } from '../lib/fileRegistry';
import { extractCodeBlocksForRegistry, hasFileComment, parseContent, stripFileComment } from '../lib/markdown';
import type { CodeBlock } from '../lib/markdown';
import { readImportableAttachments } from '../lib/chatAttachments';
import { buildChatAwarenessTurnContent, buildExchangeMemory, isLikelyCorrectionFollowUp } from '../lib/chatAwareness';
import { extractUrlsFromText, fetchUrlsFromPrompt, fetchGlobalContext, getRequiredLiveSourceCount, shouldFetchGlobalContext, urlContextToSystemInject, globalContextToSystemInject, globalContextToConversationInject, extractCrewRosterFromContexts, extractCaseParticipantRosterFromContexts } from '../lib/fetcher';
import type { ExtractedCaseParticipantMember, ExtractedCrewRosterMember, FetchContextDepth, FetchedContext } from '../lib/fetcher';
import { buildCodeResearchSystemInject, fetchCodeResearchContext } from '../lib/codeResearch';
import { reviewAssistantReply } from '../lib/replyReview';
import { PRESETS, getPreset, DEFAULT_PRESET_ID, describePreset } from '../lib/presets';
import { classifyChatWorkflow } from '../lib/chatMode';
import { EXPORTED_SOURCE_METADATA_END, EXPORTED_SOURCE_METADATA_START } from '../lib/chatLog';
import { useReplyPreferences } from '../hooks/useReplyPreferences';
import { buildReplyPreferenceId, buildReplyPreferenceInject, cleanReplyPreferenceText } from '../lib/replyPreferences';
import { computeDiff } from '../lib/diffMetrics';
import { isConventionalExtensionlessWorkspaceFile, workspaceFilePathHasDefinedType } from '../lib/workspaceFileTypes';
import {
  IconX,
  IconHexagon,
  IconDownload,
  IconRotateCcw,
} from './Icon';
import type {
  ChatReasoningEffort,
  InterruptedTaskState,
  Panel,
  Message,
  MessageWorkspaceChangeSet,
  ReplyFeedback,
  ReplyPreferenceRecord,
  ResponseTrace,
  ResponseTraceMetric,
  ResponseTracePhase,
  ResponseTracePlannerStep,
  ResponseTraceSource,
  ThreadType,
  WorkspaceBackupReference,
  WorkspaceCommandResult,
  WorkspaceRuntimeProfile,
} from '../types';
import type { FileEntry, FileRegistry } from '../lib/fileRegistry';

interface Props {
  panel: Panel;
  models: string[];
  showAdvancedUse?: boolean;
  onUpdate: (id: string, patch: Partial<Panel>) => void;
  onClose: (id: string) => void;
  onSave: (panel: Panel) => void;
  selected?: boolean;
  backgroundMode?: boolean;
  onActivate?: (id: string) => void;
  onImportWorkspaceFiles?: (files: File[]) => void;
  launchPrompt?: string | null;
  onConsumeLaunchPrompt?: (panelId: string) => void;
  onPrepareWorkspaceRun?: (panel: Panel, prompt: string) => Promise<WorkspaceBackupReference | null>;
  onReadWorkspaceContext?: (
    panel: Panel,
  ) => Promise<{
    fileEntries: FileEntry[];
    workspaceEntryPaths?: string[];
  } | null>;
  onApplyWorkspaceStep?: (
    panel: Panel,
    step: { path: string; content: string },
  ) => Promise<{
    writtenPaths: string[];
    fileEntries: FileEntry[];
  }>;
  onCommitWorkspaceRun?: (
    panel: Panel,
    prompt: string,
    options: { writtenPaths: string[] },
    onProgress?: (step: { id: string; label: string; detail?: string }) => void,
  ) => Promise<{
    writtenPaths: string[];
    fileEntries: FileEntry[];
    profile: WorkspaceRuntimeProfile | null;
    dependencyRefreshes: WorkspaceCommandResult[];
    validations: WorkspaceCommandResult[];
    setupGuidePath: string | null;
  }>;
  onRestoreWorkspaceBackup?: (workspaceId: string, backup: WorkspaceBackupReference) => Promise<void>;
}

const activeLaunchPromptRuns = new Set<string>();
const MESSAGE_OVERSCAN_PX = 640;
const MESSAGE_STACK_GAP_PX = 12;
const STICKY_SCROLL_THRESHOLD_PX = 96;
const MESSAGE_WHEEL_DAMPING = 0.72;
const MAX_WORKSPACE_REPAIR_ATTEMPTS = 8;
const WORKSPACE_MANIFEST_PACKAGE_LIMIT = 24;
const WORKSPACE_DIGEST_MAX_CHARS = 4_500;
const WORKSPACE_DIGEST_PREVIEW_LINE_LIMIT = 2;
const PREWRITE_TECHNICAL_DOC_WAIT_MS = 10_000;
const PREWRITE_PACKAGE_WAIT_MS = 5_000;
const MANIFEST_PACKAGE_VERSION_WAIT_MS = 4_000;
const CODE_RESEARCH_MAX_SOURCES = 4;
const WORKSPACE_FAILURE_ANSI_RE = /\u001b\[[0-9;]*m/g;
const WORKSPACE_FAILURE_FILE_RE = /\b(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html|md|go|py|rs)\b/g;
const DIRECT_CODE_REPLY_SYSTEM = [
  'You are a senior software engineer helping inside a live workspace.',
  'Respond directly to the current coding request.',
  '- If the user asked for a snippet, example, or utility, return a focused code answer instead of planning a whole project.',
  '- Do not invent file paths or workspace edits unless the user explicitly asked for real project file changes.',
  '- If you return a real workspace file, include the FILE declaration on the first line of the code block.',
  '- If the user asked for an explanation, explain the relevant code and behavior clearly before suggesting changes.',
  '- Keep the explanation concise and practical.',
].join('\n');

interface WorkspaceFailureFocusFile {
  path: string;
  reason: string;
  previewLines: string[];
}

interface WorkspaceFailureDiagnostics {
  summary: string;
  previewLines: string[];
  focusFiles: WorkspaceFailureFocusFile[];
}

interface WorkspaceExtractionDiagnostic {
  code: string;
  detail: string;
  targetPath: string;
  detectedBlocks: string[];
  draftPreview: string;
}

const STEP_FILE_REPAIR_SYSTEM = [
  'You are repairing a workspace code-generation step.',
  'Return exactly one fenced code block for exactly one file.',
  'Do not include any prose before or after the code block.',
  'The code block must contain the complete file for the requested path.',
  'The first line inside the block must declare the file path, or the fence label must carry the file path for JSON/YAML.',
  'If the target is a support file or manifest such as .env.example, go.mod, go.sum, requirements.txt, or Cargo.toml, still return a single fenced block and put the exact file path in the block.',
  'Do not invent a different file path.',
].join('\n');

function normalizeWorkspaceRelativePath(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function buildRegistryFromWorkspaceEntries(entries: FileEntry[] | undefined): FileRegistry {
  return new Map((entries ?? []).map((entry) => [entry.path, { ...entry }]));
}

function stripWorkspaceFailureAnsi(value: string): string {
  return value.replace(WORKSPACE_FAILURE_ANSI_RE, '');
}

function normalizeWorkspaceFailureLine(value: string): string {
  return stripWorkspaceFailureAnsi(value).replace(/\s+/g, ' ').trim();
}

function extractWorkspaceFailureText(failures: WorkspaceCommandResult[]): string {
  return failures
    .flatMap((failure) => [failure.command, failure.stderr, failure.stdout, failure.combinedOutput])
    .map((value) => stripWorkspaceFailureAnsi(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

function resolveRegistryPathFromFailureCandidate(candidate: string, registry: FileRegistry): string | null {
  const normalizedCandidate = candidate
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
  if (!normalizedCandidate) return null;

  const registryPaths = [...registry.keys()];
  const exactMatch = registryPaths.find((path) => path.toLowerCase() === normalizedCandidate);
  if (exactMatch) return exactMatch;

  const suffixMatch = registryPaths.find((path) => {
    const normalizedPath = path.toLowerCase();
    return normalizedCandidate.endsWith(`/${normalizedPath}`) || normalizedPath.endsWith(`/${normalizedCandidate}`);
  });
  return suffixMatch ?? null;
}

function extractWorkspaceFailurePreviewLines(failureText: string): string[] {
  const lines = failureText.replace(/\r\n/g, '\n').split('\n');
  const preview = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\s*\d+\s*\|\s*(.+?)\s*$/);
    const normalized = normalizeWorkspaceFailureLine(match?.[1] ?? '');
    if (!normalized) continue;
    preview.add(normalized);
    if (preview.size >= 6) break;
  }
  return [...preview];
}

function isCssLikeWorkspacePath(path: string): boolean {
  return /\.(?:css|scss|sass|less)$/i.test(path);
}

function findPreviewMatchedWorkspacePaths(previewLines: string[], registry: FileRegistry, limit = 3): string[] {
  if (!previewLines.length || !registry.size) return [];

  const normalizedPreviewLines = previewLines.map(normalizeWorkspaceFailureLine);
  const scored = [...registry.values()]
    .map((entry) => {
      const fileLines = entry.content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(normalizeWorkspaceFailureLine);
      let matched = 0;
      let lastIndex = -1;
      let firstMatchIndex = Number.POSITIVE_INFINITY;

      for (const previewLine of normalizedPreviewLines) {
        let nextIndex = fileLines.findIndex((line, index) => index > lastIndex && line === previewLine);
        if (nextIndex === -1) {
          nextIndex = fileLines.findIndex((line, index) => index > lastIndex && line.includes(previewLine));
        }
        if (nextIndex === -1) continue;
        matched += 1;
        lastIndex = nextIndex;
        if (firstMatchIndex === Number.POSITIVE_INFINITY) {
          firstMatchIndex = nextIndex;
        }
      }

      return {
        path: entry.path,
        matched,
        firstMatchIndex: Number.isFinite(firstMatchIndex) ? firstMatchIndex : 999_999,
        cssBonus: isCssLikeWorkspacePath(entry.path) ? 1 : 0,
      };
    })
    .filter((entry) => entry.matched > 0)
    .sort((left, right) => {
      if (right.matched !== left.matched) return right.matched - left.matched;
      if (right.cssBonus !== left.cssBonus) return right.cssBonus - left.cssBonus;
      if (left.firstMatchIndex !== right.firstMatchIndex) return left.firstMatchIndex - right.firstMatchIndex;
      return left.path.localeCompare(right.path);
    });

  return scored.slice(0, limit).map((entry) => entry.path);
}

function buildWorkspaceFailureDiagnostics(
  failures: WorkspaceCommandResult[],
  registry: FileRegistry,
): WorkspaceFailureDiagnostics {
  const failureText = extractWorkspaceFailureText(failures);
  const normalizedFailureText = failureText.toLowerCase();
  const previewLines = extractWorkspaceFailurePreviewLines(failureText);
  const focusFiles: WorkspaceFailureFocusFile[] = [];
  const seenPaths = new Set<string>();
  const addFocusFile = (path: string | null | undefined, reason: string) => {
    if (!path || seenPaths.has(path) || !registry.has(path)) return;
    seenPaths.add(path);
    focusFiles.push({ path, reason, previewLines });
  };

  for (const match of failureText.matchAll(WORKSPACE_FAILURE_FILE_RE)) {
    addFocusFile(
      resolveRegistryPathFromFailureCandidate(match[0] ?? '', registry),
      'Referenced directly in the failing command output.',
    );
    if (focusFiles.length >= 3) break;
  }

  for (const path of findPreviewMatchedWorkspacePaths(previewLines, registry, 3)) {
    addFocusFile(path, 'Its current contents match the line preview shown in the failing build output.');
    if (focusFiles.length >= 3) break;
  }

  if (/lightningcss|vite:css|postcss|pseudo element|invalid token/i.test(normalizedFailureText)) {
    for (const entry of [...registry.values()].filter((candidate) => isCssLikeWorkspacePath(candidate.path)).sort((left, right) => left.path.localeCompare(right.path))) {
      addFocusFile(entry.path, 'The failing output points to the CSS pipeline, so the current stylesheet is a likely source.');
      if (focusFiles.length >= 3) break;
    }
  }

  if (/\bpackage\.json\b|npm error|pnpm error|yarn error|eresolve|etarget|no matching version found|peer vite/i.test(normalizedFailureText)) {
    addFocusFile(registry.has('package.json') ? 'package.json' : null, 'The failing output points to dependency or manifest issues.');
    addFocusFile(registry.has('vite.config.ts') ? 'vite.config.ts' : registry.has('vite.config.js') ? 'vite.config.js' : null, 'The failing output references the Vite toolchain or plugin configuration.');
  }

  const summaryParts: string[] = [];
  if (/syntaxerror|invalid token|unexpected token/i.test(normalizedFailureText)) {
    summaryParts.push('The blocker is a syntax error, so the next repair must fix invalid source text before anything else.');
  }
  if (/lightningcss|vite:css|postcss/i.test(normalizedFailureText)) {
    summaryParts.push('The error is coming from the CSS pipeline, so the repair should focus on stylesheet syntax and invalid selectors/tokens.');
  }
  if (/npm error|eresolve|etarget|no matching version found|peer /i.test(normalizedFailureText)) {
    summaryParts.push('The blocker is dependency resolution, so the repair should focus on manifest versions and package compatibility.');
  }
  if (!summaryParts.length) {
    summaryParts.push('The next repair must identify the exact failing file, line, or config key from the command output and fix that blocker first.');
  }

  return {
    summary: summaryParts.join(' '),
    previewLines,
    focusFiles: focusFiles.slice(0, 3),
  };
}

function buildNumberedWorkspaceExcerpt(content: string, previewLines: string[], maxLines = 80): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const normalizedPreviewLines = previewLines.map(normalizeWorkspaceFailureLine).filter(Boolean);
  let matchIndex = -1;

  if (normalizedPreviewLines.length > 0) {
    matchIndex = lines.findIndex((line) => {
      const normalizedLine = normalizeWorkspaceFailureLine(line);
      return normalizedPreviewLines.some((previewLine) => normalizedLine === previewLine || normalizedLine.includes(previewLine));
    });
  }

  const start = matchIndex >= 0
    ? Math.max(0, matchIndex - 4)
    : 0;
  const end = matchIndex >= 0
    ? Math.min(lines.length, matchIndex + Math.max(normalizedPreviewLines.length, 1) + 4)
    : Math.min(lines.length, maxLines);
  const lineNumberWidth = String(end).length;
  const excerpt = lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(lineNumberWidth, ' ')} | ${line}`)
    .join('\n');

  if (end < lines.length) {
    return `${excerpt}\n...`;
  }
  return excerpt;
}

function buildWorkspaceRepairFocusContext(
  diagnostics: WorkspaceFailureDiagnostics,
  registry: FileRegistry,
): string {
  const sections: string[] = [];

  if (diagnostics.summary) {
    sections.push(`Failure diagnosis: ${diagnostics.summary}`);
  }

  if (diagnostics.previewLines.length > 0) {
    sections.push([
      'Failing output line preview:',
      ...diagnostics.previewLines.map((line) => `- ${line}`),
    ].join('\n'));
  }

  if (diagnostics.focusFiles.length > 0) {
    sections.push([
      'Most likely workspace files involved in the failure:',
      ...diagnostics.focusFiles.map((focusFile) => {
        const entry = registry.get(focusFile.path)!;
        return [
          `### ${focusFile.path}`,
          `Reason: ${focusFile.reason}`,
          `\`\`\`${entry.lang || 'text'}`,
          buildNumberedWorkspaceExcerpt(entry.content, focusFile.previewLines),
          '```',
        ].join('\n');
      }),
    ].join('\n\n'));
  }

  if (!sections.length) return '';
  return `\n\n${sections.join('\n\n')}`;
}

function buildHeuristicRepairPlanFromDiagnostics(
  diagnostics: WorkspaceFailureDiagnostics,
  registry: FileRegistry,
  repairAttempt: number,
): { projectSummary: string; steps: DeepStep[] } | null {
  if (!diagnostics.focusFiles.length) return null;

  const steps = diagnostics.focusFiles
    .slice(0, 3)
    .reduce<DeepStep[]>((acc, focusFile, index) => {
      const entry = registry.get(focusFile.path);
      if (!entry) return acc;

      const purpose = isCssLikeWorkspacePath(focusFile.path)
        ? 'Fix the exact CSS syntax/build issue shown in the failing command output. Return valid stylesheet code only, remove any stray prose/markdown or invalid tokens, and keep the file aligned with the current Vite build pipeline.'
        : focusFile.path === 'package.json'
          ? 'Fix the exact dependency or manifest issue shown in the failing command output. Keep only compatible package versions and valid manifest fields so install/build can pass on the next retest.'
          : `Fix the exact validation error affecting ${focusFile.path}. Use the failing command output and the current file contents to make the minimal complete repair so the next retest can pass.`;

      acc.push({
        stepNumber: index + 1,
        label: focusFile.path,
        filePath: focusFile.path,
        purpose: `${purpose} ${focusFile.reason}`,
        imports: [],
        exports: [],
        isSupport: false,
      });
      return acc;
    }, []);

  if (!steps.length) return null;

  return {
    projectSummary: `Automated repair attempt ${repairAttempt}: focus the fix on the files implicated by the failing validation output.`,
    steps,
  };
}

function buildMessageWorkspaceChanges(
  previousRegistry: FileRegistry,
  nextRegistry: FileRegistry,
  backup: WorkspaceBackupReference | null,
): MessageWorkspaceChangeSet | null {
  const changedPaths = new Set<string>();
  for (const path of previousRegistry.keys()) changedPaths.add(path);
  for (const path of nextRegistry.keys()) changedPaths.add(path);

  const files = [...changedPaths]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path) => {
      const previous = previousRegistry.get(path);
      const next = nextRegistry.get(path);
      const previousContent = previous?.content;
      const nextContent = next?.content;
      const previousLang = previous?.lang ?? '';
      const nextLang = next?.lang ?? '';

      if (
        previousContent === nextContent
        && previousLang === nextLang
      ) {
        return [];
      }

      return [{
        path,
        lang: next?.lang ?? previous?.lang ?? 'text',
        previousContent,
        nextContent,
      }];
    });

  if (!files.length) return null;

  return {
    files,
    backup,
  };
}

function buildWorkspaceDirectoryInject(registry: FileRegistry): string {
  if (!registry.size) return '';

  const paths = [...registry.keys()].sort((left, right) => left.localeCompare(right));
  const visiblePaths = paths.slice(0, 320);
  const remaining = paths.length - visiblePaths.length;

  return [
    '',
    '---',
    '## Workspace directory',
    ...visiblePaths.map((path) => `- ${path}`),
    ...(remaining > 0 ? [`- ...and ${remaining} more file${remaining === 1 ? '' : 's'}`] : []),
    '---',
  ].join('\n');
}

function collectWorkspaceParentDirectoryPaths(path: string): string[] {
  const normalized = normalizeWorkspaceRelativePath(path);
  if (!normalized) return [];

  const segments = normalized.split('/').filter(Boolean);
  const parentPaths: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parentPaths.push(segments.slice(0, index).join('/'));
  }
  return parentPaths;
}

function buildWorkspaceEntryInventory(
  entryPaths: string[],
  registry?: FileRegistry,
  extraPaths: string[] = [],
): string[] {
  const merged = new Set<string>();
  const addPath = (candidatePath?: string | null) => {
    if (!candidatePath) return;
    const normalized = normalizeWorkspaceRelativePath(candidatePath);
    if (!normalized) return;
    merged.add(normalized);
    for (const parentPath of collectWorkspaceParentDirectoryPaths(normalized)) {
      merged.add(parentPath);
    }
  };

  entryPaths.forEach(addPath);
  registry?.forEach((_entry, path) => addPath(path));
  extraPaths.forEach(addPath);

  return [...merged].sort((left, right) => left.localeCompare(right));
}

function extractWorkspaceDigestItems(
  content: string,
  pattern: RegExp,
  limit = 4,
): string[] {
  const matches = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    matches.add(candidate);
    if (matches.size >= limit) break;
  }
  return [...matches];
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutHandle: number | null = null;
  try {
    const value = await Promise.race([
      promise.then((resolved) => ({ value: resolved, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timeoutHandle = window.setTimeout(() => {
          resolve({ value: fallback, timedOut: true });
        }, timeoutMs);
      }),
    ]);
    return value;
  } finally {
    if (timeoutHandle != null) {
      window.clearTimeout(timeoutHandle);
    }
  }
}

function isWorkspaceDigestPriorityPath(path: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|vite\.config\.[^/]+|index\.html|src\/main\.[^/]+|src\/app\.[^/]+|src\/App\.[^/]+|go\.mod|pyproject\.toml|requirements\.txt|cargo\.toml|readme(?:\.[^/]+)?|dockerfile)$/i.test(path);
}

function summariseWorkspaceEntry(entry: FileEntry): string {
  const lines = entry.content.replace(/\r\n/g, '\n').split('\n');
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  const prioritized = isWorkspaceDigestPriorityPath(entry.path);
  const preview = isWorkspaceDigestPriorityPath(entry.path)
    ? nonEmptyLines
        .slice(0, WORKSPACE_DIGEST_PREVIEW_LINE_LIMIT)
        .map((line) => line.slice(0, 72))
        .join(' | ')
    : '';
  const imports = prioritized
    ? extractWorkspaceDigestItems(
        entry.content,
        /(?:import\s+[^'"]*from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g,
      )
    : [];
  const exports = prioritized
    ? extractWorkspaceDigestItems(
        entry.content,
        /(?:export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+|module\.exports\s*=\s*)([A-Za-z0-9_$]+)/g,
      )
    : [];
  const details = [
    `${entry.lang || 'text'}`,
    `${lines.length} line${lines.length === 1 ? '' : 's'}`,
    ...(imports.length > 0 ? [`imports ${imports.join(', ')}`] : []),
    ...(exports.length > 0 ? [`exports ${exports.join(', ')}`] : []),
    ...(preview ? [`preview ${preview}`] : []),
  ];

  return `- ${entry.path} [${details.join(' | ')}]`;
}

function buildWorkspaceAnalysisDigest(registry: FileRegistry, maxChars = WORKSPACE_DIGEST_MAX_CHARS): string {
  if (!registry.size) return '';

  const entries = [...registry.values()].sort((left, right) => left.path.localeCompare(right.path));
  const fullLines = entries.map((entry) => summariseWorkspaceEntry(entry));
  let section = [
    '',
    'Existing workspace file analysis:',
    'Every line below was derived from the current readable files in the workspace before planning.',
    ...fullLines,
  ].join('\n');

  if (section.length <= maxChars) return section;

  const compactLines = entries.map((entry) => {
    const lines = entry.content.replace(/\r\n/g, '\n').split('\n').length;
    return `- ${entry.path} [${entry.lang || 'text'} | ${lines} lines]`;
  });
  section = [
    '',
    'Existing workspace file analysis:',
    'Every line below was derived from the current readable files in the workspace before planning.',
    ...compactLines,
  ].join('\n');

  if (section.length <= maxChars) return section;

  const output: string[] = [
    '',
    'Existing workspace file analysis:',
    'Every line below was derived from the current readable files in the workspace before planning.',
  ];
  let length = output.join('\n').length;
  let includedCount = 0;
  for (const line of compactLines) {
    if (length + line.length + 1 > maxChars) break;
    output.push(line);
    length += line.length + 1;
    includedCount += 1;
  }

  const remaining = compactLines.length - includedCount;
  if (remaining > 0) {
    output.push(`- ...and ${remaining} more readable workspace file${remaining === 1 ? '' : 's'} were analyzed before planning.`);
  }

  return output.join('\n');
}

function buildWorkspaceFocusedContext(
  registry: FileRegistry,
  step: DeepStep,
  alreadyWritten: Array<{ path: string; exports: string[] }>,
): string {
  if (!registry.size) return '';

  const normalizedTargetPath = normalizeWorkspaceRelativePath(step.filePath);
  const targetDir = normalizedTargetPath.includes('/')
    ? normalizedTargetPath.slice(0, normalizedTargetPath.lastIndexOf('/'))
    : '';
  const selectedPaths: string[] = [];
  const seen = new Set<string>();
  const addPath = (candidatePath?: string | null) => {
    if (!candidatePath) return;
    const normalized = normalizeWorkspaceRelativePath(candidatePath);
    if (!normalized || seen.has(normalized) || !registry.has(normalized)) return;
    seen.add(normalized);
    selectedPaths.push(normalized);
  };

  addPath(normalizedTargetPath);
  step.imports.forEach((candidatePath) => addPath(candidatePath));

  for (const entry of [...alreadyWritten].reverse()) {
    addPath(entry.path);
    if (selectedPaths.length >= 8) break;
  }

  [
    'package.json',
    'tsconfig.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'requirements.txt',
    'README.md',
    'vite.config.ts',
    'vite.config.js',
    'wails.json',
  ].forEach((candidatePath) => addPath(candidatePath));

  if (targetDir) {
    for (const path of [...registry.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!path.startsWith(`${targetDir}/`) || path === normalizedTargetPath) continue;
      addPath(path);
      if (selectedPaths.length >= 10) break;
    }
  }

  if (!selectedPaths.length) return '';

  return [
    '',
    'Relevant current workspace files:',
    ...selectedPaths.map((path) => {
      const entry = registry.get(path)!;
      return `### ${path}\n\`\`\`${entry.lang}\n${entry.content}\n\`\`\``;
    }),
  ].join('\n\n');
}

function isWorkspaceIgnoreFilePath(path: string): boolean {
  const basename = workspaceSupportBasename(path).toLowerCase();
  return basename === '.gitignore'
    || basename === '.dockerignore'
    || basename === '.npmignore'
    || basename === '.eslintignore'
    || basename === '.prettierignore';
}

function buildWorkspaceIgnoreFileContext(
  registry: FileRegistry,
  step: DeepStep,
  workspaceEntryPaths: string[],
): string {
  if (!isWorkspaceIgnoreFilePath(step.filePath)) return '';

  const entryInventory = buildWorkspaceEntryInventory(workspaceEntryPaths, registry, [step.filePath]);
  if (!entryInventory.length) return '';

  const visiblePaths = entryInventory.slice(0, 420);
  const remaining = entryInventory.length - visiblePaths.length;
  const envPaths = entryInventory
    .filter((path) => /(^|\/)\.env(?:\.[^/]+)?$/i.test(path))
    .slice(0, 16);
  const lockfilePaths = entryInventory
    .filter((path) => /(^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(path))
    .slice(0, 16);
  const databasePaths = entryInventory
    .filter((path) => /\.(?:db|sqlite|sqlite3|sql)$/i.test(path))
    .slice(0, 16);
  const hasNodeManifest = entryInventory.some((path) => /(^|\/)package\.json$/i.test(path));

  const candidateLines: string[] = [];
  if (hasNodeManifest) {
    candidateLines.push('- Node package manifests are present, so dependency directories like `node_modules/` and local lockfiles like `package-lock.json` should be evaluated as ignore candidates.');
  }
  if (envPaths.length > 0) {
    candidateLines.push(`- Environment files found in the workspace tree: ${envPaths.map((path) => `\`${path}\``).join(', ')}.`);
  }
  if (lockfilePaths.length > 0) {
    candidateLines.push(`- Lockfiles found in the workspace tree: ${lockfilePaths.map((path) => `\`${path}\``).join(', ')}.`);
  }
  if (databasePaths.length > 0) {
    candidateLines.push(`- Local database or SQL files found in the workspace tree: ${databasePaths.map((path) => `\`${path}\``).join(', ')}.`);
  }

  return [
    '',
    'Recursive workspace inventory for ignore-file generation:',
    'Treat the list below as if you changed into the workspace root and recursively listed every subfolder before writing this ignore file.',
    ...visiblePaths.map((path) => `- ${path}`),
    ...(remaining > 0 ? [`- ...and ${remaining} more workspace entr${remaining === 1 ? 'y' : 'ies'}`] : []),
    '',
    'Ignore-file guidance:',
    ...(candidateLines.length > 0
      ? candidateLines
      : ['- Ignore machine-local env files, dependency folders, local database files, generated output, and similar workspace-local artifacts when they appear in the tree above.']),
    '- Prefer ignore patterns that match the real folders and files already present in the recursive inventory.',
  ].join('\n');
}

function buildTechnicalPlanningContext(contexts: FetchedContext[]): string {
  if (!contexts.length) return '';

  return [
    '',
    'Technical references gathered for this request:',
    ...contexts.slice(0, 6).map((context) => `- ${context.title}${context.url ? ` (${context.url})` : ''}`),
  ].join('\n');
}

function buildPlannerWorkspacePrompt(
  userPrompt: string,
  registry: FileRegistry,
  technicalContexts: FetchedContext[] = [],
  workspaceAnalysis = '',
): string {
  if (!registry.size && technicalContexts.length === 0 && !workspaceAnalysis) return userPrompt;

  const paths = [...registry.keys()].sort((left, right) => left.localeCompare(right));
  const visiblePaths = paths.slice(0, 140);
  const remaining = paths.length - visiblePaths.length;
  const workspaceSection = registry.size > 0
    ? [
        '',
        'Known workspace files:',
        ...visiblePaths.map((path) => `- ${path}`),
        ...(remaining > 0 ? [`- ...and ${remaining} more file${remaining === 1 ? '' : 's'}`] : []),
      ]
    : [];

  return [
    userPrompt,
    buildTechnicalPlanningContext(technicalContexts),
    workspaceAnalysis,
    ...workspaceSection,
  ].join('\n');
}

function buildWorkspaceStepUserMessage(
  plan: {
    projectSummary: string;
    mode: RequestMode;
    steps: DeepStep[];
  },
  step: DeepStep,
  alreadyWritten: Array<{ path: string; exports: string[] }>,
  registry: FileRegistry,
  workspaceEntryPaths: string[] = [],
): string {
  const ignoreContext = buildWorkspaceIgnoreFileContext(registry, step, workspaceEntryPaths);
  return [
    buildStepUserMessage(plan, step, alreadyWritten),
    buildWorkspaceFocusedContext(registry, step, alreadyWritten),
    ignoreContext,
    '',
    isWorkspaceIgnoreFilePath(step.filePath)
      ? 'Use the recursive workspace inventory and current file contents above when deciding what this ignore file should cover.'
      : 'Use the workspace directory and current file contents above when deciding imports, structure, and pathing.',
    'When you reference another file, use the exact path and filename shown above or already completed in a previous step.',
    'If the target file already exists, return the complete updated file content for that file.',
  ].join('\n');
}

function stripGeneratedFilePreamble(value: string, targetPath: string): string {
  const normalizedTargetPath = normalizeWorkspaceRelativePath(targetPath);
  const targetBasename = normalizedTargetPath.split('/').pop() ?? normalizedTargetPath;
  const lines = value.replace(/\r\n/g, '\n').split('\n');

  while (lines.length > 0) {
    const first = lines[0].trim();
    if (!first) {
      lines.shift();
      continue;
    }

    const normalizedFirst = normalizeWorkspaceRelativePath(first.replace(/^`+|`+$/g, '').replace(/^file:\s*/i, ''));
    const isFileDirective = /^\/\/\s*FILE:/i.test(first)
      || /^#\s*FILE:/i.test(first)
      || /^<!--\s*FILE:/i.test(first)
      || /^\/\*\s*FILE:/i.test(first)
      || normalizedFirst === normalizedTargetPath
      || normalizedFirst === targetBasename;

    if (!isFileDirective) break;
    lines.shift();
  }

  return lines.join('\n').replace(/^\n+/, '');
}

function tryExtractStructuredJsonPayload(value: string, targetPath: string): string | null {
  const stripped = stripGeneratedFilePreamble(value, targetPath).trim();
  if (!stripped) return null;

  const candidates = new Set<string>([stripped]);
  const firstObject = stripped.indexOf('{');
  const lastObject = stripped.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(stripped.slice(firstObject, lastObject + 1).trim());
  }

  const firstArray = stripped.indexOf('[');
  const lastArray = stripped.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.add(stripped.slice(firstArray, lastArray + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function sanitizeWorkspaceGeneratedFileContent(value: string, targetPath: string): string | null {
  const stripped = stripGeneratedFilePreamble(value, targetPath);
  const normalizedTargetPath = normalizeWorkspaceRelativePath(targetPath).toLowerCase();

  if (normalizedTargetPath.endsWith('.json')) {
    return tryExtractStructuredJsonPayload(stripped, targetPath);
  }

  if (/\.(?:ya?ml)$/.test(normalizedTargetPath)) {
    return stripGeneratedFilePreamble(stripped, targetPath);
  }

  return stripped;
}

function looksLikeWorkspaceTextConfigContent(value: string): boolean {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let inspected = 0;
  let configish = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    inspected += 1;
    if (
      /^#/.test(line)
      || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)
      || /^[A-Za-z_][A-Za-z0-9_.-]*:\s+\S/.test(line)
      || /^\{\{[^}]+\}\}$/.test(line)
      || /^export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(line)
    ) {
      configish += 1;
    }
    if (inspected >= 12) break;
  }

  return inspected > 0 && configish >= Math.max(1, Math.ceil(inspected * 0.45));
}

function looksLikeWorkspaceIgnoreContent(value: string): boolean {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let inspected = 0;
  let ignoreLike = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    inspected += 1;

    if (/^#/.test(line)) {
      ignoreLike += 1;
      if (inspected >= 18) break;
      continue;
    }

    const candidate = line.replace(/^!/, '');
    if (
      /^(?:\/|\*\*\/)?[A-Za-z0-9._*@?{}-]+(?:\/[A-Za-z0-9._*@?{}-]+)*\/?$/.test(candidate)
      || /^(?:\/|\*\*\/)?\.[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._*@?{}-]+)*\/?$/.test(candidate)
    ) {
      ignoreLike += 1;
    }

    if (inspected >= 18) break;
  }

  return inspected > 0 && ignoreLike >= Math.max(1, Math.ceil(inspected * 0.7));
}

function workspaceSupportBasename(path: string): string {
  const normalized = normalizeWorkspaceRelativePath(path);
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function looksLikeGoModContent(value: string): boolean {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  let score = 0;
  if (/^module\s+\S+$/.test(lines[0])) score += 2;
  if (lines.some((line) => /^(?:go|toolchain)\s+\S+$/i.test(line))) score += 1;
  if (lines.some((line) => /^(?:require|replace|exclude|retract)\b/i.test(line))) score += 1;
  if (lines.some((line) => /^\S+\s+v\d+\S*(?:\s*\/\/.*)?$/i.test(line))) score += 1;
  return score >= 2;
}

function looksLikeGoSumContent(value: string): boolean {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  const matchingLines = lines.filter((line) =>
    /^\S+\s+v\S+(?:\/go\.mod)?\s+h1:[A-Za-z0-9+/=]+$/i.test(line),
  );
  return matchingLines.length >= Math.max(1, Math.ceil(lines.length * 0.6));
}

function looksLikeTomlSupportContent(value: string): boolean {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  let score = 0;
  for (const line of lines.slice(0, 18)) {
    if (/^#/.test(line)) continue;
    if (/^\[[^\]]+\]$/.test(line) || /^[A-Za-z0-9_.-]+\s*=\s*.+$/.test(line)) {
      score += 1;
    }
  }
  return score >= Math.max(1, Math.ceil(Math.min(lines.length, 6) * 0.45));
}

function looksLikeRequirementsTxtContent(value: string): boolean {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  const matchingLines = lines.filter((line) =>
    /^#/.test(line)
    || /^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:==|>=|<=|~=|>|<)\s*[^#\s]+)?(?:\s+#.*)?$/.test(line),
  );
  return matchingLines.length >= Math.max(1, Math.ceil(lines.length * 0.7));
}

function inferWorkspaceSupportLang(path: string): string {
  const basename = workspaceSupportBasename(path).toLowerCase();
  if (basename.endsWith('.json')) return 'json';
  if (basename.endsWith('.yaml') || basename.endsWith('.yml')) return 'yaml';
  if (basename.endsWith('.toml')) return 'toml';
  if (basename === 'go.mod' || basename === 'go.sum') return 'text';
  if (basename === 'requirements.txt') return 'text';
  return 'text';
}

function isRawWorkspaceSupportPath(path: string): boolean {
  const basename = workspaceSupportBasename(path).toLowerCase();
  return isConventionalExtensionlessWorkspaceFile(path)
    || basename === 'go.mod'
    || basename === 'go.sum'
    || basename === 'requirements.txt'
    || basename.endsWith('.toml')
    || basename.endsWith('.yaml')
    || basename.endsWith('.yml');
}

function looksLikeWorkspaceSupportFileContent(path: string, value: string): boolean {
  const basename = workspaceSupportBasename(path).toLowerCase();
  if (!value.trim()) return false;

  if (isWorkspaceIgnoreFilePath(path)) {
    return looksLikeWorkspaceIgnoreContent(value);
  }

  if (isConventionalExtensionlessWorkspaceFile(path)) {
    return looksLikeWorkspaceTextConfigContent(value);
  }

  if (basename === 'go.mod') return looksLikeGoModContent(value);
  if (basename === 'go.sum') return looksLikeGoSumContent(value);
  if (basename.endsWith('.json')) return Boolean(tryExtractStructuredJsonPayload(value, path));
  if (basename.endsWith('.toml')) return looksLikeTomlSupportContent(value);
  if (basename === 'requirements.txt') return looksLikeRequirementsTxtContent(value);
  if (basename.endsWith('.yaml') || basename.endsWith('.yml')) return looksLikeWorkspaceTextConfigContent(value);

  return false;
}

function resolveRawWorkspaceSupportStepBlock(stepContent: string, stepPath: string) {
  const normalizedTargetPath = normalizeWorkspaceRelativePath(stepPath);
  if (/```|~~~/.test(stepContent)) return null;

  const content = sanitizeWorkspaceGeneratedFileContent(stepContent, normalizedTargetPath);
  if (!content) return null;

  const stripped = stripGeneratedFilePreamble(content, normalizedTargetPath).trim();
  if (!stripped || !looksLikeWorkspaceSupportFileContent(normalizedTargetPath, stripped)) return null;

  return {
    path: normalizedTargetPath,
    content: stripped,
    lang: inferWorkspaceSupportLang(normalizedTargetPath),
  };
}

function resolveWorkspaceStepBlock(stepContent: string, stepPath: string) {
  const normalizedTargetPath = normalizeWorkspaceRelativePath(stepPath);
  const sanitizeSingleBlockContent = (value: string): string | null => {
    const lines = value.replace(/\r\n/g, '\n').split('\n');
    const firstMeaningfulIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstMeaningfulIndex === -1) return sanitizeWorkspaceGeneratedFileContent(value, normalizedTargetPath);

    const firstMeaningfulLine = lines[firstMeaningfulIndex].trim().replace(/^`+|`+$/g, '');
    const fileDirectiveMatch = firstMeaningfulLine.match(/^file:\s*(.+)$/i);
    const candidatePath = normalizeWorkspaceRelativePath(fileDirectiveMatch?.[1] ?? firstMeaningfulLine);
    const targetBasename = normalizedTargetPath.split('/').pop() ?? normalizedTargetPath;

    if (candidatePath === normalizedTargetPath || candidatePath === targetBasename) {
      lines.splice(firstMeaningfulIndex, 1);
      return sanitizeWorkspaceGeneratedFileContent(lines.join('\n').replace(/^\n+/, ''), normalizedTargetPath);
    }

    return sanitizeWorkspaceGeneratedFileContent(value, normalizedTargetPath);
  };
  const blocks = extractCodeBlocksForRegistry(stepContent)
    .map((block) => ({
      ...block,
      content: sanitizeWorkspaceGeneratedFileContent(block.content, block.path),
      path: normalizeWorkspaceRelativePath(block.path),
    }))
    .filter((block): block is { path: string; content: string; lang: string } => Boolean(block.content));

  const exactMatch = blocks.find((block) => block.path === normalizedTargetPath);
  if (exactMatch) return exactMatch;

  if (blocks.length === 1) {
    const sanitizedContent = sanitizeSingleBlockContent(blocks[0].content);
    if (!sanitizedContent) return null;
    return {
      ...blocks[0],
      content: sanitizedContent,
      path: normalizedTargetPath,
    };
  }

  const parsedBlocks = parseContent(stepContent).parts
    .filter((part): part is { type: 'code'; block: CodeBlock } => part.type === 'code')
    .map((part) => ({
      path: normalizeWorkspaceRelativePath(part.block.suggestedFilename || normalizedTargetPath),
      content: sanitizeSingleBlockContent(stripFileComment(part.block.code)),
      lang: part.block.lang,
    }))
    .filter((block): block is { path: string; content: string; lang: string } => Boolean(block.content && block.content.trim().length > 0));

  if (parsedBlocks.length === 1) {
    return {
      ...parsedBlocks[0],
      path: normalizedTargetPath,
    };
  }

  const rawTextFallback = resolveRawWorkspaceSupportStepBlock(stepContent, normalizedTargetPath);
  if (rawTextFallback) return rawTextFallback;

  return null;
}

function getWorkspaceExtractionDraftPreview(value: string, maxLines = 8, maxChars = 700): string {
  const preview = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .join('\n')
    .trim();
  if (!preview) return '';
  if (preview.length <= maxChars) return preview;
  return `${preview.slice(0, maxChars - 1).trimEnd()}...`;
}

function summarizeWorkspaceExtractionBlock(options: {
  path: string;
  lang: string;
  content: string;
  sanitizedContent?: string | null;
  hasFileComment?: boolean;
}): string {
  const normalizedPath = normalizeWorkspaceRelativePath(options.path || '(no path)');
  const rawLines = options.content.replace(/\r\n/g, '\n').split('\n').length;
  const sanitizedLines = options.sanitizedContent
    ? options.sanitizedContent.replace(/\r\n/g, '\n').split('\n').length
    : 0;
  const status = options.sanitizedContent == null
    ? 'sanitization failed'
    : `${sanitizedLines} sanitized line${sanitizedLines === 1 ? '' : 's'}`;
  return `${normalizedPath} (${options.lang || 'text'}, ${rawLines} raw line${rawLines === 1 ? '' : 's'}, ${status}${options.hasFileComment === false ? ', missing FILE marker' : ''})`;
}

function diagnoseWorkspaceStepExtractionFailure(stepContent: string, stepPath: string): WorkspaceExtractionDiagnostic {
  const targetPath = normalizeWorkspaceRelativePath(stepPath);
  const draftPreview = getWorkspaceExtractionDraftPreview(stepContent);
  const trimmed = stepContent.trim();

  if (!trimmed) {
    return {
      code: 'empty_model_output',
      detail: `The model returned no text while generating ${targetPath}.`,
      targetPath,
      detectedBlocks: [],
      draftPreview,
    };
  }

  const parsedCodeBlocks = parseContent(stepContent).parts
    .filter((part): part is { type: 'code'; block: CodeBlock } => part.type === 'code')
    .map((part) => {
      const path = normalizeWorkspaceRelativePath(part.block.suggestedFilename || targetPath);
      const content = stripFileComment(part.block.code);
      return {
        path,
        content,
        lang: part.block.lang || 'text',
        hasFileComment: hasFileComment(part.block.code),
        sanitizedContent: sanitizeWorkspaceGeneratedFileContent(content, targetPath),
      };
    });

  const registryCandidates = extractCodeBlocksForRegistry(stepContent).map((block) => ({
    ...block,
    path: normalizeWorkspaceRelativePath(block.path),
    sanitizedContent: sanitizeWorkspaceGeneratedFileContent(block.content, block.path),
  }));

  const detectedBlocks = registryCandidates.length > 0
    ? registryCandidates.map((block) => summarizeWorkspaceExtractionBlock(block))
    : parsedCodeBlocks.map((block) => summarizeWorkspaceExtractionBlock(block));

  const targetCandidates = registryCandidates.filter((block) => block.path === targetPath);
  if (targetCandidates.length > 0 && targetCandidates.every((block) => !block.sanitizedContent?.trim())) {
    return {
      code: 'target_block_sanitized_empty',
      detail: `A block for ${targetPath} was found, but its content became empty or invalid after sanitization. For JSON files this usually means invalid JSON; for support files it means the file syntax did not match the expected format.`,
      targetPath,
      detectedBlocks,
      draftPreview,
    };
  }

  if (registryCandidates.length > 0 && targetCandidates.length === 0) {
    return {
      code: 'wrong_file_path',
      detail: `The model returned project file block${registryCandidates.length === 1 ? '' : 's'}, but none targeted ${targetPath}.`,
      targetPath,
      detectedBlocks,
      draftPreview,
    };
  }

  if (parsedCodeBlocks.length > 0) {
    const blocksWithFileComments = parsedCodeBlocks.filter((block) => block.hasFileComment);
    if (!blocksWithFileComments.length) {
      return {
        code: 'code_block_missing_file_marker',
        detail: `The model returned code fences, but none included a FILE marker for ${targetPath}, so the workspace writer could not safely identify which file to save.`,
        targetPath,
        detectedBlocks,
        draftPreview,
      };
    }

    if (parsedCodeBlocks.length > 1) {
      return {
        code: 'multiple_ambiguous_code_blocks',
        detail: `The model returned ${parsedCodeBlocks.length} code block${parsedCodeBlocks.length === 1 ? '' : 's'}, but the extractor could not identify one complete block for ${targetPath}.`,
        targetPath,
        detectedBlocks,
        draftPreview,
      };
    }

    return {
      code: 'code_block_not_extractable',
      detail: `The model returned a code block, but it did not resolve into a complete writable file for ${targetPath}.`,
      targetPath,
      detectedBlocks,
      draftPreview,
    };
  }

  if (isRawWorkspaceSupportPath(targetPath)) {
    const sanitized = sanitizeWorkspaceGeneratedFileContent(stepContent, targetPath);
    const stripped = sanitized ? stripGeneratedFilePreamble(sanitized, targetPath).trim() : '';
    if (!stripped) {
      return {
        code: 'raw_support_content_empty',
        detail: `The model returned raw text for ${targetPath}, but no usable support-file content remained after cleanup.`,
        targetPath,
        detectedBlocks,
        draftPreview,
      };
    }

    return {
      code: 'raw_support_syntax_rejected',
      detail: `The model returned raw text for ${targetPath}, but it did not match the expected syntax for that support-file type.`,
      targetPath,
      detectedBlocks,
      draftPreview,
    };
  }

  return {
    code: 'no_extractable_file_block',
    detail: `The model did not return a fenced project file block for ${targetPath}.`,
    targetPath,
    detectedBlocks,
    draftPreview,
  };
}

function formatWorkspaceExtractionDiagnostic(diagnostic: WorkspaceExtractionDiagnostic): string {
  return [
    `${diagnostic.detail} (${diagnostic.code})`,
    ...(diagnostic.detectedBlocks.length > 0
      ? [
          'Detected block candidates:',
          ...diagnostic.detectedBlocks.slice(0, 6).map((block) => `- ${block}`),
        ]
      : []),
    ...(diagnostic.draftPreview
      ? [
          'Draft preview:',
          diagnostic.draftPreview,
        ]
      : []),
  ].join('\n');
}

function buildWorkspaceExtractionErrorMessage(
  targetPath: string,
  diagnostic: WorkspaceExtractionDiagnostic,
  initialDiagnostic?: WorkspaceExtractionDiagnostic,
): string {
  const lines = [
    `Unable to extract a complete file for ${targetPath}.`,
    '',
    'Extraction diagnosis:',
    formatWorkspaceExtractionDiagnostic(diagnostic),
  ];

  if (initialDiagnostic && initialDiagnostic.code !== diagnostic.code) {
    lines.push(
      '',
      'Initial extraction issue before repair:',
      formatWorkspaceExtractionDiagnostic(initialDiagnostic),
    );
  }

  return lines.join('\n');
}

function mergePackageVersions(...lists: PackageVersion[][]): PackageVersion[] {
  const merged = new Map<string, PackageVersion>();
  for (const list of lists) {
    for (const pkg of list) {
      merged.set(`${pkg.ecosystem}:${pkg.name}`, pkg);
    }
  }
  return [...merged.values()];
}

function readWorkspaceManifestPackages(
  registry: FileRegistry,
  limit = WORKSPACE_MANIFEST_PACKAGE_LIMIT,
): Array<{ name: string; ecosystem: 'npm' }> {
  const manifest = registry.get('package.json');
  if (!manifest) return [];

  try {
    const parsed = JSON.parse(manifest.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const packageNames = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
    ]
      .map((name) => name.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit);

    return packageNames.map((name) => ({ name, ecosystem: 'npm' as const }));
  } catch {
    return [];
  }
}

function truncateWorkspaceFailureOutput(value: string, maxLength = 1200): string {
  const compact = value.trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}\n...`;
}

function buildWorkspaceRepairPlannerPrompt(options: {
  originalRequest: string;
  projectSummary: string;
  failures: WorkspaceCommandResult[];
  registry: FileRegistry;
  repairAttempt: number;
  workspaceAnalysis?: string;
  diagnostics?: WorkspaceFailureDiagnostics;
}): string {
  const knownPaths = [...options.registry.keys()].sort((left, right) => left.localeCompare(right));
  const visiblePaths = knownPaths.slice(0, 220);
  const remaining = knownPaths.length - visiblePaths.length;

  return [
    `Original request: ${options.originalRequest}`,
    '',
    `Current implementation summary: ${options.projectSummary}`,
    '',
    `Automated repair attempt ${options.repairAttempt} of ${MAX_WORKSPACE_REPAIR_ATTEMPTS}.`,
    'The workspace failed automated dependency installation and/or validation.',
    'Plan only the minimal file changes needed to fix the failures and make the workspace pass the next retest.',
    'Prefer editing existing files over adding new ones unless a required file is missing.',
    'If obsolete scaffold variants exist, consolidate them to one canonical path instead of keeping both JS and TS entry files side by side.',
    'Start by identifying the exact failing package, file path, symbol, config key, or syntax line from the command output below.',
    'Do not stop at diagnosis. Convert the diagnosis into concrete file edits that eliminate the exact blocking error on the next retest.',
    'If the output shows a syntax error, fix the syntax first before broader cleanup or refactoring.',
    'If the output shows line previews without a file path, match those lines against the focused workspace files below and repair the file whose contents align with the preview.',
    'If the error implicates a framework or package like Vite, React, TypeScript, npm, or a plugin, use that package or framework documentation as the primary reference while planning the repair.',
    options.repairAttempt > 1
      ? 'The previous repair did not clear the blockers. Broaden the fix as needed, including replacing incorrect scaffolds, correcting dependency versions, and removing redundant entry/config variants.'
      : 'Keep the fix focused, but make it complete enough that the very next retest can pass.',
    '',
    'Failing automated checks:',
    ...options.failures.map((failure, index) => {
      const status = failure.timedOut
        ? 'timed out'
        : `failed with exit code ${failure.exitCode}`;
      const output = truncateWorkspaceFailureOutput(
        [failure.stderr, failure.stdout, failure.combinedOutput].filter(Boolean).join('\n').trim(),
      );
      return [
        `${index + 1}. ${failure.command} ${status}`,
        ...(output ? ['Output:', output] : []),
      ].join('\n');
    }),
    '',
    'Known workspace files:',
    ...visiblePaths.map((path) => `- ${path}`),
    ...(remaining > 0 ? [`- ...and ${remaining} more file${remaining === 1 ? '' : 's'}`] : []),
    options.workspaceAnalysis ?? '',
    buildWorkspaceRepairFocusContext(options.diagnostics ?? { summary: '', previewLines: [], focusFiles: [] }, options.registry),
    '',
    'Return only the minimal debug plan needed to repair the workspace.',
  ].join('\n');
}

function collectInvalidWorkspaceStepPaths(steps: DeepStep[]): string[] {
  return [...new Set(
    steps
      .map((step) => normalizeWorkspaceRelativePath(step.filePath))
      .filter((path) => path.length > 0 && !workspaceFilePathHasDefinedType(path)),
  )];
}

async function repairWorkspaceStepOutput(options: {
  modelName: string;
  abortSignal: AbortSignal;
  request: string;
  plan: {
    projectSummary: string;
    mode: RequestMode;
    steps: DeepStep[];
  };
  step: DeepStep;
  draft: string;
  registry: FileRegistry;
  alreadyWritten: Array<{ path: string; exports: string[] }>;
  workspaceEntryPaths?: string[];
  extractionDiagnostic?: WorkspaceExtractionDiagnostic;
  technicalDocsInject?: string;
}): Promise<string> {
  const ignoreContext = buildWorkspaceIgnoreFileContext(
    options.registry,
    options.step,
    options.workspaceEntryPaths ?? [],
  );
  const repairMessage = [
    `Original request: ${options.request}`,
    '',
    `Target file: ${options.step.filePath}`,
    `Purpose: ${options.step.purpose}`,
    '',
    'The previous draft did not resolve into a single usable file block for the target path.',
    options.extractionDiagnostic
      ? [
          'Extractor diagnosis:',
          formatWorkspaceExtractionDiagnostic(options.extractionDiagnostic),
        ].join('\n')
      : '',
    'Return only the repaired final file now.',
    isRawWorkspaceSupportPath(options.step.filePath)
      ? 'This target is a support or manifest file. Return one fenced block for exactly this path and do not add explanation before or after it: '
        + `${options.step.filePath}`
      : '',
    buildWorkspaceFocusedContext(options.registry, options.step, options.alreadyWritten),
    ignoreContext,
    '',
    'Previous draft:',
    options.draft,
  ].join('\n');

  return chatOnce(
    options.modelName,
    [{ role: 'user', content: repairMessage }],
    STEP_FILE_REPAIR_SYSTEM + buildWorkspaceDirectoryInject(options.registry) + (options.technicalDocsInject ?? ''),
    options.abortSignal,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normaliseTitleComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanTitleSource(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[_*~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampTitle(text: string, maxLength = 48): string {
  const clean = text.trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;

  const shortened = clean.slice(0, maxLength - 1).trimEnd();
  const boundary = shortened.lastIndexOf(' ');
  const safeCut = boundary > 16 ? shortened.slice(0, boundary) : shortened;
  return `${safeCut.trim()}...`;
}

function sentenceCaseTitle(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trimPromptLead(text: string): string {
  const cleaned = cleanTitleSource(text)
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^help\s+me(?:\s+with|\s+to)?\s+/i, '')
    .replace(/^i\s+need\s+(?:help\s+with\s+)?/i, '')
    .replace(/^let'?s\s+/i, '')
    .trim();

  return cleaned || cleanTitleSource(text);
}

function clampPromptUnderstandingSubject(text: string, maxLength = 168): string {
  const cleaned = trimPromptLead(text)
    .replace(/^(?:write|build|create|make|generate|design|add|implement|integrate|wire|fix|debug|repair|update|modify|refactor|explain|review)\s+(?:me\s+|us\s+)?/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[.?!]+$/g, '')
    .trim();

  if (!cleaned) return 'the request in the prompt';
  if (cleaned.length <= maxLength) return cleaned;
  const shortened = cleaned.slice(0, maxLength - 3).trimEnd();
  const boundary = shortened.lastIndexOf(' ');
  return `${(boundary > 84 ? shortened.slice(0, boundary) : shortened).trim()}...`;
}

function hashWorkspaceNarrativeSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickWorkspaceNarrativeLine<T>(items: T[], seed: number, offset = 0): T {
  return items[(seed + offset) % items.length];
}

function buildInitialWorkspaceUnderstandingParagraph(
  prompt: string,
  options: {
    existingFileCount: number;
    projectLabel?: string;
    runStartedAt?: number;
    panelId?: string;
  },
): string {
  const normalized = prompt.toLowerCase();
  const subject = clampPromptUnderstandingSubject(prompt);
  const hasWorkspaceFiles = options.existingFileCount > 0;
  const projectLabel = options.projectLabel?.trim();
  const seed = hashWorkspaceNarrativeSeed([
    prompt,
    options.panelId ?? '',
    options.projectLabel ?? '',
    String(options.existingFileCount),
    String(options.runStartedAt ?? Date.now()),
  ].join('|'));

  const docsOnly = /\b(readme|install guide|installation guide|contributing|changelog|license|documentation|docs|document this|api docs)\b/i.test(normalized);
  const debugLike = /error:|exception:|cannot find|is not defined|is not a function|undefined is not|null is not|typeerror|syntaxerror|referenceerror|uncaught|stack trace|it(?:'s| is) (?:broken|not working|crashing|failing)|fix (?:this|the|my)|why (?:is|does|am i getting)|failed\b|failing\b|broken\b/i.test(normalized);
  const snippetLike = /\b(snippet|sample code|sample snippet|example code|one-liner|utility function|show me an example|show me a snippet|give me a snippet|give me an example|just the code|standalone example)\b/i.test(normalized);
  const websiteLike = /\b(website|web app|landing page|homepage|home page|portfolio|hero|navbar|pricing|calendar|contact)\b/i.test(normalized);
  const backendFrontendLike = /\bbackend\b/i.test(normalized) && /\bfrontend\b/i.test(normalized);
  const integrationLike = /\b(integrate|integration|connect|wire up|hook up|support for)\b/i.test(normalized);

  if (debugLike) {
    return [
      pickWorkspaceNarrativeLine([
        `I'm treating this pass as a debugging run around ${subject}.`,
        `I'm approaching ${subject} as a failure-localization pass first.`,
        `For this chat, I'm reading ${subject} as a repair job that needs the real blocker pinned down before anything broad changes.`,
        `I'm taking the first move on ${subject} as diagnosis, not cleanup.`,
      ], seed),
      pickWorkspaceNarrativeLine([
        'The first job is to localize the real blocker instead of guessing, so I need the failing command output, the implicated files, and the current workspace state in front of me before I widen the fix.',
        'I need the failure text, the touched files, and the current workspace shape lined up together so the fix targets the thing that actually broke.',
        'I do not want to patch around symptoms here; I want the command output and workspace files to point at the specific file, package, or syntax edge that needs correction.',
      ], seed, 3),
      hasWorkspaceFiles
        ? `Because this is happening inside${projectLabel ? ` ${projectLabel}` : ' the existing workspace'}, I want to reuse what is already there and patch only the files that are actually causing the failure.`
        : 'Because this run is still building its workspace context, I need to anchor the fix to the actual failure path before I start rewriting files.',
      'Once that diagnosis is tight, I can turn it into a focused repair path and run the workspace back through validation instead of narrating around the error.',
    ].join(' ');
  }

  if (docsOnly) {
    return [
      pickWorkspaceNarrativeLine([
        `I'm framing this pass as documentation work around ${subject}.`,
        `I'm treating ${subject} as a docs-first task where the written guide needs to match the real project.`,
        `For this run, I'm reading ${subject} as a request to explain the workspace clearly instead of changing code for its own sake.`,
      ], seed),
      pickWorkspaceNarrativeLine([
        'The important part is to capture the real project flow clearly, not to pad the run with generic setup language or unrelated source edits.',
        'The useful outcome is accurate project guidance, so I need the commands, file names, and runtime pathing to come from the workspace instead of a generic scaffold.',
        'I want the docs to describe how this project actually works, not how a similar project might work from memory.',
      ], seed, 5),
      hasWorkspaceFiles
        ? `I need to read the current workspace first so the docs reflect the commands, file names, and runtime paths that already exist${projectLabel ? ` in ${projectLabel}` : ''}.`
        : 'I need to ground the docs in the files and runtime shape this prompt is asking for, so the written guide matches what will actually be generated.',
      'After that, I can write the documentation in a way that explains the project cleanly and stays aligned with the current codebase.',
    ].join(' ');
  }

  if (snippetLike) {
    return [
      pickWorkspaceNarrativeLine([
        `I'm taking ${subject} as a focused code request, not a full-project rebuild.`,
        `I'm reading this pass around ${subject} as something that needs a tight answer before it needs broad workspace planning.`,
        `For this chat, I'm treating ${subject} as a compact implementation or example request.`,
      ], seed),
      pickWorkspaceNarrativeLine([
        'That means the goal is a tight, useful implementation or explanation rather than a workspace-wide overhaul.',
        'The goal is to answer the specific coding need cleanly without inventing extra files or pretending the prompt asked for a rebuild.',
        'I want the result to stay narrow enough to be useful, but still aligned with the stack and names already in play.',
      ], seed, 7),
      hasWorkspaceFiles
        ? 'I still want to check the surrounding code first so the answer matches the patterns and names already in the workspace.'
        : 'I can keep this compact, but I still need to make sure the example fits the stack and conventions the prompt implies.',
      'Once that framing is locked, I can answer directly without wasting time planning files that the request never asked for.',
    ].join(' ');
  }

  return [
    pickWorkspaceNarrativeLine([
      `I'm reading this pass as ${hasWorkspaceFiles ? 'work inside the existing workspace' : 'a fresh build'} for ${subject}.`,
      `For this run, I'm framing ${subject} as ${hasWorkspaceFiles ? 'an update to the workspace that already exists' : 'a new workspace build that needs clean foundations'}.`,
      `I'm anchoring this chat around ${subject}, with the first priority being a workspace shape that can actually run.`,
      `I'm treating ${subject} as ${hasWorkspaceFiles ? 'a real workspace change, not a detached code sketch' : 'a from-scratch build that needs its files to land in the right order'}.`,
    ], seed),
    websiteLike
      ? pickWorkspaceNarrativeLine([
          'The job is not just to drop in visual sections, but to shape the layout, supporting files, and runtime wiring so the site actually boots cleanly and reads as one coherent product.',
          'I need the visual structure, entry files, and runtime setup to grow together so this does not turn into a pretty folder that opens to a blank page.',
          'I want the site sections, responsive behavior, imports, and boot path to line up as one product instead of a pile of disconnected components.',
        ], seed, 11)
      : backendFrontendLike
        ? pickWorkspaceNarrativeLine([
            'The job here is to make the backend, frontend, support files, and runtime wiring land in a clean order so the pieces connect to something real as the workspace fills in.',
            'I need the API layer, frontend entrypoints, shared assumptions, and run commands to connect early so the project is testable instead of just generated.',
            'The important part is getting the backend and frontend contracts to meet in real files before validation tries to run the whole thing.',
          ], seed, 13)
        : integrationLike
          ? pickWorkspaceNarrativeLine([
              'The main thing I need to get right is how the moving pieces connect, because integration work falls apart fast when the paths, contracts, or runtime assumptions drift.',
              'I need to keep the contracts, imports, and runtime assumptions lined up, because integration bugs usually come from small mismatches between otherwise valid files.',
              'This needs a connection-first pass so each file knows what it is supposed to talk to before the implementation spreads out.',
            ], seed, 17)
          : pickWorkspaceNarrativeLine([
              'The main thing I need to get right is the execution order, so the workspace grows from stable foundations instead of collecting disconnected files.',
              'I want the first files to establish the project skeleton clearly so later edits attach to something stable instead of improvising around missing structure.',
              'The safest path is to build the workspace in dependency order, then keep each later file tied to what has already landed.',
            ], seed, 19),
    hasWorkspaceFiles
      ? `Before I write anything, I need to read what already exists${projectLabel ? ` in ${projectLabel}` : ''} so I reuse the current structure and avoid duplicating files or scaffolding over valid work.`
      : 'Because this starts from a light workspace, I need to establish the project shape, support files, and entrypoints in a clean order so the first validation pass has something real to execute.',
    'Once that understanding is locked, I can turn the request into a file-by-file plan and start landing the work in the workspace without losing track of what the prompt is actually asking for.',
  ].join(' ');
}

function isLikelyConnectivityError(message: string): boolean {
  return /(failed to fetch|fetch failed|networkerror|network error|timed out|timeout|econnrefused|unable to connect|connection refused)/i.test(message);
}

function buildModelErrorHelp(model: string, message: string): string {
  const provider = getModelProvider(model);

  if (provider === 'ollama') {
    if (/requires more system memory/i.test(message)) {
      return 'Ollama is reachable, but the selected model cannot load with the memory currently available. Free RAM, switch to a smaller quantization, or pick a smaller model before retrying.';
    }

    if (isLikelyConnectivityError(message)) {
      return [
        'Make sure Ollama is running and that the configured endpoint is correct:',
        '```bash',
        'ollama serve',
        '```',
        '',
        'If you are using the browser-only dev server, start Ollama with `OLLAMA_ORIGINS=*` so the browser can reach it.',
      ].join('\n');
    }

    return 'Ollama is reachable and returned the error above. Check the selected model and Ollama runtime resources before retrying.';
  }

  if (provider === 'openai') {
    return 'Check the saved OpenAI API key, model access, and any quota or permission limits for this request.';
  }

  if (provider === 'anthropic') {
    return 'Check the saved Anthropic API key, model access, and any quota or permission limits for this request.';
  }

  return '';
}

function trimReplyLead(text: string): string {
  const cleaned = cleanTitleSource(text)
    .replace(/^(?:hello|hi|hey)[,.!\s]+/i, '')
    .replace(/^(?:sure|absolutely|certainly|of\s+course|okay|ok)[,.!\s]+/i, '')
    .replace(/^i\s+can\s+(?:help|assist)(?:\s+you)?(?:\s+with|\s+by)?\s+/i, '')
    .replace(/^here'?s\s+/i, '')
    .trim();

  return cleaned || cleanTitleSource(text);
}

function extractReplyTitleSource(text: string): string {
  const summaryMatch = text.match(/<!--\s*summary\s*-->\s*([\s\S]*)$/i);
  return trimReplyLead(summaryMatch?.[1] || text);
}

function titleFromText(text: string, maxWords = 7): string {
  const cleaned = cleanTitleSource(text);
  if (!cleaned) return '';

  const firstLine = cleaned.split(/\s*(?:\n|[.!?])\s+/)[0]?.trim() || cleaned;
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, maxWords);
  return clampTitle(sentenceCaseTitle(words.join(' ')));
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function isLowSignalPrompt(text: string): boolean {
  const cleaned = cleanTitleSource(text).toLowerCase();
  if (!cleaned) return true;
  if (/^(?:hi|hello|hey|yo|sup|test|ok|okay|thanks|thank you|help)[.!?]*$/.test(cleaned)) {
    return true;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length <= 2 && cleaned.length < 20;
}

function isGenericAssistantReply(text: string): boolean {
  const cleaned = cleanTitleSource(text).toLowerCase();
  return (
    !cleaned ||
    /^(?:how can i help(?: you)?(?: today)?|how can i assist(?: you)?(?: today)?)/.test(cleaned) ||
    /^(?:what can i help you with|what do you need help with)/.test(cleaned)
  );
}

function normalizeGeneratedTitle(text: string): string {
  const cleaned = cleanTitleSource(text)
    .replace(/^title\s*[:\-]\s*/i, '')
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .split(/\r?\n/)[0]
    .trim()
    .replace(/[.?!:;,]+$/, '');

  return clampTitle(sentenceCaseTitle(cleaned));
}

function isUsableGeneratedTitle(text: string): boolean {
  const cleaned = normaliseTitleComparison(text);
  if (!cleaned) return false;
  if (/^(?:chat|new chat|untitled|conversation|assistant reply|reply|response|answer|summary)$/i.test(cleaned)) {
    return false;
  }
  return countWords(cleaned) <= 10;
}

function canAutoManageTitle(currentTitle: string, projectLabel?: string, autoTitle?: string | null): boolean {
  const clean = currentTitle.trim();
  if (!clean) return true;

  if (autoTitle && normaliseTitleComparison(clean) === normaliseTitleComparison(autoTitle)) {
    return true;
  }

  if (/^(?:chat(?:\s+\d+)?|new(?:\s+[a-z]+){0,4}\s+chat|untitled)$/i.test(clean)) {
    return true;
  }

  if (projectLabel) {
    const workspaceTitlePattern = new RegExp(`^${escapeRegExp(projectLabel.trim())}\\s+chat$`, 'i');
    if (workspaceTitlePattern.test(clean)) return true;
  }

  return false;
}

function deriveFallbackAutoChatTitle({
  currentTitle,
  projectLabel,
  prompt,
  assistantReply,
  autoTitle,
}: {
  currentTitle: string;
  projectLabel?: string;
  prompt: string;
  assistantReply?: string;
  autoTitle?: string | null;
}): string | null {
  if (!canAutoManageTitle(currentTitle, projectLabel, autoTitle)) {
    return null;
  }

  const promptTitle = titleFromText(trimPromptLead(prompt));
  if (!assistantReply) {
    return promptTitle || null;
  }

  const replyTitle = titleFromText(extractReplyTitleSource(assistantReply));
  if (isLowSignalPrompt(prompt) && replyTitle && !isGenericAssistantReply(assistantReply)) {
    return replyTitle;
  }

  return promptTitle || replyTitle || null;
}

const AUTO_CHAT_TITLE_SYSTEM_PROMPT = [
  'You name chats for a desktop AI app.',
  'Use the user prompt and assistant reply together to produce one concise, specific title.',
  'Prefer the concrete topic, task, or outcome over generic phrasing.',
  'Return only the title text.',
  'Do not use quotes, markdown, prefixes, numbering, or trailing punctuation.',
  'Keep it under 48 characters and ideally between 3 and 7 words.',
  'Avoid generic titles like "Answer", "Chat", "Conversation", or "Summary".',
].join('\n');

function buildAutoChatTitlePrompt(prompt: string, assistantReply: string): string {
  const cleanedPrompt = cleanTitleSource(prompt).slice(0, 600);
  const cleanedReply = cleanTitleSource(extractReplyTitleSource(assistantReply)).slice(0, 1400);
  return [
    'Create the best short title for this chat.',
    '',
    `User prompt: ${cleanedPrompt || '(empty)'}`,
    '',
    `Assistant reply: ${cleanedReply || '(empty)'}`,
  ].join('\n');
}

function shouldAutoSetInitialChatTitle(messages: Message[]): boolean {
  return !messages.some((message) => message.role === 'assistant');
}

function exportChatAsMarkdown(panel: Panel): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    `# Chat Log - ${panel.title}`, ``,
    `**Model:** ${panel.model || 'unknown'}  `,
    `**Preset:** ${panel.preset || 'code'}  `,
    ...(panel.projectLabel ? [`**Project:** ${panel.projectLabel}  `] : []),
    `**Exported:** ${date}  `,
    ``, `---`, ``,
  ];
  for (const msg of panel.messages) {
    if (msg.role === 'user') {
      lines.push('### You', '', msg.content, '', '---', '');
      continue;
    }

    lines.push('### Assistant', '', msg.content);
    const sourceSection = buildExportedSourceMetadata(msg.responseTrace);
    if (sourceSection.length) {
      lines.push('', EXPORTED_SOURCE_METADATA_START, ...sourceSection, EXPORTED_SOURCE_METADATA_END);
    }
    lines.push('', '---', '');
  }
  return lines.join('\n');
}

function formatDiscoveryEngineLabel(source: ResponseTraceSource): string {
  if (!source.discoveryEngines?.length) return 'N/A';
  return source.discoveryEngines.map((engine) => {
    switch (engine) {
      case 'duckduckgo':
        return 'DuckDuckGo';
      case 'google':
        return 'Google';
      case 'local':
        return 'Local Search';
      default:
        return engine;
    }
  }).join(', ');
}

function formatSourceOriginLabel(source: ResponseTraceSource): string {
  switch (source.contextOrigin) {
    case 'page':
      return 'Verified page fetch';
    case 'local-index':
      return 'Local index document';
    case 'search-result':
      return 'Search result snippet';
    default:
      return 'Unknown';
  }
}

function sortSourcesForExport(sources: ResponseTraceSource[]): ResponseTraceSource[] {
  return [...sources].sort((left, right) => {
    const leftPromptScore = left.promptSelected ? 1 : 0;
    const rightPromptScore = right.promptSelected ? 1 : 0;
    if (rightPromptScore !== leftPromptScore) return rightPromptScore - leftPromptScore;
    if (left.status !== right.status) return left.status === 'fetched' ? -1 : 1;
    const leftPublished = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightPublished = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    if (rightPublished !== leftPublished) return rightPublished - leftPublished;
    return (left.url || '').localeCompare(right.url || '');
  });
}

function buildExportedSourceMetadata(trace?: ResponseTrace): string[] {
  const sources = trace?.sources ?? [];
  if (!trace && !sources.length) return [];

  if (!sources.length) {
    const relevantPhase = [...(trace?.phases ?? [])].reverse().find((phase) =>
      phase.id === 'withhold-unverified-reply'
      || phase.id === 'verify-live-sources'
      || phase.id === 'live-context-fetch'
    );
    const lines: string[] = [
      '#### Source Catalog',
      '',
      'Captured 0 sources for this reply.',
    ];
    if (relevantPhase?.detail) {
      lines.push(`Retrieval status: ${relevantPhase.detail}`);
    } else if (trace?.orchestrationSummary) {
      lines.push(`Retrieval status: ${trace.orchestrationSummary}`);
    }
    lines.push('');
    return lines;
  }

  const orderedSources = sortSourcesForExport(sources);
  const fetchedCount = orderedSources.filter((source) => source.status === 'fetched').length;
  const promptSelectedCount = orderedSources.filter((source) => source.promptSelected).length;
  const lines: string[] = [
    '#### Source Catalog',
    '',
    `Captured ${orderedSources.length} source${orderedSources.length === 1 ? '' : 's'} for this reply.`,
    `${fetchedCount} fetched successfully; ${promptSelectedCount} selected into the prompt bundle.`,
    '',
  ];

  orderedSources.forEach((source, index) => {
    const sourceName = source.host || source.provider || source.title || source.url;
    const sourcePath = source.path || '/';
    lines.push(`${index + 1}. **${source.title || source.url}**`);
    lines.push(`Source name: ${sourceName}`);
    lines.push(`Path: ${sourcePath}`);
    lines.push(`URL: ${source.url}`);
    lines.push(`Search engine: ${formatDiscoveryEngineLabel(source)}`);
    lines.push(`Capture: ${formatSourceOriginLabel(source)}`);
    lines.push(`Status: ${source.status}`);
    if (source.provider) lines.push(`Provider: ${source.provider}`);
    if (source.publishedAt) lines.push(`Published: ${source.publishedAt}`);
    if (source.sourceType) lines.push(`Type: ${source.sourceType}`);
    if (source.credibility) lines.push(`Credibility: ${source.credibility}`);
    lines.push(`Included in prompt bundle: ${source.promptSelected ? 'yes' : 'no'}`);
    if (source.preview) lines.push(`Context: ${source.preview}`);
    if (source.error) lines.push(`Error: ${source.error}`);
    lines.push('');
  });

  return lines;
}

function formatTraceDuration(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getTraceSurface(panel: Panel): ThreadType {
  if (panel.threadType === 'chat' || panel.threadType === 'code' || panel.threadType === 'debug') {
    return panel.threadType;
  }
  return panel.projectId ? 'code' : 'chat';
}

function truncateTracePreview(text: string, maxLength = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatChatReferenceDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

const CORRECTION_PROMPT_RE = /\b(wrong|incorrect|inaccurate|not accurate|not right|still wrong|same info|same answer|same thing|check again|recheck|verify again|double[- ]check|that is false|that can't be right)\b/i;
const CREW_LOOKUP_PROMPT_RE = /\b(crew|crew members?|astronauts?|pilot|commander|mission specialists?|roster|who(?:'s| is| are)? the crew|what are their names|who are they|names?)\b/i;
const DIRECT_CREW_IDENTITY_PROMPT_RE = /\b(who(?:'s| is| are)?(?: the)?|what(?: are| is)?(?: their)? names?|name(?:s)? of|which(?: one)?(?: is| are)? the|pilot|commander|mission specialists?)\b/i;
const CREW_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};
const CREW_ROLE_PRIORITY: Record<string, number> = {
  Commander: 0,
  Pilot: 1,
  'Mission Specialist': 2,
  'Flight Engineer': 3,
  Specialist: 4,
};
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'balanced';
const REASONING_EFFORT_OPTIONS: Array<{ value: ChatReasoningEffort; label: string }> = [
  { value: 'light', label: 'Low' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High' },
  { value: 'extra-high', label: 'Extra High' },
];
const REASONING_EFFORT_CONFIG: Record<ChatReasoningEffort, {
  label: string;
  fetchDepth: FetchContextDepth;
  maxSources: number;
  minLiveSources: number;
  paragraphGuidance: string;
  citationGuidance: string;
  comparisonGuidance: string;
}> = {
  light: {
    label: 'Low',
    fetchDepth: 'standard',
    maxSources: 10,
    minLiveSources: 4,
    paragraphGuidance: 'Keep the answer compact: usually 1 to 2 tight paragraphs or a short list when that is clearer.',
    citationGuidance: 'Keep source mentions out of the reply unless the user explicitly asks for evidence or citations.',
    comparisonGuidance: 'Note major contradictions only when they materially change the conclusion.',
  },
  balanced: {
    label: 'Balanced',
    fetchDepth: 'standard',
    maxSources: 12,
    minLiveSources: 5,
    paragraphGuidance: 'Give a clear medium-depth answer: usually 2 to 3 compact paragraphs unless the user asked for more.',
    citationGuidance: 'Answer directly and let the sources stay in the UI unless the user explicitly asks where the information came from.',
    comparisonGuidance: 'Call out important agreement or disagreement across sources without turning the answer into a report.',
  },
  high: {
    label: 'High',
    fetchDepth: 'deep',
    maxSources: 14,
    minLiveSources: 6,
    paragraphGuidance: 'Give a more complete answer: usually 3 to 5 information-dense paragraphs with concrete dates and implications.',
    citationGuidance: 'Use corroborated details before making precise claims, but keep the prose focused on the answer instead of naming sources unless asked.',
    comparisonGuidance: 'Compare the retrieved sources before answering. Emphasize where the reporting aligns, then explain any material disagreement plainly.',
  },
  'extra-high': {
    label: 'Extra High',
    fetchDepth: 'deep',
    maxSources: 15,
    minLiveSources: 8,
    paragraphGuidance: 'Give a thorough answer: usually 4 to 6 full paragraphs unless the user explicitly wants a short reply.',
    citationGuidance: 'Prefer facts repeated across multiple independent sources, but do not turn the reply into a citation list unless the user explicitly asks for one.',
    comparisonGuidance: 'Actively compare source overlap and source conflict. Surface similarities first, then explain opposing reporting and which version looks newest or best supported.',
  },
};

function isCorrectionPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return CORRECTION_PROMPT_RE.test(clean) || isLikelyCorrectionFollowUp(clean);
}

function isCrewLookupPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return CREW_LOOKUP_PROMPT_RE.test(clean);
}

function isDirectCrewIdentityPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return DIRECT_CREW_IDENTITY_PROMPT_RE.test(clean);
}

function isIdentitySensitivePrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return /\b(who|which people|which person|which individuals?|which leaders?|which defendants?|which accused|people|person|individuals?|figures?|leaders?|defendants?|accused|who was tried|who were tried|tried|convicted|sentenced|executed|hanged|hung|fate|what happened to|role|involvement|involved)\b/i.test(clean);
}

function buildReasoningEffortInject(options: {
  effort: ChatReasoningEffort;
  fetchLiveContext: boolean;
  requiredLiveSourceCount: number;
  targetLiveSourceCount: number;
}): string {
  const config = REASONING_EFFORT_CONFIG[options.effort];
  const lines = [
    '',
    '---',
    '## Reply Depth And Reasoning Effort',
    `Reasoning effort for this chat: ${config.label}.`,
    '- Treat this as the depth and evidence target for the current reply, unless the user explicitly asks for something shorter.',
    '- Higher effort means more corroboration, more careful comparison, and clearer confidence language, not filler.',
    `- ${config.paragraphGuidance}`,
    `- ${config.citationGuidance}`,
    `- ${config.comparisonGuidance}`,
  ];

  if (options.fetchLiveContext) {
    lines.push(
      `- Aim to compare roughly ${options.targetLiveSourceCount} live source${options.targetLiveSourceCount === 1 ? '' : 's'} for freshness-sensitive replies when retrieval can support it.`,
      `- When live research is active, do not rely on a single page or a single outlet. Use at least ${options.requiredLiveSourceCount} verified live source${options.requiredLiveSourceCount === 1 ? '' : 's'} before making current factual claims.`,
      '- Prefer the facts repeated across multiple independent sources, especially when official reporting and major news coverage align.',
      '- If sources materially disagree, say that directly and explain which version appears better supported by freshness, specificity, and corroboration.',
    );
  }

  lines.push('---');
  return lines.join('\n');
}

function extractRequestedCrewRole(text: string): string | null {
  if (/\bcommander\b/i.test(text)) return 'Commander';
  if (/\bpilot\b/i.test(text)) return 'Pilot';
  if (/\bmission specialist(?:s)?\b/i.test(text)) return 'Mission Specialist';
  if (/\bflight engineer\b/i.test(text)) return 'Flight Engineer';
  if (/\bspecialist\b/i.test(text)) return 'Specialist';
  return null;
}

function extractRequestedCrewCount(text: string): number | null {
  const numericMatch = text.match(/\b([1-9])\b(?=[^\n]{0,24}\b(?:crew|astronauts?|members?|people|names?)\b)/i)
    ?? text.match(/\b(?:crew|astronauts?|members?|people|names?)\b[^\n]{0,12}\b([1-9])\b/i);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const lower = text.toLowerCase();
  for (const [label, value] of Object.entries(CREW_COUNT_WORDS)) {
    if (new RegExp(`\\b${label}\\b(?=[^\\n]{0,24}\\b(?:crew|astronauts?|members?|people|names?)\\b)`, 'i').test(lower)
      || new RegExp(`\\b(?:crew|astronauts?|members?|people|names?)\\b[^\\n]{0,12}\\b${label}\\b`, 'i').test(lower)) {
      return value;
    }
  }

  return null;
}

function sortValidatedCrewRoster(roster: ExtractedCrewRosterMember[]): ExtractedCrewRosterMember[] {
  return [...roster].sort((left, right) => {
    const leftPriority = left.role ? (CREW_ROLE_PRIORITY[left.role] ?? 99) : 99;
    const rightPriority = right.role ? (CREW_ROLE_PRIORITY[right.role] ?? 99) : 99;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (right.sourceCount !== left.sourceCount) return right.sourceCount - left.sourceCount;
    if (right.supportScore !== left.supportScore) return right.supportScore - left.supportScore;
    return left.name.localeCompare(right.name);
  });
}

function buildValidatedCrewRosterInject(roster: ExtractedCrewRosterMember[]): string {
  if (!roster.length) return '';
  const lines = sortValidatedCrewRoster(roster).map((member) => (
    `- ${member.name}${member.role ? ` - ${member.role}` : ''} (${member.sourceCount} source${member.sourceCount === 1 ? '' : 's'})`
  ));
  return [
    '',
    '---',
    '## Validated Crew Roster',
    'The following names were derived directly from the fetched live sources and validated before answer generation.',
    'When answering crew or flight-role questions, use only this validated roster and do not add any other names.',
    '',
    ...lines,
    '---',
  ].join('\n');
}

function sortValidatedCaseParticipantRoster(roster: ExtractedCaseParticipantMember[]): ExtractedCaseParticipantMember[] {
  return [...roster].sort((left, right) => {
    if (right.sourceCount !== left.sourceCount) return right.sourceCount - left.sourceCount;
    if (right.supportScore !== left.supportScore) return right.supportScore - left.supportScore;
    return left.name.localeCompare(right.name);
  });
}

function buildValidatedCaseParticipantInject(roster: ExtractedCaseParticipantMember[]): string {
  if (!roster.length) return '';
  const lines = sortValidatedCaseParticipantRoster(roster).map((member) => (
    `- ${member.name}${member.outcome ? ` - ${member.outcome}` : ''} (${member.sourceCount} source${member.sourceCount === 1 ? '' : 's'})`
  ));
  return [
    '',
    '---',
    '## Validated Case Participants',
    'The following people were explicitly identified in the fetched live sources as defendants, accused people, or people tried in this case.',
    'If you refer to someone as a defendant, an accused person, someone tried, or someone sentenced in this case, use only this validated roster.',
    'Someone not in this list may still be discussed as not tried, absent, or dead before the proceeding, but you must not call them a defendant or say they were tried.',
    'If you mention outcomes like execution, acquittal, or imprisonment, use only the validated outcomes below and do not generalize beyond them.',
    '',
    ...lines,
    '---',
  ].join('\n');
}

function buildCrewLookupReply(
  roster: ExtractedCrewRosterMember[],
  prompt: string,
  referenceDateLabel: string,
): string {
  const orderedRoster = sortValidatedCrewRoster(roster);
  const requestedRole = extractRequestedCrewRole(prompt);
  const requestedCount = extractRequestedCrewCount(prompt);

  if (!orderedRoster.length) {
    return [
      `As of ${referenceDateLabel}, I could not verify the crew roster in this run, so I am not going to guess.`,
      '',
      'Please retry once the live source pass returns enough roster evidence.',
    ].join('\n');
  }

  if (requestedRole) {
    const matchingRoster = orderedRoster.filter((member) => member.role === requestedRole || (requestedRole === 'Mission Specialist' && member.role === 'Specialist'));
    if (!matchingRoster.length) {
      return [
        `As of ${referenceDateLabel}, I could not verify the ${requestedRole.toLowerCase()} in this run.`,
        '',
        `Verified names from this run: ${orderedRoster.map((member) => member.name).join(', ')}.`,
      ].join('\n');
    }

    if (matchingRoster.length === 1) {
      return `As of ${referenceDateLabel}, ${matchingRoster[0].name} is identified as the ${requestedRole.toLowerCase()}.`;
    }

    return [
      `As of ${referenceDateLabel}, these ${requestedRole.toLowerCase()}s are identified:`,
      '',
      ...matchingRoster.map((member) => `- ${member.name}`),
    ].join('\n');
  }

  const limitedRoster = requestedCount && requestedCount > 0
    ? orderedRoster.slice(0, requestedCount)
    : orderedRoster;

  const lines = [
    `As of ${referenceDateLabel}, these crew members are identified:`,
    '',
    ...limitedRoster.map((member) => `- ${member.name}`),
  ];

  if (requestedCount && orderedRoster.length < requestedCount) {
    lines.push(
      '',
      `I could only verify ${orderedRoster.length} name${orderedRoster.length === 1 ? '' : 's'} in this run, so I am not guessing the rest.`,
    );
  }

  return lines.join('\n');
}

function buildCorrectionInject(): string {
  return [
    '',
    '---',
    '## Correction Mode',
    'The user says a previous assistant answer in this conversation was wrong.',
    'Do not repeat, preserve, summarize, or defend earlier assistant claims just because they appeared earlier in the thread.',
    'Re-evaluate the question from the fetched evidence and current user turns only.',
    'If earlier assistant claims conflict with the retrieved evidence, explicitly correct the record and give the corrected answer directly.',
    'If the user uses pronouns or contradiction wording like "he wasn\'t" or "that\'s not right", resolve them against the latest active subject from the conversation instead of treating them as a brand-new topic.',
    'If the user challenges whether one specific person was dead, absent, or not tried, answer that person directly in the first sentence and do not pivot back to a broader roster unless the user asks for one.',
    'For name, crew, roster, or role questions, list only the names and roles explicitly shown in the retrieved sources.',
    'Keep the correction concise and factual instead of repeating a long apology.',
    '---',
  ].join('\n');
}

function buildCrewLookupInject(): string {
  return [
    '',
    '---',
    '## Crew Lookup Mode',
    'The user is asking for crew members, names, or flight roles.',
    'Do not reuse names from earlier assistant replies or from general memory.',
    'Use fetched evidence and current user turns only.',
    'Prefer official roster or crew pages over general mission overview pages.',
    'If the retrieved sources do not explicitly show the names and roles, say they could not be confirmed in this pass instead of inventing them.',
    'Do not include people from another mission, another program, or historical Moon flights.',
    '---',
  ].join('\n');
}

function buildConversationHistoryForReply(messages: Message[], currentUserText: string): Message[] {
  const priorHistory = messages.slice(0, -1);
  if (!isCorrectionPrompt(currentUserText) && !isCrewLookupPrompt(currentUserText)) {
    return priorHistory;
  }

  const userOnlyHistory = priorHistory.filter((message) => message.role === 'user');
  return userOnlyHistory.length ? userOnlyHistory : priorHistory;
}

function findPreviousUserMessage(messages: Message[], assistantIndex: number): Message | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index];
    }
  }
  return null;
}

function buildReplyPreferenceContext(messages: Message[], assistantIndex: number): string {
  const start = Math.max(0, assistantIndex - 4);
  return messages
    .slice(start, assistantIndex)
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncateTracePreview(cleanReplyPreferenceText(message.content), 220)}`;
    })
    .join('\n');
}

function buildReplyPreferenceEntry(options: {
  chatId: string;
  chatTitle: string;
  assistantMessage: Message;
  assistantIndex: number;
  messages: Message[];
  panel: Panel;
  feedback: ReplyFeedback;
}): Omit<ReplyPreferenceRecord, 'createdAt' | 'updatedAt'> | null {
  const promptMessage = findPreviousUserMessage(options.messages, options.assistantIndex);
  if (!promptMessage) return null;

  const cleanedReply = cleanReplyPreferenceText(options.assistantMessage.content);
  if (!cleanedReply.trim()) return null;

  return {
    id: buildReplyPreferenceId({
      chatId: options.chatId,
      prompt: promptMessage.content,
      reply: cleanedReply,
      responseCompletedAt: options.assistantMessage.responseCompletedAt,
      index: options.assistantIndex,
    }),
    chatId: options.chatId,
    chatTitle: options.chatTitle,
    prompt: promptMessage.content,
    reply: cleanedReply,
    conversationContext: buildReplyPreferenceContext(options.messages, options.assistantIndex),
    feedback: options.feedback,
    surface: getTraceSurface(options.panel),
    preset: options.panel.preset ?? DEFAULT_PRESET_ID,
    model: options.panel.model,
    traceSummary: options.assistantMessage.responseTrace?.orchestrationSummary,
    sourceUrls: (options.assistantMessage.responseTrace?.sources ?? [])
      .filter((source) => source.status === 'fetched' && source.url)
      .map((source) => source.url),
  };
}

function buildChatWorkflowInject(options: {
  mode: string;
  summary: string;
  minParagraphs: number;
  minSentencesPerParagraph: number;
  referenceDateLabel: string;
  forceFetch: boolean;
}): string {
  const lines = [
    '',
    '---',
    '## Detected Chat Workflow',
    `Mode: ${options.mode}`,
    options.summary,
    `Reference date for timeline wording: ${options.referenceDateLabel}.`,
  ];

  if (options.mode === 'deep-research') {
    lines.push(
      '',
      'Response contract:',
      `- Write at least ${options.minParagraphs} full-length paragraphs.`,
      `- Each paragraph must contain at least ${options.minSentencesPerParagraph} complete sentences.`,
      '- Do this in the first answer. Do not save key details for a later rewrite.',
      '- Put the important detail in the first answer instead of holding it back for a later follow-up.',
      '- Keep the answer dense with concrete dates, source-grounded facts, and implications.',
      '- For time-sensitive answers, separate three things clearly: what is true now, what already happened, and what comes next.',
      '- Keep past milestones in the answer when they are relevant, but describe them in past tense as completed or prior events.',
      '- Do not erase or dismiss relevant past milestones just because they already happened.',
      '- If the user asks after a launch, decision, or announcement date, say it happened on that date and then explain the current status after it.',
      '- For every exact date you mention, compare it to the reference date before writing the sentence.',
      '- Dates before the reference date must be described only in past tense: happened, launched, occurred, completed, was announced, was tested.',
      '- Dates on the reference date may be described as happening today or having happened today.',
      '- Dates after the reference date may be described as upcoming, scheduled, expected, planned, or will happen.',
      '- Before finishing the answer, do a final tense check on every dated milestone and rewrite any sentence that mismatches past, present, or future.',
      '- If you present a timeline, split it into what already happened, the current status, and what comes next instead of mixing old and upcoming items together.',
    );
  } else if (options.mode === 'note-taking') {
    lines.push(
      '',
      'Response contract:',
      '- Organize the answer as clean notes, key points, and follow-ups when useful.',
      '- Optimize for clarity and structure over conversational padding.',
    );
  } else {
    lines.push(
      '',
      'Time-sensitive response contract:',
      ...(options.forceFetch
        ? [
            '- Start with a direct answer to the user\'s actual question in the first sentence.',
            '- Keep the reply concise unless the user explicitly asks for a deep or exhaustive answer.',
            '- For time-sensitive factual answers, prefer a clean structure: `Current status`, `What already happened`, and `What comes next`.',
            '- Each section should be a short paragraph, not a wall of text or a muddled timeline dump.',
            '- Answer directly without mentioning the retrieval process, provided context, or source bundle unless the user explicitly asks about evidence or sources.',
            '- Do not add a `Sources` or `References` section unless the user explicitly asks for one.',
            '- Only state precise dates, crew details, launch windows, landing plans, return dates, or outcomes when the fetched evidence clearly supports them.',
            '- For numbered missions or flights, do not transfer crew names, landing goals, launch outcomes, or milestone dates from a different mission number or from a different historical program.',
            '- If the user did not ask for crew members or names, do not volunteer a crew roster unless the retrieved evidence makes crew identity central to the question being answered.',
            '- If the fetched evidence does not clearly confirm a specific detail, say that detail remains unclear, inconsistently reported, or unverified in the retrieved sources.',
            '- Resolve the timeline into one coherent story instead of listing conflicting dated claims side by side.',
            '- If newer evidence conflicts with an older schedule article, describe the older item as earlier reporting or an earlier plan, not as the current status.',
            '- If a source says an event was delayed, rescheduled, or scheduled to a date or month that has already arrived by the reference date, treat that source as earlier planning coverage unless it also states what happened after that date.',
            '- Never describe the same mission or event as both already underway/completed and still scheduled for a later future date.',
            '- If evidence conflicts, write the contradiction plainly as: "Earlier reporting said X, but newer reporting indicates Y."',
          ]
        : []),
      '- For every exact date you mention, compare it to the reference date before writing the sentence.',
      '- Dates before the reference date must be described in past tense.',
      '- Dates on the reference date may be described as happening today or having happened today.',
      '- Dates after the reference date may be described as upcoming, scheduled, expected, planned, or will happen.',
      '- Keep relevant past milestones in the answer when they help explain the current status.',
      '- Separate what already happened, what is true now, and what comes next.',
    );
  }

  lines.push('---');
  return lines.join('\n');
}

function buildRuntimeDateInject(referenceDateLabel: string): string {
  return [
    '',
    '---',
    '## Runtime Date And Freshness Guard',
    `Today in this runtime is ${referenceDateLabel}.`,
    '- You must treat that as the current date for relative and time-sensitive wording.',
    '- Never say "as of my last update", "my knowledge cutoff", or anything that sounds like a training-data timestamp.',
    '- If live retrieval did not verify a current fact, say that current fact remains unverified in this run.',
    '- Do not substitute stale background knowledge for a verified current status.',
    '- If you mention a year, schedule, or timeline older than the runtime date, describe it as prior background or earlier reporting rather than current status.',
    '---',
  ].join('\n');
}

function buildLimitedLiveContextInject(fetchedCount: number, requiredCount: number): string {
  const sourceLabel = fetchedCount === 1 ? 'source' : 'sources';
  return [
    '',
    '---',
    '## Limited Live Research Coverage',
    `This run captured ${fetchedCount} verified live ${sourceLabel}, below the preferred ${requiredCount} for this prompt.`,
    '',
    'You should still be helpful, but you must fail closed on unverified specifics instead of guessing.',
    '',
    'Rules:',
    '- Lead with the best-supported answer you can form from the retrieved evidence you do have.',
    '- Use stable background context only to add orientation, not to invent missing current facts.',
    '- If a current detail was not verified in the fetched evidence, say that point remains unclear or only partially verified.',
    '- If the fetched material does not verify specific people, names, dates, roles, convictions, sentences, or outcomes, say you could not verify those details in this run and do not guess them.',
    '- Keep the answer useful and well-rounded, but conservative about exact current status claims.',
    '---',
  ].join('\n');
}

function buildLimitedContextDisclaimer(fetchedCount: number, requiredCount: number): string {
  if (fetchedCount > 0) {
    const sourceLabel = fetchedCount === 1 ? 'source' : 'sources';
    return `Limited-context note: this reply was built from ${fetchedCount} verified live ${sourceLabel}, below the preferred ${requiredCount} for this prompt, so it may be short on details or miss newer developments.`;
  }

  return 'Limited-context note: live retrieval for this run was limited and did not capture enough verified sources for full coverage, so this reply may be short on details or miss newer developments.';
}

function countVerifiedEvidenceContexts(contexts: FetchedContext[]): number {
  return contexts.filter((context) =>
    !context.error
    && context.contextOrigin !== 'search-result'
    && context.text.trim().length >= 120,
  ).length;
}

function buildInsufficientEvidenceReply(options: {
  prompt: string;
  verifiedEvidenceCount: number;
  fetchedSourceCount: number;
  requiredSourceCount: number;
}): string {
  const subject = isIdentitySensitivePrompt(options.prompt)
    ? 'the specific people or outcomes you asked about'
    : 'this topic reliably';
  if (options.fetchedSourceCount > 0) {
    return [
      `I could not verify ${subject} from the sources fetched in this run, so I do not want to guess.`,
      '',
      `The live research pass captured ${options.fetchedSourceCount} source${options.fetchedSourceCount === 1 ? '' : 's'}, but only ${options.verifiedEvidenceCount} full evidence page${options.verifiedEvidenceCount === 1 ? '' : 's'} with enough usable content, below the preferred ${options.requiredSourceCount}.`,
      'Please retry once the source pass returns fuller verified pages.',
    ].join('\n');
  }

  return [
    `I could not verify ${subject} in this run, so I do not want to guess.`,
    '',
    'The live research pass did not return enough usable evidence pages to support a reliable answer.',
    'Please retry once the source pass returns fuller verified pages.',
  ].join('\n');
}

function deriveSourceDiscoveryEngines(context: FetchedContext): ResponseTraceSource['discoveryEngines'] {
  if (context.discoveryEngines?.length) {
    return context.discoveryEngines;
  }

  switch (context.provider) {
    case 'DuckDuckGo':
      return ['duckduckgo'];
    case 'Google Search':
      return ['google'];
    case 'Larry Local Search':
      return ['local'];
    default:
      return undefined;
  }
}

function deriveTraceSourceLocation(url: string): Pick<ResponseTraceSource, 'host' | 'path'> {
  try {
    const parsed = new URL(url);
    const search = parsed.search || '';
    return {
      host: parsed.hostname.replace(/^www\./i, ''),
      path: `${parsed.pathname || '/'}${search}`,
    };
  } catch {
    return {};
  }
}

function createResponseTrace({
  prompt,
  panel,
  model,
  presetId,
  reasoningEffort,
  pipeline,
  startedAt,
}: {
  prompt: string;
  panel: Panel;
  model: string;
  presetId: string;
  reasoningEffort: ChatReasoningEffort;
  pipeline: ResponseTrace['pipeline'];
  startedAt: number;
}): ResponseTrace {
  return {
    version: 1,
    prompt,
    surface: getTraceSurface(panel),
    preset: presetId,
    reasoningEffort,
    model,
    pipeline,
    startedAt,
    orchestrationSummary: pipeline === 'deep-plan'
      ? 'Deep planning flow started: classify the request, build a file plan, execute steps, then write a summary.'
      : 'Single-pass reply started with optional live context fetching before the model stream.',
    phases: [],
    sources: [],
    packages: [],
    plannerSteps: [],
  };
}

function startTracePhase(trace: ResponseTrace, id: string, label: string, detail?: string): ResponseTracePhase {
  const phase: ResponseTracePhase = {
    id,
    label,
    detail,
    status: 'running',
    startedAt: Date.now(),
  };
  trace.phases.push(phase);
  return phase;
}

function finishTracePhase(
  phase: ResponseTracePhase | undefined,
  options: {
    status?: ResponseTracePhase['status'];
    detail?: string;
    metrics?: ResponseTraceMetric[];
  } = {},
) {
  if (!phase) return;
  phase.status = options.status ?? 'completed';
  phase.completedAt = Date.now();
  if (options.detail !== undefined) phase.detail = options.detail;
  if (options.metrics !== undefined) phase.metrics = options.metrics;
}

function appendTraceSources(
  trace: ResponseTrace,
  contexts: FetchedContext[],
  kind: ResponseTraceSource['kind'],
) {
  if (!contexts.length) return;
  trace.sources = [
    ...(trace.sources ?? []),
    ...contexts.map((context, index) => ({
      id: `${kind}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      title: context.title || context.url,
      url: context.url,
      status: context.error ? 'error' as const : 'fetched' as const,
      durationMs: context.durationMs,
      preview: context.text ? truncateTracePreview(context.text) : undefined,
      error: context.error,
      provider: context.provider,
      sourceType: context.sourceType,
      credibility: context.credibility,
      publishedAt: context.publishedAt,
      discoveryEngines: deriveSourceDiscoveryEngines(context),
      contextOrigin: context.contextOrigin,
      promptSelected: context.promptSelected,
      ...deriveTraceSourceLocation(context.url),
    })),
  ];
}

function cloneTrace(
  trace: ResponseTrace,
  options: {
    completedAt?: number;
    freezeRunning?: boolean;
  } = {},
): ResponseTrace {
  return {
    ...trace,
    completedAt: options.completedAt ?? trace.completedAt,
    phases: trace.phases.map((phase) => ({
      ...phase,
      status: options.freezeRunning && phase.status === 'running' ? 'completed' : phase.status,
      metrics: phase.metrics?.map((metric) => ({ ...metric })),
    })),
    sources: trace.sources?.map((source) => ({ ...source })),
    packages: trace.packages?.map((pkg) => ({ ...pkg })),
    plannerSteps: trace.plannerSteps?.map((step) => ({ ...step })),
  };
}

function snapshotTrace(trace: ResponseTrace, completedAt?: number): ResponseTrace {
  return cloneTrace(trace, { completedAt, freezeRunning: true });
}

function estimateMessageHeight(
  message: Message,
  hideCodeBlocks: boolean,
  trailingGapPx: number,
): number {
  if (message.role === 'assistant' && hideCodeBlocks) {
    return 248 + trailingGapPx;
  }

  const newlineCount = (message.content.match(/\n/g)?.length ?? 0) + 1;
  const codeFenceCount = Math.floor((message.content.match(/```/g)?.length ?? 0) / 2);
  const sampledLength = Math.min(message.content.length, 4_000);
  const baseHeight = message.role === 'assistant' ? 132 : 88;
  const lengthHeight = Math.ceil(sampledLength / 110) * (message.role === 'assistant' ? 16 : 11);
  const lineHeight = Math.min(newlineCount, 42) * 4;
  const codeHeight = Math.min(180, codeFenceCount * 64);
  const minimumHeight = message.role === 'assistant' ? 172 : 104;
  const estimatedHeight = baseHeight + lengthHeight + lineHeight + codeHeight;

  return Math.max(minimumHeight + trailingGapPx, Math.min(760, estimatedHeight + trailingGapPx));
}

function normalizeWheelDelta(event: WheelEvent, viewport: HTMLDivElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(viewport).lineHeight);
    const lineHeight = Number.isFinite(computedLineHeight) ? computedLineHeight : 16;
    return event.deltaY * lineHeight;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewport.clientHeight;
  }

  return event.deltaY;
}

function buildInterruptedTaskResumePrompt(task: InterruptedTaskState): string {
  return [
    'Continue the interrupted workspace task from the current workspace state.',
    `Original request: ${task.prompt}`,
    'Some files may already have been created or updated.',
    'Read the workspace as it exists now, continue from what is already done, and do not restart the project from scratch.',
  ].join('\n');
}

function shouldShowInterruptedTaskResume(panel: Panel): boolean {
  if (!panel.projectId || panel.streaming || !panel.interruptedTask) return false;
  const assistantMessageCount = panel.messages.filter((message) => message.role === 'assistant').length;
  return assistantMessageCount <= panel.interruptedTask.assistantMessageCountAtStart;
}

export function ChatPanel({
  panel,
  models,
  onUpdate,
  onClose,
  onSave,
  selected,
  backgroundMode,
  onActivate,
  launchPrompt,
  onConsumeLaunchPrompt,
  onPrepareWorkspaceRun,
  onReadWorkspaceContext,
  onApplyWorkspaceStep,
  onCommitWorkspaceRun,
  onRestoreWorkspaceBackup,
}: Props) {
  const { replyPreferences, saveReplyPreference, removeReplyPreference } = useReplyPreferences();
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestTitleRef = useRef(panel.title);
  const autoTitleRef = useRef<string | null>(null);
  const responseTimingRef = useRef<{
    startedAt: number;
    startedPerf: number;
    firstTokenAt?: number;
    firstTokenPerf?: number;
  } | null>(null);
  const visibleReplyContentRef = useRef('');
  const rowElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const rowSeenRef = useRef<Set<number>>(new Set());
  const rowHeightsRef = useRef<Map<number, number>>(new Map());
  const rowResizeObserversRef = useRef<Map<number, ResizeObserver>>(new Map());
  const visibilityObserverRef = useRef<IntersectionObserver | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const suppressAutoScrollUntilRef = useRef(0);
  const scrollTopRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const scrollDirectionRef = useRef<'up' | 'down'>('down');
  const [inputValue, setInputValue] = useState('');
  const [liveResponseMs, setLiveResponseMs] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const hasMessages = panel.messages.length > 0;
  const interruptedTaskResume = shouldShowInterruptedTaskResume(panel) ? panel.interruptedTask : null;

  function disconnectResizeObservers() {
    for (const observer of rowResizeObserversRef.current.values()) {
      observer.disconnect();
    }
    rowResizeObserversRef.current.clear();
  }

  function disconnectVisibilityObserver() {
    visibilityObserverRef.current?.disconnect();
    visibilityObserverRef.current = null;
  }

  function disconnectVirtualObservers() {
    disconnectResizeObservers();
    disconnectVisibilityObserver();
    rowElementsRef.current.clear();
  }

  function scrollMessagesToEnd(behavior: ScrollBehavior = 'auto') {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    stickToBottomRef.current = true;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }

  function syncViewportMetrics() {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const nextScrollTop = viewport.scrollTop;
    const previousScrollTop = scrollTopRef.current;

    if (nextScrollTop < previousScrollTop) {
      scrollDirectionRef.current = 'up';
    } else if (nextScrollTop > previousScrollTop) {
      scrollDirectionRef.current = 'down';
    }

    scrollTopRef.current = nextScrollTop;
    stickToBottomRef.current =
      viewport.scrollHeight - (nextScrollTop + viewport.clientHeight) <= STICKY_SCROLL_THRESHOLD_PX;
    setScrollTop(nextScrollTop);
    setViewportHeight(viewport.clientHeight);
  }

  function handleVirtualRowRef(index: number, node: HTMLDivElement | null) {
    const previousNode = rowElementsRef.current.get(index);
    if (previousNode && previousNode !== node) {
      visibilityObserverRef.current?.unobserve(previousNode);
    }

    const resizeObservers = rowResizeObserversRef.current;
    resizeObservers.get(index)?.disconnect();
    resizeObservers.delete(index);
    rowElementsRef.current.delete(index);

    if (!node) return;

    rowElementsRef.current.set(index, node);
    node.dataset.rowIndex = String(index);
    node.dataset.enter = scrollDirectionRef.current;
    if (rowSeenRef.current.has(index)) {
      node.classList.add('is-visible');
    } else {
      node.classList.remove('is-visible');
    }

    const measure = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      const previousHeight = rowHeightsRef.current.get(index);

      if (!nextHeight || previousHeight === nextHeight) return;

      rowHeightsRef.current.set(index, nextHeight);
      setMeasurementVersion((version) => version + 1);
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        measure();
      });
      resizeObserver.observe(node);
      resizeObservers.set(index, resizeObserver);
    }

    if (typeof IntersectionObserver === 'undefined') {
      node.classList.add('is-visible');
      rowSeenRef.current.add(index);
      return;
    }

    if (!rowSeenRef.current.has(index)) {
      visibilityObserverRef.current?.observe(node);
    }
  }

  useEffect(() => {
    latestTitleRef.current = panel.title;
  }, [panel.title]);

  useEffect(() => {
    autoTitleRef.current = null;
  }, [panel.id]);

  useEffect(() => {
    rowHeightsRef.current.clear();
    rowSeenRef.current.clear();
    disconnectVirtualObservers();
    scrollTopRef.current = 0;
    stickToBottomRef.current = true;
    scrollDirectionRef.current = 'down';
    setScrollTop(0);
    setViewportHeight(messagesViewportRef.current?.clientHeight ?? 0);
    setMeasurementVersion(0);
  }, [panel.id]);

  useEffect(() => {
    const resizeObservers = rowResizeObserversRef.current;
    const heights = rowHeightsRef.current;

    for (const index of [...resizeObservers.keys()]) {
      if (index < panel.messages.length) continue;
      resizeObservers.get(index)?.disconnect();
      resizeObservers.delete(index);
    }

    for (const index of [...rowElementsRef.current.keys()]) {
      if (index < panel.messages.length) continue;
      const node = rowElementsRef.current.get(index);
      if (node) {
        visibilityObserverRef.current?.unobserve(node);
      }
      rowElementsRef.current.delete(index);
    }

    for (const index of [...heights.keys()]) {
      if (index < panel.messages.length) continue;
      heights.delete(index);
    }

    for (const index of [...rowSeenRef.current.values()]) {
      if (index < panel.messages.length) continue;
      rowSeenRef.current.delete(index);
    }
  }, [panel.messages.length]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return undefined;

    const queueSync = () => {
      if (scrollFrameRef.current != null) return;

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncViewportMetrics();
      });
    };

    syncViewportMetrics();

    const handleScroll = () => {
      queueSync();
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return;

      const normalizedDelta = normalizeWheelDelta(event, viewport);
      if (normalizedDelta === 0) return;

      event.preventDefault();
      viewport.scrollTop += normalizedDelta * MESSAGE_WHEEL_DAMPING;
      queueSync();
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    viewport.addEventListener('wheel', handleWheel, { passive: false });

    if (typeof IntersectionObserver !== 'undefined') {
      visibilityObserverRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLDivElement;

          if (entry.isIntersecting) {
            target.dataset.enter = scrollDirectionRef.current;
            target.classList.add('is-visible');
            const rowIndex = Number(target.dataset.rowIndex);
            if (Number.isFinite(rowIndex)) {
              rowSeenRef.current.add(rowIndex);
            }
            visibilityObserverRef.current?.unobserve(target);
          }
        }
      }, {
        root: viewport,
        threshold: 0,
      });

      for (const node of rowElementsRef.current.values()) {
        visibilityObserverRef.current.observe(node);
      }
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        queueSync();
      });
      resizeObserver.observe(viewport);
    }

    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('wheel', handleWheel);
      disconnectVisibilityObserver();
      resizeObserver?.disconnect();
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [panel.id]);

  useEffect(() => {
    return () => {
      disconnectVirtualObservers();
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hasMessages && !panel.streaming) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, panel.id, panel.streaming]);

  useEffect(() => {
    if (!stickToBottomRef.current || !hasMessages) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('smooth');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, panel.messages.length]);

  useEffect(() => {
    if (!stickToBottomRef.current || !panel.streamingContent) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [panel.streamingContent]);

  useEffect(() => {
    if (!stickToBottomRef.current || (!hasMessages && !panel.streaming)) return;
    if (performance.now() < suppressAutoScrollUntilRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, measurementVersion, panel.streaming]);

  function handleAssistantRunStatusToggle() {
    suppressAutoScrollUntilRef.current = performance.now() + 500;
  }

  useEffect(() => {
    if (!panel.streaming) {
      if (!backgroundMode) {
        inputRef.current?.focus();
      }
      setLiveResponseMs(null);
    }
  }, [backgroundMode, panel.streaming]);

  useEffect(() => {
    if (!panel.streaming || !responseTimingRef.current) return undefined;

    const tick = () => {
      if (!responseTimingRef.current) return;
      setLiveResponseMs(Math.max(0, performance.now() - responseTimingRef.current.startedPerf));
    };

    tick();
    const interval = window.setInterval(tick, 100);
    return () => window.clearInterval(interval);
  }, [panel.streaming]);

  const replyPreferenceFeedbackById = new Map(
    replyPreferences.map((entry) => [entry.id, entry.feedback]),
  );

  const handleReplyFeedbackChange = useCallback((assistantMessage: Message, assistantIndex: number, next: ReplyFeedback | null) => {
    const draft = buildReplyPreferenceEntry({
      chatId: panel.id,
      chatTitle: panel.title,
      assistantMessage,
      assistantIndex,
      messages: panel.messages,
      panel,
      feedback: next ?? 'liked',
    });

    if (!draft) return;

    if (next == null) {
      removeReplyPreference(draft.id);
      return;
    }

    saveReplyPreference({
      ...draft,
      feedback: next,
    });
  }, [panel, removeReplyPreference, saveReplyPreference]);

  function handleExportLog() {
    const blob = new Blob([exportChatAsMarkdown(panel)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${panel.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'chat'}_log.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function handleRestoreLatestWorkspaceBackup() {
    if (!panel.projectId || !panel.latestWorkspaceBackup || !onRestoreWorkspaceBackup) return;
    const confirmed = window.confirm('Restore the workspace to the backup saved before the latest AI run? Current files in the workspace will be replaced.');
    if (!confirmed) return;
    await onRestoreWorkspaceBackup(panel.projectId, panel.latestWorkspaceBackup);
  }

  async function handleRestoreReplyWorkspaceChanges(changeSet: MessageWorkspaceChangeSet) {
    if (!panel.projectId || !changeSet.backup || !onRestoreWorkspaceBackup) return;
    const confirmed = window.confirm('Undo this reply by restoring the workspace to the backup saved before it ran? Current files in the workspace will be replaced.');
    if (!confirmed) return;
    await onRestoreWorkspaceBackup(panel.projectId, changeSet.backup);
  }

  function handleResumeInterruptedTask() {
    if (!interruptedTaskResume || panel.streaming) return;
    const resumePrompt = interruptedTaskResume.resumePrompt?.trim() || buildInterruptedTaskResumePrompt(interruptedTaskResume);
    void sendPrompt(resumePrompt);
  }

  const sendPrompt = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || panel.streaming) return;
    setInputValue('');

    const userMsg: Message               = { role: 'user', content: text };
    const updatedMessages                = [...panel.messages, userMsg];
    const snapshotRegistry: FileRegistry = new Map(panel.fileRegistry);
    const presetId                       = panel.preset ?? DEFAULT_PRESET_ID;
    const isCodePreset                   = presetId === 'code';
    const reasoningEffort                = panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const reasoningConfig                = REASONING_EFFORT_CONFIG[reasoningEffort];
    const chatWorkflow                   = !isCodePreset
      ? classifyChatWorkflow(text, panel.messages, presetId)
      : null;
    const effectivePresetId              = chatWorkflow?.effectivePresetId ?? presetId;
    const fetchDepth: FetchContextDepth  = !isCodePreset && (chatWorkflow?.fetchDepth === 'deep' || reasoningConfig.fetchDepth === 'deep')
      ? 'deep'
      : chatWorkflow?.fetchDepth ?? 'standard';
    const modelName                      = resolveModelHandle(panel.model, models, { preserveUnavailable: true });
    const correctionTurn                 = !isCodePreset && isCorrectionPrompt(text);
    const crewLookupTurn                 = !isCodePreset && isCrewLookupPrompt(text);
    const hasPromptUrls                  = extractUrlsFromText(text).length > 0;
    const fetchLiveContext               = !isCodePreset && shouldFetchGlobalContext(text, panel.messages, {
      forceFetch: correctionTurn || crewLookupTurn || chatWorkflow?.forceFetch,
    });
    const runStartedAt = Date.now();
    const initialPhaseLabel = hasPromptUrls || fetchLiveContext ? 'Fetching context...' : 'Starting reply...';
    const interruptedTask: InterruptedTaskState | null = isCodePreset && panel.projectId
      ? {
          prompt: text,
          startedAt: runStartedAt,
          assistantMessageCountAtStart: updatedMessages.filter((message) => message.role === 'assistant').length,
          threadType: panel.threadType ?? 'code',
          projectId: panel.projectId,
          projectLabel: panel.projectLabel,
          lastPhaseLabel: initialPhaseLabel,
          resumePrompt: [
            'Continue the interrupted workspace task from the current workspace state.',
            `Original request: ${text}`,
            'Some files may already have been created or updated.',
            'Read the workspace as it exists now, continue from what is already done, and do not restart the project from scratch.',
          ].join('\n'),
        }
      : null;
    const trace = createResponseTrace({
      prompt: text,
      panel,
      model: modelName,
      presetId: effectivePresetId,
      reasoningEffort,
      pipeline: isCodePreset ? 'deep-plan' : 'single-pass',
      startedAt: runStartedAt,
    });
    if (isCodePreset) {
      const understandingPhase = startTracePhase(
        trace,
        'understand-request',
        'Understand request',
        buildInitialWorkspaceUnderstandingParagraph(text, {
          existingFileCount: snapshotRegistry.size,
          projectLabel: panel.projectLabel,
          runStartedAt,
          panelId: panel.id,
        }),
      );
      finishTracePhase(understandingPhase, {
        metrics: [
          { label: 'Workspace files', value: String(snapshotRegistry.size) },
        ],
      });
    }
    if (chatWorkflow) {
      trace.chatMode = chatWorkflow.mode;
      trace.chatModeConfidence = chatWorkflow.confidence;
      trace.reasoningSummary = chatWorkflow.summary;
    }
    let terminalTracePhase: ResponseTracePhase | undefined;
    let preparedWorkspaceBackup: WorkspaceBackupReference | null = panel.latestWorkspaceBackup ?? null;
    let workspaceWrittenFiles: Array<{ path: string; purpose?: string }> = [];
    let workspaceExecutionHistory: Array<{ path: string; exports: string[] }> = [];
    let activeWorkspaceRegistry: FileRegistry = new Map(panel.fileRegistry);
    let workspaceEntryInventory = buildWorkspaceEntryInventory([], activeWorkspaceRegistry);
    let technicalDocContexts: FetchedContext[] = [];
    let technicalDocInject = '';
    let resolvedPackages: PackageVersion[] = [];
    let currentWorkspaceProjectSummary = text;
    let cachedManifestPackageSignature = '';
    let cachedManifestResolvedPackages: PackageVersion[] = [];
    responseTimingRef.current = { startedAt: runStartedAt, startedPerf: performance.now() };
    visibleReplyContentRef.current = '';
    setLiveResponseMs(0);

    onUpdate(panel.id, {
      messages: updatedMessages,
      streaming: true,
      streamingContent: '',
      streamingTrace: cloneTrace(trace),
      prevRegistry: snapshotRegistry,
      streamingPhase: {
        label: initialPhaseLabel,
        stepIndex: 0,
        totalSteps: 0,
      },
      interruptedTask,
    });

    const pushStreamingTrace = (patch: Partial<Panel> = {}) => {
      onUpdate(panel.id, {
        ...patch,
        streamingTrace: cloneTrace(trace),
      });
    };

    const abort = new AbortController();
    abortRef.current = abort;

    async function buildWorkspacePackageVersionInject(registry: FileRegistry): Promise<string> {
      const manifestPackages = readWorkspaceManifestPackages(registry);
      const signature = manifestPackages.map((pkg) => `${pkg.ecosystem}:${pkg.name}`).join('|');
      if (!signature) {
        cachedManifestPackageSignature = '';
        cachedManifestResolvedPackages = [];
      } else if (signature !== cachedManifestPackageSignature) {
        const manifestResolution = await awaitWithTimeout(
          resolvePackageVersions(manifestPackages),
          MANIFEST_PACKAGE_VERSION_WAIT_MS,
          [],
        );
        cachedManifestResolvedPackages = manifestResolution.value;
        cachedManifestPackageSignature = signature;
      }

      return packageVersionsToSystemInject(mergePackageVersions(resolvedPackages, cachedManifestResolvedPackages));
    }

    // Auto-fetch: URLs in the prompt + global knowledge sources
    // Pass the full conversation history so follow-up questions ("what is the
    // US involvement?") can inherit topics from prior messages ("Iran").
    // Global context is injected BOTH into the system prompt AND as a synthetic
    // assistant prefill turn in the conversation, so even small models that
    // deprioritise system prompts will see and use the live data.
    let urlInject    = '';
    let globalInject = '';
    let replyPreferenceInject = '';
    let contextTurns: Message[] = [];
    let promptContexts: FetchedContext[] = [];
    let globalContexts: FetchedContext[] = [];
    let promptBundleContexts: FetchedContext[] = [];
    let verifiedPromptBundleContexts: FetchedContext[] = [];
    let verifiedLiveSourceCount = 0;
    let contextFetchErrorMessage: string | null = null;
    const shouldUseReplyPreferences = !isCodePreset;
    const replyPreferenceSummary = shouldUseReplyPreferences
      ? buildReplyPreferenceInject({
          preferences: replyPreferences,
          prompt: text,
          surface: getTraceSurface(panel),
          preset: effectivePresetId,
        })
      : { inject: '', matchedCount: 0 };
    const promptContextPhase = hasPromptUrls
      ? startTracePhase(trace, 'prompt-url-fetch', 'Fetch linked URLs', 'Scrape any URLs the user pasted into the prompt before generation.')
      : undefined;
    const chatModePhase = chatWorkflow
      ? startTracePhase(trace, 'classify-chat-mode', 'Detect chat mode', 'Classify the prompt as conversation, note-taking, creative, or deep research before retrieval.')
      : undefined;
    const liveContextPhase = fetchLiveContext
      ? startTracePhase(trace, 'live-context-fetch', 'Fetch live context', 'Query public sources for up-to-date context before the reply stream begins.')
      : undefined;
    const replyPreferencePhase = startTracePhase(
      trace,
      'reply-preferences',
      'Load reply preferences',
      'Apply previously rated valid and invalid replies as guidance when they are relevant to the current prompt.',
    );
    pushStreamingTrace();
    try {
      if (isCodePreset && panel.projectId && onPrepareWorkspaceRun) {
        const backupPhase = startTracePhase(
          trace,
          'backup-workspace',
          'Back up workspace',
          'Create a restore point before reading, planning, or writing workspace code.',
        );
        terminalTracePhase = backupPhase;
        pushStreamingTrace({
          streamingPhase: {
            label: 'Backing up workspace...',
            stepIndex: 0,
            totalSteps: 0,
          },
        });
        preparedWorkspaceBackup = await onPrepareWorkspaceRun(panel, text);
        finishTracePhase(backupPhase, {
          detail: preparedWorkspaceBackup
            ? 'Saved a workspace restore point before starting the live coding run.'
            : 'No workspace backup was created for this run.',
        });
        terminalTracePhase = undefined;
        pushStreamingTrace(preparedWorkspaceBackup
          ? { latestWorkspaceBackup: preparedWorkspaceBackup }
          : {});
      }

      if (chatModePhase && chatWorkflow) {
        finishTracePhase(chatModePhase, {
          detail: chatWorkflow.summary,
          metrics: [
            { label: 'Mode', value: chatWorkflow.mode },
            { label: 'Preset', value: effectivePresetId },
            { label: 'Confidence', value: chatWorkflow.confidence },
            { label: 'Fetch depth', value: fetchDepth },
          ],
        });
      }

      replyPreferenceInject = replyPreferenceSummary.inject;
      finishTracePhase(replyPreferencePhase, {
        status: shouldUseReplyPreferences ? 'completed' : 'skipped',
        detail: shouldUseReplyPreferences
          ? replyPreferenceSummary.matchedCount > 0
            ? `Matched ${replyPreferenceSummary.matchedCount} previously rated reply preference${replyPreferenceSummary.matchedCount === 1 ? '' : 's'} for this prompt.`
            : 'No prior reply preferences were relevant enough to inject into this prompt.'
          : 'Skipped app-wide reply preferences for this workspace code run to avoid cross-project bleed-through.',
        metrics: [
          { label: 'Stored', value: String(replyPreferences.length) },
          { label: 'Matched', value: String(replyPreferenceSummary.matchedCount) },
        ],
      });
      pushStreamingTrace();

      const [loadedPromptContexts, loadedGlobalContexts] = await Promise.all([
        fetchUrlsFromPrompt(text),
        fetchLiveContext
          ? fetchGlobalContext(text, panel.messages, {
              depth: fetchDepth,
              forceFetch: chatWorkflow?.forceFetch,
              maxSources: reasoningConfig.maxSources,
            })
          : Promise.resolve([]),
      ]);
      promptContexts = loadedPromptContexts;
      globalContexts = loadedGlobalContexts;
      promptBundleContexts = globalContexts.filter((context) => context.promptSelected);
      verifiedPromptBundleContexts = promptBundleContexts.filter((context) =>
        !context.error
        && context.contextOrigin !== 'search-result'
        && context.text.trim().length >= 120,
      );
      verifiedLiveSourceCount = verifiedPromptBundleContexts.length;
      appendTraceSources(trace, promptContexts, 'prompt-url');
      appendTraceSources(trace, globalContexts, 'live-context');

      if (promptContextPhase) {
        const fetchedPromptCount = promptContexts.filter((context) => !context.error && context.text.trim()).length;
        const promptErrorCount = promptContexts.filter((context) => context.error).length;
        finishTracePhase(promptContextPhase, {
          detail: fetchedPromptCount > 0
            ? `Fetched ${fetchedPromptCount} linked source${fetchedPromptCount === 1 ? '' : 's'} before reply generation.`
            : 'No linked pages returned usable content.',
          metrics: [
            { label: 'URLs', value: String(promptContexts.length) },
            { label: 'Fetched', value: String(fetchedPromptCount) },
            ...(promptErrorCount > 0 ? [{ label: 'Errors', value: String(promptErrorCount) }] : []),
          ],
        });
      }

      if (liveContextPhase) {
        const fetchedLiveCount = globalContexts.filter((context) => !context.error && context.text.trim()).length;
        const liveErrorCount = globalContexts.filter((context) => context.error).length;
        const officialCount = globalContexts.filter((context) => context.credibility === 'official').length;
        const majorNewsCount = globalContexts.filter((context) => context.credibility === 'major-news').length;
        const communityCount = globalContexts.filter((context) => context.credibility === 'community').length;
        finishTracePhase(liveContextPhase, {
          detail: verifiedLiveSourceCount > 0
            ? `Collected ${globalContexts.length} ranked live source${globalContexts.length === 1 ? '' : 's'} and promoted ${verifiedLiveSourceCount} verified page${verifiedLiveSourceCount === 1 ? '' : 's'} into the prompt bundle.`
            : fetchedLiveCount > 0
              ? `Collected ${globalContexts.length} live source lead${globalContexts.length === 1 ? '' : 's'}, but none produced a verified evidence page for the prompt bundle.`
              : 'No live context sources returned usable text.',
          metrics: [
            { label: 'Sources', value: String(globalContexts.length) },
            { label: 'Fetched', value: String(fetchedLiveCount) },
            ...(promptBundleContexts.length > 0 ? [{ label: 'Prompt bundle', value: String(promptBundleContexts.length) }] : []),
            ...(verifiedLiveSourceCount > 0 ? [{ label: 'Verified pages', value: String(verifiedLiveSourceCount) }] : []),
            ...(officialCount > 0 ? [{ label: 'Official', value: String(officialCount) }] : []),
            ...(majorNewsCount > 0 ? [{ label: 'Major News', value: String(majorNewsCount) }] : []),
            ...(communityCount > 0 ? [{ label: 'Community', value: String(communityCount) }] : []),
            ...(liveErrorCount > 0 ? [{ label: 'Errors', value: String(liveErrorCount) }] : []),
          ],
        });
      }

      urlInject    = urlContextToSystemInject(promptContexts);
      globalInject = globalContextToSystemInject(verifiedPromptBundleContexts, { depth: fetchDepth });
      contextTurns = globalContextToConversationInject(verifiedPromptBundleContexts, text, { depth: fetchDepth });
      pushStreamingTrace();
    } catch (error) {
      contextFetchErrorMessage = error instanceof Error ? error.message : String(error);
      if (replyPreferencePhase.status === 'running') {
        finishTracePhase(replyPreferencePhase, {
          status: 'error',
          detail: 'Reply preference memory could not be applied before reply generation.',
        });
      }
      if (chatModePhase?.status === 'running') {
        finishTracePhase(chatModePhase, {
          status: 'error',
          detail: 'Prompt classification failed before reply generation.',
        });
      }
      finishTracePhase(promptContextPhase, {
        status: 'error',
        detail: contextFetchErrorMessage || 'Linked page fetching failed before reply generation.',
      });
      finishTracePhase(liveContextPhase, {
        status: 'error',
        detail: contextFetchErrorMessage || 'Live context fetching failed before reply generation.',
      });
      pushStreamingTrace();
    }

    // Non-code presets - single pass
    let limitedContextDisclaimer = '';
    if (!isCodePreset) {
      const preset = getPreset(effectivePresetId);
      const referenceDate = new Date();
      const referenceDateLabel = formatChatReferenceDate(referenceDate);
      const referenceDateIso = referenceDate.toISOString();
      const baseRequiredLiveSourceCount = fetchLiveContext
        ? getRequiredLiveSourceCount(text, panel.messages, {
            depth: fetchDepth,
            forceFetch: correctionTurn || crewLookupTurn || chatWorkflow?.forceFetch,
          })
        : 0;
      const requiredLiveSourceCount = fetchLiveContext
        ? Math.max(baseRequiredLiveSourceCount, reasoningConfig.minLiveSources)
        : 0;
      const runtimeDateInject = buildRuntimeDateInject(referenceDateLabel);
      const chatWorkflowInject = chatWorkflow
        ? buildChatWorkflowInject({
            mode: chatWorkflow.mode,
            summary: chatWorkflow.summary,
            minParagraphs: chatWorkflow.minParagraphs,
            minSentencesPerParagraph: chatWorkflow.minSentencesPerParagraph,
            referenceDateLabel,
            forceFetch: chatWorkflow.forceFetch,
          })
        : '';
      const reasoningEffortInject = buildReasoningEffortInject({
        effort: reasoningEffort,
        fetchLiveContext,
        requiredLiveSourceCount,
        targetLiveSourceCount: reasoningConfig.maxSources,
      });
      const liveResearchFallbackInject = fetchLiveContext && verifiedLiveSourceCount === 0
        ? [
            '',
            '---',
            '## Live Research Retrieval Status',
            contextFetchErrorMessage?.includes('Local fetch proxy unavailable')
              ? 'A live research pass was attempted, but this app session is not connected to a valid local fetch proxy.'
              : globalContexts.length > 0
                ? 'A live research pass was attempted for this prompt and found source leads, but no usable external evidence pages were verified.'
                : 'A live research pass was attempted for this prompt, but no usable external excerpts were captured.',
            'You must still help the user instead of refusing, but you must not invent or guess current facts.',
            '',
            'Rules:',
            '- Give the most useful stable background insight you can from general knowledge.',
            '- Clearly separate stable background context from any current-status claim you could not verify live.',
            '- Do not state exact current timelines, launch dates, crew lists, locations, counts, schedules, or status milestones unless they were verified by fetched live sources.',
            '- If a fresh fact could not be verified, say that exact point remains unverified instead of turning it into a confident claim.',
            '- Do not use phrases like "as of my last update", and do not answer a current-events question with stale training-era dates as if they were current.',
            '- Say that live retrieval did not return usable excerpts in this pass if needed, not that you lack real-time access.',
            '- Never answer with "I do not have access to real-time information", "my training data does not include this", or a deflection to search elsewhere.',
            '---',
          ].join('\n')
        : '';
      const hasLimitedLiveContext = fetchLiveContext
        && requiredLiveSourceCount > 0
        && verifiedLiveSourceCount > 0
        && verifiedLiveSourceCount < requiredLiveSourceCount;
      const limitedLiveContextInject = hasLimitedLiveContext
        ? buildLimitedLiveContextInject(verifiedLiveSourceCount, requiredLiveSourceCount)
        : '';
      const chatAwarenessContext = buildChatAwarenessTurnContent(updatedMessages, text);
      const chatAwarenessInject = chatAwarenessContext
        ? `\n---\n${chatAwarenessContext}\nKeep that active subject central whenever the new user prompt is generic or elliptical.\n---\n`
        : '';
      const correctionInject = correctionTurn ? buildCorrectionInject() : '';
      const crewLookupInject = crewLookupTurn ? buildCrewLookupInject() : '';
      const crewRosterPhase = crewLookupTurn
        ? startTracePhase(
            trace,
            'extract-crew-roster',
            'Validate crew roster',
            'Derive a validated crew roster from the fetched live sources before answer generation.',
          )
        : undefined;
      let validatedCrewRoster: ExtractedCrewRosterMember[] = [];
      const caseParticipantPhase = startTracePhase(
        trace,
        'extract-case-participants',
        'Validate case participants',
        'Derive a validated roster of defendants, accused people, or people tried from the fetched live sources before answer generation.',
      );
      let validatedCaseParticipants: ExtractedCaseParticipantMember[] = [];
      if (crewLookupTurn) {
        const rosterContexts = verifiedPromptBundleContexts.length
          ? verifiedPromptBundleContexts
          : globalContexts.filter((context) =>
              !context.error
              && context.contextOrigin !== 'search-result'
              && context.text.trim().length >= 120,
            ).slice(0, 80);
        validatedCrewRoster = extractCrewRosterFromContexts(
          rosterContexts,
          text,
          panel.messages,
        );
        if (crewRosterPhase) {
          finishTracePhase(crewRosterPhase, {
            detail: validatedCrewRoster.length > 0
              ? `Validated ${validatedCrewRoster.length} crew roster entr${validatedCrewRoster.length === 1 ? 'y' : 'ies'} from the fetched live sources.`
              : globalContexts.length > 0
                ? 'Live sources were fetched, but no validated crew roster could be derived from them.'
                : 'No live sources were available to derive a validated crew roster.',
            metrics: [
              { label: 'Live sources', value: String(globalContexts.length) },
              { label: 'Validated names', value: String(validatedCrewRoster.length) },
            ],
          });
        }
      }
      const caseParticipantContexts = verifiedPromptBundleContexts.length
        ? verifiedPromptBundleContexts
        : globalContexts.filter((context) =>
            !context.error
            && context.contextOrigin !== 'search-result'
            && context.text.trim().length >= 120,
          ).slice(0, 80);
      validatedCaseParticipants = extractCaseParticipantRosterFromContexts(
        caseParticipantContexts,
        text,
        panel.messages,
      );
      finishTracePhase(caseParticipantPhase, {
        detail: validatedCaseParticipants.length > 0
          ? `Validated ${validatedCaseParticipants.length} case participant${validatedCaseParticipants.length === 1 ? '' : 's'} from the fetched live sources.`
          : globalContexts.length > 0
            ? 'No validated case participant roster was derived from the fetched live sources for this prompt.'
            : 'No live sources were available to derive a validated case participant roster.',
        metrics: [
          { label: 'Live sources', value: String(globalContexts.length) },
          { label: 'Validated names', value: String(validatedCaseParticipants.length) },
        ],
      });
      pushStreamingTrace();
      const validatedCrewInject = validatedCrewRoster.length > 0
        ? buildValidatedCrewRosterInject(validatedCrewRoster)
        : '';
      const validatedCaseParticipantInject = validatedCaseParticipants.length > 0
        ? buildValidatedCaseParticipantInject(validatedCaseParticipants)
        : '';
      const contextAssemblyPhase = startTracePhase(
        trace,
        'context-assembly',
        'Assemble model context',
        'Combine preset instructions, file context, fetched sources, and conversation history into the final prompt.',
      );
      const hasSufficientLiveContext = !fetchLiveContext
        || requiredLiveSourceCount <= 0
        || verifiedLiveSourceCount >= requiredLiveSourceCount;
      const verifiedEvidenceCount = countVerifiedEvidenceContexts([
        ...promptContexts,
        ...verifiedPromptBundleContexts,
      ]);
      const systemPrompt = runtimeDateInject
        + preset.systemPrompt
        + replyPreferenceInject
        + registryToSystemPrompt(panel.fileRegistry)
        + chatAwarenessInject
        + urlInject
        + globalInject
        + chatWorkflowInject
        + reasoningEffortInject
        + correctionInject
        + crewLookupInject
        + validatedCrewInject
        + validatedCaseParticipantInject
        + liveResearchFallbackInject
        + limitedLiveContextInject;
      finishTracePhase(contextAssemblyPhase, {
        detail: contextTurns.length > 0
          ? 'Injected fetched live context into both the system prompt and the conversation history.'
          : 'Built the final prompt from the preset, registry, and conversation history.',
        metrics: [
          { label: 'Reasoning', value: reasoningConfig.label },
          { label: 'Preference matches', value: String(replyPreferenceSummary.matchedCount) },
          { label: 'Prompt URLs', value: String(promptContexts.length) },
          { label: 'Live sources', value: String(globalContexts.length) },
          { label: 'Prompt bundle', value: String(promptBundleContexts.length) },
          { label: 'Verified live', value: String(verifiedLiveSourceCount) },
          ...(requiredLiveSourceCount > 0 ? [{ label: 'Required live', value: String(requiredLiveSourceCount) }] : []),
          { label: 'Injected turns', value: String(contextTurns.length) },
        ],
      });

      const enrichmentLabels: string[] = [];
      if (promptContexts.length) {
        enrichmentLabels.push(`${promptContexts.length} linked source${promptContexts.length === 1 ? '' : 's'}`);
      }
      if (globalContexts.length) {
        enrichmentLabels.push(
          verifiedLiveSourceCount > 0
            ? `${verifiedLiveSourceCount} verified live source${verifiedLiveSourceCount === 1 ? '' : 's'}`
            : `${globalContexts.length} live source lead${globalContexts.length === 1 ? '' : 's'}`,
        );
      }
      const modeLabel = chatWorkflow?.mode ? `${chatWorkflow.mode.replace(/-/g, ' ')} ` : '';
      trace.orchestrationSummary = enrichmentLabels.length > 0
        ? `Single-pass ${modeLabel}reply enriched with ${enrichmentLabels.join(' and ')} before streaming from ${modelName}.`
        : `Single-pass ${modeLabel}reply streamed directly from ${modelName} with no extra fetched context.`;
      pushStreamingTrace();

      if (!hasSufficientLiveContext) {
        const verificationPhase = startTracePhase(
          trace,
          'verify-live-sources',
          'Verify live source floor',
          'Ensure the prompt has enough verified live sources before answer generation.',
        );
        finishTracePhase(verificationPhase, {
          status: contextFetchErrorMessage?.includes('Local fetch proxy unavailable') ? 'error' : 'completed',
          detail: contextFetchErrorMessage?.includes('Local fetch proxy unavailable')
            ? `${contextFetchErrorMessage} Proceeding with limited-context guidance and a disclaimer instead of withholding the reply.`
            : `Captured ${verifiedLiveSourceCount} verified live source${verifiedLiveSourceCount === 1 ? '' : 's'} from ${globalContexts.length} total lead${globalContexts.length === 1 ? '' : 's'}, below the preferred ${requiredLiveSourceCount} for this prompt. Proceeding with limited-context guidance and a disclaimer.`,
          metrics: [
            { label: 'Leads', value: String(globalContexts.length) },
            { label: 'Verified', value: String(verifiedLiveSourceCount) },
            { label: 'Required', value: String(requiredLiveSourceCount) },
          ],
        });
        limitedContextDisclaimer = buildLimitedContextDisclaimer(verifiedLiveSourceCount, requiredLiveSourceCount);
        trace.orchestrationSummary = contextFetchErrorMessage?.includes('Local fetch proxy unavailable')
          ? 'Live retrieval was limited by the local fetch proxy, so the reply proceeded with conservative fallback guidance and a limited-context disclaimer.'
          : `Live retrieval captured ${verifiedLiveSourceCount} verified source${verifiedLiveSourceCount === 1 ? '' : 's'} from ${globalContexts.length} total lead${globalContexts.length === 1 ? '' : 's'}, below the preferred ${requiredLiveSourceCount}; the reply proceeded with a limited-context disclaimer instead of being withheld.`;
        pushStreamingTrace();
      }

      if (crewLookupTurn && isDirectCrewIdentityPrompt(text)) {
        trace.orchestrationSummary = validatedCrewRoster.length > 0
          ? `Direct crew lookup answered from ${validatedCrewRoster.length} validated roster entr${validatedCrewRoster.length === 1 ? 'y' : 'ies'} extracted from live sources.`
          : 'Direct crew lookup could not derive a validated roster from the live sources, so the reply was withheld instead of guessed.';
        pushStreamingTrace();
        await finaliseResponse(
          buildCrewLookupReply(validatedCrewRoster, text, referenceDateLabel),
          updatedMessages,
          snapshotRegistry,
          panel.fileRegistry,
        );
        return;
      }

      const identitySensitiveTurn = isIdentitySensitivePrompt(text) || isCorrectionPrompt(text);
      const shouldWithholdForInsufficientEvidence = fetchLiveContext
        && requiredLiveSourceCount > 0
        && (
          verifiedEvidenceCount === 0
          || (
            identitySensitiveTurn
            && validatedCaseParticipants.length === 0
            && verifiedEvidenceCount < 2
            && verifiedLiveSourceCount < requiredLiveSourceCount
          )
        );

      if (shouldWithholdForInsufficientEvidence) {
        const insufficientEvidencePhase = startTracePhase(
          trace,
          'withhold-unverified-reply',
          'Withhold unverified reply',
          'Avoid generating a factual answer when the live research run did not return enough usable evidence to support one reliably.',
        );
        finishTracePhase(insufficientEvidencePhase, {
          detail: verifiedEvidenceCount === 0
            ? 'The live research run returned discovery snippets or otherwise insufficient evidence pages, so the reply was withheld instead of guessed.'
            : 'The live research run did not return enough usable evidence to verify the requested people or outcomes, so the reply was withheld instead of guessed.',
          metrics: [
            { label: 'Fetched live', value: String(globalContexts.length) },
            { label: 'Evidence pages', value: String(verifiedEvidenceCount) },
            { label: 'Validated names', value: String(validatedCaseParticipants.length) },
          ],
        });
        trace.orchestrationSummary = verifiedEvidenceCount === 0
          ? 'Live retrieval only returned discovery-level material, so the app withheld a factual answer instead of guessing from snippets.'
          : 'Live retrieval did not return enough usable evidence to verify the requested people or outcomes, so the app withheld the reply instead of guessing.';
        pushStreamingTrace();
        await finaliseResponse(
          buildInsufficientEvidenceReply({
            prompt: text,
            verifiedEvidenceCount,
            fetchedSourceCount: globalContexts.length,
            requiredSourceCount: requiredLiveSourceCount,
          }),
          updatedMessages,
          snapshotRegistry,
          panel.fileRegistry,
        );
        return;
      }

      // Build the message array: history + [assistant context prefill] + user message.
      // The context prefill keeps the gathered research in play without forcing the
      // final visible answer to narrate the retrieval process.
      const priorHistory = buildConversationHistoryForReply(updatedMessages, text);
      const messagesWithContext = [
        ...priorHistory,
        ...(chatAwarenessContext ? [{ role: 'assistant' as const, content: chatAwarenessContext }] : []),
        ...contextTurns,   // synthetic assistant turn with live research
        userMsg,           // the user's actual question
      ];

      let accumulated = '';
      terminalTracePhase = startTracePhase(
        trace,
        'draft-reply',
        'Draft reply',
        'Generate an internal draft before the backend review pass finalizes the user-visible answer.',
      );
      pushStreamingTrace({
        streamingPhase: {
          label: 'Drafting reply...',
          stepIndex: 0,
          totalSteps: 0,
        },
      });
      try {
        const gen = streamChat(modelName, messagesWithContext, systemPrompt, abort.signal);
        for await (const chunk of gen) {
          markFirstToken();
          accumulated += chunk;
        }
        finishTracePhase(terminalTracePhase, {
          detail: `Generated an internal draft of ${countWords(accumulated)} words before review.`,
          metrics: [
            { label: 'Words', value: String(countWords(accumulated)) },
          ],
        });
        terminalTracePhase = undefined;
        pushStreamingTrace();
        const reviewedReply = await reviewReplyDraft(accumulated, messagesWithContext, {
          systemPrompt,
          referenceDateIso,
          requiredLiveSourceCount,
          verifiedSourceCount: verifiedLiveSourceCount,
          fetchLiveContext,
        });
        await finaliseResponse(reviewedReply, updatedMessages, snapshotRegistry, panel.fileRegistry);
      } catch (err) {
        handleError(err, updatedMessages);
      }
      return;
    }

    async function executeWorkspacePlanSteps(options: {
      plan: {
        projectSummary: string;
        mode: RequestMode;
        steps: DeepStep[];
      };
      registry: FileRegistry;
      requestPrompt: string;
      phaseKey: string;
      writeVerb?: string;
      assistantContext?: string;
      technicalDocsInject?: string;
      updatePlannerTrace?: boolean;
    }): Promise<FileRegistry> {
      let currentRegistry = new Map(options.registry);

      for (let si = 0; si < options.plan.steps.length; si++) {
        const step = options.plan.steps[si];
        if (!workspaceFilePathHasDefinedType(step.filePath)) {
          throw new Error(`Refusing to write "${step.filePath}" because the planned file path does not define a real file type or extension.`);
        }
        const readPhase = startTracePhase(
          trace,
          `${options.phaseKey}-read-step-${si + 1}`,
          `Reading ${step.filePath}`,
          `Review the current workspace context for ${step.filePath} before generating the next change.`,
        );
        pushStreamingTrace({
          streamingContent: '',
          streamingPhase: {
            label: `Reading ${step.filePath}...`,
            stepIndex: si + 1,
            totalSteps: options.plan.steps.length,
          },
        });

        const stepUserMsg = buildWorkspaceStepUserMessage(
          options.plan,
          step,
          workspaceExecutionHistory,
          currentRegistry,
          workspaceEntryInventory,
        );
        finishTracePhase(readPhase, {
          detail: `Loaded the live workspace context for ${step.filePath}.`,
          metrics: [
            { label: 'Known files', value: String(currentRegistry.size) },
            { label: 'Imports', value: String(step.imports.length) },
          ],
        });

        const writeVerb = options.writeVerb ?? 'Writing';
        const stepPhase = startTracePhase(
          trace,
          `${options.phaseKey}-execute-step-${si + 1}`,
          `${writeVerb} ${step.filePath}`,
          `${step.filePath} - ${step.purpose}`,
        );
        terminalTracePhase = stepPhase;

        pushStreamingTrace({
          streamingContent: '',
          streamingPhase: {
            label: `${writeVerb} ${step.filePath}...`,
            stepIndex: si + 1,
            totalSteps: options.plan.steps.length,
          },
        });
        const stepMessages: Message[] = [
          { role: 'user', content: options.requestPrompt },
          {
            role: 'assistant',
            content: options.assistantContext
              ?? `Understood. I will implement this workspace one file at a time. I am writing ${step.filePath} against the current workspace state.`,
          },
          { role: 'user', content: stepUserMsg },
        ];

        const stepSystem = getStepExecutorSystem()
          + replyPreferenceInject
          + buildWorkspaceDirectoryInject(currentRegistry)
          + urlInject
          + (options.technicalDocsInject ?? '')
          + await buildWorkspacePackageVersionInject(currentRegistry);

        let stepContent = '';
        const gen = streamChat(modelName, stepMessages, stepSystem, abort.signal);
        for await (const token of gen) {
          markFirstToken();
          stepContent += token;
        }

        let resolvedStepBlock = resolveWorkspaceStepBlock(stepContent, step.filePath);
        if (!resolvedStepBlock) {
          const initialExtractionDiagnostic = diagnoseWorkspaceStepExtractionFailure(stepContent, step.filePath);
          const repairPhase = startTracePhase(
            trace,
            `${options.phaseKey}-repair-step-${si + 1}`,
            `Repairing ${step.filePath}`,
            `Normalize the generated output so ${step.filePath} can be written safely into the live workspace. ${initialExtractionDiagnostic.detail}`,
          );
          pushStreamingTrace({
            streamingContent: '',
            streamingPhase: {
              label: `Repairing ${step.filePath}...`,
              stepIndex: si + 1,
              totalSteps: options.plan.steps.length,
            },
          });
          const repairedContent = await repairWorkspaceStepOutput({
            modelName,
            abortSignal: abort.signal,
            request: options.requestPrompt,
            plan: options.plan,
            step,
            draft: stepContent,
            registry: currentRegistry,
            alreadyWritten: workspaceExecutionHistory,
            workspaceEntryPaths: workspaceEntryInventory,
            extractionDiagnostic: initialExtractionDiagnostic,
            technicalDocsInject: options.technicalDocsInject,
          });
          resolvedStepBlock = resolveWorkspaceStepBlock(repairedContent, step.filePath);
          if (!resolvedStepBlock) {
            const repairedExtractionDiagnostic = diagnoseWorkspaceStepExtractionFailure(repairedContent, step.filePath);
            finishTracePhase(repairPhase, {
              status: 'error',
              detail: formatWorkspaceExtractionDiagnostic(repairedExtractionDiagnostic),
            });
            throw new Error(buildWorkspaceExtractionErrorMessage(
              step.filePath,
              repairedExtractionDiagnostic,
              initialExtractionDiagnostic,
            ));
          }
          finishTracePhase(repairPhase, {
            detail: `Repaired the step output so ${step.filePath} could be written safely. Initial extraction issue: ${initialExtractionDiagnostic.detail}`,
            metrics: [
              { label: 'File', value: resolvedStepBlock!.path },
            ],
          });
        }

        const previousFileContent = currentRegistry.get(resolvedStepBlock.path)?.content ?? '';
        const stepDiffMetrics = computeDiff(previousFileContent, resolvedStepBlock.content);

        currentRegistry = updateRegistry(currentRegistry, [resolvedStepBlock], updatedMessages.length);
        activeWorkspaceRegistry = currentRegistry;
        workspaceEntryInventory = buildWorkspaceEntryInventory(workspaceEntryInventory, currentRegistry, [resolvedStepBlock.path]);

        if (onApplyWorkspaceStep) {
          const syncPhase = startTracePhase(
            trace,
            `${options.phaseKey}-sync-step-${si + 1}`,
            `Syncing ${resolvedStepBlock.path}`,
            `Write ${resolvedStepBlock.path} into the live workspace before the next step begins.`,
          );
          pushStreamingTrace({
            streamingContent: '',
            streamingPhase: {
              label: `Syncing ${resolvedStepBlock.path}...`,
              stepIndex: si + 1,
              totalSteps: options.plan.steps.length,
            },
          });
          const syncResult = await onApplyWorkspaceStep(panel, {
            path: resolvedStepBlock.path,
            content: resolvedStepBlock.content,
          });
          currentRegistry = buildRegistryFromWorkspaceEntries(syncResult.fileEntries);
          activeWorkspaceRegistry = currentRegistry;
          workspaceEntryInventory = buildWorkspaceEntryInventory(workspaceEntryInventory, currentRegistry, syncResult.writtenPaths);
          finishTracePhase(syncPhase, {
            detail: `Edited ${resolvedStepBlock.path}.`,
            metrics: [
              { label: 'File', value: resolvedStepBlock.path },
              { label: 'Added', value: String(stepDiffMetrics.added) },
              { label: 'Removed', value: String(stepDiffMetrics.removed) },
              { label: 'Written', value: String(syncResult.writtenPaths.length) },
              { label: 'Known files', value: String(currentRegistry.size) },
            ],
          });
        }

        onUpdate(panel.id, {
          fileRegistry: currentRegistry,
          streamingContent: '',
        });

        const writtenEntry = {
          path: resolvedStepBlock.path,
          purpose: step.purpose,
        };
        const writtenIndex = workspaceWrittenFiles.findIndex((entry) => entry.path === resolvedStepBlock.path);
        if (writtenIndex === -1) {
          workspaceWrittenFiles.push(writtenEntry);
        } else {
          workspaceWrittenFiles[writtenIndex] = writtenEntry;
        }

        const executionEntry = {
          path: resolvedStepBlock.path,
          exports: step.exports,
        };
        const executionIndex = workspaceExecutionHistory.findIndex((entry) => entry.path === resolvedStepBlock.path);
        if (executionIndex === -1) {
          workspaceExecutionHistory.push(executionEntry);
        } else {
          workspaceExecutionHistory[executionIndex] = executionEntry;
        }

        finishTracePhase(stepPhase, {
          metrics: [
            { label: 'File', value: resolvedStepBlock.path },
            { label: 'Added', value: String(stepDiffMetrics.added) },
            { label: 'Removed', value: String(stepDiffMetrics.removed) },
            { label: 'Exports', value: String(step.exports.length) },
            { label: 'Known files', value: String(currentRegistry.size) },
          ],
        });
        terminalTracePhase = undefined;

        if (options.updatePlannerTrace) {
          trace.plannerSteps = trace.plannerSteps?.map((plannedStep) =>
            plannedStep.stepNumber === step.stepNumber && plannedStep.filePath === step.filePath
              ? { ...plannedStep, status: 'executed' }
              : plannedStep,
          );
        }
      }

      return currentRegistry;
    }

    async function rewriteWorkspaceSummary(
      projectSummary: string,
      phaseId: string,
      phaseLabel: string,
      streamingLabel: string,
      detail: string,
    ): Promise<string> {
      const summaryPhase = startTracePhase(trace, phaseId, phaseLabel, detail);
      terminalTracePhase = summaryPhase;
      pushStreamingTrace({
        streamingContent: '',
        streamingPhase: {
          label: streamingLabel,
          stepIndex: 0,
          totalSteps: 0,
        },
      });

      const summaryMessage = buildSummaryUserMessage(text, projectSummary, workspaceWrittenFiles);
      try {
        const summaryContent = await chatOnce(
          modelName,
          [{ role: 'user', content: summaryMessage }],
          getSummarySystem() + replyPreferenceInject,
          abort.signal,
        );

        onUpdate(panel.id, { streamingContent: summaryContent });
        finishTracePhase(summaryPhase, {
          detail: 'Updated the final developer-facing summary.',
          metrics: [
            { label: 'Files', value: String(workspaceWrittenFiles.length) },
            { label: 'Words', value: String(countWords(summaryContent)) },
          ],
        });
        return summaryContent;
      } catch (error) {
        finishTracePhase(summaryPhase, {
          status: 'error',
          detail: error instanceof Error
            ? `Updating the final summary failed, so the earlier draft was kept: ${error.message}`
            : 'Updating the final summary failed, so the earlier draft was kept.',
        });
        throw error;
      } finally {
        terminalTracePhase = undefined;
      }
    }

    function buildFallbackWorkspaceSummary(projectSummary: string): string {
      const trimmedSummary = projectSummary.trim();
      if (trimmedSummary) return trimmedSummary;

      if (workspaceWrittenFiles.length > 0) {
        const shownPaths = workspaceWrittenFiles
          .slice(0, 4)
          .map((entry) => `\`${entry.path}\``)
          .join(', ');
        const remaining = workspaceWrittenFiles.length - Math.min(workspaceWrittenFiles.length, 4);
        return remaining > 0
          ? `Updated ${shownPaths}, and ${remaining} more workspace files.`
          : `Updated ${shownPaths}.`;
      }

      return 'Completed the requested workspace changes.';
    }

    function buildBlockedWorkspaceSummary(blockers: WorkspaceCommandResult[]): string {
      const changedFilesLine = workspaceWrittenFiles.length > 0
        ? (() => {
            const shownPaths = workspaceWrittenFiles
              .slice(0, 5)
              .map((entry) => `\`${entry.path}\``)
              .join(', ');
            const remaining = workspaceWrittenFiles.length - Math.min(workspaceWrittenFiles.length, 5);
            return remaining > 0
              ? `Files written so far: ${shownPaths}, and ${remaining} more.`
              : `Files written so far: ${shownPaths}.`;
          })()
        : 'No workspace files were written successfully before validation failed.';

      const blockingLines = blockers.map((result) => {
        const status = result.timedOut
          ? 'timed out'
          : `failed with exit code ${result.exitCode}`;
        return `- \`${result.command}\` ${status}`;
      });

      return [
        'I applied the requested workspace changes, but the workspace is still failing required validation and is not ready to ship yet.',
        '',
        changedFilesLine,
        '',
        'Blocking checks:',
        ...blockingLines,
      ].join('\n');
    }

    // Code preset: plan -> execute each step independently
    try {
      let currentRegistry = new Map(panel.fileRegistry);
      activeWorkspaceRegistry = currentRegistry;
      onUpdate(panel.id, {
        streamingContent: '',
        streamingPhase: { label: 'Reading workspace files...', stepIndex: 0, totalSteps: 0 },
      });
      const workspaceReadPhase = startTracePhase(
        trace,
        'read-workspace-files',
        'Read workspace files',
        'Scan the current workspace and read every available text file before classifying or planning code changes.',
      );
      terminalTracePhase = workspaceReadPhase;
        if (panel.projectId && onReadWorkspaceContext) {
          const refreshedWorkspace = await onReadWorkspaceContext(panel);
          if (refreshedWorkspace?.fileEntries) {
            currentRegistry = buildRegistryFromWorkspaceEntries(refreshedWorkspace.fileEntries);
            activeWorkspaceRegistry = currentRegistry;
            workspaceEntryInventory = buildWorkspaceEntryInventory(
              refreshedWorkspace.workspaceEntryPaths ?? [],
              currentRegistry,
            );
            onUpdate(panel.id, {
              fileRegistry: currentRegistry,
              streamingContent: '',
            });
          }
        }
      workspaceEntryInventory = buildWorkspaceEntryInventory(workspaceEntryInventory, currentRegistry);
      const workspaceAnalysisDigest = buildWorkspaceAnalysisDigest(currentRegistry);
      const workspaceFilePaths = [...currentRegistry.keys()].slice(0, 200);
      finishTracePhase(workspaceReadPhase, {
        detail: currentRegistry.size > 0
          ? `Read ${currentRegistry.size} readable workspace file${currentRegistry.size === 1 ? '' : 's'} before planning.`
          : 'No readable workspace files were found, so planning will proceed from the request alone.',
        metrics: [
          { label: 'Readable files', value: String(currentRegistry.size) },
        ],
      });
      terminalTracePhase = undefined;
      onUpdate(panel.id, {
        streamingContent: '',
        streamingPhase: { label: 'Classifying request...', stepIndex: 0, totalSteps: 0 },
      });
      const classificationPhase = startTracePhase(
        trace,
        'classify-request',
        'Classify request',
        'Decide whether the coding task is a build, feature, refactor, docs, or debug flow.',
      );
      terminalTracePhase = classificationPhase;
      const classification = await classifyRequest(text, panel.messages, modelName, abort.signal, {
        hasExistingProject: Boolean(panel.projectId && workspaceFilePaths.length > 0),
        workspaceFilePaths,
        workspaceContextSummary: workspaceAnalysisDigest,
      });
      finishTracePhase(classificationPhase, {
        detail: `Classified as ${classification.mode.replace(/_/g, ' ')}.`,
        metrics: [
          { label: 'Mode', value: classification.mode.replace(/_/g, ' ') },
          { label: 'Confidence', value: classification.confidence },
          { label: 'Packages', value: String(classification.mentionedPackages.length) },
        ],
      });
      terminalTracePhase = undefined;
      trace.plannerMode = classification.mode;
      trace.plannerConfidence = classification.confidence;
      trace.reasoningSummary = classification.reasoning || undefined;
      const technicalDocsPromise = fetchCodeResearchContext(text, panel.messages, {
        classification,
        workspaceFilePaths,
        depth: 'standard',
        maxSources: Math.min(CODE_RESEARCH_MAX_SOURCES, Math.max(2, reasoningConfig.maxSources)),
      }).catch(() => []);
      const packageMetadataPromise = classification.mentionedPackages.length > 0
        ? resolvePackageVersions(classification.mentionedPackages).catch(() => [])
        : null;
      let technicalDocsLoaded = false;
      let packageMetadataLoaded = classification.mentionedPackages.length === 0;

      const ensureTechnicalDocsReady = async (
        phaseId: string,
        phaseLabel: string,
        streamingLabel: string,
        detail: string,
        waitMs = PREWRITE_TECHNICAL_DOC_WAIT_MS,
      ) => {
        if (technicalDocsLoaded) return;
        onUpdate(panel.id, {
          streamingContent: '',
          streamingPhase: { label: streamingLabel, stepIndex: 0, totalSteps: 0 },
        });
        const technicalDocsPhase = startTracePhase(
          trace,
          phaseId,
          phaseLabel,
          detail,
        );
        terminalTracePhase = technicalDocsPhase;
        const technicalDocsResult = await awaitWithTimeout(technicalDocsPromise, waitMs, []);
        technicalDocContexts = technicalDocsResult.value;
        if (technicalDocContexts.length > 0) {
          appendTraceSources(trace, technicalDocContexts, 'live-context');
        }
        technicalDocInject = buildCodeResearchSystemInject(technicalDocContexts);
        finishTracePhase(technicalDocsPhase, {
          status: technicalDocsResult.timedOut && technicalDocContexts.length === 0 ? 'skipped' : 'completed',
          detail: technicalDocsResult.timedOut && technicalDocContexts.length === 0
            ? 'Technical doc lookup exceeded the speed budget, so file generation continued from workspace context and targeted repair checks.'
            : technicalDocContexts.length > 0
              ? `Fetched ${technicalDocContexts.length} technical reference source${technicalDocContexts.length === 1 ? '' : 's'} for the coding workflow.`
              : 'No technical reference pages returned usable content for this coding workflow, so the run will continue from workspace context and package metadata.',
          metrics: [
            { label: 'Sources', value: String(technicalDocContexts.length) },
          ],
        });
        terminalTracePhase = undefined;
        technicalDocsLoaded = true;
      };

      const ensurePackageMetadataReady = async (
        phaseId: string,
        phaseLabel: string,
        streamingLabel: string,
        detail: string,
        waitMs = PREWRITE_PACKAGE_WAIT_MS,
      ) => {
        if (packageMetadataLoaded || !packageMetadataPromise) return;
        onUpdate(panel.id, {
          streamingContent: '',
          streamingPhase: { label: streamingLabel, stepIndex: 0, totalSteps: 0 },
        });
        const packagePhase = startTracePhase(
          trace,
          phaseId,
          phaseLabel,
          detail,
        );
        terminalTracePhase = packagePhase;
        const packageResult = await awaitWithTimeout(packageMetadataPromise, waitMs, []);
        resolvedPackages = packageResult.value;
        trace.packages = resolvedPackages.map((pkg) => ({ ...pkg }));
        finishTracePhase(packagePhase, {
          status: packageResult.timedOut && resolvedPackages.length === 0 ? 'skipped' : 'completed',
          detail: packageResult.timedOut && resolvedPackages.length === 0
            ? 'Package metadata lookup exceeded the speed budget, so generation continued without blocking on registry version resolution.'
            : resolvedPackages.length > 0
              ? `Resolved ${resolvedPackages.length} package version${resolvedPackages.length === 1 ? '' : 's'} for the coding workflow.`
              : 'No package versions could be resolved from the detected package list.',
          metrics: [
            { label: 'Mentioned', value: String(classification.mentionedPackages.length) },
            { label: 'Resolved', value: String(resolvedPackages.length) },
          ],
        });
        terminalTracePhase = undefined;
        packageMetadataLoaded = true;
      };

      if (classification.mode === 'code_snippet' || classification.mode === 'explain') {
        await ensureTechnicalDocsReady(
          'read-technical-docs',
          'Read technical docs',
          'Reading technical docs...',
          'Fetch official docs, GitHub references, StackOverflow threads, and package references relevant to this coding request before drafting the direct reply.',
          6_000,
        );
        await ensurePackageMetadataReady(
          'resolve-packages',
          'Read package metadata',
          'Reading package metadata...',
          'Fetch current package versions from public registries before drafting the direct reply.',
          3_500,
        );
        trace.orchestrationSummary = classification.mode === 'code_snippet'
          ? 'The code workflow categorized this as a focused snippet/example request and answered directly without planning workspace-wide file changes.'
          : 'The code workflow categorized this as an explanation request and answered directly from the workspace context without planning file changes.';
        const directReplyPhase = startTracePhase(
          trace,
          'direct-code-reply',
          classification.mode === 'code_snippet' ? 'Draft code snippet' : 'Explain code context',
          classification.mode === 'code_snippet'
            ? 'Write a focused code example instead of planning a full project.'
            : 'Explain the relevant workspace code directly instead of planning file edits.',
        );
        terminalTracePhase = directReplyPhase;
        pushStreamingTrace({
          streamingPhase: {
            label: classification.mode === 'code_snippet' ? 'Drafting code snippet...' : 'Explaining workspace code...',
            stepIndex: 0,
            totalSteps: 0,
          },
        });

        const directSystem =
          DIRECT_CODE_REPLY_SYSTEM
          + replyPreferenceInject
          + registryToSystemPrompt(currentRegistry)
          + urlInject
          + technicalDocInject
          + packageVersionsToSystemInject(resolvedPackages);
        let directContent = '';
        const directGen = streamChat(modelName, updatedMessages, directSystem, abort.signal);
        for await (const token of directGen) {
          markFirstToken();
          directContent += token;
          onUpdate(panel.id, { streamingContent: directContent });
        }

        finishTracePhase(directReplyPhase, {
          detail: classification.mode === 'code_snippet'
            ? `Generated a focused code example of ${countWords(directContent)} words.`
            : `Generated a direct explanation of ${countWords(directContent)} words.`,
          metrics: [
            { label: 'Mode', value: classification.mode.replace(/_/g, ' ') },
            { label: 'Words', value: String(countWords(directContent)) },
          ],
        });
        terminalTracePhase = undefined;
        await finaliseResponse(directContent, updatedMessages, snapshotRegistry, currentRegistry);
        return;
      }

      onUpdate(panel.id, {
        streamingContent: '',
        streamingPhase: { label: 'Planning files...', stepIndex: 0, totalSteps: 0 },
      });
      const planningPhase = startTracePhase(
        trace,
        'plan-request',
        'Build execution plan',
        'Turn the classified request into a file-by-file implementation plan.',
      );
      terminalTracePhase = planningPhase;
      const planningResult = await planRequest(
        buildPlannerWorkspacePrompt(text, currentRegistry, [], workspaceAnalysisDigest),
        panel.messages,
        classification,
        modelName,
        abort.signal,
      );
      let effectivePlanningResult = planningResult;
      let invalidPlannedPaths = collectInvalidWorkspaceStepPaths(planningResult.steps);
      if (invalidPlannedPaths.length > 0) {
        const replanPhase = startTracePhase(
          trace,
          'repair-plan-file-types',
          'Correct planned file paths',
          'The initial plan included file paths without defined extensions, so the planner must regenerate those paths before any files are written.',
        );
        pushStreamingTrace({
          streamingContent: '',
          streamingPhase: {
            label: 'Correcting planned file paths...',
            stepIndex: 0,
            totalSteps: 0,
          },
        });
        const replanPrompt = [
          text,
          '',
          'The previous plan proposed invalid file paths without explicit file types or extensions:',
          ...invalidPlannedPaths.map((path) => `- ${path}`),
          '',
          'Regenerate the full plan now.',
          'Every source, config, stylesheet, script, markup, and data file must use its real final extension such as .ts, .tsx, .js, .jsx, .css, .go, .json, .html, or .md unless the filename is a conventional extensionless file like Dockerfile, Makefile, Procfile, or a dotfile.',
          'Reuse the existing workspace files when they already satisfy the role instead of inventing duplicate files.',
        ].join('\n');
        effectivePlanningResult = await planRequest(
          buildPlannerWorkspacePrompt(replanPrompt, currentRegistry, [], workspaceAnalysisDigest),
          panel.messages,
          classification,
          modelName,
          abort.signal,
        );
        invalidPlannedPaths = collectInvalidWorkspaceStepPaths(effectivePlanningResult.steps);
        if (invalidPlannedPaths.length > 0) {
          finishTracePhase(replanPhase, {
            status: 'error',
            detail: `The planner still proposed invalid file paths: ${invalidPlannedPaths.join(', ')}.`,
          });
          throw new Error(`Planner returned file paths without defined file types: ${invalidPlannedPaths.join(', ')}.`);
        }
        finishTracePhase(replanPhase, {
          detail: 'Regenerated the plan with defined file extensions before execution started.',
          metrics: [
            { label: 'Corrected paths', value: String(planningResult.steps.length) },
            { label: 'Final steps', value: String(effectivePlanningResult.steps.length) },
          ],
        });
      }
      finishTracePhase(planningPhase, {
        detail: `Planned ${effectivePlanningResult.steps.length} implementation step${effectivePlanningResult.steps.length === 1 ? '' : 's'}.`,
        metrics: [
          { label: 'Mode', value: classification.mode.replace(/_/g, ' ') },
          { label: 'Steps', value: String(effectivePlanningResult.steps.length) },
        ],
      });
      terminalTracePhase = undefined;

      const plan = {
        projectSummary: effectivePlanningResult.projectSummary,
        mode: classification.mode,
        classification,
        resolvedPackages,
        steps: effectivePlanningResult.steps,
      };
      currentWorkspaceProjectSummary = plan.projectSummary;
      trace.plannerSummary = plan.projectSummary;
      trace.plannerSteps = plan.steps.map<ResponseTracePlannerStep>((step) => ({
        stepNumber: step.stepNumber,
        label: step.label,
        filePath: step.filePath,
        purpose: step.purpose,
        status: 'planned',
      }));
      trace.orchestrationSummary = `Deep planning classified this request as ${classification.mode.replace(/_/g, ' ')}, gathered live technical references, built a ${plan.steps.length}-step file plan, and will write each step directly into the workspace before composing the final reply.`;

      if (plan.steps.length === 0) {
        await finaliseResponse(
          'I reviewed the request, but the planner did not produce any concrete file steps to apply in this workspace.',
          updatedMessages,
          snapshotRegistry,
          currentRegistry,
        );
        return;
      }

      await ensurePackageMetadataReady(
        'resolve-packages',
        'Read package metadata',
        'Reading package metadata...',
        'Fetch current package versions from public registries before the first file is written.',
        3_000,
      );
      await ensureTechnicalDocsReady(
        'read-technical-docs',
        'Read technical docs',
        'Reading technical docs...',
        'Fetch official docs, GitHub references, StackOverflow threads, and package references relevant to this coding request before file generation begins.',
        2_000,
      );

      currentRegistry = await executeWorkspacePlanSteps({
        plan,
        registry: currentRegistry,
        requestPrompt: text,
        phaseKey: 'plan',
        technicalDocsInject: technicalDocInject,
        updatePlannerTrace: true,
      });

      if (false) {
      const pkgVersionInject = packageVersionsToSystemInject(plan.resolvedPackages ?? []);
      const alreadyWritten: Array<{ path: string; exports: string[] }> = [];

      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        const readPhase = startTracePhase(
          trace,
          `read-step-${si + 1}`,
          `Reading ${step.filePath}`,
          `Review the current workspace context for ${step.filePath} before generating the next change.`,
        );
        pushStreamingTrace({
          streamingContent: '',
          streamingPhase: {
            label: `Reading ${step.filePath}...`,
            stepIndex: si + 1,
            totalSteps: plan.steps.length,
          },
        });

        const stepUserMsg = buildWorkspaceStepUserMessage(plan, step, alreadyWritten, currentRegistry, workspaceEntryInventory);
        finishTracePhase(readPhase, {
          detail: `Loaded the live workspace context for ${step.filePath}.`,
          metrics: [
            { label: 'Known files', value: String(currentRegistry.size) },
            { label: 'Imports', value: String(step.imports.length) },
          ],
        });

        const stepPhase = startTracePhase(
          trace,
          `execute-step-${si + 1}`,
          `Writing ${step.filePath}`,
          `${step.filePath} — ${step.purpose}`,
        );
        terminalTracePhase = stepPhase;

        pushStreamingTrace({
          streamingContent: '',
          streamingPhase: {
            label: `Writing ${step.filePath}...`,
            stepIndex: si + 1,
            totalSteps: plan.steps.length,
          },
        });
        const stepMessages: Message[] = [
          { role: 'user', content: text },
          { role: 'assistant', content: `Understood. I will implement this workspace one file at a time. I am writing ${step.filePath} against the current workspace state.` },
          { role: 'user', content: stepUserMsg },
        ];

        const stepSystem = getStepExecutorSystem()
          + replyPreferenceInject
          + buildWorkspaceDirectoryInject(currentRegistry)
          + urlInject
          + technicalDocInject
          + pkgVersionInject;

        let stepContent = '';
        const gen = streamChat(modelName, stepMessages, stepSystem, abort.signal);
        for await (const token of gen) {
          markFirstToken();
          stepContent += token;
        }

        let resolvedStepBlock = resolveWorkspaceStepBlock(stepContent, step.filePath);
        if (!resolvedStepBlock) {
          const initialExtractionDiagnostic = diagnoseWorkspaceStepExtractionFailure(stepContent, step.filePath);
          const repairPhase = startTracePhase(
            trace,
            `repair-step-${si + 1}`,
            `Repairing ${step.filePath}`,
            `Normalize the generated output so ${step.filePath} can be written safely into the live workspace. ${initialExtractionDiagnostic.detail}`,
          );
          pushStreamingTrace({
            streamingContent: '',
            streamingPhase: {
              label: `Repairing ${step.filePath}...`,
              stepIndex: si + 1,
              totalSteps: plan.steps.length,
            },
          });
          const repairedContent = await repairWorkspaceStepOutput({
            modelName,
            abortSignal: abort.signal,
            request: text,
            plan,
            step,
            draft: stepContent,
            registry: currentRegistry,
            alreadyWritten,
            workspaceEntryPaths: workspaceEntryInventory,
            extractionDiagnostic: initialExtractionDiagnostic,
            technicalDocsInject: technicalDocInject,
          });
          resolvedStepBlock = resolveWorkspaceStepBlock(repairedContent, step.filePath);
          if (!resolvedStepBlock) {
            const repairedExtractionDiagnostic = diagnoseWorkspaceStepExtractionFailure(repairedContent, step.filePath);
            finishTracePhase(repairPhase, {
              status: 'error',
              detail: formatWorkspaceExtractionDiagnostic(repairedExtractionDiagnostic),
            });
            throw new Error(buildWorkspaceExtractionErrorMessage(
              step.filePath,
              repairedExtractionDiagnostic,
              initialExtractionDiagnostic,
            ));
          }
          finishTracePhase(repairPhase, {
            detail: `Repaired the step output so ${step.filePath} could be written safely. Initial extraction issue: ${initialExtractionDiagnostic.detail}`,
            metrics: [
              { label: 'File', value: resolvedStepBlock!.path },
            ],
          });
        }

        const finalStepBlock = resolvedStepBlock!;
        const applyWorkspaceStep = onApplyWorkspaceStep;

        currentRegistry = updateRegistry(currentRegistry, [finalStepBlock], updatedMessages.length);
        activeWorkspaceRegistry = currentRegistry;

        if (applyWorkspaceStep) {
          const syncPhase = startTracePhase(
            trace,
            `sync-step-${si + 1}`,
            `Syncing ${finalStepBlock.path}`,
            `Write ${finalStepBlock.path} into the live workspace before the next step begins.`,
          );
          pushStreamingTrace({
            streamingContent: '',
            streamingPhase: {
              label: `Syncing ${finalStepBlock.path}...`,
              stepIndex: si + 1,
              totalSteps: plan.steps.length,
            },
          });
          const syncResult = await applyWorkspaceStep!(panel, {
            path: finalStepBlock.path,
            content: finalStepBlock.content,
          });
          currentRegistry = buildRegistryFromWorkspaceEntries(syncResult.fileEntries);
          activeWorkspaceRegistry = currentRegistry;
          finishTracePhase(syncPhase, {
            detail: `${finalStepBlock.path} is now saved in the live workspace.`,
            metrics: [
              { label: 'Written', value: String(syncResult.writtenPaths.length) },
              { label: 'Known files', value: String(currentRegistry.size) },
            ],
          });
        }

        onUpdate(panel.id, {
          fileRegistry: currentRegistry,
          streamingContent: '',
        });

        const writtenEntry = {
          path: finalStepBlock.path,
          purpose: step.purpose,
        };
        const writtenIndex = workspaceWrittenFiles.findIndex((entry) => entry.path === finalStepBlock.path);
        if (writtenIndex === -1) {
          workspaceWrittenFiles.push(writtenEntry);
        } else {
          workspaceWrittenFiles[writtenIndex] = writtenEntry;
        }

        const alreadyWrittenEntry = {
          path: finalStepBlock.path,
          exports: step.exports,
        };
        const alreadyWrittenIndex = alreadyWritten.findIndex((entry) => entry.path === finalStepBlock.path);
        if (alreadyWrittenIndex === -1) {
          alreadyWritten.push(alreadyWrittenEntry);
        } else {
          alreadyWritten[alreadyWrittenIndex] = alreadyWrittenEntry;
        }

        finishTracePhase(stepPhase, {
          detail: `Wrote ${finalStepBlock.path} into the live workspace.`,
          metrics: [
            { label: 'File', value: finalStepBlock.path },
            { label: 'Exports', value: String(step.exports.length) },
            { label: 'Known files', value: String(currentRegistry.size) },
          ],
        });
        terminalTracePhase = undefined;
        trace.plannerSteps = trace.plannerSteps?.map((plannedStep) =>
          plannedStep.stepNumber === step.stepNumber && plannedStep.filePath === step.filePath
            ? { ...plannedStep, status: 'executed' }
            : plannedStep,
        );
      }
      }

      onUpdate(panel.id, {
        streamingPhase: {
          label: 'Validating workspace...',
          stepIndex: plan.steps.length + 1,
          totalSteps: plan.steps.length + 1,
        },
        streamingContent: '',
      });

      await finaliseResponse('', updatedMessages, snapshotRegistry, currentRegistry);

    } catch (err) {
      handleError(err, updatedMessages);
    }

    async function reviewReplyDraft(
      draft: string,
      reviewMessagesBase: Message[],
      options: {
        systemPrompt: string;
        referenceDateIso: string;
        requiredLiveSourceCount: number;
        verifiedSourceCount: number;
        fetchLiveContext: boolean;
      },
    ): Promise<string> {
      const reviewPhase = startTracePhase(
        trace,
        'review-reply',
        'Review reply',
        'Run the Go backend review to remove source narration, check detail level, and catch obvious date mismatches before finalizing the reply.',
      );
      pushStreamingTrace({
        streamingPhase: {
          label: 'Reviewing reply...',
          stepIndex: 0,
          totalSteps: 0,
        },
      });

      const reviewResult = await reviewAssistantReply({
        prompt: text,
        draft,
        referenceDate: options.referenceDateIso,
        fetchLiveContext: options.fetchLiveContext,
        verifiedSourceCount: options.verifiedSourceCount,
        preferredSourceCount: options.requiredLiveSourceCount,
      });

      finishTracePhase(reviewPhase, {
        detail: reviewResult.reviewSummary,
        metrics: [
          { label: 'Issues', value: String(reviewResult.issues.length) },
          { label: 'Rewrite', value: reviewResult.requiresRewrite ? 'Yes' : 'No' },
        ],
      });
      pushStreamingTrace();

      if (!reviewResult.requiresRewrite) {
        trace.orchestrationSummary = 'Single-pass reply drafted internally, reviewed by the Go backend, and finalized before the user-visible answer was committed.';
        return reviewResult.sanitizedReply || draft;
      }

      const rewritePhase = startTracePhase(
        trace,
        'rewrite-reply',
        'Rewrite reply',
        'Revise the draft once to satisfy the backend review guidance before showing it to the user.',
      );
      pushStreamingTrace({
        streamingPhase: {
          label: 'Revising reply...',
          stepIndex: 0,
          totalSteps: 0,
        },
      });

      const rewriteMessages: Message[] = [
        ...reviewMessagesBase,
        { role: 'assistant', content: reviewResult.sanitizedReply || draft },
        {
          role: 'user',
          content: reviewResult.rewritePrompt || [
            'Revise your previous answer and return only the rewritten final reply.',
            'Answer directly.',
            'Do not mention sources, context, or the retrieval process unless the user explicitly asked for them.',
          ].join('\n'),
        },
      ];
      const rewrittenDraft = await chatOnce(modelName, rewriteMessages, options.systemPrompt, abort.signal);

      finishTracePhase(rewritePhase, {
        detail: `Rewrote the reply to satisfy the backend review guidance. The revised draft is ${countWords(rewrittenDraft)} words.`,
        metrics: [
          { label: 'Words', value: String(countWords(rewrittenDraft)) },
        ],
      });
      pushStreamingTrace();

      const finalReviewPhase = startTracePhase(
        trace,
        'final-review-reply',
        'Final review',
        'Run one last backend check on the revised reply before final output.',
      );
      pushStreamingTrace({
        streamingPhase: {
          label: 'Finalizing reply...',
          stepIndex: 0,
          totalSteps: 0,
        },
      });

      const finalReviewResult = await reviewAssistantReply({
        prompt: text,
        draft: rewrittenDraft,
        referenceDate: options.referenceDateIso,
        fetchLiveContext: options.fetchLiveContext,
        verifiedSourceCount: options.verifiedSourceCount,
        preferredSourceCount: options.requiredLiveSourceCount,
      });

      finishTracePhase(finalReviewPhase, {
        detail: finalReviewResult.reviewSummary,
        metrics: [
          { label: 'Issues', value: String(finalReviewResult.issues.length) },
          { label: 'Rewrite', value: finalReviewResult.requiresRewrite ? 'Still needed' : 'Passed' },
        ],
      });
      pushStreamingTrace();
      trace.orchestrationSummary = 'Single-pass reply drafted internally, reviewed by the Go backend, rewritten once, and finalized before the user-visible answer was committed.';
      return finalReviewResult.sanitizedReply || rewrittenDraft;
    }

    async function resolveAutoChatTitle(
      assistantReply: string,
      msgs: Message[],
    ): Promise<string> {
      if (!shouldAutoSetInitialChatTitle(msgs)) {
        return latestTitleRef.current;
      }

      const fallbackTitle = deriveFallbackAutoChatTitle({
        currentTitle: latestTitleRef.current,
        projectLabel: panel.projectLabel,
        prompt: text,
        assistantReply,
        autoTitle: autoTitleRef.current,
      }) ?? latestTitleRef.current;

      if (!canAutoManageTitle(latestTitleRef.current, panel.projectLabel, autoTitleRef.current)) {
        return fallbackTitle;
      }

      const titlePhase = startTracePhase(
        trace,
        'generate-chat-title',
        'Generate chat title',
        'Use the prompt and drafted reply to name the chat before the final answer is committed.',
      );
      pushStreamingTrace({
        streamingPhase: {
          label: 'Naming chat...',
          stepIndex: 0,
          totalSteps: 0,
        },
      });

      try {
        const generated = await chatOnce(
          modelName,
          [{
            role: 'user',
            content: buildAutoChatTitlePrompt(text, assistantReply),
          }],
          AUTO_CHAT_TITLE_SYSTEM_PROMPT,
          abort.signal,
        );
        if (!canAutoManageTitle(latestTitleRef.current, panel.projectLabel, autoTitleRef.current)) {
          finishTracePhase(titlePhase, {
            status: 'skipped',
            detail: 'The chat title was edited manually while title generation was running, so the manual title was kept.',
            metrics: [
              { label: 'Mode', value: 'Manual' },
            ],
          });
          return latestTitleRef.current;
        }
        const nextTitle = normalizeGeneratedTitle(generated);
        if (isUsableGeneratedTitle(nextTitle)) {
          finishTracePhase(titlePhase, {
            detail: `Generated the chat title "${nextTitle}".`,
            metrics: [
              { label: 'Mode', value: 'AI-generated' },
              { label: 'Words', value: String(countWords(nextTitle)) },
            ],
          });
          return nextTitle;
        }

        finishTracePhase(titlePhase, {
          detail: 'The generated title was too generic, so the fallback title was kept.',
          metrics: [
            { label: 'Mode', value: 'Fallback' },
          ],
        });
        return fallbackTitle;
      } catch (error) {
        if (!canAutoManageTitle(latestTitleRef.current, panel.projectLabel, autoTitleRef.current)) {
          finishTracePhase(titlePhase, {
            status: 'skipped',
            detail: 'The chat title was edited manually while title generation was running, so the manual title was kept.',
            metrics: [
              { label: 'Mode', value: 'Manual' },
            ],
          });
          return latestTitleRef.current;
        }
        finishTracePhase(titlePhase, {
          status: 'error',
          detail: error instanceof Error
            ? `Title generation failed, so the fallback title was kept: ${error.message}`
            : 'Title generation failed, so the fallback title was kept.',
          metrics: [
            { label: 'Mode', value: 'Fallback' },
          ],
        });
        return fallbackTitle;
      } finally {
        pushStreamingTrace();
      }
    }

    async function finaliseResponse(
      content: string,
      msgs: Message[],
      snapReg: FileRegistry,
      baseReg: FileRegistry,
    ) {
      const authoredContentBase = content;
      let finalContentBase = content;
      const shouldDelayWorkspaceReply = Boolean(
        isCodePreset
        && panel.projectId
        && onCommitWorkspaceRun
        && workspaceWrittenFiles.length > 0,
      );
      let finalContent = !isCodePreset && limitedContextDisclaimer
        ? `${finalContentBase.trimEnd()}\n\n${limitedContextDisclaimer}`
        : finalContentBase;
      onUpdate(panel.id, {
        streamingContent: shouldDelayWorkspaceReply ? '' : finalContent,
      });
      const timing = responseTimingRef.current;
      const responseFirstTokenMs = timing
        ? Math.max(0, Math.round((timing.firstTokenPerf ?? performance.now()) - timing.startedPerf))
        : undefined;
      const streamElapsedMs = timing
        ? Math.max(0, Math.round(performance.now() - timing.startedPerf))
        : undefined;
      const timingMetrics: ResponseTraceMetric[] = [
        ...(responseFirstTokenMs != null ? [{ label: 'First token', value: formatTraceDuration(responseFirstTokenMs) }] : []),
        ...(streamElapsedMs != null ? [{ label: 'Total', value: formatTraceDuration(streamElapsedMs) }] : []),
      ];
      if (terminalTracePhase?.status === 'running') {
        finishTracePhase(terminalTracePhase, {
          detail: 'Completed the final reply stream.',
          metrics: timingMetrics,
        });
        terminalTracePhase = undefined;
      }
      let updatedReg = new Map(baseReg);
      if (shouldDelayWorkspaceReply) {
        const commitWorkspaceRun = onCommitWorkspaceRun!;
        const applyWorkspaceStep = onApplyWorkspaceStep;
        let currentWorkspacePhase: ResponseTracePhase | undefined;
        const progressLabelCounts = new Map<string, number>();
        const formatWorkspaceCommandStatus = (result: WorkspaceCommandResult) => result.timedOut
          ? 'timed out'
          : result.exitCode === 0
            ? 'passed'
            : `failed with exit code ${result.exitCode}`;
        const collectBlockingResults = (result: {
          dependencyRefreshes: WorkspaceCommandResult[];
          validations: WorkspaceCommandResult[];
        }) => [...result.dependencyRefreshes, ...result.validations].filter((commandResult) =>
          commandResult.timedOut || commandResult.exitCode !== 0,
        );
        const commitProgress = (step: { id: string; label: string; detail?: string }) => {
          if (currentWorkspacePhase?.status === 'running') {
            finishTracePhase(currentWorkspacePhase, {
              detail: currentWorkspacePhase.detail || 'Completed the previous workspace operation.',
            });
          }

          const stepCount = (progressLabelCounts.get(step.id) ?? 0) + 1;
          progressLabelCounts.set(step.id, stepCount);
          currentWorkspacePhase = startTracePhase(
            trace,
            stepCount === 1 ? step.id : `${step.id}-${stepCount}`,
            step.label,
            step.detail,
          );
          pushStreamingTrace({
            streamingContent: '',
            streamingPhase: {
              label: `${step.label}...`,
              stepIndex: 0,
              totalSteps: 0,
            },
          });
        };

        try {
          let commitResult = await commitWorkspaceRun(
            panel,
            text,
            { writtenPaths: workspaceWrittenFiles.map((entry) => entry.path) },
            commitProgress,
          );
          if (currentWorkspacePhase?.status === 'running') {
            finishTracePhase(currentWorkspacePhase, {
              detail: currentWorkspacePhase.detail || 'Completed the latest workspace operation.',
            });
          }

          updatedReg = buildRegistryFromWorkspaceEntries(commitResult.fileEntries);
          activeWorkspaceRegistry = updatedReg;
          let repairAttempts = 0;
          const repairNotes: string[] = [];
          let blockingResults = collectBlockingResults(commitResult);

          while (blockingResults.length > 0 && repairAttempts < MAX_WORKSPACE_REPAIR_ATTEMPTS && applyWorkspaceStep) {
            repairAttempts += 1;
            pushStreamingTrace({
              streamingContent: '',
              streamingPhase: {
                label: `Repairing failed validation (attempt ${repairAttempts})...`,
                stepIndex: repairAttempts,
                totalSteps: MAX_WORKSPACE_REPAIR_ATTEMPTS,
              },
            });

            const repairDiagnostics = buildWorkspaceFailureDiagnostics(blockingResults, updatedReg);
            const repairPrompt = buildWorkspaceRepairPlannerPrompt({
              originalRequest: text,
              projectSummary: currentWorkspaceProjectSummary,
              failures: blockingResults,
              registry: updatedReg,
              repairAttempt: repairAttempts,
              workspaceAnalysis: buildWorkspaceAnalysisDigest(updatedReg),
              diagnostics: repairDiagnostics,
            });
            const repairClassification: ClassificationResult = {
              mode: 'debug',
              confidence: 'high',
              reasoning: 'Automated dependency installation or validation failed and needs a minimal fix.',
              mentionedPackages: readWorkspaceManifestPackages(updatedReg),
            };

            let repairTechnicalContexts: FetchedContext[] = [];
            let repairTechnicalDocInject = technicalDocInject;
            const repairDocsPhase = startTracePhase(
              trace,
              `repair-docs-${repairAttempts}`,
              `Read repair docs (${repairAttempts})`,
              'Fetch targeted documentation for the failing validation before planning the repair.',
            );
            try {
              repairTechnicalContexts = await fetchCodeResearchContext(repairPrompt, panel.messages, {
                classification: repairClassification,
                workspaceFilePaths: [...updatedReg.keys()].slice(0, 200),
                failureOutputs: blockingResults,
                depth: 'standard',
                maxSources: Math.min(6, Math.max(4, reasoningConfig.maxSources)),
              });
              appendTraceSources(trace, repairTechnicalContexts, 'live-context');
              repairTechnicalDocInject += buildCodeResearchSystemInject(repairTechnicalContexts);
              finishTracePhase(repairDocsPhase, {
                detail: repairTechnicalContexts.length > 0
                  ? `Fetched ${repairTechnicalContexts.length} repair reference source${repairTechnicalContexts.length === 1 ? '' : 's'} for the failing validation.`
                  : 'No additional repair docs were fetched, so the repair will continue from the workspace and previously gathered sources.',
                metrics: [
                  { label: 'Sources', value: String(repairTechnicalContexts.length) },
                ],
              });
            } catch (error) {
              finishTracePhase(repairDocsPhase, {
                status: 'error',
                detail: error instanceof Error
                  ? `Repair doc lookup failed, so the repair continued from the workspace alone: ${error.message}`
                  : 'Repair doc lookup failed, so the repair continued from the workspace alone.',
              });
            }

            const repairPlanningPhase = startTracePhase(
              trace,
              `repair-plan-${repairAttempts}`,
              `Plan repair (${repairAttempts})`,
              'Build the minimal debug plan needed to fix the failing dependency or validation checks.',
            );
            const repairPlanningResult = await planRequest(
              buildPlannerWorkspacePrompt(
                repairPrompt,
                updatedReg,
                repairTechnicalContexts.length > 0 ? repairTechnicalContexts : technicalDocContexts,
                buildWorkspaceAnalysisDigest(updatedReg),
              ),
              panel.messages,
              repairClassification,
              modelName,
              abort.signal,
            );
            const heuristicRepairPlan = buildHeuristicRepairPlanFromDiagnostics(repairDiagnostics, updatedReg, repairAttempts);
            const effectiveRepairSteps = repairPlanningResult.steps.length > 0
              ? repairPlanningResult.steps
              : heuristicRepairPlan?.steps ?? [];
            const effectiveRepairSummary = repairPlanningResult.projectSummary.trim()
              || heuristicRepairPlan?.projectSummary
              || 'Repair the blocking validation issue in the current workspace.';
            finishTracePhase(repairPlanningPhase, {
              detail: effectiveRepairSteps.length > 0
                ? `Planned ${effectiveRepairSteps.length} repair step${effectiveRepairSteps.length === 1 ? '' : 's'} for attempt ${repairAttempts}.${repairDiagnostics.focusFiles.length > 0 ? ` Focused files: ${repairDiagnostics.focusFiles.map((file) => file.path).join(', ')}.` : ''}`
                : `No concrete repair steps were planned for attempt ${repairAttempts}.`,
              metrics: [
                { label: 'Steps', value: String(effectiveRepairSteps.length) },
                ...(repairDiagnostics.focusFiles.length > 0 ? [{ label: 'Focused files', value: String(repairDiagnostics.focusFiles.length) }] : []),
              ],
            });

            if (effectiveRepairSteps.length === 0) {
              repairNotes.push(`Automated repair attempt ${repairAttempts} did not produce concrete file changes, so the repair loop will try again against the same blockers.`);
              continue;
            }

            const repairPlan = {
              projectSummary: effectiveRepairSummary,
              mode: 'debug' as RequestMode,
              steps: effectiveRepairSteps,
            };
            currentWorkspaceProjectSummary = `${currentWorkspaceProjectSummary}\n\nAutomated repair: ${repairPlan.projectSummary}`.trim();
            updatedReg = await executeWorkspacePlanSteps({
              plan: repairPlan,
              registry: updatedReg,
              requestPrompt: repairPrompt,
              phaseKey: `repair-${repairAttempts}`,
              writeVerb: 'Repairing',
              assistantContext: [
                'Understood. I am fixing the failing workspace validation by applying the minimal file changes against the current workspace state.',
                repairDiagnostics.summary,
                repairDiagnostics.focusFiles.length > 0
                  ? `Focus on these files first: ${repairDiagnostics.focusFiles.map((file) => file.path).join(', ')}.`
                  : '',
              ].filter(Boolean).join(' '),
              technicalDocsInject: repairTechnicalDocInject,
            });

            commitResult = await commitWorkspaceRun(
              panel,
              text,
              { writtenPaths: workspaceWrittenFiles.map((entry) => entry.path) },
              commitProgress,
            );
            if (currentWorkspacePhase?.status === 'running') {
              finishTracePhase(currentWorkspacePhase, {
                detail: currentWorkspacePhase.detail || 'Completed the latest workspace operation.',
              });
            }

            updatedReg = buildRegistryFromWorkspaceEntries(commitResult.fileEntries);
            activeWorkspaceRegistry = updatedReg;
            blockingResults = collectBlockingResults(commitResult);
            repairNotes.push(
              blockingResults.length > 0
                ? `Automated repair attempt ${repairAttempts} completed, but ${blockingResults.length} blocking check${blockingResults.length === 1 ? '' : 's'} still failed.`
                : `Automated repair attempt ${repairAttempts} fixed the blocking checks and the workspace passed the retest.`,
            );
          }

          const commitNotes: string[] = [];
          if (commitResult.writtenPaths.length > 0) {
            const shownPaths = commitResult.writtenPaths.slice(0, 5);
            const remaining = commitResult.writtenPaths.length - shownPaths.length;
            commitNotes.push(`Workspace files synced live: ${shownPaths.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.`);
          }

          if (commitResult.dependencyRefreshes.length > 0) {
            commitNotes.push(`Dependency install: ${commitResult.dependencyRefreshes.map((refreshResult) => {
              return `\`${refreshResult.command}\` ${formatWorkspaceCommandStatus(refreshResult)}`;
            }).join('; ')}.`);
          }

          if (commitResult.validations.length > 0) {
            commitNotes.push(`Pre-delivery testing: ${commitResult.validations.map((validationResult) => {
              return `\`${validationResult.command}\` ${formatWorkspaceCommandStatus(validationResult)}`;
            }).join('; ')}.`);
          } else if (commitResult.profile?.commands.length) {
            commitNotes.push(`Runtime review: detected ${commitResult.profile.commands.map((command) => command.label.toLowerCase()).join(', ')} commands.`);
          } else {
            commitNotes.push('Runtime review: no runnable workspace commands were detected automatically.');
          }

          const remainingBlockingResults = collectBlockingResults(commitResult);
          if (repairNotes.length > 0) {
            commitNotes.unshift(repairNotes.join(' '));
          }
          if (remainingBlockingResults.length > 0) {
            commitNotes.unshift(`Validation issues remain after automated repair: ${remainingBlockingResults.map((validation) => `\`${validation.command}\``).join(', ')}.`);
          } else if (repairAttempts > 0) {
            commitNotes.unshift('Validation issues were detected, repaired, and retested successfully before delivery.');
          }

          if (commitResult.setupGuidePath) {
            commitNotes.push(`Setup guide updated: ${commitResult.setupGuidePath}.`);
          }

          if (remainingBlockingResults.length > 0) {
            finalContentBase = buildBlockedWorkspaceSummary(remainingBlockingResults);
          } else {
            try {
              finalContentBase = await rewriteWorkspaceSummary(
                currentWorkspaceProjectSummary,
                repairAttempts > 0 ? 'rewrite-summary-after-repair' : 'write-summary',
                repairAttempts > 0 ? 'Update final reply' : 'Write final reply',
                repairAttempts > 0 ? 'Updating final reply...' : 'Writing final reply...',
                repairAttempts > 0
                  ? 'Regenerate the final reply after the automated repair loop completed.'
                  : 'Generate the final prose reply after validation and automated repair have completed.',
              );
            } catch {
              finalContentBase = authoredContentBase.trim() || buildFallbackWorkspaceSummary(currentWorkspaceProjectSummary);
            }
          }

          finalContentBase = `${finalContentBase.trimEnd()}\n\n${commitNotes.join('\n')}`;
          finalContent = finalContentBase;
          trace.orchestrationSummary = remainingBlockingResults.length > 0
            ? 'Deep planning completed, live technical references informed the file writes, the workspace ran dependency and validation checks, and automated repair attempts were applied before the final reply documented the remaining blockers.'
            : repairAttempts > 0
              ? 'Deep planning completed, live technical references informed the file writes, dependency and validation failures triggered an automated repair loop, and the workspace passed the final retest before the reply was committed.'
              : commitResult.validations.length > 0 || commitResult.dependencyRefreshes.length > 0
                ? 'Deep planning completed, live technical references informed the file writes, each step was written into the live workspace as it finished, dependency installation ran before validation, runtime configuration was reviewed, and pre-delivery validation commands ran before the reply was committed.'
                : 'Deep planning completed, live technical references informed the file writes, each step was written into the live workspace as it finished, and runtime configuration was reviewed before the reply was committed.';
          onUpdate(panel.id, {
            streamingContent: finalContent,
          });
        } catch (error) {
          if (currentWorkspacePhase?.status === 'running') {
            finishTracePhase(currentWorkspacePhase, {
              status: 'error',
              detail: error instanceof Error ? error.message : 'The live workspace commit failed before the reply could be delivered.',
            });
          }
          throw error;
        }
      }

      const nextTitle = await resolveAutoChatTitle(finalContentBase, msgs);
      const completedAt = Date.now();
      const responseTimeMs = timing
        ? Math.max(0, Math.round(performance.now() - timing.startedPerf))
        : undefined;
      trace.firstTokenAt = timing?.firstTokenAt ?? trace.firstTokenAt;
      trace.completedAt = completedAt;
      trace.firstTokenDurationMs = responseFirstTokenMs;
      trace.totalDurationMs = responseTimeMs;
      const nextMessageIndex      = msgs.length;
      const newBlocks             = extractCodeBlocksForRegistry(finalContent);
      updatedReg                  = updateRegistry(updatedReg, newBlocks, nextMessageIndex);
      activeWorkspaceRegistry     = updatedReg;
      const workspaceChanges      = buildMessageWorkspaceChanges(snapReg, updatedReg, preparedWorkspaceBackup);
      const assistantMsg: Message = {
        role: 'assistant',
        content: finalContent,
        exchangeMemory: buildExchangeMemory(text, finalContentBase),
        workspaceChanges,
        responseTimeMs,
        responseFirstTokenMs,
        responseStartedAt: timing?.startedAt,
        responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
        responseCompletedAt: timing ? completedAt : undefined,
        responseTrace: snapshotTrace(trace, completedAt),
      };
      const finalMessages         = [...msgs, assistantMsg];
      autoTitleRef.current = nextTitle;
      responseTimingRef.current = null;
      visibleReplyContentRef.current = '';
      setLiveResponseMs(null);

      onUpdate(panel.id, {
        title: nextTitle,
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        streamingTrace: null,
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
        latestWorkspaceBackup: preparedWorkspaceBackup,
        interruptedTask: null,
      });
      onSave({
        ...panel,
        title: nextTitle,
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        streamingTrace: null,
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
        latestWorkspaceBackup: preparedWorkspaceBackup,
        interruptedTask: null,
      });
    }

    function handleError(err: unknown, msgs: Message[]) {
      const timing = responseTimingRef.current;
      const completedAt = Date.now();
      const responseFirstTokenMs = timing
        ? Math.max(0, Math.round((timing.firstTokenPerf ?? performance.now()) - timing.startedPerf))
        : undefined;
      const responseTimeMs = timing
        ? Math.max(0, Math.round(performance.now() - timing.startedPerf))
        : undefined;
      const timingMetrics: ResponseTraceMetric[] = [
        ...(responseFirstTokenMs != null ? [{ label: 'First token', value: formatTraceDuration(responseFirstTokenMs) }] : []),
        ...(responseTimeMs != null ? [{ label: 'Elapsed', value: formatTraceDuration(responseTimeMs) }] : []),
      ];
      if (terminalTracePhase?.status === 'running') {
        finishTracePhase(terminalTracePhase, {
          status: (err as Error)?.name === 'AbortError' ? 'skipped' : 'error',
          detail: (err as Error)?.name === 'AbortError'
            ? 'Generation was stopped before the phase finished.'
            : `The phase ended with an error: ${(err as Error).message}`,
          metrics: timingMetrics,
        });
        terminalTracePhase = undefined;
      }
      trace.firstTokenAt = timing?.firstTokenAt ?? trace.firstTokenAt;
      trace.completedAt = completedAt;
      trace.firstTokenDurationMs = responseFirstTokenMs;
      trace.totalDurationMs = responseTimeMs;
      if ((err as Error)?.name === 'AbortError') {
        const content = visibleReplyContentRef.current || panel.streamingContent;
        if (content) {
          const nextMessageIndex = msgs.length;
          const newBlocks = extractCodeBlocksForRegistry(content);
          const updatedReg = updateRegistry(activeWorkspaceRegistry, newBlocks, nextMessageIndex);
          activeWorkspaceRegistry = updatedReg;
          const workspaceChanges = buildMessageWorkspaceChanges(snapshotRegistry, updatedReg, preparedWorkspaceBackup);
          const assistantMsg: Message = {
            role: 'assistant',
            content: content + '\n\n_[stopped]_',
            exchangeMemory: buildExchangeMemory(text, content),
            workspaceChanges,
            responseTimeMs,
            responseFirstTokenMs,
            responseStartedAt: timing?.startedAt,
            responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
            responseCompletedAt: timing ? completedAt : undefined,
            responseTrace: snapshotTrace(trace, completedAt),
          };
          const finalMessages         = [...msgs, assistantMsg];
          const nextTitle             = shouldAutoSetInitialChatTitle(msgs)
            ? deriveFallbackAutoChatTitle({
                currentTitle: latestTitleRef.current,
                projectLabel: panel.projectLabel,
                prompt: text,
                assistantReply: content,
                autoTitle: autoTitleRef.current,
              }) ?? latestTitleRef.current
            : latestTitleRef.current;
          autoTitleRef.current = nextTitle;
          responseTimingRef.current = null;
          setLiveResponseMs(null);
          onUpdate(panel.id, {
            title: nextTitle,
            messages: finalMessages,
            streaming: false,
            streamingContent: '',
            streamingTrace: null,
            fileRegistry: updatedReg,
            prevRegistry: snapshotRegistry,
            streamingPhase: null,
            latestWorkspaceBackup: preparedWorkspaceBackup,
            interruptedTask: null,
          });
          onSave({
            ...panel,
            title: nextTitle,
            messages: finalMessages,
            streaming: false,
            streamingContent: '',
            streamingTrace: null,
            fileRegistry: updatedReg,
            prevRegistry: snapshotRegistry,
            streamingPhase: null,
            latestWorkspaceBackup: preparedWorkspaceBackup,
            interruptedTask: null,
          });
        } else {
          responseTimingRef.current = null;
          visibleReplyContentRef.current = '';
          setLiveResponseMs(null);
          onUpdate(panel.id, {
            streaming: false,
            streamingContent: '',
            streamingTrace: null,
            fileRegistry: activeWorkspaceRegistry,
            prevRegistry: snapshotRegistry,
            streamingPhase: null,
            latestWorkspaceBackup: preparedWorkspaceBackup,
            interruptedTask: null,
          });
          onSave({
            ...panel,
            streaming: false,
            streamingContent: '',
            streamingTrace: null,
            fileRegistry: activeWorkspaceRegistry,
            prevRegistry: snapshotRegistry,
            streamingPhase: null,
            latestWorkspaceBackup: preparedWorkspaceBackup,
            interruptedTask: null,
          });
        }
      } else {
        trace.orchestrationSummary = `The reply pipeline failed before completion while using ${modelName}.`;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorHelp = buildModelErrorHelp(modelName, errorMessage);
        const errMsg: Message = {
          role: 'assistant',
          content: errorHelp
            ? `Error: ${errorMessage}\n\n${errorHelp}`
            : `Error: ${errorMessage}`,
          workspaceChanges: buildMessageWorkspaceChanges(snapshotRegistry, activeWorkspaceRegistry, preparedWorkspaceBackup),
          responseTimeMs,
          responseFirstTokenMs,
          responseStartedAt: timing?.startedAt,
          responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
          responseCompletedAt: timing ? completedAt : undefined,
          responseTrace: snapshotTrace(trace, completedAt),
        };
        const nextMessages = [...msgs, errMsg];
        responseTimingRef.current = null;
        visibleReplyContentRef.current = '';
        setLiveResponseMs(null);
        onUpdate(panel.id, {
          messages: nextMessages,
          streaming: false,
          streamingContent: '',
          streamingTrace: null,
          fileRegistry: activeWorkspaceRegistry,
          prevRegistry: snapshotRegistry,
          streamingPhase: null,
          latestWorkspaceBackup: preparedWorkspaceBackup,
          interruptedTask: null,
        });
        onSave({
          ...panel,
          messages: nextMessages,
          streaming: false,
          streamingContent: '',
          streamingTrace: null,
          fileRegistry: activeWorkspaceRegistry,
          prevRegistry: snapshotRegistry,
          streamingPhase: null,
          latestWorkspaceBackup: preparedWorkspaceBackup,
          interruptedTask: null,
        });
      }
    }

    function markFirstToken() {
      const timing = responseTimingRef.current;
      if (!timing || timing.firstTokenPerf != null) return;

      const firstTokenAt = Date.now();
      const firstTokenPerf = performance.now();
      responseTimingRef.current = {
        ...timing,
        firstTokenAt,
        firstTokenPerf,
      };
      trace.firstTokenAt = firstTokenAt;
    }

  }, [models, onApplyWorkspaceStep, onCommitWorkspaceRun, onPrepareWorkspaceRun, onReadWorkspaceContext, onSave, onUpdate, panel, replyPreferences]);

  function handleSend() {
    void sendPrompt(inputValue);
  }

  useEffect(() => {
    if (!launchPrompt?.trim() || panel.streaming || panel.messages.length > 0) return;
    const launchKey = `${panel.id}::${launchPrompt.trim()}`;
    if (activeLaunchPromptRuns.has(launchKey)) return;
    activeLaunchPromptRuns.add(launchKey);
    onConsumeLaunchPrompt?.(panel.id);
    void (async () => {
      try {
        await sendPrompt(launchPrompt);
      } finally {
        activeLaunchPromptRuns.delete(launchKey);
      }
    })();
  }, [
    launchPrompt,
    onConsumeLaunchPrompt,
    panel.id,
    panel.messages.length,
    panel.streaming,
    sendPrompt,
  ]);

  function handleStop()  { abortRef.current?.abort(); }
  function handleModelChange(model: string) {
    onUpdate(panel.id, { model });
    onSave({ ...panel, model });
  }
  function handlePresetChange(id: string) {
    onUpdate(panel.id, { preset: id });
    onSave({ ...panel, preset: id });
  }
  function handleReasoningEffortChange(reasoningEffort: ChatReasoningEffort) {
    onUpdate(panel.id, { reasoningEffort });
    onSave({ ...panel, reasoningEffort });
  }
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleUploadFiles(files: File[]) {
    const imported = await readImportableAttachments(files);
    if (!imported.length) return;
    const updatedRegistry = updateRegistry(panel.fileRegistry, imported, panel.messages.length);
    onUpdate(panel.id, { fileRegistry: updatedRegistry });
    onSave({ ...panel, fileRegistry: updatedRegistry });
  }

  const currentPreset  = panel.preset ?? DEFAULT_PRESET_ID;
  const currentReasoningEffort = panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const currentModel = resolveModelHandle(panel.model, models, { preserveUnavailable: true });
  const isCodeThread = panel.threadType === 'code' || panel.threadType === 'debug';
  const presetCandidates = isCodeThread
    ? PRESETS.filter((preset) => preset.id === 'code')
    : PRESETS.filter((preset) => preset.id !== 'code');
  const presetPickerOptions = (
    presetCandidates.some((preset) => preset.id === currentPreset)
      ? presetCandidates
      : [getPreset(currentPreset), ...presetCandidates.filter((preset) => preset.id !== currentPreset)]
  ).map<ChatComposerOption>((preset) => ({
    value: preset.id,
    label: preset.label,
    description: describePreset(preset.id),
  }));
  const reasoningOptions = REASONING_EFFORT_OPTIONS.map<ChatComposerOption>((option) => {
    const optionConfig = REASONING_EFFORT_CONFIG[option.value];
    return {
      value: option.value,
      label: option.label,
      description: `Uses up to ${optionConfig.maxSources} of the strongest live sources in the final prompt bundle while retaining a much larger retrieval catalog; requires at least ${optionConfig.minLiveSources} verified source${optionConfig.minLiveSources === 1 ? '' : 's'}.`,
    };
  });
  const isCodeStreaming = panel.streaming && currentPreset === 'code';
  const inputPlaceholder =
    "Ask anything... paste a URL and it'll be fetched automatically. Shift+Enter for newline.";
  const messageOffsets = new Array<number>(panel.messages.length);
  const messageHeights = new Array<number>(panel.messages.length);
  let totalVirtualHeight = 0;

  for (let index = 0; index < panel.messages.length; index += 1) {
    const message = panel.messages[index];
    const trailingGapPx = index === panel.messages.length - 1 ? 0 : MESSAGE_STACK_GAP_PX;
    const hideCodeBlocks = message.role === 'assistant' && currentPreset === 'code';
    const measuredHeight = rowHeightsRef.current.get(index);
    const nextHeight = measuredHeight ?? estimateMessageHeight(message, hideCodeBlocks, trailingGapPx);

    messageOffsets[index] = totalVirtualHeight;
    messageHeights[index] = nextHeight;
    totalVirtualHeight += nextHeight;
  }

  let virtualStartIndex = 0;
  let virtualEndIndex = -1;

  if (hasMessages) {
    const renderTop = Math.max(0, scrollTop - MESSAGE_OVERSCAN_PX);
    const renderBottom = scrollTop + Math.max(viewportHeight, 1) + MESSAGE_OVERSCAN_PX;

    while (
      virtualStartIndex < panel.messages.length
      && messageOffsets[virtualStartIndex] + messageHeights[virtualStartIndex] < renderTop
    ) {
      virtualStartIndex += 1;
    }

    let endCursor = virtualStartIndex;
    while (endCursor < panel.messages.length && messageOffsets[endCursor] < renderBottom) {
      endCursor += 1;
    }

    virtualEndIndex = Math.min(
      panel.messages.length - 1,
      Math.max(endCursor - 1, virtualStartIndex + 5),
    );
  }

  return (
    <div
      className={`chat-panel${selected ? ' active' : ''}${backgroundMode ? ' background-mode' : ''}`}
      onMouseDown={() => onActivate?.(panel.id)}
    >
      <div className="panel-header">
        <input
          className="panel-title"
          value={panel.title}
          placeholder="Chat name..."
          onChange={e => onUpdate(panel.id, { title: e.target.value })}
          onBlur={() => onSave(panel)}
        />
        {hasMessages && (
          <button className="panel-btn" onClick={handleExportLog} title="Export chat log as Markdown">
            <IconDownload size={13} />
          </button>
        )}
        {panel.projectId && panel.latestWorkspaceBackup && onRestoreWorkspaceBackup && (
          <button
            className="panel-btn"
            onClick={() => {
              void handleRestoreLatestWorkspaceBackup();
            }}
            title="Restore workspace to the backup saved before the latest AI run"
          >
            <IconRotateCcw size={13} />
          </button>
        )}
        <button
          className="panel-btn close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(panel.id);
          }}
          title="Close panel"
        >
          <IconX size={13} />
        </button>
      </div>

      <div className="messages" ref={messagesViewportRef}>
        {!hasMessages && !panel.streaming ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconHexagon size={52} /></div>
            <h3>Ready</h3>
            <p>Ask me to write code, generate docs, or debug anything.</p>
          </div>
        ) : (
          <div className="messages-stack">
            {interruptedTaskResume && (
              <div className="interrupted-task-card" role="status" aria-live="polite">
                <div className="interrupted-task-copy">
                  <strong>My tasks were interrupted, would you like to continue?</strong>
                  <p>We saved the last in-progress workspace task so you can pick up where the AI left off.</p>
                  {interruptedTaskResume.lastPhaseLabel && (
                    <span className="interrupted-task-phase">Last saved step: {interruptedTaskResume.lastPhaseLabel}</span>
                  )}
                </div>

                <button
                  type="button"
                  className="interrupted-task-btn"
                  onClick={handleResumeInterruptedTask}
                  disabled={panel.streaming}
                >
                  Continue Task
                </button>
              </div>
            )}

            {hasMessages && (
              <div className="messages-virtual-stage" style={{ height: `${totalVirtualHeight}px` }}>
                {panel.messages.slice(virtualStartIndex, virtualEndIndex + 1).map((msg, localIndex) => {
                  const actualIndex = virtualStartIndex + localIndex;
                  const isCodeAssistant = msg.role === 'assistant' && currentPreset === 'code';
                  const replyPreferenceDraft = msg.role === 'assistant'
                    ? buildReplyPreferenceEntry({
                        chatId: panel.id,
                        chatTitle: panel.title,
                        assistantMessage: msg,
                        assistantIndex: actualIndex,
                        messages: panel.messages,
                        panel,
                        feedback: 'liked',
                      })
                    : null;
                  return (
                    <div
                      key={actualIndex}
                      className="message-virtual-row"
                      style={{ top: `${messageOffsets[actualIndex]}px` }}
                    >
                      <div
                        ref={(node) => handleVirtualRowRef(actualIndex, node)}
                        className={`message-virtual-row-shell${actualIndex === panel.messages.length - 1 ? ' is-last' : ''}`}
                      >
                        <MessageBubble
                          message={msg}
                          chatTitle={panel.title}
                          withDownload={true}
                          prevRegistry={panel.prevRegistry}
                          onUndoWorkspaceChanges={handleRestoreReplyWorkspaceChanges}
                          model={panel.model}
                          feedbackValue={replyPreferenceDraft ? replyPreferenceFeedbackById.get(replyPreferenceDraft.id) ?? null : null}
                          onFeedbackChange={replyPreferenceDraft ? (next) => handleReplyFeedbackChange(msg, actualIndex, next) : undefined}
                          hideCodeBlocks={isCodeAssistant}
                          isMostRecentReply={!panel.streaming && msg.role === 'assistant' && actualIndex === panel.messages.length - 1}
                          onAssistantRunStatusToggle={handleAssistantRunStatusToggle}
                          suppressNoCodeWarning={currentPreset !== 'code'}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {panel.streaming && (
              <>
                <div className="streaming-wrap">
                  <MessageBubble
                    message={{
                      role: 'assistant',
                      content: panel.streamingContent,
                      responseTrace: panel.streamingTrace ?? undefined,
                    }}
                    chatTitle={panel.title}
                    withDownload={false}
                    prevRegistry={panel.prevRegistry}
                    onUndoWorkspaceChanges={handleRestoreReplyWorkspaceChanges}
                    model={panel.model}
                    hideCodeBlocks={isCodeStreaming}
                    isStreaming={true}
                    streamingPhase={panel.streamingPhase}
                    liveResponseMs={liveResponseMs}
                    isMostRecentReply={true}
                    onAssistantRunStatusToggle={handleAssistantRunStatusToggle}
                    suppressNoCodeWarning={true}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <FileRegistryPanel registry={panel.fileRegistry} chatTitle={panel.title} />

      <div className="panel-input">
        <ChatComposer
          value={inputValue}
          onValueChange={setInputValue}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          ariaLabel={inputPlaceholder}
          textareaRef={inputRef}
          disabled={panel.streaming}
          uploadTitle="Upload files or a zip into this chat"
          uploadActive={panel.fileRegistry.size > 0}
          onUploadFiles={handleUploadFiles}
          reasoningValue={currentReasoningEffort}
          reasoningOptions={reasoningOptions}
          onReasoningChange={(value) => handleReasoningEffortChange(value as ChatReasoningEffort)}
          reasoningDisabled={currentPreset === 'code'}
          presetValue={currentPreset}
          presetOptions={presetPickerOptions}
          onPresetChange={handlePresetChange}
          presetDisabled={presetPickerOptions.length < 2}
          modelValue={currentModel}
          modelOptions={models}
          onModelChange={handleModelChange}
          onSend={handleSend}
          sendDisabled={!inputValue.trim()}
          isStreaming={panel.streaming}
          onStop={handleStop}
        />
      </div>
    </div>
  );
}
