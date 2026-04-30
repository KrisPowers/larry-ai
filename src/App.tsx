import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { CodeWorkspaceStage } from './components/CodeWorkspaceStage';
import { PromptLibraryView } from './components/PromptLibraryView';
import { Sidebar } from './components/Sidebar';
import { WorkspaceIdeMenubar } from './components/WorkspaceIdeMenubar';
import { WorkspaceFileEditorPanel, type WorkspaceEditorDocumentView } from './components/WorkspaceFileEditorPanel';
import { WorkspaceTerminalPanel, type WorkspaceTerminalEntryView } from './components/WorkspaceTerminalPanel';
import { useOllama } from './hooks/useOllama';
import { useDB } from './hooks/useDB';
import { useReplyPreferences } from './hooks/useReplyPreferences';
import { useToast } from './hooks/useToast';
import { createRegistry, updateRegistry } from './lib/fileRegistry';
import { mergeStoredFileEntries } from './lib/chatAttachments';
import { stripExportedChatMetadata } from './lib/chatLog';
import { runDeepResearchSearchEngineTest } from './lib/fetcher';
import {
  copyBrowserWorkspaceEntry,
  createBrowserWorkspaceBackup,
  createBrowserWorkspaceDirectory,
  createBrowserWorkspaceFile,
  deleteBrowserWorkspaceEntry,
  openBrowserWorkspaceFileExternal,
  isBrowserWorkspacePickerAvailable,
  pickBrowserWorkspaceDirectory,
  readBrowserWorkspaceFile,
  renameBrowserWorkspaceEntry,
  restoreBrowserWorkspaceBackup,
  scanBrowserWorkspace,
  writeBrowserWorkspaceFileDocument,
  writeBrowserWorkspaceFile,
} from './lib/browserWorkspaceHost';
import {
  buildModelHandle,
  DEFAULT_OLLAMA_BASE,
  getModelDisplayLabel,
  getModelDisplayName,
  getModelProvider,
  normalizeModelHandle,
  normalizeOllamaBase,
  resolveModelHandle,
} from './lib/ollama';
import { DEFAULT_PRESET_ID, PRESETS, describePreset } from './lib/presets';
import { clearReplyPreferences } from './lib/replyPreferences';
import { isDesktopRuntime, loadStorageSnapshot, saveAppSettings, saveChat as persistChatRecord, saveWorkspaces } from './lib/persistence';
import { cloneProviderSettingsMap, createDefaultProviderSettingsMap } from './lib/providerConnections';
import {
  addSearchEngineSeed,
  crawlSearchEngine,
  deleteSearchEngineSeed,
  getSearchEngineStatus,
  isLocalSearchEngineAvailable,
  listSearchEngineSeeds,
} from './lib/searchEngine';
import {
  createWorkspaceBackup,
  createWorkspaceDirectory,
  copyWorkspaceEntry,
  createWorkspaceFile,
  createManagedWorkspaceDirectory,
  deleteWorkspaceEntry,
  inspectWorkspaceRuntime,
  isWorkspaceHostAvailable,
  openWorkspaceEntry,
  openWorkspaceInExplorer,
  pickWorkspaceDirectory,
  readWorkspaceFile,
  renameWorkspaceEntry,
  restoreWorkspaceBackup,
  runWorkspaceCommand,
  runWorkspaceWebPreview,
  scanWorkspace,
  writeWorkspaceFileDocument,
  writeWorkspaceFile,
} from './lib/workspaceHost';
import { isConventionalExtensionlessWorkspaceFile, workspaceFilePathHasDefinedType } from './lib/workspaceFileTypes';
import { IconCheck, IconClock3, IconDownload, IconFileText, IconFolderPlus, IconHexagon, IconMessageSquare, IconRefreshCw, IconSearch, IconSettings, IconTerminal, IconTrash2, IconUpload, IconX } from './components/Icon';
import { applyWorkspaceSnapshot, buildWorkspaceGroups, buildWorkspaceIdFromPath, deriveWorkspaceFromChat, findWorkspaceGroup, normaliseProjectId, workspaceHasLinkedSource, type WorkspaceGroup } from './lib/workspaces';
import { ProviderIcon } from './components/ProviderIcon';
import type {
  AppSettings,
  ChatReasoningEffort,
  ModelProvider,
  Panel,
  ChatRecord,
  ProjectFolder,
  ProviderSettingsMap,
  ThreadType,
  WorkspaceBackupReference,
  WorkspaceCommandResult,
  WorkspaceFileDocument,
  WorkspaceFileNode,
  WorkspaceRuntimeProfile,
  WorkspaceSnapshot,
} from './types';
import type { FileEntry, FileRegistry } from './lib/fileRegistry';
import type { DeepResearchSearchEngineTestResult } from './lib/fetcher';
import type { LocalSearchCrawlSummary, LocalSearchEngineStatus, LocalSearchSeed } from './lib/searchEngine';

const MAX_VISIBLE_CHAT_PANELS = 2;
const CHAT_FORM_TRANSITION_MIN_MS = 2000;
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'balanced';
const WORKSPACE_FILE_AUTO_SAVE_DELAY_MS = 2000;
const CHAT_DEFAULT_PRESETS = PRESETS.filter((preset) => preset.id !== 'code');
const REASONING_EFFORT_OPTIONS: Array<{ value: ChatReasoningEffort; label: string }> = [
  { value: 'light', label: 'Low' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High' },
  { value: 'extra-high', label: 'Extra High' },
];

interface BrowserStorageSnapshot {
  supported: boolean;
  usage?: number;
  quota?: number;
}

type AppRoute =
  | { kind: 'landing' }
  | { kind: 'chat-start' }
  | { kind: 'code-start' }
  | { kind: 'settings' }
  | { kind: 'chat'; chatId: string }
  | { kind: 'not-found'; path: string };

type SettingsTabId = 'workspace' | 'editor' | 'providers' | 'data' | 'shortcuts' | 'advanced';

type ShortcutInsight = {
  keys: string[];
  action: string;
};

type ShortcutInsightGroup = {
  id: string;
  title: string;
  items: ShortcutInsight[];
};

type ProviderDialogMode = 'connect' | 'edit';

interface ProviderDialogState {
  provider: ModelProvider;
  mode: ProviderDialogMode;
  credentialValue: string;
  selectedModels: string[];
  autoUpdate: boolean;
}

const PROVIDER_ORDER: ModelProvider[] = ['openai', 'anthropic', 'ollama'];
const PROVIDER_STARTER_MODELS: Record<ModelProvider, string[]> = {
  openai: [
    buildModelHandle('openai', 'gpt-5.4'),
    buildModelHandle('openai', 'gpt-5.4-mini'),
    buildModelHandle('openai', 'gpt-5-mini'),
    buildModelHandle('openai', 'gpt-4o'),
  ],
  anthropic: [
    buildModelHandle('anthropic', 'claude-opus-4-1-20250805'),
    buildModelHandle('anthropic', 'claude-sonnet-4-20250514'),
    buildModelHandle('anthropic', 'claude-3-7-sonnet-20250219'),
  ],
  ollama: [
    buildModelHandle('ollama', 'qwen2.5-coder:7b'),
    buildModelHandle('ollama', 'llama3.2:latest'),
    buildModelHandle('ollama', 'deepseek-r1:8b'),
    buildModelHandle('ollama', 'gemma3:12b'),
  ],
};
const PROVIDER_UI_META: Record<ModelProvider, {
  setupTitle: string;
  setupDescription: string;
  fieldLabel: string;
  fieldPlaceholder: string;
  fieldHelp: string;
  addCardLabel: string;
  providerName: string;
}> = {
  openai: {
    setupTitle: 'Set up GPT',
    setupDescription: 'Connect to OpenAI and set up your GPT models.',
    fieldLabel: 'API Key',
    fieldPlaceholder: 'sk-...',
    fieldHelp: 'Paste your API key from OpenAI to access your models.',
    addCardLabel: 'GPT',
    providerName: 'OpenAI',
  },
  anthropic: {
    setupTitle: 'Set up Claude',
    setupDescription: 'Connect to Anthropic and set up your Claude models.',
    fieldLabel: 'API Key',
    fieldPlaceholder: 'sk-ant-...',
    fieldHelp: 'Paste your API key from Anthropic to access your models.',
    addCardLabel: 'Claude',
    providerName: 'Anthropic',
  },
  ollama: {
    setupTitle: 'Set up Ollama',
    setupDescription: 'Connect to Ollama and make local or hosted models available in the app.',
    fieldLabel: 'Endpoint',
    fieldPlaceholder: DEFAULT_OLLAMA_BASE,
    fieldHelp: 'Enter the Ollama endpoint for your local or remote model host.',
    addCardLabel: 'Ollama',
    providerName: 'Ollama',
  },
};

const SETTINGS_TAB_META: Record<SettingsTabId, {
  label: string;
  title: string;
  description: string;
}> = {
  workspace: {
    label: 'Workspace',
    title: 'Workspace defaults',
    description: 'Set the defaults that shape new chats and keep setup tasks easy to find.',
  },
  editor: {
    label: 'Code Editor',
    title: 'Editor behavior and visuals',
    description: 'Control autosave timing and the editor visuals used when browsing workspace files.',
  },
  providers: {
    label: 'Models',
    title: 'Language models',
    description: 'Manage provider connections, default model selection, and the model lists exposed across chats.',
  },
  data: {
    label: 'Data',
    title: 'Local data and transfers',
    description: 'Inspect storage usage, export local app data, and clear saved memory when needed.',
  },
  shortcuts: {
    label: 'Shortcuts',
    title: 'Shortcut insights and navigation',
    description: 'Track live keyboard shortcuts and keep power-user actions easy to discover as the workspace grows.',
  },
  advanced: {
    label: 'Advanced',
    title: 'Advanced controls and diagnostics',
    description: 'Expose extra UI controls and run fetch diagnostics when you need deeper visibility.',
  },
};

function isSettingsTabId(value: string): value is SettingsTabId {
  return value in SETTINGS_TAB_META;
}

function buildStartPath(threadType: ThreadType): string {
  if (threadType === 'code' || threadType === 'debug') return '/code';
  return '/chat';
}

function resolveThreadSurface(record?: Partial<Pick<ChatRecord, 'threadType' | 'preset' | 'projectId' | 'projectLabel'>> | null): ThreadType {
  if (record?.threadType === 'chat') {
    return 'chat';
  }

  if (record?.threadType === 'code' || record?.threadType === 'debug') {
    return 'code';
  }

  if (record?.preset === 'code') {
    return 'code';
  }

  return 'chat';
}

function measureStringBytes(value: string): number {
  return new Blob([value]).size;
}

function measurePersistedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized === '{}' || serialized === '[]') return 0;
  return measureStringBytes(serialized);
}

function estimateLocalStorageEntryBytes(key: string, value: string): number {
  return measureStringBytes(key) + measureStringBytes(value);
}

function roundUp(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? roundUp(kb, 1).toFixed(1) : Math.ceil(kb)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? roundUp(mb, 1).toFixed(1) : Math.ceil(mb)} MB`;
  }

  const gb = bytes / (1024 * 1024 * 1024);
  const roundedGb = roundUp(gb, 1);
  return `${Number.isInteger(roundedGb) ? roundedGb.toFixed(0) : roundedGb.toFixed(1)} GB`;
}

function formatStoragePercent(percent: number): string {
  if (percent <= 0) return '0%';
  if (percent < 0.1) return '0.1%';
  const rounded = roundUp(percent, percent < 10 ? 1 : 0);
  return `${rounded.toFixed(percent < 10 ? 1 : 0)}%`;
}

function formatDiagnosticDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatDiagnosticTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLocalSearchTimestamp(value?: number | null): string {
  if (!value) return 'Never';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Unknown';
  return timestamp.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDiagnosticFilenameTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'report';

  const year = timestamp.getFullYear();
  const month = String(timestamp.getMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getDate()).padStart(2, '0');
  const hours = String(timestamp.getHours()).padStart(2, '0');
  const minutes = String(timestamp.getMinutes()).padStart(2, '0');
  const seconds = String(timestamp.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

function isChatReasoningEffort(value: string | null): value is ChatReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value);
}

function getReasoningEffortLabel(value: ChatReasoningEffort): string {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? 'Balanced';
}

function buildStorageVisualSegments<T extends { bytes: number }>(buckets: T[]) {
  const activeBuckets = buckets.filter((bucket) => bucket.bytes > 0);
  if (!activeBuckets.length) return [];

  const totalBytes = activeBuckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
  const contributionPercents = activeBuckets.map((bucket) => (bucket.bytes / totalBytes) * 100);
  const minVisualPercent = Math.min(12, 100 / activeBuckets.length);
  const visualPercents = new Array(activeBuckets.length).fill(0);
  const unlocked = new Set(activeBuckets.map((_, index) => index));
  let remainingVisualPercent = 100;
  let remainingContributionPercent = 100;

  let changed = true;
  while (changed && unlocked.size > 0) {
    changed = false;

    for (const index of [...unlocked]) {
      const proportional = remainingContributionPercent > 0
        ? (contributionPercents[index] / remainingContributionPercent) * remainingVisualPercent
        : 0;

      if (proportional < minVisualPercent) {
        visualPercents[index] = minVisualPercent;
        remainingVisualPercent -= minVisualPercent;
        remainingContributionPercent -= contributionPercents[index];
        unlocked.delete(index);
        changed = true;
      }
    }
  }

  if (unlocked.size > 0) {
    for (const index of unlocked) {
      visualPercents[index] = remainingContributionPercent > 0
        ? (contributionPercents[index] / remainingContributionPercent) * remainingVisualPercent
        : remainingVisualPercent / unlocked.size;
    }
  }

  return activeBuckets.map((bucket, index) => ({
    ...bucket,
    contributionPercent: contributionPercents[index],
    visualPercent: visualPercents[index],
  }));
}

function getCustomPresetStorageUsage(desktopRuntime: boolean): { bytes: number; count: number } {
  if (desktopRuntime) {
    return { bytes: 0, count: 0 };
  }

  try {
    let bytes = 0;
    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !/preset/i.test(key)) continue;
      const value = localStorage.getItem(key) ?? '';
      bytes += estimateLocalStorageEntryBytes(key, value);
      count += 1;
    }
    return { bytes, count };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseAppRoute(pathname: string): AppRoute {
  const cleanPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

  if (cleanPath === '/') {
    return { kind: 'chat-start' };
  }

  if (cleanPath === '/chat') {
    return { kind: 'chat-start' };
  }

  if (cleanPath === '/code') {
    return { kind: 'code-start' };
  }

  if (cleanPath === '/debug') {
    return { kind: 'code-start' };
  }

  if (cleanPath === '/settings') {
    return { kind: 'settings' };
  }

  const segments = cleanPath.split('/').filter(Boolean);
  if (segments.length === 1) {
    return { kind: 'chat', chatId: decodeRouteSegment(segments[0]) };
  }

  return { kind: 'not-found', path: pathname };
}

function buildChatPath(chatId: string): string {
  return `/${encodeURIComponent(chatId)}`;
}

function restoreRegistry(chatData?: Partial<ChatRecord>): FileRegistry {
  const reg = createRegistry();
  if (!chatData?.fileEntries?.length) return reg;
  return updateRegistry(reg, chatData.fileEntries, 0);
}

function cloneFileEntries(entries?: ChatRecord['fileEntries']) {
  return entries?.map((entry) => ({ ...entry })) ?? [];
}

function entriesFromRegistry(registry: FileRegistry) {
  return [...registry.values()].map((entry) => ({ ...entry }));
}

function registryFromEntries(entries?: ChatRecord['fileEntries']): FileRegistry {
  return new Map(cloneFileEntries(entries).map((entry) => [entry.path, entry]));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]'));
}

function isChatPanelKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('.chat-panel'));
}

function newPanel(defaultModel: string, chatData?: Partial<ChatRecord>): Panel {
  return {
    id: chatData?.id ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: chatData?.title ?? 'New chat',
    model: normalizeModelHandle(chatData?.model ?? defaultModel),
    preset: chatData?.preset ?? DEFAULT_PRESET_ID,
    reasoningEffort: chatData?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    threadType: chatData?.threadType,
    projectId: chatData?.projectId,
    projectLabel: chatData?.projectLabel,
    messages: chatData?.messages ?? [],
    streaming: false,
    streamingContent: '',
    streamingTrace: null,
    fileRegistry: restoreRegistry(chatData),
    prevRegistry: new Map(),
    streamingPhase: null,
    latestWorkspaceBackup: chatData?.latestWorkspaceBackup ?? null,
    interruptedTask: chatData?.interruptedTask ?? null,
  };
}

function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
    py: 'py', html: 'html', css: 'css', scss: 'scss',
    json: 'json', md: 'md', sh: 'sh', bash: 'bash',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql',
    go: 'go', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp',
  };
  return map[ext] ?? ext ?? 'text';
}

function resetPanelRunState(panel: Panel, overrides: Partial<Panel> = {}): Panel {
  return {
    ...panel,
    messages: [],
    streaming: false,
    streamingContent: '',
    streamingTrace: null,
    fileRegistry: overrides.fileRegistry ?? new Map(),
    prevRegistry: new Map(),
    streamingPhase: null,
    latestWorkspaceBackup: null,
    interruptedTask: null,
    ...overrides,
  };
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function isWorkspacePathWithinTarget(path: string, targetPath: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedTarget = normalizeWorkspacePath(targetPath);
  return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
}

function buildSiblingWorkspacePath(relativePath: string, nextName: string): string {
  const normalizedPath = normalizeWorkspacePath(relativePath);
  const normalizedName = nextName.trim();
  if (/[\\/]/.test(normalizedName)) {
    throw new Error('File names cannot include path separators.');
  }
  if (!normalizedName || normalizedName === '.' || normalizedName === '..') {
    throw new Error('Enter a valid file name.');
  }

  const segments = normalizedPath.split('/');
  segments[segments.length - 1] = normalizedName;
  return segments.join('/');
}

function buildDuplicateWorkspacePath(relativePath: string, existingPaths: Set<string>): string {
  const normalizedPath = normalizeWorkspacePath(relativePath);
  const segments = normalizedPath.split('/');
  const fileName = segments.pop() ?? normalizedPath;
  const dotIndex = fileName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : '';
  const parentPath = segments.join('/');

  for (let attempt = 1; attempt < 500; attempt += 1) {
    const candidateName = `${stem} copy${attempt > 1 ? ` ${attempt}` : ''}${extension}`;
    const candidatePath = parentPath ? `${parentPath}/${candidateName}` : candidateName;
    if (!existingPaths.has(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(`Unable to create a duplicate name for "${fileName}".`);
}

function buildWorkspaceChildPath(parentRelativePath: string | null, name: string): string {
  const normalizedName = name.trim().replace(/\\/g, '/');
  if (!normalizedName || normalizedName === '.' || normalizedName === '..') {
    throw new Error('Enter a valid name.');
  }
  if (normalizedName.includes('/')) {
    throw new Error('Names cannot include path separators.');
  }

  const parent = parentRelativePath ? normalizeWorkspacePath(parentRelativePath) : '';
  return parent ? `${parent}/${normalizedName}` : normalizedName;
}

function buildUniqueWorkspaceChildPath(
  parentRelativePath: string | null,
  baseName: string,
  existingPaths: Set<string>,
): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const nextName = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    const nextPath = buildWorkspaceChildPath(parentRelativePath, nextName);
    if (!existingPaths.has(nextPath)) {
      return nextPath;
    }
  }

  throw new Error(`Unable to create a unique path for "${baseName}".`);
}

function collectWorkspaceFilePaths(nodes: WorkspaceFileNode[] | undefined): string[] {
  if (!nodes?.length) return [];

  const paths: string[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === 'file') {
      paths.push(normalizeWorkspacePath(node.path));
      continue;
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }

  return paths;
}

function collectWorkspaceEntryPaths(nodes: WorkspaceFileNode[] | undefined): string[] {
  if (!nodes?.length) return [];

  const paths: string[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    paths.push(normalizeWorkspacePath(node.path));
    if (node.kind === 'directory' && node.children?.length) {
      stack.push(...node.children);
    }
  }

  return paths;
}

function buildWorkspacePathForClipboard(workspace: Pick<ProjectFolder, 'rootPath' | 'label'>, relativePath: string): string {
  if (!workspace.rootPath) {
    return normalizeWorkspacePath(relativePath);
  }

  const separator = workspace.rootPath.includes('\\') ? '\\' : '/';
  const normalizedRelativePath = normalizeWorkspacePath(relativePath).split('/').join(separator);
  return `${workspace.rootPath.replace(/[\\/]+$/, '')}${separator}${normalizedRelativePath}`;
}

function normalizeWorkspaceLookupLabel(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Clipboard access is not available in this environment.'));
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) {
        reject(new Error('Unable to copy that value to the clipboard.'));
        return;
      }
      resolve();
    } catch (error) {
      document.body.removeChild(textarea);
      reject(error instanceof Error ? error : new Error('Unable to copy that value to the clipboard.'));
    }
  });
}

function buildPackageManagerCommand(packageManager: 'npm' | 'pnpm' | 'yarn', script: string): string {
  if (packageManager === 'yarn') return `yarn ${script}`;
  if (packageManager === 'pnpm') return `pnpm ${script}`;
  return `npm run ${script}`;
}

function buildPackageManagerInstallCommand(packageManager: 'npm' | 'pnpm' | 'yarn'): string {
  if (packageManager === 'yarn') return 'yarn install';
  if (packageManager === 'pnpm') return 'pnpm install';
  return 'npm install';
}

function hasRunnablePackageScript(script?: string): boolean {
  const trimmed = script?.trim();
  if (!trimmed) return false;
  return !trimmed.toLowerCase().includes('no test specified');
}

interface WorkspaceDependencyRefreshPlan {
  label: string;
  cleanupPaths: string[];
  commands: string[];
}

function createWorkspaceCommandResult(
  command: string,
  exitCode: number,
  combinedOutput: string,
  options: { stdout?: string; stderr?: string; durationMs?: number; timedOut?: boolean } = {},
): WorkspaceCommandResult {
  return {
    command,
    exitCode,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    combinedOutput,
    durationMs: options.durationMs ?? 0,
    timedOut: options.timedOut ?? false,
  };
}

function workspaceCommandFailed(result: WorkspaceCommandResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

function pickWorkspacePreviewCommand(profile: WorkspaceRuntimeProfile | null) {
  return profile?.commands.find((candidate) => candidate.kind === 'start') ?? null;
}

function pickWorkspaceDependencyRefreshPlan(
  profile: WorkspaceRuntimeProfile | null,
  entries: Array<{ path: string; content: string }> | undefined,
  options: { freshInstall?: boolean } = {},
): WorkspaceDependencyRefreshPlan | null {
  if (!profile) return null;

  const byPath = new Map((entries ?? []).map((entry) => [normalizeWorkspacePath(entry.path).toLowerCase(), entry]));
  const freshInstall = options.freshInstall ?? false;
  if (profile.ecosystem === 'node') {
    const packageManager: 'npm' | 'pnpm' | 'yarn' = byPath.has('pnpm-lock.yaml')
      ? 'pnpm'
      : byPath.has('yarn.lock')
        ? 'yarn'
        : 'npm';

    return {
      label: freshInstall ? 'Refreshing Node dependencies' : 'Installing Node dependencies',
      cleanupPaths: freshInstall ? ['node_modules'] : [],
      commands: [buildPackageManagerInstallCommand(packageManager)],
    };
  }

  if (profile.ecosystem === 'go') {
    return {
      label: freshInstall ? 'Refreshing Go modules' : 'Installing Go modules',
      cleanupPaths: freshInstall ? ['vendor'] : [],
      commands: ['go mod tidy', 'go mod download'],
    };
  }

  if (profile.ecosystem === 'rust') {
    return {
      label: freshInstall ? 'Refreshing Rust dependencies' : 'Installing Rust dependencies',
      cleanupPaths: freshInstall ? ['target'] : [],
      commands: ['cargo fetch'],
    };
  }

  if (profile.ecosystem === 'python') {
    return {
      label: freshInstall ? 'Refreshing Python dependencies' : 'Installing Python dependencies',
      cleanupPaths: freshInstall ? ['.venv'] : [],
      commands: byPath.has('requirements.txt')
        ? ['python -m pip install -r requirements.txt']
        : ['python -m pip install -e .'],
    };
  }

  return null;
}

function shouldRunWorkspaceWebPreview(
  profile: WorkspaceRuntimeProfile | null,
  entries: Array<{ path: string; content: string }> | undefined,
): boolean {
  if (profile?.ecosystem !== 'node') return false;

  const byPath = new Map((entries ?? []).map((entry) => [normalizeWorkspacePath(entry.path).toLowerCase(), entry]));
  const packageEntry = byPath.get('package.json');
  const manifestLower = packageEntry?.content.toLowerCase() ?? '';

  return (
    manifestLower.includes('"vite"')
    || manifestLower.includes('"next"')
    || manifestLower.includes('"react-scripts"')
    || byPath.has('vite.config.ts')
    || byPath.has('vite.config.js')
    || byPath.has('vite.config.mjs')
    || byPath.has('vite.config.cjs')
  );
}

function deriveWorkspaceRuntimeProfileFromEntries(
  entries: Array<{ path: string; content: string }> | undefined,
): WorkspaceRuntimeProfile | null {
  if (!entries?.length) return null;

  const byPath = new Map(entries.map((entry) => [normalizeWorkspacePath(entry.path).toLowerCase(), entry]));
  const packageEntry = byPath.get('package.json');
  if (packageEntry) {
    let packageName = 'Workspace';
    let scripts: Record<string, string> = {};
    try {
      const parsed = JSON.parse(packageEntry.content) as { name?: string; scripts?: Record<string, string> };
      packageName = parsed.name?.trim() || packageName;
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }

    const packageManager: 'npm' | 'pnpm' | 'yarn' = byPath.has('pnpm-lock.yaml')
      ? 'pnpm'
      : byPath.has('yarn.lock')
        ? 'yarn'
        : 'npm';
    const commands: WorkspaceRuntimeProfile['commands'] = [];

    if (hasRunnablePackageScript(scripts.build)) {
      commands.push({ kind: 'build', label: 'Build application', command: buildPackageManagerCommand(packageManager, 'build') });
    }
    if (hasRunnablePackageScript(scripts.test)) {
      commands.push({ kind: 'test', label: 'Run tests', command: buildPackageManagerCommand(packageManager, 'test') });
    }
    if (hasRunnablePackageScript(scripts.lint)) {
      commands.push({ kind: 'lint', label: 'Run lint checks', command: buildPackageManagerCommand(packageManager, 'lint') });
    }
    if (hasRunnablePackageScript(scripts.preview)) {
      commands.push({ kind: 'start', label: 'Preview built application', command: buildPackageManagerCommand(packageManager, 'preview') });
    } else if (hasRunnablePackageScript(scripts.dev)) {
      commands.push({ kind: 'start', label: 'Start dev server', command: buildPackageManagerCommand(packageManager, 'dev') });
    } else if (hasRunnablePackageScript(scripts.start)) {
      commands.push({ kind: 'start', label: 'Start application', command: buildPackageManagerCommand(packageManager, 'start') });
    }

    return {
      ecosystem: 'node',
      label: packageName,
      detectedFiles: [
        'package.json',
        ...(byPath.has('pnpm-lock.yaml') ? ['pnpm-lock.yaml'] : []),
        ...(byPath.has('yarn.lock') ? ['yarn.lock'] : []),
      ],
      commands,
    };
  }

  if (byPath.has('go.mod')) {
    return {
      ecosystem: 'go',
      label: 'Go workspace',
      detectedFiles: ['go.mod'],
      commands: [
        { kind: 'test', label: 'Run Go tests', command: 'go test ./...' },
        { kind: 'build', label: 'Build Go packages', command: 'go build ./...' },
      ],
    };
  }

  if (byPath.has('cargo.toml')) {
    return {
      ecosystem: 'rust',
      label: 'Rust workspace',
      detectedFiles: ['Cargo.toml'],
      commands: [
        { kind: 'test', label: 'Run Rust tests', command: 'cargo test' },
        { kind: 'build', label: 'Build Rust project', command: 'cargo build' },
      ],
    };
  }

  if (byPath.has('pyproject.toml') || byPath.has('requirements.txt')) {
    const commands: WorkspaceRuntimeProfile['commands'] = [];
    if (byPath.has('pytest.ini') || [...byPath.keys()].some((path) => path.startsWith('tests/'))) {
      commands.push({ kind: 'test', label: 'Run Python tests', command: 'python -m pytest' });
    }
    commands.push({ kind: 'build', label: 'Compile Python sources', command: 'python -m compileall .' });
    return {
      ecosystem: 'python',
      label: 'Python workspace',
      detectedFiles: [
        ...(byPath.has('pyproject.toml') ? ['pyproject.toml'] : []),
        ...(byPath.has('requirements.txt') ? ['requirements.txt'] : []),
      ],
      commands,
    };
  }

  return null;
}

function pickWorkspaceValidationCommands(profile: WorkspaceRuntimeProfile | null) {
  if (!profile?.commands.length) return [];

  const priorityOrder: Array<WorkspaceRuntimeProfile['commands'][number]['kind']> = [
    'build',
    'test',
    'lint',
  ];
  const selectedCommands: WorkspaceRuntimeProfile['commands'] = [];
  const seenCommands = new Set<string>();

  for (const kind of priorityOrder) {
    const command = profile.commands.find((candidate) => candidate.kind === kind);
    if (!command || seenCommands.has(command.command)) continue;
    selectedCommands.push(command);
    seenCommands.add(command.command);
  }

  if (!selectedCommands.length && profile.commands[0]) {
    selectedCommands.push(profile.commands[0]);
  }

  return selectedCommands;
}

function workspaceValidationTimeoutMs(command: WorkspaceRuntimeProfile['commands'][number]) {
  return command.kind === 'start' ? 12_000 : command.kind === 'test' ? 90_000 : 60_000;
}

function workspacePrefersTypeScript(
  prompt: string,
  profile: WorkspaceRuntimeProfile | null,
  entries: Array<{ path: string; content: string }> | undefined,
): boolean {
  if (/\btypescript\b|\btsx\b/i.test(prompt)) return true;
  if (profile?.detectedFiles.some((path) => /tsconfig\.json$/i.test(path))) return true;

  const normalizedPaths = new Set((entries ?? []).map((entry) => normalizeWorkspacePath(entry.path).toLowerCase()));
  if (normalizedPaths.has('tsconfig.json')) return true;
  return [...normalizedPaths].some((path) => /\.(ts|tsx)$/.test(path));
}

function collectWorkspaceConflictingWebEntryVariants(options: {
  prompt: string;
  profile: WorkspaceRuntimeProfile | null;
  entries: Array<{ path: string; content: string }> | undefined;
  writtenPaths?: string[];
}): Array<{ preferredPath: string; redundantPaths: string[] }> {
  const entries = options.entries ?? [];
  if (!entries.length) return [];
  if (!shouldRunWorkspaceWebPreview(options.profile, entries) && !isWebsitePrompt(options.prompt)) {
    return [];
  }

  const prefersTypeScript = workspacePrefersTypeScript(options.prompt, options.profile, entries);
  const existingPaths = new Set(entries.map((entry) => normalizeWorkspacePath(entry.path)));
  const writtenPathSet = new Set((options.writtenPaths ?? []).map((path) => normalizeWorkspacePath(path)));
  const candidateGroups = [
    prefersTypeScript
      ? ['vite.config.ts', 'vite.config.tsx', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']
      : ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts', 'vite.config.tsx'],
    prefersTypeScript
      ? ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js']
      : ['src/main.jsx', 'src/main.js', 'src/main.tsx', 'src/main.ts'],
    prefersTypeScript
      ? ['src/App.tsx', 'src/app.tsx', 'src/App.ts', 'src/app.ts', 'src/App.jsx', 'src/app.jsx', 'src/App.js', 'src/app.js']
      : ['src/App.jsx', 'src/app.jsx', 'src/App.js', 'src/app.js', 'src/App.tsx', 'src/app.tsx', 'src/App.ts', 'src/app.ts'],
  ];

  return candidateGroups.flatMap((group) => {
    const presentPaths = group.filter((candidate) => existingPaths.has(candidate));
    if (presentPaths.length < 2) return [];

    const preferredPath = group.find((candidate) => writtenPathSet.has(candidate) && existingPaths.has(candidate))
      ?? group.find((candidate) => existingPaths.has(candidate));
    if (!preferredPath) return [];

    const redundantPaths = presentPaths.filter((candidate) => candidate !== preferredPath);
    return redundantPaths.length > 0 ? [{ preferredPath, redundantPaths }] : [];
  });
}

function auditWorkspaceConflictingWebEntryVariants(options: {
  prompt: string;
  profile: WorkspaceRuntimeProfile | null;
  entries: Array<{ path: string; content: string }> | undefined;
  writtenPaths?: string[];
}): string[] {
  return collectWorkspaceConflictingWebEntryVariants(options).flatMap((conflict) => (
    conflict.redundantPaths.map((redundantPath) => (
      `${redundantPath}: redundant web entry/config variant conflicts with ${conflict.preferredPath}; keep a single canonical file instead of mixed JS/TS scaffold variants.`
    ))
  ));
}

function sortWorkspaceTreeNodes(nodes: WorkspaceFileNode[]) {
  nodes.sort((left, right) => {
    if (left.kind === right.kind) {
      return left.path.localeCompare(right.path, undefined, { sensitivity: 'base' });
    }

    return left.kind === 'directory' ? -1 : 1;
  });
}

function cloneWorkspaceTree(nodes: WorkspaceFileNode[] | undefined): WorkspaceFileNode[] {
  return (nodes ?? []).map((node) => (
    node.kind === 'directory'
      ? { ...node, children: cloneWorkspaceTree(node.children) }
      : { ...node }
  ));
}

function fileExtensionFromWorkspacePath(path: string): string | undefined {
  const name = normalizeWorkspacePath(path).split('/').pop() ?? '';
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : undefined;
}

function countWorkspaceTreeFiles(nodes: WorkspaceFileNode[] | undefined): number {
  return (nodes ?? []).reduce((count, node) => {
    if (node.kind === 'file') {
      return count + 1;
    }

    return count + countWorkspaceTreeFiles(node.children);
  }, 0);
}

function countWorkspaceTreeDirectories(nodes: WorkspaceFileNode[] | undefined): number {
  return (nodes ?? []).reduce((count, node) => {
    if (node.kind !== 'directory') {
      return count;
    }

    return count + 1 + countWorkspaceTreeDirectories(node.children);
  }, 0);
}

function upsertWorkspaceTreeFile(nodes: WorkspaceFileNode[] | undefined, relativePath: string): WorkspaceFileNode[] {
  const normalizedPath = normalizeWorkspacePath(relativePath);
  const segments = normalizedPath.split('/').filter(Boolean);
  if (!segments.length) {
    return cloneWorkspaceTree(nodes);
  }

  const nextTree = cloneWorkspaceTree(nodes);
  let cursor = nextTree;
  let currentPath = '';

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    let directory = cursor.find((node) => node.kind === 'directory' && node.name === segment);
    if (!directory) {
      directory = {
        name: segment,
        path: currentPath,
        kind: 'directory',
        children: [],
      };
      cursor.push(directory);
    } else if (!directory.children) {
      directory.children = [];
    }
    sortWorkspaceTreeNodes(cursor);
    cursor = directory.children!;
  }

  const fileName = segments[segments.length - 1]!;
  const existingFile = cursor.find((node) => node.kind === 'file' && node.name === fileName);
  if (!existingFile) {
    cursor.push({
      name: fileName,
      path: normalizedPath,
      kind: 'file',
      extension: fileExtensionFromWorkspacePath(normalizedPath),
    });
    sortWorkspaceTreeNodes(cursor);
  }

  return nextTree;
}

function buildWorkspaceSnapshotWithDocument(
  workspace: Pick<ProjectFolder, 'rootPath' | 'fileTree' | 'fileEntries'>,
  document: WorkspaceFileDocument,
): WorkspaceSnapshot {
  const normalizedPath = normalizeWorkspacePath(document.path);
  const nextEntries = [...(workspace.fileEntries ?? [])];
  const nextEntry: FileEntry = {
    path: normalizedPath,
    content: document.content,
    lang: document.lang,
    updatedAt: Date.now(),
  };
  const existingIndex = nextEntries.findIndex((entry) => normalizeWorkspacePath(entry.path) === normalizedPath);
  if (existingIndex === -1) {
    nextEntries.push(nextEntry);
  } else {
    nextEntries[existingIndex] = nextEntry;
  }
  nextEntries.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));

  const nextTree = upsertWorkspaceTreeFile(workspace.fileTree, normalizedPath);

  return {
    rootPath: workspace.rootPath ?? '',
    fileTree: nextTree,
    fileEntries: nextEntries,
    fileCount: countWorkspaceTreeFiles(nextTree),
    directoryCount: countWorkspaceTreeDirectories(nextTree),
    syncedAt: Date.now(),
  };
}

function isWorkspaceMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /does not exist|not exist|no such file/i.test(message);
}

function truncateWorkspaceOutput(value: string, maxLength = 2400): string {
  const compact = value.trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}\n...`;
}

const RELATIVE_MODULE_IMPORT_RE = /(?:import\s+[^'"]*from\s*|export\s+[^'"]*from\s*|import\s*\(\s*|require\s*\()\s*['"]([^'"]+)['"]/g;
const HTML_MODULE_ENTRY_RE = /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/gi;
const WORKSPACE_IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.sass', '.less'];

function collapseWorkspacePath(path: string): string {
  const segments = normalizeWorkspacePath(path).split('/');
  const output: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return output.join('/');
}

function resolveWorkspaceRelativePath(fromPath: string, specifier: string): string {
  const normalizedSpecifier = normalizeWorkspacePath(specifier);
  if (normalizedSpecifier.startsWith('/')) {
    return collapseWorkspacePath(normalizedSpecifier);
  }

  const fromDir = normalizeWorkspacePath(fromPath).split('/').slice(0, -1).join('/');
  return collapseWorkspacePath(fromDir ? `${fromDir}/${normalizedSpecifier}` : normalizedSpecifier);
}

function resolveWorkspaceModulePath(
  fromPath: string,
  specifier: string,
  existingPaths: Set<string>,
): string | null {
  const resolvedBase = resolveWorkspaceRelativePath(fromPath, specifier);
  const hasExplicitExtension = /\.[a-z0-9]+$/i.test(resolvedBase.split('/').pop() ?? '');
  const candidates = hasExplicitExtension
    ? [resolvedBase]
    : [
        resolvedBase,
        ...WORKSPACE_IMPORT_EXTENSIONS.map((extension) => `${resolvedBase}${extension}`),
        ...WORKSPACE_IMPORT_EXTENSIONS.map((extension) => `${resolvedBase}/index${extension}`),
      ];

  return candidates.find((candidate) => existingPaths.has(candidate)) ?? null;
}

function auditWorkspaceRelativeImports(
  entries: Array<{ path: string; content: string }> | undefined,
): string[] {
  if (!entries?.length) return [];

  const findings: string[] = [];
  const existingPaths = new Set(entries.map((entry) => normalizeWorkspacePath(entry.path)));

  for (const entry of entries) {
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(entry.path)) continue;

    for (const match of entry.content.matchAll(RELATIVE_MODULE_IMPORT_RE)) {
      const specifier = match[1]?.trim() ?? '';
      if (!specifier.startsWith('.')) continue;
      if (resolveWorkspaceModulePath(entry.path, specifier, existingPaths)) continue;
      findings.push(`${entry.path}: unresolved relative import "${specifier}".`);
    }
  }

  return findings;
}

function auditHtmlModuleEntrypoints(
  entries: Array<{ path: string; content: string }> | undefined,
): string[] {
  if (!entries?.length) return [];

  const findings: string[] = [];
  const existingPaths = new Set(entries.map((entry) => normalizeWorkspacePath(entry.path)));

  for (const entry of entries) {
    if (!/\.html?$/i.test(entry.path)) continue;

    for (const match of entry.content.matchAll(HTML_MODULE_ENTRY_RE)) {
      const specifier = match[1]?.trim() ?? '';
      if (!specifier) continue;
      const normalizedSpecifier = collapseWorkspacePath(specifier.startsWith('/') ? specifier.slice(1) : specifier);
      if (resolveWorkspaceModulePath(entry.path, normalizedSpecifier, existingPaths) || existingPaths.has(normalizedSpecifier)) {
        continue;
      }
      findings.push(`${entry.path}: module entry "${specifier}" does not resolve to a real file in the workspace.`);
    }
  }

  return findings;
}

function isWebsitePrompt(prompt: string): boolean {
  return /\b(website|web app|landing page|homepage|home page|marketing site|portfolio|frontend|ui|react|vite|next|navbar|hero|pricing|contact|calendar)\b/i.test(prompt);
}

function auditWorkspaceFileTypes(
  entries: Array<{ path: string; content: string }> | undefined,
  writtenPaths: string[] | undefined,
): string[] {
  if (!entries?.length || !writtenPaths?.length) return [];

  const normalizedWrittenPaths = new Set(writtenPaths.map((path) => normalizeWorkspacePath(path)));
  const findings: string[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeWorkspacePath(entry.path);
    if (!normalizedWrittenPaths.has(normalizedPath)) continue;
    if (workspaceFilePathHasDefinedType(normalizedPath)) continue;
    if (isConventionalExtensionlessWorkspaceFile(normalizedPath)) continue;
    findings.push(`${normalizedPath}: generated file path is missing a defined file type or extension.`);
  }

  return findings;
}

function buildWorkspaceAuditResults(options: {
  prompt: string;
  profile: WorkspaceRuntimeProfile | null;
  entries: Array<{ path: string; content: string }> | undefined;
  writtenPaths?: string[];
}): WorkspaceCommandResult[] {
  const entries = options.entries ?? [];
  const byPath = new Map(entries.map((entry) => [normalizeWorkspacePath(entry.path).toLowerCase(), entry]));
  const findings = [
    ...auditHtmlModuleEntrypoints(entries),
    ...auditWorkspaceRelativeImports(entries),
    ...auditWorkspaceFileTypes(entries, options.writtenPaths),
    ...auditWorkspaceConflictingWebEntryVariants(options),
  ];
  const websiteLike = shouldRunWorkspaceWebPreview(options.profile, entries) || isWebsitePrompt(options.prompt);

  const packageEntry = byPath.get('package.json');
  let packageScripts: Record<string, string> = {};
  let packageJsonParsed = false;
  if (packageEntry) {
    try {
      const manifest = JSON.parse(packageEntry.content) as { scripts?: Record<string, string> };
      packageScripts = manifest.scripts ?? {};
      packageJsonParsed = true;
    } catch {
      findings.push('package.json exists but could not be parsed as valid JSON.');
    }
  }

  if (websiteLike) {
    const hasMainEntry = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js']
      .some((path) => byPath.has(path));
    const hasTypeScriptSignals =
      /\btypescript\b/i.test(options.prompt)
      || entries.some((entry) => /\.tsx?$/i.test(entry.path));
    const hasRunnableWebScript = ['dev', 'build', 'preview', 'start']
      .some((scriptName) => hasRunnablePackageScript(packageScripts[scriptName]));

    if (!packageEntry) {
      findings.push('Missing package.json; this web workspace cannot install or start dependencies yet.');
    }
    if (!byPath.has('index.html')) {
      findings.push('Missing index.html; a Vite-style web app needs an HTML entry document.');
    }
    if (!hasMainEntry) {
      findings.push('Missing a main entry module such as src/main.tsx, src/main.jsx, src/main.ts, or src/main.js.');
    }
    if (hasTypeScriptSignals && !byPath.has('tsconfig.json')) {
      findings.push('Missing tsconfig.json for a TypeScript web workspace.');
    }
    if (packageEntry && packageJsonParsed && !hasRunnableWebScript) {
      findings.push('package.json is missing runnable dev/build/preview/start scripts for the web workspace.');
    }
    if (options.profile && options.profile.commands.length === 0) {
      findings.push('No runnable workspace commands were detected automatically for this web workspace.');
    }
  }

  if (!findings.length) {
    if (!websiteLike) return [];
    return [
      createWorkspaceCommandResult(
        'workspace audit',
        0,
        'Static workspace audit passed. Required web entry files, scripts, and relative file references resolved successfully.',
      ),
    ];
  }

  return [
    createWorkspaceCommandResult(
      'workspace audit',
      1,
      findings.map((finding) => `- ${finding}`).join('\n'),
    ),
  ];
}

function buildSetupGuideContent(options: {
  workspaceLabel: string;
  latestRequest: string;
  profile: WorkspaceRuntimeProfile | null;
  dependencyRefreshes: WorkspaceCommandResult[];
  validations: WorkspaceCommandResult[];
  changedFiles: string[];
}): string {
  const commandLines = options.profile?.commands.length
    ? options.profile.commands.map((command) => `- ${command.label}: \`${command.command}\``)
    : ['- No runnable command was detected automatically in this workspace yet.'];
  const changedFileLines = options.changedFiles.length
    ? options.changedFiles.map((path) => `- \`${path}\``)
    : ['- No file changes were written during the latest request.'];
  const dependencyLines = options.dependencyRefreshes.length > 0
    ? options.dependencyRefreshes.flatMap((refresh) => [
        `### \`${refresh.command}\``,
        `- Exit code: ${refresh.exitCode}`,
        `- Duration: ${Math.max(0, Math.round(refresh.durationMs / 100) / 10)}s`,
        `- Result: ${refresh.timedOut ? 'timed out before completion' : refresh.exitCode === 0 ? 'passed' : 'failed'}`,
        ...(refresh.combinedOutput.trim()
          ? ['```text', truncateWorkspaceOutput(refresh.combinedOutput), '```']
          : ['- Output: command completed without captured output.']),
      ])
    : ['- Automatic dependency installation did not run before validation for the latest request.'];
  const validationLines = options.validations.length > 0
    ? options.validations.flatMap((validation) => [
        `### \`${validation.command}\``,
        `- Exit code: ${validation.exitCode}`,
        `- Duration: ${Math.max(0, Math.round(validation.durationMs / 100) / 10)}s`,
        `- Result: ${validation.timedOut ? 'timed out before completion' : validation.exitCode === 0 ? 'passed' : 'failed'}`,
        ...(validation.combinedOutput.trim()
          ? ['```text', truncateWorkspaceOutput(validation.combinedOutput), '```']
          : ['- Output: command completed without captured output.']),
      ])
    : ['- No validation command has run successfully for this workspace yet.'];

  return [
    '# Setup Guide',
    '',
    '## Workspace',
    `- Name: ${options.workspaceLabel}`,
    `- Updated: ${new Date().toLocaleString()}`,
    '',
    '## Latest Request',
    options.latestRequest.trim() || 'No request summary available.',
    '',
    '## How To Run',
    ...commandLines,
    '',
    '## Dependency Install',
    ...dependencyLines,
    '',
    '## Latest Changed Files',
    ...changedFileLines,
    '',
    '## Validation',
    ...validationLines,
    '',
  ].join('\n');
}

function deriveUploadedFolderLabel(files: File[], fallback?: string): string {
  const preferred = fallback?.trim();
  if (preferred) return preferred;

  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const rootSegment = relativePath.split('/').find(Boolean)?.trim();
    if (rootSegment) return rootSegment;
  }

  return 'Workspace';
}

function parseChatLog(md: string, filename: string): ChatRecord | null {
  try {
    const lines = md.split('\n');
    const title = lines[0]?.replace(/^#\s*Chat Log\s*[\u2014\u2013-]\s*/, '').trim() || filename.replace(/\.md$/, '');

    const modelLine = lines.find(l => l.startsWith('**Model:**'));
    const presetLine = lines.find(l => l.startsWith('**Preset:**'));
    const projectLine = lines.find(l => l.startsWith('**Project:**'));
    const model = modelLine ? modelLine.replace(/\*\*Model:\*\*\s*/, '').trim() : '';
    const preset = presetLine ? presetLine.replace(/\*\*Preset:\*\*\s*/, '').trim() : DEFAULT_PRESET_ID;
    const projectLabel = projectLine ? projectLine.replace(/\*\*Project:\*\*\s*/, '').trim() : '';
    const projectId = projectLabel ? normaliseProjectId(projectLabel) : undefined;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const sections = md.split(/\n---\n/);
    for (const section of sections) {
      const s = section.trim();
      if (s.startsWith('### You')) {
        const content = s.replace(/^###\s+You\s*\n/, '').trim();
        if (content) messages.push({ role: 'user', content });
      } else if (s.startsWith('### Assistant')) {
        const content = stripExportedChatMetadata(s.replace(/^###\s+Assistant\s*\n/, '').trim());
        if (content) messages.push({ role: 'assistant', content });
      }
    }
    if (!messages.length) return null;

    return {
      id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      model: normalizeModelHandle(model),
      preset,
      projectId,
      projectLabel: projectLabel || undefined,
      messages,
      updatedAt: Date.now(),
      fileEntries: [],
    };
  } catch {
    return null;
  }
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

interface ChatLaunchTransitionState {
  chatId: string;
  prompt: string;
  startedAt: number;
}

interface WorkspaceFileDraft extends WorkspaceEditorDocumentView {
  workspaceId: string;
  rootPath?: string;
  browserHandleId?: string;
}

interface WorkspaceTerminalSession {
  open: boolean;
  commandDraft: string;
  running: boolean;
  entries: WorkspaceTerminalEntryView[];
}

function buildWorkspaceFileKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}::${relativePath}`;
}

export default function App() {
  const desktopRuntime = isDesktopRuntime();
  const localSearchAvailable = isLocalSearchEngineAvailable();
  const [ollamaEndpoint, setOllamaEndpoint] = useState(DEFAULT_OLLAMA_BASE);
  const [openAIApiKey, setOpenAIApiKey] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsMap>(() => createDefaultProviderSettingsMap());
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState | null>(null);
  const { models: catalogModels, providers, status } = useOllama({
    endpoint: ollamaEndpoint,
    openAIApiKey,
    anthropicApiKey,
  });
  const { chats, ready, save, remove, clearAll, refresh } = useDB();
  const { replyPreferences } = useReplyPreferences();
  const { toast } = useToast();
  const [panels, setPanels] = useState<Panel[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
  const [queuedLaunchPrompts, setQueuedLaunchPrompts] = useState<Record<string, string>>({});
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultChatPreset, setDefaultChatPreset] = useState(DEFAULT_PRESET_ID);
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ChatReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [developerToolsEnabled, setDeveloperToolsEnabled] = useState(false);
  const [advancedUseEnabled, setAdvancedUseEnabled] = useState(false);
  const [codeEditorAutoSaveEnabled, setCodeEditorAutoSaveEnabled] = useState(true);
  const [codeEditorIndentGuidesEnabled, setCodeEditorIndentGuidesEnabled] = useState(true);
  const [codeEditorSetupGuideEnabled, setCodeEditorSetupGuideEnabled] = useState(false);
  const [codeEditorDependencyInstallEnabled, setCodeEditorDependencyInstallEnabled] = useState(false);
  const [deepResearchSearchTestResult, setDeepResearchSearchTestResult] = useState<DeepResearchSearchEngineTestResult | null>(null);
  const [deepResearchSearchTestRunning, setDeepResearchSearchTestRunning] = useState(false);
  const [localSearchStatus, setLocalSearchStatus] = useState<LocalSearchEngineStatus | null>(null);
  const [localSearchSeeds, setLocalSearchSeeds] = useState<LocalSearchSeed[]>([]);
  const [localSearchBusy, setLocalSearchBusy] = useState(false);
  const [localSearchCrawlRunning, setLocalSearchCrawlRunning] = useState(false);
  const [localSearchLastCrawl, setLocalSearchLastCrawl] = useState<LocalSearchCrawlSummary | null>(null);
  const [localSearchSeedUrlDraft, setLocalSearchSeedUrlDraft] = useState('');
  const [localSearchSeedLabelDraft, setLocalSearchSeedLabelDraft] = useState('');
  const [localSearchMaxPagesDraft, setLocalSearchMaxPagesDraft] = useState('');
  const [localSearchMaxDepthDraft, setLocalSearchMaxDepthDraft] = useState('');
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageSnapshot>({
    supported: true,
  });
  const [hoveredStorageBucketId, setHoveredStorageBucketId] = useState<string | null>(null);
  const storagePopupHideTimeoutRef = useRef<number | null>(null);
  const importLogsSettingsRef = useRef<HTMLInputElement>(null);
  const importWorkspaceLauncherRef = useRef<HTMLInputElement>(null);
  const [selectedCodeWorkspaceId, setSelectedCodeWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceFileKey, setActiveWorkspaceFileKey] = useState<string | null>(null);
  const [workspaceFileDrafts, setWorkspaceFileDrafts] = useState<Record<string, WorkspaceFileDraft>>({});
  const [workspaceTerminalSessions, setWorkspaceTerminalSessions] = useState<Record<string, WorkspaceTerminalSession>>({});
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [chatStarterVisible, setChatStarterVisible] = useState(false);
  const [chatStarterPanelId, setChatStarterPanelId] = useState<string | null>(null);
  const [chatLaunchTransition, setChatLaunchTransition] = useState<ChatLaunchTransitionState | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('workspace');
  const [settingsReady, setSettingsReady] = useState(false);
  const workspaceMergeInFlightRef = useRef(false);
  const autoHydratedWorkspaceSourcesRef = useRef(new Set<string>());
  const workspaceFileDraftsRef = useRef<Record<string, WorkspaceFileDraft>>({});
  const workspaceFileAutoSaveTimersRef = useRef<Record<string, number>>({});
  const chatsRef = useRef<ChatRecord[]>([]);
  const projectFoldersRef = useRef<ProjectFolder[]>([]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    projectFoldersRef.current = projectFolders;
  }, [projectFolders]);

  const commitProjectFoldersUpdate = useCallback((updater: (prev: ProjectFolder[]) => ProjectFolder[]) => {
    const next = updater(projectFoldersRef.current);
    projectFoldersRef.current = next;
    setProjectFolders(next);
    return next;
  }, []);

  const findProjectFolderById = useCallback((projectId?: string | null) => {
    if (!projectId) return null;

    const folders = projectFoldersRef.current;
    const exact = folders.find((folder) => folder.id === projectId) ?? null;
    if (exact && workspaceHasLinkedSource(exact)) return exact;

    const codeChats = chatsRef.current.filter((chat) => resolveThreadSurface(chat) === 'code');
    const canonicalWorkspace = findWorkspaceGroup(buildWorkspaceGroups(codeChats, folders), projectId);
    if (canonicalWorkspace) {
      const canonicalFolder = folders.find((folder) => folder.id === canonicalWorkspace.id) ?? null;
      if (canonicalFolder && workspaceHasLinkedSource(canonicalFolder)) {
        return canonicalFolder;
      }
    }

    const normalizedProjectId = projectId.trim().toLowerCase();
    const labelMatches = folders.filter((folder) => normaliseProjectId(folder.label) === normalizedProjectId);
    if (labelMatches.length > 0) {
      return labelMatches.find((folder) => workspaceHasLinkedSource(folder)) ?? labelMatches[0] ?? null;
    }

    if (exact) return exact;
    if (!canonicalWorkspace) return null;

    return folders.find((folder) => folder.id === canonicalWorkspace.id) ?? null;
  }, []);

  const resolveWorkspaceReference = useCallback((
    workspace?: Partial<Pick<ProjectFolder, 'id' | 'label' | 'createdAt' | 'rootPath' | 'browserHandleId' | 'fileEntries'>> | null,
  ): ProjectFolder | null => {
    if (!workspace) return null;
    if (workspaceHasLinkedSource(workspace)) {
      return {
        id: workspace.id ?? workspace.rootPath ?? workspace.browserHandleId ?? normaliseProjectId(workspace.label ?? 'workspace'),
        label: workspace.label ?? 'Workspace',
        createdAt: workspace.createdAt ?? Date.now(),
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
        fileEntries: workspace.fileEntries,
      };
    }

    const resolvedById = workspace.id ? findProjectFolderById(workspace.id) : null;
    if (resolvedById && workspaceHasLinkedSource(resolvedById)) {
      return resolvedById;
    }

    const labelKey = normalizeWorkspaceLookupLabel(workspace.label);
    if (labelKey) {
      const resolvedByLabel = findProjectFolderById(normaliseProjectId(workspace.label!))
        ?? projectFoldersRef.current.find((folder) =>
          workspaceHasLinkedSource(folder) &&
          normalizeWorkspaceLookupLabel(folder.label) === labelKey,
        )
        ?? null;
      if (resolvedByLabel && workspaceHasLinkedSource(resolvedByLabel)) {
        return resolvedByLabel;
      }
    }

    return resolvedById ?? null;
  }, [findProjectFolderById]);

  const findWorkspaceForPanel = useCallback((panel: Pick<Panel, 'projectId' | 'projectLabel'>) => {
    const directWorkspace = panel.projectId ? findProjectFolderById(panel.projectId) : null;
    if (directWorkspace && workspaceHasLinkedSource(directWorkspace)) {
      return directWorkspace;
    }

    const labeledWorkspace = resolveWorkspaceReference({
      id: panel.projectId ?? undefined,
      label: panel.projectLabel ?? undefined,
    });
    if (labeledWorkspace && workspaceHasLinkedSource(labeledWorkspace)) {
      return labeledWorkspace;
    }

    const selectedWorkspace = selectedCodeWorkspaceId ? findProjectFolderById(selectedCodeWorkspaceId) : null;
    if (
      selectedWorkspace &&
      workspaceHasLinkedSource(selectedWorkspace) &&
      (
        !panel.projectLabel ||
        normalizeWorkspaceLookupLabel(selectedWorkspace.label) === normalizeWorkspaceLookupLabel(panel.projectLabel) ||
        panel.projectId === selectedWorkspace.id
      )
    ) {
      return selectedWorkspace;
    }

    return directWorkspace ?? labeledWorkspace ?? null;
  }, [findProjectFolderById, resolveWorkspaceReference, selectedCodeWorkspaceId]);

  const refreshLocalSearchPanel = useCallback(async () => {
    if (!isLocalSearchEngineAvailable()) {
      setLocalSearchStatus(null);
      setLocalSearchSeeds([]);
      setLocalSearchLastCrawl(null);
      setLocalSearchMaxPagesDraft('');
      setLocalSearchMaxDepthDraft('');
      return;
    }

    const [statusSnapshot, seedsSnapshot] = await Promise.all([
      getSearchEngineStatus(),
      listSearchEngineSeeds(),
    ]);
    setLocalSearchStatus(statusSnapshot);
    setLocalSearchSeeds(seedsSnapshot);
    setLocalSearchLastCrawl(statusSnapshot?.lastCrawl ?? null);
    if (statusSnapshot) {
      setLocalSearchMaxPagesDraft((current) => current || String(statusSnapshot.defaultMaxPages));
      setLocalSearchMaxDepthDraft((current) => current || String(statusSnapshot.defaultMaxDepth));
    }
  }, []);

  useEffect(() => {
    void refreshLocalSearchPanel();
  }, [refreshLocalSearchPanel]);

  const buildPersistedChatRecord = useCallback((
    chat: Omit<ChatRecord, 'updatedAt'> & { updatedAt?: number },
  ): ChatRecord => {
    const linkedWorkspace = findProjectFolderById(chat.projectId);
    const canonicalProjectId = linkedWorkspace?.id ?? chat.projectId;
    const canonicalProjectLabel = linkedWorkspace?.label ?? chat.projectLabel;

    return {
      ...chat,
      projectId: canonicalProjectId,
      projectLabel: canonicalProjectLabel,
      reasoningEffort: chat.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      updatedAt: chat.updatedAt ?? Date.now(),
      fileEntries: linkedWorkspace && workspaceHasLinkedSource(linkedWorkspace)
        ? undefined
        : cloneFileEntries(chat.fileEntries),
      latestWorkspaceBackup: chat.latestWorkspaceBackup ?? null,
      interruptedTask: chat.interruptedTask ?? null,
    };
  }, [findProjectFolderById]);

  const persistWorkspaceChat = useCallback(async (
    chat: Omit<ChatRecord, 'updatedAt'> & { updatedAt?: number },
  ) => {
    await save(buildPersistedChatRecord(chat));
  }, [buildPersistedChatRecord, save]);

  const persistWorkspaceChatDirect = useCallback(async (
    chat: Omit<ChatRecord, 'updatedAt'> & { updatedAt?: number },
  ) => {
    await persistChatRecord(buildPersistedChatRecord(chat));
  }, [buildPersistedChatRecord]);

  const inProgressChatPersistSignaturesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const activePersistIds = new Set<string>();

    for (const panel of panels) {
      const interruptedTask = panel.interruptedTask
        ? {
            ...panel.interruptedTask,
            lastPhaseLabel: panel.streamingPhase?.label ?? panel.interruptedTask.lastPhaseLabel,
          }
        : null;
      const shouldPersistCheckpoint = Boolean(panel.projectId) && (panel.streaming || Boolean(interruptedTask));
      if (!shouldPersistCheckpoint) continue;

      activePersistIds.add(panel.id);
      const assistantMessageCount = panel.messages.filter((message) => message.role === 'assistant').length;
      const lastMessage = panel.messages[panel.messages.length - 1] ?? null;
      const signature = JSON.stringify({
        title: panel.title,
        model: panel.model,
        preset: panel.preset,
        reasoningEffort: panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        threadType: panel.threadType ?? null,
        projectId: panel.projectId ?? null,
        projectLabel: panel.projectLabel ?? null,
        messageCount: panel.messages.length,
        assistantMessageCount,
        lastMessageRole: lastMessage?.role ?? null,
        lastMessageContent: lastMessage?.content ?? null,
        streaming: panel.streaming,
        streamingPhaseLabel: panel.streamingPhase?.label ?? null,
        latestWorkspaceBackupId: panel.latestWorkspaceBackup?.id ?? null,
        interruptedTask,
      });

      if (inProgressChatPersistSignaturesRef.current[panel.id] === signature) {
        continue;
      }

      inProgressChatPersistSignaturesRef.current[panel.id] = signature;
      void persistWorkspaceChatDirect({
        id: panel.id,
        title: panel.title,
        model: panel.model,
        preset: panel.preset,
        reasoningEffort: panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        threadType: panel.threadType,
        projectId: panel.projectId,
        projectLabel: panel.projectLabel,
        messages: panel.messages,
        updatedAt: Date.now(),
        fileEntries: entriesFromRegistry(panel.fileRegistry),
        latestWorkspaceBackup: panel.latestWorkspaceBackup ?? null,
        interruptedTask,
      });
    }

    for (const panelId of Object.keys(inProgressChatPersistSignaturesRef.current)) {
      if (activePersistIds.has(panelId)) continue;
      delete inProgressChatPersistSignaturesRef.current[panelId];
    }
  }, [panels, persistWorkspaceChatDirect]);

  const providerModelCatalog = useMemo<Record<ModelProvider, string[]>>(() => {
    const grouped: Record<ModelProvider, string[]> = {
      openai: [],
      anthropic: [],
      ollama: [],
    };

    for (const model of catalogModels) {
      grouped[getModelProvider(model)].push(model);
    }

    return grouped;
  }, [catalogModels]);

  const providerModelOptions = useMemo<Record<ModelProvider, string[]>>(() => ({
    openai: providerModelCatalog.openai.length ? providerModelCatalog.openai : PROVIDER_STARTER_MODELS.openai,
    anthropic: providerModelCatalog.anthropic.length ? providerModelCatalog.anthropic : PROVIDER_STARTER_MODELS.anthropic,
    ollama: providerModelCatalog.ollama.length ? providerModelCatalog.ollama : PROVIDER_STARTER_MODELS.ollama,
  }), [providerModelCatalog]);

  const models = useMemo(() => catalogModels.filter((model) => {
    const provider = getModelProvider(model);
    const selectedModels = providerSettings[provider].selectedModels;
    if (!selectedModels.length) return true;
    return selectedModels.includes(model);
  }), [catalogModels, providerSettings]);

  const resolvedDefaultModel = resolveModelHandle(defaultModel, models);

  const navigate = useCallback((path: string, replace = false) => {
    const nextRoute = parseAppRoute(path);
    if (window.location.pathname !== path) {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    }
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    workspaceFileDraftsRef.current = workspaceFileDrafts;
  }, [workspaceFileDrafts]);

  const clearWorkspaceFileAutoSaveTimer = useCallback((fileKey: string) => {
    const timeoutId = workspaceFileAutoSaveTimersRef.current[fileKey];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete workspaceFileAutoSaveTimersRef.current[fileKey];
    }
  }, []);

  const clearAllWorkspaceFileAutoSaveTimers = useCallback(() => {
    for (const timeoutId of Object.values(workspaceFileAutoSaveTimersRef.current)) {
      window.clearTimeout(timeoutId);
    }
    workspaceFileAutoSaveTimersRef.current = {};
  }, []);

  useEffect(() => () => {
    clearAllWorkspaceFileAutoSaveTimers();
  }, [clearAllWorkspaceFileAutoSaveTimers]);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseAppRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (window.location.pathname === '/' && route.kind === 'chat-start') {
      navigate('/chat', true);
      return;
    }

    if (window.location.pathname === '/debug' && route.kind === 'code-start') {
      navigate('/code', true);
    }
  }, [navigate, route.kind]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const snapshot = await loadStorageSnapshot();
      if (cancelled) return;

      setProjectFolders(snapshot.workspaces);
      setDefaultModel(snapshot.settings.defaultModel);
      if (CHAT_DEFAULT_PRESETS.some((preset) => preset.id === snapshot.settings.defaultChatPreset)) {
        setDefaultChatPreset(snapshot.settings.defaultChatPreset);
      }
      if (isChatReasoningEffort(snapshot.settings.defaultReasoningEffort)) {
        setDefaultReasoningEffort(snapshot.settings.defaultReasoningEffort);
      }
      setDeveloperToolsEnabled(snapshot.settings.developerToolsEnabled);
      setAdvancedUseEnabled(snapshot.settings.advancedUseEnabled);
      setCodeEditorAutoSaveEnabled(snapshot.settings.codeEditorAutoSaveEnabled);
      setCodeEditorIndentGuidesEnabled(snapshot.settings.codeEditorIndentGuidesEnabled);
      setCodeEditorSetupGuideEnabled(snapshot.settings.codeEditorSetupGuideEnabled);
      setCodeEditorDependencyInstallEnabled(snapshot.settings.codeEditorDependencyInstallEnabled);
      setOllamaEndpoint(snapshot.settings.ollamaEndpoint);
      setOpenAIApiKey(snapshot.settings.openAIApiKey);
      setAnthropicApiKey(snapshot.settings.anthropicApiKey);
      setProviderSettings(snapshot.settings.providerSettings);
      setSettingsReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    void saveWorkspaces(projectFolders);
  }, [projectFolders, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !ready) return;
    if (workspaceMergeInFlightRef.current) return;

    const normalizeLabel = (value: string) => value.trim().toLowerCase();
    const merges = projectFolders.flatMap((linkedFolder) => {
      if (!workspaceHasLinkedSource(linkedFolder)) return [];

      const legacyFolder = projectFolders.find((candidate) =>
        candidate.id !== linkedFolder.id &&
        !workspaceHasLinkedSource(candidate) &&
        normalizeLabel(candidate.label) === normalizeLabel(linkedFolder.label),
      );
      if (!legacyFolder) return [];

      const legacyChatCount = chats.filter((chat) => chat.projectId === legacyFolder.id).length;
      const linkedChatCount = chats.filter((chat) => chat.projectId === linkedFolder.id).length;
      const legacyLooksCanonical =
        legacyFolder.id === normaliseProjectId(legacyFolder.label) || legacyChatCount > linkedChatCount;

      return [{
        canonicalFolder: legacyLooksCanonical ? legacyFolder : linkedFolder,
        linkedFolder,
        legacyFolder,
      }];
    });

    if (!merges.length) return;

    workspaceMergeInFlightRef.current = true;
    void (async () => {
      try {
        const remap = new Map<string, string>();
        const mergedFolders = [...projectFolders];

        for (const { canonicalFolder, linkedFolder, legacyFolder } of merges) {
          const otherFolder = canonicalFolder.id === linkedFolder.id ? legacyFolder : linkedFolder;
          const sourceFolder = workspaceHasLinkedSource(linkedFolder)
            ? linkedFolder
            : workspaceHasLinkedSource(canonicalFolder)
              ? canonicalFolder
              : linkedFolder;
          const fallbackEntries = sourceFolder.fileEntries?.length ? sourceFolder.fileEntries : canonicalFolder.fileEntries;

          remap.set(otherFolder.id, canonicalFolder.id);

          const mergedFolder: ProjectFolder = {
            id: canonicalFolder.id,
            label: canonicalFolder.label || sourceFolder.label,
            createdAt: Math.min(canonicalFolder.createdAt, sourceFolder.createdAt),
            rootPath: sourceFolder.rootPath,
            browserHandleId: sourceFolder.browserHandleId,
            fileTree: sourceFolder.fileTree,
            fileEntries: fallbackEntries,
            fileCount: sourceFolder.fileCount ?? fallbackEntries?.length ?? canonicalFolder.fileCount,
            directoryCount: sourceFolder.directoryCount ?? canonicalFolder.directoryCount,
            syncedAt: sourceFolder.syncedAt ?? canonicalFolder.syncedAt,
            archivedAt: canonicalFolder.archivedAt ?? sourceFolder.archivedAt,
          };

          const canonicalIndex = mergedFolders.findIndex((folder) => folder.id === canonicalFolder.id);
          if (canonicalIndex !== -1) {
            mergedFolders[canonicalIndex] = mergedFolder;
          }

          const otherIndex = mergedFolders.findIndex((folder) => folder.id === otherFolder.id);
          if (otherIndex !== -1) {
            mergedFolders.splice(otherIndex, 1);
          }
        }

        setProjectFolders(mergedFolders);
        setPanels((prev) => prev.map((panel) => {
          const nextProjectId = panel.projectId ? remap.get(panel.projectId) ?? panel.projectId : panel.projectId;
          if (nextProjectId === panel.projectId) return panel;
          return { ...panel, projectId: nextProjectId };
        }));
        setSelectedCodeWorkspaceId((current) => current ? remap.get(current) ?? current : current);

        const chatsToPersist = chats
          .filter((chat) => chat.projectId && remap.has(chat.projectId))
          .map((chat) => ({
            ...chat,
            projectId: remap.get(chat.projectId!) ?? chat.projectId,
          }));

        if (chatsToPersist.length) {
          await Promise.all(chatsToPersist.map((chat) => persistWorkspaceChatDirect(chat)));
          await refresh();
        }
      } finally {
        workspaceMergeInFlightRef.current = false;
      }
    })();
  }, [chats, persistWorkspaceChatDirect, projectFolders, ready, refresh, settingsReady]);

  useEffect(() => {
    if (!settingsReady) return;

    const nextSettings: AppSettings = {
      defaultModel,
      defaultChatPreset,
      defaultReasoningEffort,
      developerToolsEnabled,
      advancedUseEnabled,
      codeEditorAutoSaveEnabled,
      codeEditorIndentGuidesEnabled,
      codeEditorSetupGuideEnabled,
      codeEditorDependencyInstallEnabled,
      ollamaEndpoint,
      openAIApiKey,
      anthropicApiKey,
      providerSettings,
    };

    void saveAppSettings(nextSettings);
  }, [
    advancedUseEnabled,
    anthropicApiKey,
    codeEditorAutoSaveEnabled,
    codeEditorIndentGuidesEnabled,
    codeEditorSetupGuideEnabled,
    codeEditorDependencyInstallEnabled,
    defaultChatPreset,
    defaultModel,
    defaultReasoningEffort,
    developerToolsEnabled,
    ollamaEndpoint,
    openAIApiKey,
    providerSettings,
    settingsReady,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadBrowserStorageEstimate() {
      if (desktopRuntime || typeof navigator === 'undefined' || !navigator.storage?.estimate) {
        if (!cancelled) setBrowserStorage({ supported: false });
        return;
      }

      try {
        const estimate = await navigator.storage.estimate();
        if (!cancelled) {
          setBrowserStorage({
            supported: true,
            usage: estimate.usage,
            quota: estimate.quota,
          });
        }
      } catch {
        if (!cancelled) setBrowserStorage({ supported: false });
      }
    }

    void loadBrowserStorageEstimate();
    return () => {
      cancelled = true;
    };
  }, [
    advancedUseEnabled,
    anthropicApiKey,
    chats,
    desktopRuntime,
    defaultChatPreset,
    defaultModel,
    defaultReasoningEffort,
    developerToolsEnabled,
    ollamaEndpoint,
    openAIApiKey,
    projectFolders,
    replyPreferences.length,
  ]);

  useEffect(() => () => {
    if (storagePopupHideTimeoutRef.current != null) {
      window.clearTimeout(storagePopupHideTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!confirmDialog || confirmBusy) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmDialog(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmBusy, confirmDialog]);

  const requestConfirmation = useCallback((dialog: ConfirmDialogState) => {
    setConfirmDialog(dialog);
  }, []);

  const closeConfirmDialog = useCallback(() => {
    if (confirmBusy) return;
    setConfirmDialog(null);
  }, [confirmBusy]);

  const cancelStoragePopupHide = useCallback(() => {
    if (storagePopupHideTimeoutRef.current != null) {
      window.clearTimeout(storagePopupHideTimeoutRef.current);
      storagePopupHideTimeoutRef.current = null;
    }
  }, []);

  const scheduleStoragePopupHide = useCallback(() => {
    cancelStoragePopupHide();
    storagePopupHideTimeoutRef.current = window.setTimeout(() => {
      setHoveredStorageBucketId(null);
      storagePopupHideTimeoutRef.current = null;
    }, 110);
  }, [cancelStoragePopupHide]);

  const handleConfirmAction = useCallback(async () => {
    if (!confirmDialog) return;
    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmDialog]);

  const createPanel = useCallback((chatData?: Partial<ChatRecord>) => {
    const nextPanel = newPanel(resolvedDefaultModel, chatData);
    setPanels((prev) => {
      const existing = prev.find((panel) => panel.id === nextPanel.id);
      if (existing) {
        setActivePanelId(existing.id);
        return prev;
      }

      setActivePanelId(nextPanel.id);
      return [...prev, nextPanel];
    });
    return nextPanel;
  }, [resolvedDefaultModel]);

  const consumeLaunchPrompt = useCallback((panelId: string) => {
    setQueuedLaunchPrompts((prev) => {
      if (!(panelId in prev)) return prev;
      const next = { ...prev };
      delete next[panelId];
      return next;
    });
  }, []);

  const openDraftChat = useCallback((options: {
    model?: string;
    preset?: string;
    reasoningEffort?: ChatReasoningEffort;
    threadType?: ThreadType;
    projectId?: string;
    projectLabel?: string;
    fileEntries?: ChatRecord['fileEntries'];
    initialPrompt?: string;
    title?: string;
    navigateOnCreate?: boolean;
  }) => {
    const fileEntries = cloneFileEntries(options.fileEntries);
    const panel = createPanel({
      title: options.title ?? 'New chat',
      model: options.model || resolvedDefaultModel,
      preset: options.preset ?? defaultChatPreset,
      reasoningEffort: options.reasoningEffort ?? defaultReasoningEffort,
      threadType: options.threadType,
      projectId: options.projectId,
      projectLabel: options.projectLabel,
      messages: [],
      fileEntries,
      updatedAt: Date.now(),
    });

    void persistWorkspaceChat({
      id: panel.id,
      title: panel.title,
      model: panel.model,
      preset: panel.preset,
      reasoningEffort: panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      threadType: panel.threadType,
      projectId: panel.projectId,
      projectLabel: panel.projectLabel,
      messages: [],
      updatedAt: Date.now(),
      fileEntries,
    });

    const initialPrompt = options.initialPrompt?.trim();
    if (initialPrompt) {
      setQueuedLaunchPrompts((prev) => ({
        ...prev,
        [panel.id]: initialPrompt,
      }));
    }

    if (options.navigateOnCreate ?? true) {
      navigate(buildChatPath(panel.id));
    }
    return panel.id;
  }, [createPanel, defaultChatPreset, defaultReasoningEffort, navigate, persistWorkspaceChat, resolvedDefaultModel]);

  const upsertProjectFolder = useCallback((folder: {
    id: string;
    label: string;
    createdAt?: number;
    rootPath?: string;
    browserHandleId?: string;
    fileTree?: ProjectFolder['fileTree'];
    fileCount?: number;
    directoryCount?: number;
    syncedAt?: number;
    archivedAt?: number;
    fileEntries?: ProjectFolder['fileEntries'];
  }) => {
    const canonicalFolder = findProjectFolderById(folder.id);
    const targetId = canonicalFolder?.id ?? folder.id;
    const targetLabel = canonicalFolder?.label ?? folder.label;

    commitProjectFoldersUpdate((prev) => {
      const nextEntries = folder.fileEntries ? cloneFileEntries(folder.fileEntries) : undefined;
      const existing = prev.find((candidate) => candidate.id === targetId);
      if (!existing) {
        return [
          ...prev,
          {
            id: targetId,
            label: targetLabel,
            createdAt: folder.createdAt ?? Date.now(),
            rootPath: folder.rootPath,
            browserHandleId: folder.browserHandleId,
            fileTree: folder.fileTree,
            fileCount: folder.fileCount,
            directoryCount: folder.directoryCount,
            syncedAt: folder.syncedAt,
            archivedAt: folder.archivedAt,
            fileEntries: nextEntries,
          },
        ];
      }

      return prev.map((candidate) => {
        if (candidate.id !== targetId) return candidate;
        return {
          ...candidate,
          label: targetLabel,
          rootPath: folder.rootPath ?? candidate.rootPath,
          browserHandleId: folder.browserHandleId ?? candidate.browserHandleId,
          fileTree: folder.fileTree ?? candidate.fileTree,
          fileCount: folder.fileCount ?? candidate.fileCount,
          directoryCount: folder.directoryCount ?? candidate.directoryCount,
          syncedAt: folder.syncedAt ?? candidate.syncedAt,
          archivedAt: folder.archivedAt ?? candidate.archivedAt,
          fileEntries: nextEntries ?? candidate.fileEntries,
        };
      });
    });
  }, [commitProjectFoldersUpdate, findProjectFolderById]);

  const applyWorkspaceSnapshotToState = useCallback((
    workspace: Pick<ProjectFolder, 'id' | 'label' | 'createdAt' | 'rootPath' | 'browserHandleId'>,
    snapshot: WorkspaceSnapshot,
    options: { unarchive?: boolean } = {},
  ) => {
    const nextFolder = applyWorkspaceSnapshot({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath ?? snapshot.rootPath,
      browserHandleId: workspace.browserHandleId,
      archivedAt: options.unarchive ? 0 : undefined,
    }, snapshot);

    upsertProjectFolder(nextFolder);
    setPanels((prev) => prev.map((panel) => (
      panel.projectId !== workspace.id
        ? panel
        : {
            ...panel,
            projectLabel: workspace.label,
            fileRegistry: registryFromEntries(snapshot.fileEntries),
          }
    )));
  }, [upsertProjectFolder]);

  const syncWorkspaceFolder = useCallback(async (
    workspace: Pick<ProjectFolder, 'id' | 'label' | 'createdAt' | 'rootPath' | 'browserHandleId'>,
    options: { silent?: boolean } = {},
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (!resolvedWorkspace || !workspaceHasLinkedSource(resolvedWorkspace)) {
      if (!options.silent) {
        toast('This workspace is not linked to a local folder yet.');
      }
      return null;
    }

    try {
      const snapshot = resolvedWorkspace.rootPath
        ? await scanWorkspace(resolvedWorkspace.rootPath)
        : await scanBrowserWorkspace(resolvedWorkspace.browserHandleId!);
      applyWorkspaceSnapshotToState({
        id: resolvedWorkspace.id ?? workspace.id,
        label: resolvedWorkspace.label ?? workspace.label,
        createdAt: resolvedWorkspace.createdAt ?? workspace.createdAt,
        rootPath: resolvedWorkspace.rootPath,
        browserHandleId: resolvedWorkspace.browserHandleId,
      }, snapshot, { unarchive: true });
      if (!options.silent) {
        toast(`Refreshed "${resolvedWorkspace.label ?? workspace.label}".`);
      }
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh that workspace.';
      if (!options.silent) {
        toast(message);
      }
      return null;
    }
  }, [applyWorkspaceSnapshotToState, resolveWorkspaceReference, toast]);

  const loadWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return readWorkspaceFile(resolvedWorkspace.rootPath, relativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return readBrowserWorkspaceFile(resolvedWorkspace.browserHandleId, relativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const persistWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
    content: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return writeWorkspaceFile(resolvedWorkspace.rootPath, relativePath, content);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return writeBrowserWorkspaceFile(resolvedWorkspace.browserHandleId, relativePath, content);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const writeWorkspaceFileDocumentDirect = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
    content: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return writeWorkspaceFileDocument(resolvedWorkspace.rootPath, relativePath, content);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return writeBrowserWorkspaceFileDocument(resolvedWorkspace.browserHandleId, relativePath, content);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const createWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
    content = '',
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return createWorkspaceFile(resolvedWorkspace.rootPath, relativePath, content);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return createBrowserWorkspaceFile(resolvedWorkspace.browserHandleId, relativePath, content);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const createWorkspaceDirectoryDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return createWorkspaceDirectory(resolvedWorkspace.rootPath, relativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return createBrowserWorkspaceDirectory(resolvedWorkspace.browserHandleId, relativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const renameWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
    nextRelativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return renameWorkspaceEntry(resolvedWorkspace.rootPath, relativePath, nextRelativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return renameBrowserWorkspaceEntry(resolvedWorkspace.browserHandleId, relativePath, nextRelativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const copyWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
    nextRelativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return copyWorkspaceEntry(resolvedWorkspace.rootPath, relativePath, nextRelativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return copyBrowserWorkspaceEntry(resolvedWorkspace.browserHandleId, relativePath, nextRelativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const deleteWorkspaceFileDocument = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return deleteWorkspaceEntry(resolvedWorkspace.rootPath, relativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return deleteBrowserWorkspaceEntry(resolvedWorkspace.browserHandleId, relativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const openWorkspaceFileOutsideApp = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
    relativePath: string,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return openWorkspaceEntry(resolvedWorkspace.rootPath, relativePath);
    }

    if (resolvedWorkspace?.browserHandleId) {
      return openBrowserWorkspaceFileExternal(resolvedWorkspace.browserHandleId, relativePath);
    }

    throw new Error('This workspace is not linked to a local folder yet.');
  }, [resolveWorkspaceReference]);

  const inspectWorkspaceRuntimeProfile = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId' | 'fileEntries'>,
  ) => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return inspectWorkspaceRuntime(resolvedWorkspace.rootPath);
    }

    return deriveWorkspaceRuntimeProfileFromEntries(workspace.fileEntries);
  }, [resolveWorkspaceReference]);

  const createWorkspaceRunBackup = useCallback(async (
    workspace: Pick<WorkspaceGroup, 'id' | 'label' | 'rootPath' | 'browserHandleId'>,
  ): Promise<WorkspaceBackupReference | null> => {
    const resolvedWorkspace = resolveWorkspaceReference(workspace);
    if (resolvedWorkspace?.rootPath) {
      return createWorkspaceBackup(
        resolvedWorkspace.rootPath,
        resolvedWorkspace.id ?? workspace.id,
        resolvedWorkspace.label ?? workspace.label,
      );
    }

    if (resolvedWorkspace?.browserHandleId) {
      return createBrowserWorkspaceBackup(
        resolvedWorkspace.browserHandleId,
        resolvedWorkspace.label ?? workspace.label,
      );
    }

    return null;
  }, [resolveWorkspaceReference]);

  const syncWorkspaceDraftsFromSnapshot = useCallback((
    workspaceId: string,
    snapshot: WorkspaceSnapshot,
    writtenPaths: string[],
  ) => {
    const normalizedPaths = new Set(writtenPaths.map((path) => normalizeWorkspacePath(path)));
    if (!normalizedPaths.size) return;

    const entriesByPath = new Map(
      (snapshot.fileEntries ?? []).map((entry) => [normalizeWorkspacePath(entry.path), entry]),
    );

    setWorkspaceFileDrafts((prev) => {
      let changed = false;
      const nextDrafts = { ...prev };

      for (const relativePath of normalizedPaths) {
        const draftKey = buildWorkspaceFileKey(workspaceId, relativePath);
        const currentDraft = nextDrafts[draftKey];
        const nextEntry = entriesByPath.get(relativePath);
        if (!currentDraft || !nextEntry) continue;
        if (currentDraft.content !== currentDraft.savedContent) continue;

        nextDrafts[draftKey] = {
          ...currentDraft,
          content: nextEntry.content,
          savedContent: nextEntry.content,
          lang: nextEntry.lang || currentDraft.lang,
          sizeBytes: measureStringBytes(nextEntry.content),
          modifiedAt: Date.now(),
          loading: false,
          saving: false,
          error: null,
        };
        changed = true;
      }

      return changed ? nextDrafts : prev;
    });
  }, []);

  const restoreWorkspaceRunBackup = useCallback(async (
    workspaceId: string,
    backup: WorkspaceBackupReference,
  ) => {
    const workspace = findProjectFolderById(workspaceId);
    if (!workspace) {
      toast('That workspace is no longer available.');
      return;
    }

    try {
      const snapshot = workspace.rootPath && backup.archivePath
        ? await restoreWorkspaceBackup(workspace.rootPath, backup.archivePath)
        : workspace.browserHandleId && backup.browserBackupId
          ? await restoreBrowserWorkspaceBackup(workspace.browserHandleId, backup.browserBackupId)
          : null;

      if (!snapshot) {
        toast('That workspace backup is not available for restore.');
        return;
      }

      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });
      syncWorkspaceDraftsFromSnapshot(workspace.id, snapshot, snapshot.fileEntries.map((entry) => entry.path));
      toast(`Restored "${workspace.label}" from the latest backup.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to restore that workspace backup.');
    }
  }, [applyWorkspaceSnapshotToState, findProjectFolderById, syncWorkspaceDraftsFromSnapshot, toast]);

  const applyWorkspaceStepChange = useCallback(async (
    panel: Pick<Panel, 'projectId' | 'projectLabel'>,
    step: { path: string; content: string },
  ): Promise<{
    writtenPaths: string[];
    fileEntries: FileEntry[];
  }> => {
    const workspace = findWorkspaceForPanel(panel);
    if (!workspace) {
      return {
        writtenPaths: [],
        fileEntries: [],
      };
    }

    const normalizedPath = normalizeWorkspacePath(step.path);
    // AI-authored workspace steps should behave like an IDE save:
    // write the file directly, then merge the updated document into local state
    // without rescanning the entire workspace after every single generated file.
    const nextDocument = await writeWorkspaceFileDocumentDirect(workspace, normalizedPath, step.content);
    const nextSnapshot = buildWorkspaceSnapshotWithDocument(workspace, nextDocument);

    applyWorkspaceSnapshotToState({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, nextSnapshot, { unarchive: true });
    syncWorkspaceDraftsFromSnapshot(workspace.id, nextSnapshot, [normalizedPath]);

    return {
      writtenPaths: [normalizedPath],
      fileEntries: nextSnapshot.fileEntries,
    };
  }, [
    applyWorkspaceSnapshotToState,
    findWorkspaceForPanel,
    syncWorkspaceDraftsFromSnapshot,
    writeWorkspaceFileDocumentDirect,
  ]);

  const applyWorkspaceChatChanges = useCallback(async (
    panel: Pick<Panel, 'projectId' | 'projectLabel'>,
    prompt: string,
    options: { writtenPaths?: string[] },
    onProgress?: (step: { id: string; label: string; detail?: string }) => void,
  ): Promise<{
    writtenPaths: string[];
    fileEntries: FileEntry[];
    profile: WorkspaceRuntimeProfile | null;
    dependencyRefreshes: WorkspaceCommandResult[];
    validations: WorkspaceCommandResult[];
    setupGuidePath: string | null;
  }> => {
    const workspace = findWorkspaceForPanel(panel);
    if (!workspace) {
      return {
        writtenPaths: [],
        fileEntries: [],
        profile: null,
        dependencyRefreshes: [],
        validations: [],
        setupGuidePath: null,
      };
    }
    const writtenPaths = [...new Set((options.writtenPaths ?? []).map((path) => normalizeWorkspacePath(path)))];
    let currentFileEntries = workspace.fileEntries ?? [];
    const applySnapshot = (snapshot: WorkspaceSnapshot, syncedPaths: string[]) => {
      currentFileEntries = snapshot.fileEntries;
      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });
      syncWorkspaceDraftsFromSnapshot(workspace.id, snapshot, syncedPaths);
    };
    const refreshWorkspaceSnapshot = async (syncedPaths: string[]) => {
      if (!workspace.rootPath) return null;
      const snapshot = await scanWorkspace(workspace.rootPath);
      applySnapshot(snapshot, syncedPaths);
      return snapshot;
    };

    onProgress?.({
      id: 'inspect-runtime',
      label: 'Reviewing package and config files',
      detail: 'Inspect workspace manifests and config files to detect how this project builds, tests, and runs.',
    });
    let profile = writtenPaths.length
      ? await inspectWorkspaceRuntimeProfile({
          id: workspace.id,
          rootPath: workspace.rootPath,
          browserHandleId: workspace.browserHandleId,
          fileEntries: currentFileEntries,
          label: workspace.label,
        })
      : await inspectWorkspaceRuntimeProfile(workspace);
    let dependencyRefreshes: WorkspaceCommandResult[] = [];
    let validations: WorkspaceCommandResult[] = [];

    const conflictingWebEntryVariants = collectWorkspaceConflictingWebEntryVariants({
      prompt,
      profile,
      entries: currentFileEntries,
      writtenPaths,
    });

    if (conflictingWebEntryVariants.length > 0) {
      onProgress?.({
        id: 'normalize-web-entry-files',
        label: 'Normalizing React/Vite entry files',
        detail: 'Remove stale JS or TS entry/config variants so the workspace keeps one canonical app, main, and Vite config path before validation begins.',
      });

      for (const conflict of conflictingWebEntryVariants) {
        for (const redundantPath of conflict.redundantPaths) {
          try {
            const snapshot = await deleteWorkspaceFileDocument(workspace, redundantPath);
            applySnapshot(snapshot, [...writtenPaths, redundantPath]);
          } catch (error) {
            if (isWorkspaceMissingPathError(error)) {
              continue;
            }
          }
        }
      }

      profile = await inspectWorkspaceRuntimeProfile({
        id: workspace.id,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
        fileEntries: currentFileEntries,
        label: workspace.label,
      });
    }

    const dependencyRefreshPlan = workspace.rootPath
      && writtenPaths.length > 0
      ? pickWorkspaceDependencyRefreshPlan(profile, currentFileEntries, {
          freshInstall: codeEditorDependencyInstallEnabled,
        })
      : null;

    if (workspace.rootPath && dependencyRefreshPlan) {
      onProgress?.({
        id: 'refresh-dependencies',
        label: dependencyRefreshPlan.label,
        detail: codeEditorDependencyInstallEnabled
          ? 'Remove local dependency folders, then reinstall packages fresh before validation begins.'
          : 'Install or sync declared dependencies before build, test, and preview validation begins.',
      });

      for (const cleanupPath of dependencyRefreshPlan.cleanupPaths) {
        const normalizedCleanupPath = normalizeWorkspacePath(cleanupPath);
        try {
          const snapshot = await deleteWorkspaceEntry(workspace.rootPath, normalizedCleanupPath);
          applySnapshot(snapshot, [...writtenPaths, normalizedCleanupPath]);
        } catch (error) {
          if (isWorkspaceMissingPathError(error)) {
            continue;
          }
          dependencyRefreshes.push(createWorkspaceCommandResult(
            `remove ${normalizedCleanupPath}`,
            1,
            error instanceof Error ? error.message : `Unable to remove ${normalizedCleanupPath} before reinstalling dependencies.`,
          ));
        }
      }

      for (const installCommand of dependencyRefreshPlan.commands) {
        onProgress?.({
          id: `install:${installCommand}`,
          label: `Installing dependencies with ${installCommand}`,
          detail: 'Run a fresh dependency install before build, test, and preview validation.',
        });
        dependencyRefreshes.push(await runWorkspaceCommand(
          workspace.rootPath,
          installCommand,
          180_000,
        ));
      }

      await refreshWorkspaceSnapshot(writtenPaths);
      profile = await inspectWorkspaceRuntimeProfile({
        id: workspace.id,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
        fileEntries: currentFileEntries,
        label: workspace.label,
      });
    }
    const dependencyInstallFailed = dependencyRefreshes.some(workspaceCommandFailed);

    const auditResults = buildWorkspaceAuditResults({
      prompt,
      profile,
      entries: currentFileEntries,
      writtenPaths,
    });
    const auditFailed = auditResults.some(workspaceCommandFailed);
    if (auditResults.length > 0) {
      onProgress?.({
        id: 'audit-workspace',
        label: 'Auditing generated files',
        detail: 'Check required entry files, package scripts, relative file references, and generated file extensions before runtime validation.',
      });
    }

    const validationCommands = workspace.rootPath ? pickWorkspaceValidationCommands(profile) : [];
    const runtimeValidations: WorkspaceCommandResult[] = [];
    if (workspace.rootPath && validationCommands.length > 0 && !dependencyInstallFailed && !auditFailed) {
      for (const validationCommand of validationCommands) {
        onProgress?.({
          id: `test:${validationCommand.command}`,
          label: `Testing ${validationCommand.command}`,
          detail: 'Run the detected validation command before delivering the workspace reply.',
        });
        runtimeValidations.push(await runWorkspaceCommand(
          workspace.rootPath,
          validationCommand.command,
          workspaceValidationTimeoutMs(validationCommand),
        ));
      }
    }

    validations = [...auditResults, ...runtimeValidations];

    const previewCommand = workspace.rootPath ? pickWorkspacePreviewCommand(profile) : null;
    const buildFailed = runtimeValidations.some((result, index) =>
      validationCommands[index]?.kind === 'build' && workspaceCommandFailed(result),
    );
    if (
      workspace.rootPath
      && previewCommand
      && !dependencyInstallFailed
      && !auditFailed
      && !buildFailed
      && shouldRunWorkspaceWebPreview(profile, currentFileEntries)
    ) {
      onProgress?.({
        id: 'preview-web-app',
        label: `Previewing ${previewCommand.command}`,
        detail: 'Start the web app in a contained browser probe and verify the rendered page is not blank before delivery.',
      });
      validations.push(await runWorkspaceWebPreview(
        workspace.rootPath,
        previewCommand.command,
        60_000,
      ));
    }

    let setupGuidePath: string | null = null;
    if (codeEditorSetupGuideEnabled) {
      onProgress?.({
        id: 'setup-guide',
        label: 'Updating setup.md',
        detail: 'Refresh workspace setup instructions with the latest request and detected runtime commands.',
      });
      const guidePath = 'setup.md';
      const guideContent = buildSetupGuideContent({
        workspaceLabel: workspace.label,
        latestRequest: prompt,
        profile,
        dependencyRefreshes,
        validations,
        changedFiles: writtenPaths,
      });
      const nextSnapshot = await persistWorkspaceFileDocument(workspace, guidePath, guideContent);
      setupGuidePath = guidePath;
      applySnapshot(nextSnapshot, [guidePath, ...writtenPaths]);
    }

    return {
      writtenPaths,
      fileEntries: currentFileEntries,
      profile,
      dependencyRefreshes,
      validations,
      setupGuidePath,
    };
  }, [
    applyWorkspaceSnapshotToState,
    codeEditorDependencyInstallEnabled,
    codeEditorSetupGuideEnabled,
    deleteWorkspaceEntry,
    deleteWorkspaceFileDocument,
    findWorkspaceForPanel,
    inspectWorkspaceRuntimeProfile,
    persistWorkspaceFileDocument,
    runWorkspaceCommand,
    runWorkspaceWebPreview,
    scanWorkspace,
    syncWorkspaceDraftsFromSnapshot,
  ]);

  const prepareWorkspaceRun = useCallback(async (
    panel: Panel,
    _prompt: string,
  ): Promise<WorkspaceBackupReference | null> => {
    const workspace = findWorkspaceForPanel(panel);
    if (!workspace) return null;
    return createWorkspaceRunBackup(workspace);
  }, [createWorkspaceRunBackup, findWorkspaceForPanel]);

  const readWorkspaceRunContext = useCallback(async (
    panel: Pick<Panel, 'projectId' | 'projectLabel'>,
  ): Promise<{ fileEntries: FileEntry[]; workspaceEntryPaths: string[] } | null> => {
    const workspace = findWorkspaceForPanel(panel);
    if (!workspace) return null;

    if (!workspace.rootPath && !workspace.browserHandleId) {
      const workspaceEntryPaths = collectWorkspaceEntryPaths(workspace.fileTree);
      return {
        fileEntries: workspace.fileEntries ?? [],
        workspaceEntryPaths: workspaceEntryPaths.length > 0
          ? workspaceEntryPaths
          : (workspace.fileEntries ?? []).map((entry) => normalizeWorkspacePath(entry.path)),
      };
    }

    const snapshot = workspace.rootPath
      ? await scanWorkspace(workspace.rootPath)
      : await scanBrowserWorkspace(workspace.browserHandleId!);

    applyWorkspaceSnapshotToState({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, snapshot, { unarchive: true });

    return {
      fileEntries: snapshot.fileEntries,
      workspaceEntryPaths: collectWorkspaceEntryPaths(snapshot.fileTree),
    };
  }, [applyWorkspaceSnapshotToState, findWorkspaceForPanel]);

  const commitWorkspaceRun = useCallback(async (
    panel: Panel,
    prompt: string,
    options: { writtenPaths?: string[] },
    onProgress?: (step: { id: string; label: string; detail?: string }) => void,
  ) => {
    return applyWorkspaceChatChanges(panel, prompt, options, onProgress);
  }, [applyWorkspaceChatChanges]);

  const loadWorkspaceFileIntoDraft = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
    options: { force?: boolean } = {},
  ) => {
    const key = buildWorkspaceFileKey(workspace.id, relativePath);
    const existingDraft = workspaceFileDraftsRef.current[key];
    const hasUnsavedChanges = Boolean(existingDraft && existingDraft.content !== existingDraft.savedContent);
    const cachedEntry = workspace.fileEntries?.find((entry) => entry.path === relativePath);
    const cachedContent = cachedEntry?.content ?? existingDraft?.savedContent ?? '';

    setWorkspaceFileDrafts((prev) => ({
      ...prev,
      [key]: {
        workspaceId: workspace.id,
        workspaceLabel: workspace.label,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
        relativePath,
        content: hasUnsavedChanges ? existingDraft!.content : cachedContent,
        savedContent: hasUnsavedChanges ? existingDraft!.savedContent : cachedContent,
        lang: existingDraft?.lang || cachedEntry?.lang || langFromPath(relativePath),
        sizeBytes: hasUnsavedChanges
          ? existingDraft!.sizeBytes
          : cachedContent
            ? measureStringBytes(cachedContent)
            : 0,
        modifiedAt: existingDraft?.modifiedAt,
        loading: true,
        saving: false,
        error: null,
      },
    }));

    if (
      existingDraft
      && !options.force
      && !existingDraft.error
      && !existingDraft.loading
      && existingDraft.modifiedAt
    ) {
      setWorkspaceFileDrafts((prev) => {
        const current = prev[key];
        if (!current) return prev;
        return {
          ...prev,
          [key]: {
            ...current,
            loading: false,
          },
        };
      });
      return;
    }

    try {
      const document = await loadWorkspaceFileDocument(workspace, relativePath);
      setWorkspaceFileDrafts((prev) => {
        const current = prev[key];
        if (!current) return prev;

        const draftIsDirty = current.content !== current.savedContent;
        return {
          ...prev,
          [key]: {
            ...current,
            lang: document.lang || current.lang,
            modifiedAt: document.modifiedAt,
            sizeBytes: draftIsDirty ? current.sizeBytes : document.sizeBytes,
            savedContent: document.content,
            content: draftIsDirty ? current.content : document.content,
            loading: false,
            error: null,
          },
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open that workspace file.';
      setWorkspaceFileDrafts((prev) => {
        const current = prev[key];
        if (!current) return prev;
        return {
          ...prev,
          [key]: {
            ...current,
            loading: false,
            error: message,
          },
        };
      });
    }
  }, [loadWorkspaceFileDocument]);

  const ensureWorkspaceContext = useCallback((workspaceId?: string | null) => {
    const workspace = findProjectFolderById(workspaceId);
    if (!workspace || !workspaceHasLinkedSource(workspace)) return;

    void syncWorkspaceFolder({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, { silent: true });
  }, [findProjectFolderById, syncWorkspaceFolder]);

  const openWorkspaceLauncher = useCallback(async () => {
    try {
      const normalizeLabel = (value: string) => value.trim().toLowerCase();
      const isStaleManagedWorkspacePlaceholder = (folder: ProjectFolder, label: string) => {
        const normalizedRoot = (folder.rootPath ?? '').replace(/\\/g, '/').toLowerCase();
        if (!normalizedRoot.includes('/larryai/workspaces/')) return false;
        if (normalizeLabel(folder.label) !== normalizeLabel(label)) return false;
        if ((folder.fileCount ?? 0) > 0) return false;
        return !folder.fileTree?.length;
      };

      if (isWorkspaceHostAvailable()) {
        const selection = await pickWorkspaceDirectory();
        if (!selection) return;

        const duplicate = projectFolders.find((folder) => (
          folder.rootPath?.toLowerCase() === selection.rootPath.toLowerCase()
        )) ?? projectFolders.find((folder) => (
          isStaleManagedWorkspacePlaceholder(folder, selection.label)
        )) ?? (
          selectedCodeWorkspaceId
            ? projectFolders.find((folder) => (
              folder.id === selectedCodeWorkspaceId &&
              !workspaceHasLinkedSource(folder) &&
              normalizeLabel(folder.label) === normalizeLabel(selection.label)
            ))
            : undefined
        ) ?? projectFolders.find((folder) => (
          !workspaceHasLinkedSource(folder) &&
          (
            folder.id === normaliseProjectId(selection.label) ||
            normalizeLabel(folder.label) === normalizeLabel(selection.label)
          )
        ));
        const workspaceId = duplicate?.id ?? buildWorkspaceIdFromPath(selection.rootPath, selection.label);
        const workspaceLabel = duplicate?.label ?? selection.label;
        const createdAt = duplicate?.createdAt ?? Date.now();

        applyWorkspaceSnapshotToState({
          id: workspaceId,
          label: workspaceLabel,
          createdAt,
          rootPath: selection.rootPath,
        }, selection.snapshot, { unarchive: true });

        setSelectedCodeWorkspaceId(workspaceId);
        navigate('/code');
        toast(duplicate ? `Refreshed workspace "${workspaceLabel}".` : `Created workspace "${workspaceLabel}".`);
        return;
      }

      if (isBrowserWorkspacePickerAvailable()) {
        const selection = await pickBrowserWorkspaceDirectory(projectFolders);
        if (!selection) return;

        const duplicate = (
          selection.existingWorkspaceId
            ? projectFolders.find((folder) => folder.id === selection.existingWorkspaceId)
            : projectFolders.find((folder) => (
              isStaleManagedWorkspacePlaceholder(folder, selection.label)
            ))
        ) ?? (
          selectedCodeWorkspaceId
            ? projectFolders.find((folder) => (
              folder.id === selectedCodeWorkspaceId &&
              !workspaceHasLinkedSource(folder) &&
              normalizeLabel(folder.label) === normalizeLabel(selection.label)
            ))
            : undefined
        ) ?? projectFolders.find((folder) => (
          !workspaceHasLinkedSource(folder) &&
          (
            folder.id === normaliseProjectId(selection.label) ||
            normalizeLabel(folder.label) === normalizeLabel(selection.label)
          )
        ));
        const workspaceId = duplicate?.id ?? selection.existingWorkspaceId ?? selection.browserHandleId;
        const workspaceLabel = duplicate?.label ?? selection.label;
        const createdAt = duplicate?.createdAt ?? Date.now();

        applyWorkspaceSnapshotToState({
          id: workspaceId,
          label: workspaceLabel,
          createdAt,
          browserHandleId: selection.browserHandleId,
        }, selection.snapshot, { unarchive: true });

        setSelectedCodeWorkspaceId(workspaceId);
        navigate('/code');
        toast(duplicate ? `Refreshed workspace "${workspaceLabel}".` : `Created workspace "${workspaceLabel}".`);
        return;
      }

      importWorkspaceLauncherRef.current?.click();
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to link that workspace.';
      if (/aborted|cancelled|canceled/i.test(rawMessage)) return;
      toast(rawMessage);
    }
  }, [applyWorkspaceSnapshotToState, navigate, projectFolders, selectedCodeWorkspaceId, toast]);

  const handleSelectCodeWorkspace = useCallback((workspace: WorkspaceGroup) => {
    setSelectedCodeWorkspaceId(workspace.id);
    setActiveWorkspaceFileKey((current) => {
      if (!current) return null;
      return workspaceFileDraftsRef.current[current]?.workspaceId === workspace.id ? current : null;
    });
    navigate('/code');
    void syncWorkspaceFolder({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, { silent: true });
  }, [navigate, syncWorkspaceFolder]);

  const handleSelectSidebarWorkspace = useCallback((workspace: WorkspaceGroup) => {
    setSelectedCodeWorkspaceId(workspace.id);
    setActiveWorkspaceFileKey((current) => {
      if (!current) return null;
      return workspaceFileDraftsRef.current[current]?.workspaceId === workspace.id ? current : null;
    });
    void syncWorkspaceFolder({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, { silent: true });
  }, [syncWorkspaceFolder]);

  const handleOpenWorkspaceFile = useCallback((workspace: WorkspaceGroup, relativePath: string) => {
    const fileKey = buildWorkspaceFileKey(workspace.id, relativePath);
    setSelectedCodeWorkspaceId(workspace.id);
    setActiveWorkspaceFileKey(fileKey);
    navigate('/code');
    void loadWorkspaceFileIntoDraft(workspace, relativePath);
  }, [loadWorkspaceFileIntoDraft, navigate]);

  const handleClearSelectedCodeWorkspace = useCallback(() => {
    setSelectedCodeWorkspaceId(null);
    setActiveWorkspaceFileKey(null);
    const currentRecord = route.kind === 'chat'
      ? panels.find((panel) => panel.id === route.chatId) ?? chats.find((chat) => chat.id === route.chatId)
      : null;
    if (route.kind === 'chat' && resolveThreadSurface(currentRecord) === 'code') {
      navigate('/chat');
      return;
    }
    if (route.kind === 'code-start') {
      navigate('/chat');
    }
  }, [chats, navigate, panels, route]);

  const handleClearChatSidebarWorkspace = useCallback(() => {
    setSelectedCodeWorkspaceId(null);
    setActiveWorkspaceFileKey(null);
  }, []);

  const handleRenameWorkspace = useCallback(async (workspace: WorkspaceGroup, nextLabel: string) => {
    const clean = nextLabel.trim();
    if (!clean) {
      toast('Enter a workspace name.');
      return;
    }

    upsertProjectFolder({ id: workspace.id, label: clean });
    setPanels((prev) => prev.map((panel) => (
      panel.projectId === workspace.id
        ? { ...panel, projectLabel: clean }
        : panel
    )));
    setWorkspaceFileDrafts((prev) => Object.fromEntries(
      Object.entries(prev).map(([key, draft]) => [
        key,
        draft.workspaceId === workspace.id
          ? { ...draft, workspaceLabel: clean }
          : draft,
      ]),
    ));

    const relatedChats = chats.filter((chat) => chat.projectId === workspace.id);
    await Promise.all(relatedChats.map((chat) => persistWorkspaceChat({
      ...chat,
      projectLabel: clean,
    })));

    toast(`Renamed workspace to "${clean}".`);
  }, [chats, persistWorkspaceChat, toast, upsertProjectFolder]);

  const requestArchiveWorkspace = useCallback((workspace: WorkspaceGroup) => {
    requestConfirmation({
      title: 'Archive this workspace?',
      message: 'The workspace will disappear from the active code list, but its saved chats will remain in local storage.',
      confirmLabel: 'Archive workspace',
      onConfirm: async () => {
        upsertProjectFolder({
          id: workspace.id,
          label: workspace.label,
          archivedAt: Date.now(),
        });

        setSelectedCodeWorkspaceId((current) => current === workspace.id ? null : current);
        if (route.kind === 'chat') {
          const currentRecord = panels.find((panel) => panel.id === route.chatId) ?? chats.find((chat) => chat.id === route.chatId);
          if (currentRecord && deriveWorkspaceFromChat(currentRecord).id === workspace.id) {
            navigate('/code');
          }
        }

        toast(`Archived "${workspace.label}".`);
      },
    });
  }, [chats, navigate, panels, requestConfirmation, route, toast, upsertProjectFolder]);

  const handleOpenWorkspaceInExplorer = useCallback(async (workspace: WorkspaceGroup) => {
    if (!workspace.rootPath) {
      toast('This workspace is not linked to a local folder yet.');
      return;
    }

    try {
      await openWorkspaceInExplorer(workspace.rootPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open that workspace in the file explorer.';
      toast(message);
    }
  }, [toast]);

  const handleRefreshWorkspace = useCallback((workspace: WorkspaceGroup) => {
    void syncWorkspaceFolder({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    });
  }, [syncWorkspaceFolder]);

  const handleCreateChatInFolder = useCallback((folder: { id: string; label: string }, threadType: ThreadType = 'code') => {
    const resolvedWorkspace = resolveWorkspaceReference({
      id: folder.id,
      label: folder.label,
    });
    const workspaceId = resolvedWorkspace?.id ?? folder.id;
    const workspaceLabel = resolvedWorkspace?.label ?? folder.label;
    const workspaceEntries = cloneFileEntries(resolvedWorkspace?.fileEntries);
    setActiveWorkspaceFileKey(null);
    upsertProjectFolder({ id: workspaceId, label: workspaceLabel });
    openDraftChat({
      title: `${workspaceLabel} ${threadType === 'debug' ? 'Debug' : 'Chat'}`,
      preset: 'code',
      threadType,
      projectId: workspaceId,
      projectLabel: workspaceLabel,
      fileEntries: workspaceEntries,
    });
    ensureWorkspaceContext(workspaceId);
  }, [ensureWorkspaceContext, openDraftChat, resolveWorkspaceReference, upsertProjectFolder]);

  const closePanel = useCallback((id: string) => {
    const closingRecord = panels.find((panel) => panel.id === id) ?? chats.find((chat) => chat.id === id);
    const closingSurface = resolveThreadSurface(closingRecord);
    const fallbackPath = buildStartPath(closingSurface);
    const closingIndex = panels.findIndex((panel) => panel.id === id);
    const remainingPanels = panels.filter((panel) => panel.id !== id);
    const nextSameSurfaceAfter = panels
      .slice(closingIndex + 1)
      .find((panel) => panel.id !== id && resolveThreadSurface(panel) === closingSurface) ?? null;
    const nextSameSurfaceBefore = [...panels.slice(0, Math.max(closingIndex, 0))]
      .reverse()
      .find((panel) => panel.id !== id && resolveThreadSurface(panel) === closingSurface) ?? null;
    const replacementPanel = nextSameSurfaceAfter
      ?? nextSameSurfaceBefore
      ?? remainingPanels[0]
      ?? null;

    setPanels(prev => prev.filter(p => p.id !== id));

    if (activePanelId === id) {
      setActivePanelId(replacementPanel?.id ?? null);
    }

    setQueuedLaunchPrompts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (route.kind === 'chat' && route.chatId === id) {
      if (replacementPanel && resolveThreadSurface(replacementPanel) === closingSurface) {
        navigate(buildChatPath(replacementPanel.id));
      } else {
        navigate(fallbackPath);
      }
    }
  }, [activePanelId, chats, navigate, panels, route]);

  const activatePanel = useCallback((id: string) => {
    setActivePanelId(id);
    if (route.kind === 'chat-start' || (route.kind === 'chat' && route.chatId !== id)) {
      navigate(buildChatPath(id));
    }
  }, [navigate, route]);

  const updatePanel = useCallback((id: string, patch: Partial<Panel>) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  const savePanel = useCallback((panel: Panel) => {
    const fileEntries = entriesFromRegistry(panel.fileRegistry);
    const linkedWorkspace = findProjectFolderById(panel.projectId);

    if (panel.projectId && panel.projectLabel) {
      upsertProjectFolder({
        id: panel.projectId,
        label: panel.projectLabel,
        fileEntries: linkedWorkspace && workspaceHasLinkedSource(linkedWorkspace) ? undefined : fileEntries,
      });
    }
    void persistWorkspaceChat({
      id: panel.id,
      title: panel.title,
      model: panel.model,
      preset: panel.preset,
      reasoningEffort: panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      threadType: panel.threadType,
      projectId: panel.projectId,
      projectLabel: panel.projectLabel,
      messages: panel.messages,
      updatedAt: Date.now(),
      fileEntries,
      latestWorkspaceBackup: panel.latestWorkspaceBackup ?? null,
      interruptedTask: panel.interruptedTask ?? null,
    });
  }, [findProjectFolderById, persistWorkspaceChat, upsertProjectFolder]);

  function handleOpenFromHistory(chat: ChatRecord) {
    setActiveWorkspaceFileKey(null);
    const existing = panels.find((panel) => panel.id === chat.id);
    if (!existing) {
      const workspaceEntries = chat.projectId
        ? findProjectFolderById(chat.projectId)?.fileEntries
        : undefined;
      createPanel({
        ...chat,
        fileEntries: workspaceEntries?.length ? cloneFileEntries(workspaceEntries) : chat.fileEntries,
      });
    } else {
      setActivePanelId(existing.id);
    }

    ensureWorkspaceContext(chat.projectId);
    navigate(buildChatPath(chat.id));
  }

  function handleImportChat(chat: ChatRecord) {
    if (chat.projectId && chat.projectLabel) {
      upsertProjectFolder({
        id: chat.projectId,
        label: chat.projectLabel,
        fileEntries: chat.fileEntries ?? [],
      });
    }
    void persistWorkspaceChat({
      id: chat.id,
      title: chat.title,
      model: chat.model,
      preset: chat.preset,
      reasoningEffort: chat.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      projectId: chat.projectId,
      projectLabel: chat.projectLabel,
      messages: chat.messages,
      updatedAt: chat.updatedAt,
      fileEntries: chat.fileEntries ?? [],
    });
    handleOpenFromHistory(chat);
    toast(`Imported "${chat.title}"`);
  }

  async function handleImportLogs(files: File[]) {
    let imported = 0;
    for (const file of files) {
      const text = await file.text();
      const parsed = parseChatLog(text, file.name);
      if (!parsed) continue;
      handleImportChat(parsed);
      imported++;
    }
    if (!imported) {
      toast('No valid chat logs found in selected files.');
    }
  }

  async function handleImportDirectory(
    files: File[],
    targetFolder?: { id: string; label: string },
    labelOverride?: string,
  ) {
    try {
      if (!targetFolder && isWorkspaceHostAvailable()) {
        const requestedLabel = deriveUploadedFolderLabel(files, labelOverride);
        const selection = await createManagedWorkspaceDirectory(requestedLabel);
        const normalizeLabel = (value: string) => value.trim().toLowerCase();
        const duplicate = projectFolders.find((folder) => (
          folder.rootPath?.toLowerCase() === selection.rootPath.toLowerCase()
        )) ?? projectFolders.find((folder) => (
          !workspaceHasLinkedSource(folder) &&
          (
            folder.id === normaliseProjectId(requestedLabel) ||
            normalizeLabel(folder.label) === normalizeLabel(requestedLabel)
          )
        ));
        const workspaceId = duplicate?.id ?? buildWorkspaceIdFromPath(selection.rootPath, requestedLabel);
        const workspaceLabel = duplicate?.label ?? requestedLabel;
        const createdAt = duplicate?.createdAt ?? Date.now();

        applyWorkspaceSnapshotToState({
          id: workspaceId,
          label: workspaceLabel,
          createdAt,
          rootPath: selection.rootPath,
        }, selection.snapshot, { unarchive: true });

        setSelectedCodeWorkspaceId(workspaceId);
        navigate('/code');
        toast(duplicate ? `Refreshed workspace "${workspaceLabel}".` : `Created workspace "${workspaceLabel}".`);
        return;
      }

      let added = 0;
      const targetWorkspace = targetFolder
        ? findProjectFolderById(targetFolder.id)
        : undefined;
      let reg: FileRegistry = registryFromEntries(targetWorkspace?.fileEntries);
      let importedRoot = targetFolder?.label || targetWorkspace?.label || '';

      for (const file of files) {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
        const parts = rel.split('/');
        if (!importedRoot && parts[0]) importedRoot = parts[0];
        const cleanPath = parts.length > 1 ? parts.slice(1).join('/') : rel;
        if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz|lock)$/i.test(cleanPath)) continue;
        if (/node_modules|\.git|\.next|dist\/|build\//.test(cleanPath)) continue;
        const fileText = await file.text();
        if (fileText.includes('\0')) continue;
        reg = updateRegistry(reg, [{ path: cleanPath, content: fileText, lang: langFromPath(cleanPath) }], 0);
        added++;
      }

      const projectLabel = targetFolder?.label || labelOverride?.trim() || importedRoot || 'Project';
      const projectId = targetFolder?.id || normaliseProjectId(projectLabel);
      const workspaceEntries = entriesFromRegistry(reg);

      upsertProjectFolder({
        id: projectId,
        label: projectLabel,
        fileEntries: added ? workspaceEntries : undefined,
      });

      if (!targetFolder) {
        setSelectedCodeWorkspaceId(projectId);
        navigate('/code');
      }

      if (!added) {
        toast(`Added workspace "${projectLabel}", but no importable source files were indexed.`);
        return;
      }

      setPanels((prev) =>
        prev.map((panel) =>
          panel.projectId !== projectId
            ? panel
            : {
                ...panel,
                projectId,
                projectLabel,
                fileRegistry: registryFromEntries(workspaceEntries),
              },
        ),
      );

      if (targetFolder) {
        toast(`Updated workspace "${projectLabel}" with ${added} file${added !== 1 ? 's' : ''}.`);
      } else {
        toast(`Created workspace "${projectLabel}" with ${added} file${added !== 1 ? 's' : ''}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to import that folder.';
      toast(message);
    }
  }

  const requestDeleteChat = useCallback((id: string) => {
    const chat = chats.find((candidate) => candidate.id === id);
    requestConfirmation({
      title: 'Delete this chat?',
      message: `"${chat?.title || 'Untitled'}" will be permanently removed. This action cannot be undone.`,
      confirmLabel: 'Delete chat',
      onConfirm: async () => {
        await remove(id);
        closePanel(id);
        toast('Chat deleted.');
      },
    });
  }, [chats, closePanel, remove, requestConfirmation, toast]);

  const requestArchiveChat = useCallback((id: string) => {
    const panel = panels.find((candidate) => candidate.id === id) ?? null;
    const chat = chats.find((candidate) => candidate.id === id) ?? null;
    const source = panel ?? chat;
    if (!source) return;

    requestConfirmation({
      title: 'Archive this chat?',
      message: 'The chat will disappear from the active sidebar, but remain saved in local storage.',
      confirmLabel: 'Archive chat',
      onConfirm: async () => {
        const timestamp = Date.now();
        const archivedRecord = buildPersistedChatRecord({
          id: source.id,
          title: source.title,
          model: source.model,
          preset: source.preset,
          reasoningEffort: source.reasoningEffort,
          threadType: source.threadType,
          projectId: source.projectId,
          projectLabel: source.projectLabel,
          messages: source.messages,
          updatedAt: timestamp,
          archivedAt: timestamp,
          fileEntries: panel ? entriesFromRegistry(panel.fileRegistry) : cloneFileEntries(chat?.fileEntries),
        });

        await save(archivedRecord);

        if (panel) {
          closePanel(id);
        } else if (route.kind === 'chat' && route.chatId === id) {
          navigate(buildStartPath(resolveThreadSurface(chat)));
        }

        toast(`Archived "${source.title || 'Untitled'}".`);
      },
    });
  }, [buildPersistedChatRecord, chats, closePanel, navigate, panels, requestConfirmation, route, save, toast]);

  const requestDeleteWorkspace = useCallback((workspace: { id: string; label: string }) => {
    const relatedChats = chats.filter((chat) => deriveWorkspaceFromChat(chat).id === workspace.id);
    const relatedIds = new Set(relatedChats.map((chat) => chat.id));
    const hasFolder = projectFolders.some((folder) => folder.id === workspace.id);
    const descriptor = relatedChats.length
      ? `This removes the workspace and ${relatedChats.length} chat${relatedChats.length !== 1 ? 's' : ''}.`
      : hasFolder
        ? 'This removes the empty workspace.'
        : 'This removes this workspace group.';

    requestConfirmation({
      title: 'Delete this workspace?',
      message: `${descriptor} This action cannot be undone.`,
      confirmLabel: 'Delete workspace',
      onConfirm: async () => {
        const currentRouteRecord = route.kind === 'chat'
          ? panels.find((panel) => panel.id === route.chatId) ?? chats.find((chat) => chat.id === route.chatId)
          : null;
        const fallbackPath = buildStartPath(resolveThreadSurface(currentRouteRecord));

        if (relatedChats.length) {
          await Promise.all(relatedChats.map((chat) => remove(chat.id)));
        }

        setSelectedCodeWorkspaceId((current) => current === workspace.id ? null : current);
        setProjectFolders((prev) => prev.filter((folder) => folder.id !== workspace.id));
        setPanels((prev) => {
          const next = prev.filter((panel) => !relatedIds.has(panel.id) && panel.projectId !== workspace.id);
          setActivePanelId((current) =>
            current && next.some((panel) => panel.id === current) ? current : next[0]?.id ?? null,
          );
          return next;
        });

        setQueuedLaunchPrompts((prev) => {
          const next = { ...prev };
          for (const chatId of relatedIds) {
            delete next[chatId];
          }
          return next;
        });

        if (
          route.kind === 'chat' &&
          (relatedIds.has(route.chatId) || panels.some((panel) => panel.id === route.chatId && panel.projectId === workspace.id))
        ) {
          navigate(fallbackPath);
        }

        toast(`Deleted workspace "${workspace.label}".`);
      },
    });
  }, [chats, navigate, panels, projectFolders, remove, requestConfirmation, route, toast]);

  const requestClearAll = useCallback(() => {
    requestConfirmation({
      title: 'Clear all conversation history?',
      message: 'All saved chats will be permanently removed. This action cannot be undone.',
      confirmLabel: 'Clear history',
      onConfirm: async () => {
        await clearAll();
        setPanels([]);
        setActivePanelId(null);
        setQueuedLaunchPrompts({});
        navigate('/chat');
        toast('History cleared.');
      },
    });
  }, [clearAll, navigate, requestConfirmation, toast]);

  const requestClearReplyMemory = useCallback(() => {
    requestConfirmation({
      title: 'Clear saved reply memory?',
      message: 'This removes every liked and disliked reply preference saved locally for future response shaping.',
      confirmLabel: 'Clear reply memory',
      onConfirm: async () => {
        await clearReplyPreferences();
        toast('Reply memory cleared.');
      },
    });
  }, [requestConfirmation, toast]);

  const handleExportAppData = useCallback(() => {
    const exportedAt = new Date().toISOString();
    const fileName = `larry-ai-data-export-${formatDiagnosticFilenameTimestamp(exportedAt)}.json`;
    const payload = {
      version: 1,
      exportedAt,
      storageMode: desktopRuntime ? 'desktop-sql' : 'browser',
      defaults: {
        defaultModel: resolvedDefaultModel,
        defaultChatPreset,
        defaultReasoningEffort,
        developerToolsEnabled,
        advancedUseEnabled,
      },
      connections: {
        ollamaEndpoint,
        openAIConfigured: Boolean(openAIApiKey),
        anthropicConfigured: Boolean(anthropicApiKey),
      },
      providers: providers.map((provider) => ({
        provider: provider.provider,
        label: provider.label,
        enabled: provider.enabled,
        online: provider.online,
        modelCount: provider.modelCount,
        mode: provider.mode ?? 'live',
        error: provider.error ?? null,
      })),
      data: {
        chats,
        workspaces: projectFolders,
        replyPreferences,
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    toast(`Exported app data to ${fileName}`);
  }, [
    advancedUseEnabled,
    anthropicApiKey,
    chats,
    desktopRuntime,
    defaultChatPreset,
    defaultReasoningEffort,
    developerToolsEnabled,
    ollamaEndpoint,
    openAIApiKey,
    projectFolders,
    providers,
    replyPreferences,
    resolvedDefaultModel,
    toast,
  ]);

  const resetWorkspaceDefaults = useCallback(() => {
    setDefaultModel('');
    setDefaultChatPreset(DEFAULT_PRESET_ID);
    setDefaultReasoningEffort(DEFAULT_REASONING_EFFORT);
    toast('Workspace defaults reset.');
  }, [toast]);

  const handleStartChatFromHome = useCallback((options: {
    prompt: string;
    preset: string;
    title: string;
    threadType: ThreadType;
    model?: string;
    reasoningEffort?: ChatReasoningEffort;
    workspace?: { id: string; label: string };
    fileEntries?: ChatRecord['fileEntries'];
  }) => {
    const resolvedWorkspace = options.workspace
      ? resolveWorkspaceReference({
        id: options.workspace.id,
        label: options.workspace.label,
      })
      : null;
    const workspaceId = resolvedWorkspace?.id ?? options.workspace?.id;
    const workspaceLabel = resolvedWorkspace?.label ?? options.workspace?.label;
    const workspaceEntries = resolvedWorkspace
      ? cloneFileEntries(resolvedWorkspace.fileEntries)
      : [];
    const launchFileEntries = mergeStoredFileEntries(workspaceEntries, cloneFileEntries(options.fileEntries));

    if (workspaceId && workspaceLabel) {
      upsertProjectFolder({ id: workspaceId, label: workspaceLabel });
    }

    const shouldUseChatLaunchTransition =
      options.threadType === 'chat' &&
      (route.kind === 'chat-start' || chatStarterVisible);

    const starterHostPanel = shouldUseChatLaunchTransition && chatStarterPanelId
      ? panels.find((panel) => panel.id === chatStarterPanelId) ?? null
      : null;

    let createdChatId: string;

    if (starterHostPanel && resolveThreadSurface(starterHostPanel) === 'chat' && starterHostPanel.messages.length === 0) {
      const updatedStarterPanel: Panel = resetPanelRunState(starterHostPanel, {
        title: options.title,
        model: options.model || resolvedDefaultModel,
        preset: options.preset,
        reasoningEffort: options.reasoningEffort ?? starterHostPanel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        threadType: options.threadType,
        projectId: workspaceId,
        projectLabel: workspaceLabel,
        fileRegistry: registryFromEntries(launchFileEntries),
      });

      setPanels((prev) => prev.map((panel) => panel.id === starterHostPanel.id
        ? updatedStarterPanel
        : panel));
      void persistWorkspaceChat({
        id: updatedStarterPanel.id,
        title: updatedStarterPanel.title,
        model: updatedStarterPanel.model,
        preset: updatedStarterPanel.preset,
        reasoningEffort: updatedStarterPanel.reasoningEffort,
        threadType: updatedStarterPanel.threadType,
        projectId: updatedStarterPanel.projectId,
        projectLabel: updatedStarterPanel.projectLabel,
        messages: [],
        updatedAt: Date.now(),
        fileEntries: launchFileEntries,
        latestWorkspaceBackup: null,
        interruptedTask: null,
      });
      setQueuedLaunchPrompts((prev) => ({
        ...prev,
        [starterHostPanel.id]: options.prompt.trim(),
      }));
      setActivePanelId(starterHostPanel.id);
      createdChatId = starterHostPanel.id;
    } else {
      createdChatId = openDraftChat({
        title: options.title,
        model: options.model,
        preset: options.preset,
        reasoningEffort: options.reasoningEffort,
        threadType: options.threadType,
        projectId: workspaceId,
        projectLabel: workspaceLabel,
        fileEntries: launchFileEntries,
        initialPrompt: options.prompt,
        navigateOnCreate: !shouldUseChatLaunchTransition,
      });
    }

    ensureWorkspaceContext(workspaceId);

    if (shouldUseChatLaunchTransition) {
      setChatStarterVisible(true);
      setChatLaunchTransition({
        chatId: createdChatId,
        prompt: options.prompt,
        startedAt: Date.now(),
      });
    }

    return true;
  }, [chatStarterPanelId, chatStarterVisible, ensureWorkspaceContext, openDraftChat, panels, persistWorkspaceChat, resolveWorkspaceReference, resolvedDefaultModel, route.kind, upsertProjectFolder]);

  useEffect(() => {
    if (route.kind !== 'chat') return;

    const existing = panels.find((panel) => panel.id === route.chatId);
    if (existing) {
      if (activePanelId !== existing.id) {
        setActivePanelId(existing.id);
      }
      return;
    }

    if (!ready) return;

    const chat = chats.find((candidate) => candidate.id === route.chatId);
    if (!chat) return;

    const workspaceEntries = chat.projectId
      ? findProjectFolderById(chat.projectId)?.fileEntries
      : undefined;

    createPanel({
      ...chat,
      fileEntries: workspaceEntries?.length ? cloneFileEntries(workspaceEntries) : chat.fileEntries,
    });
    ensureWorkspaceContext(chat.projectId);
  }, [activePanelId, chats, createPanel, ensureWorkspaceContext, panels, projectFolders, ready, route]);

  const activePanel = useMemo(
    () => (route.kind === 'chat' ? panels.find((panel) => panel.id === route.chatId) ?? null : null),
    [panels, route],
  );
  const routeChatRecord = useMemo(
    () => (route.kind === 'chat'
      ? activePanel ?? chats.find((chat) => chat.id === route.chatId) ?? null
      : null),
    [activePanel, chats, route],
  );
  const activeThreadSurface = useMemo<ThreadType>(
    () => resolveThreadSurface(routeChatRecord),
    [routeChatRecord],
  );
  const isMissingChatRoute =
    route.kind === 'chat' &&
    ready &&
    !activePanel &&
    !chats.some((chat) => chat.id === route.chatId);
  const chatSurfaceChats = useMemo(
    () => chats.filter((chat) => resolveThreadSurface(chat) === 'chat'),
    [chats],
  );
  const chatSurfacePanels = useMemo(
    () => panels.filter((panel) => resolveThreadSurface(panel) === 'chat'),
    [panels],
  );
  const chatViewportAnchorId = useMemo(
    () => (route.kind === 'chat' && activeThreadSurface === 'chat'
      ? activePanel?.id ?? route.chatId
      : activePanelId),
    [activePanel?.id, activePanelId, activeThreadSurface, route],
  );
  const visibleChatPanels = useMemo(() => {
    if (!chatSurfacePanels.length) return [];

    if (chatSurfacePanels.length <= MAX_VISIBLE_CHAT_PANELS) {
      return chatSurfacePanels;
    }

    const latestWindowStart = Math.max(0, chatSurfacePanels.length - MAX_VISIBLE_CHAT_PANELS);
    if (!chatViewportAnchorId) {
      return chatSurfacePanels.slice(latestWindowStart);
    }

    const activeIndex = chatSurfacePanels.findIndex((panel) => panel.id === chatViewportAnchorId);
    if (activeIndex === -1) {
      return chatSurfacePanels.slice(latestWindowStart);
    }

    const windowStart = Math.min(activeIndex, latestWindowStart);
    return chatSurfacePanels.slice(windowStart, windowStart + MAX_VISIBLE_CHAT_PANELS);
  }, [chatSurfacePanels, chatViewportAnchorId]);
  const pendingChatLaunchPanel = useMemo(
    () => chatLaunchTransition
      ? panels.find((panel) => panel.id === chatLaunchTransition.chatId) ?? null
      : null,
    [chatLaunchTransition, panels],
  );
  const pendingChatLaunchStatusText = useMemo(() => {
    if (!pendingChatLaunchPanel) return 'Preparing the first response...';
    if (pendingChatLaunchPanel.messages.some((message) => message.role === 'assistant')) {
      return 'Reply ready. Opening the conversation...';
    }
    if (pendingChatLaunchPanel.streamingContent.trim()) {
      return 'Receiving the first answer...';
    }
    return pendingChatLaunchPanel.streamingPhase?.label ?? 'Starting reply...';
  }, [pendingChatLaunchPanel]);
  const pendingChatLaunchHasResponse = useMemo(
    () => Boolean(
      pendingChatLaunchPanel &&
      (
        pendingChatLaunchPanel.streamingContent.trim() ||
        pendingChatLaunchPanel.messages.some((message) => message.role === 'assistant')
      )
    ),
    [pendingChatLaunchPanel],
  );
  const chatSurfaceOpenPanelIds = useMemo(
    () => chatSurfacePanels.map((panel) => panel.id),
    [chatSurfacePanels],
  );
  const isChatSurfaceRoute =
    route.kind === 'chat-start' || (route.kind === 'chat' && activeThreadSurface === 'chat');
  const embeddedChatStarterPanelId = chatLaunchTransition?.chatId ?? chatStarterPanelId;
  const showEmbeddedChatStarter =
    route.kind === 'chat-start'
      ? !chatSurfacePanels.length || chatStarterVisible || Boolean(chatLaunchTransition)
      : isChatSurfaceRoute && (chatStarterVisible || Boolean(chatLaunchTransition));
  const chatStarterCompanionPanels = useMemo(() => {
    const filteredPanels = visibleChatPanels.filter(
      (panel) => panel.id !== embeddedChatStarterPanelId,
    );

    if (!showEmbeddedChatStarter) {
      return filteredPanels;
    }

    const limit = Math.max(0, MAX_VISIBLE_CHAT_PANELS - 1);
    if (filteredPanels.length <= limit) {
      return filteredPanels;
    }

    const activeChatPanelId = chatViewportAnchorId;

    if (!activeChatPanelId) {
      return filteredPanels.slice(-limit);
    }

    const activeStarterCompanion = filteredPanels.find(
      (panel) => panel.id === activeChatPanelId,
    );
    if (!activeStarterCompanion) {
      return filteredPanels.slice(-limit);
    }

    const otherPanels = filteredPanels.filter((panel) => panel.id !== activeStarterCompanion.id);
    const selectedPanels = [...otherPanels.slice(-(limit - 1)), activeStarterCompanion];

    return filteredPanels.filter((panel) =>
      selectedPanels.some((selectedPanel) => selectedPanel.id === panel.id),
    );
  }, [
    chatViewportAnchorId,
    embeddedChatStarterPanelId,
    showEmbeddedChatStarter,
    visibleChatPanels,
  ]);
  const chatDisplayPanels = showEmbeddedChatStarter ? chatStarterCompanionPanels : visibleChatPanels;
  const chatDisplayFrameCount = Math.max(
    1,
    Math.min(
      MAX_VISIBLE_CHAT_PANELS,
      chatDisplayPanels.length + (showEmbeddedChatStarter ? 1 : 0),
    ),
  );
  const codeSurfaceChats = useMemo(
    () => chats.filter((chat) => resolveThreadSurface(chat) === 'code'),
    [chats],
  );
  const codeWorkspaceGroups = useMemo(
    () => buildWorkspaceGroups(codeSurfaceChats, projectFolders),
    [codeSurfaceChats, projectFolders],
  );
  const selectedCodeWorkspace = useMemo(
    () => {
      const workspace = findWorkspaceGroup(codeWorkspaceGroups, selectedCodeWorkspaceId);
      if (!workspace) return null;
      if (workspaceHasLinkedSource(workspace)) return workspace;

      const resolvedWorkspace = resolveWorkspaceReference({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
        fileEntries: workspace.fileEntries,
      });
      if (!resolvedWorkspace) return workspace;

      return {
        ...workspace,
        id: resolvedWorkspace.id,
        label: resolvedWorkspace.label,
        createdAt: resolvedWorkspace.createdAt,
        rootPath: resolvedWorkspace.rootPath,
        browserHandleId: resolvedWorkspace.browserHandleId,
        fileTree: resolvedWorkspace.fileTree ?? workspace.fileTree,
        fileEntries: resolvedWorkspace.fileEntries ?? workspace.fileEntries,
        fileCount: resolvedWorkspace.fileCount ?? workspace.fileCount,
        directoryCount: resolvedWorkspace.directoryCount ?? workspace.directoryCount,
        syncedAt: resolvedWorkspace.syncedAt ?? workspace.syncedAt,
      };
    },
    [codeWorkspaceGroups, resolveWorkspaceReference, selectedCodeWorkspaceId],
  );
  const activeWorkspaceFile = useMemo(
    () => activeWorkspaceFileKey ? workspaceFileDrafts[activeWorkspaceFileKey] ?? null : null,
    [activeWorkspaceFileKey, workspaceFileDrafts],
  );
  const activeWorkspaceTerminal = useMemo(() => {
    if (!selectedCodeWorkspaceId) return null;
    return workspaceTerminalSessions[selectedCodeWorkspaceId] ?? {
      open: false,
      commandDraft: '',
      running: false,
      entries: [],
    };
  }, [selectedCodeWorkspaceId, workspaceTerminalSessions]);

  const updateWorkspaceTerminalSession = useCallback((
    workspaceId: string,
    updater: (current: WorkspaceTerminalSession) => WorkspaceTerminalSession,
  ) => {
    setWorkspaceTerminalSessions((prev) => {
      const current = prev[workspaceId] ?? {
        open: false,
        commandDraft: '',
        running: false,
        entries: [],
      };
      return {
        ...prev,
        [workspaceId]: updater(current),
      };
    });
  }, []);

  useEffect(() => {
    if (!selectedCodeWorkspace || !workspaceHasLinkedSource(selectedCodeWorkspace)) return;

    const sourceId = selectedCodeWorkspace.rootPath || selectedCodeWorkspace.browserHandleId;
    if (!sourceId) return;

    const hasIndexedTree = Boolean(selectedCodeWorkspace.fileTree?.length);
    const hasSyncStamp = typeof selectedCodeWorkspace.syncedAt === 'number' && selectedCodeWorkspace.syncedAt > 0;
    if (hasIndexedTree && hasSyncStamp) return;

    const hydrationKey = `${selectedCodeWorkspace.id}:${sourceId}`;
    if (autoHydratedWorkspaceSourcesRef.current.has(hydrationKey)) return;

    autoHydratedWorkspaceSourcesRef.current.add(hydrationKey);
    void syncWorkspaceFolder({
      id: selectedCodeWorkspace.id,
      label: selectedCodeWorkspace.label,
      createdAt: selectedCodeWorkspace.createdAt,
      rootPath: selectedCodeWorkspace.rootPath,
      browserHandleId: selectedCodeWorkspace.browserHandleId,
    }, { silent: true });
  }, [
    selectedCodeWorkspace?.browserHandleId,
    selectedCodeWorkspace?.createdAt,
    selectedCodeWorkspace?.fileTree?.length,
    selectedCodeWorkspace?.id,
    selectedCodeWorkspace?.label,
    selectedCodeWorkspace?.rootPath,
    selectedCodeWorkspace?.syncedAt,
    syncWorkspaceFolder,
  ]);

  useEffect(() => {
    if (!selectedCodeWorkspace || !workspaceHasLinkedSource(selectedCodeWorkspace)) return undefined;

    const refreshWorkspace = () => {
      void (async () => {
        const snapshot = await syncWorkspaceFolder({
          id: selectedCodeWorkspace.id,
          label: selectedCodeWorkspace.label,
          createdAt: selectedCodeWorkspace.createdAt,
          rootPath: selectedCodeWorkspace.rootPath,
          browserHandleId: selectedCodeWorkspace.browserHandleId,
        }, { silent: true });

        if (!snapshot) return;
        syncWorkspaceDraftsFromSnapshot(
          selectedCodeWorkspace.id,
          snapshot,
          snapshot.fileEntries.map((entry) => entry.path),
        );
      })();
    };

    const intervalId = window.setInterval(refreshWorkspace, 3000);
    return () => window.clearInterval(intervalId);
  }, [
    selectedCodeWorkspace?.browserHandleId,
    selectedCodeWorkspace?.createdAt,
    selectedCodeWorkspace?.id,
    selectedCodeWorkspace?.label,
    selectedCodeWorkspace?.rootPath,
    syncWorkspaceDraftsFromSnapshot,
    syncWorkspaceFolder,
  ]);

  useEffect(() => {
    if (!activeWorkspaceFile) return;
    const matchingWorkspace = findWorkspaceGroup(codeWorkspaceGroups, activeWorkspaceFile.workspaceId);
    if (!matchingWorkspace) {
      setActiveWorkspaceFileKey(null);
      return;
    }

    if (selectedCodeWorkspaceId && activeWorkspaceFile.workspaceId !== selectedCodeWorkspaceId) {
      setActiveWorkspaceFileKey(null);
    }
  }, [activeWorkspaceFile, codeWorkspaceGroups, selectedCodeWorkspaceId]);

  const saveWorkspaceFileDraft = useCallback(async (
    fileKey: string,
    options: { showToast?: boolean } = {},
  ) => {
    const draft = workspaceFileDraftsRef.current[fileKey];
    if (!draft) return true;
    if (draft.loading || draft.saving || draft.content === draft.savedContent) {
      clearWorkspaceFileAutoSaveTimer(fileKey);
      return true;
    }

    const workspace = findProjectFolderById(draft.workspaceId);
    if (!workspace) {
      if (options.showToast !== false) {
        toast('That workspace is no longer available.');
      }
      return false;
    }

    clearWorkspaceFileAutoSaveTimer(fileKey);
    const contentToPersist = draft.content;

    setWorkspaceFileDrafts((prev) => {
      const current = prev[fileKey];
      if (!current) return prev;
      return {
        ...prev,
        [fileKey]: {
          ...current,
          saving: true,
          error: null,
        },
      };
    });

    try {
      const snapshot = await persistWorkspaceFileDocument(workspace, draft.relativePath, contentToPersist);

      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });

      setWorkspaceFileDrafts((prev) => {
        const current = prev[fileKey];
        if (!current) return prev;
        return {
          ...prev,
          [fileKey]: {
            ...current,
            workspaceLabel: workspace.label,
            rootPath: workspace.rootPath,
            browserHandleId: workspace.browserHandleId,
            savedContent: contentToPersist,
            sizeBytes: measureStringBytes(current.content),
            modifiedAt: Date.now(),
            loading: false,
            saving: false,
            error: null,
          },
        };
      });

      if (options.showToast !== false) {
        toast(`Saved "${draft.relativePath}".`);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save that workspace file.';
      setWorkspaceFileDrafts((prev) => {
        const current = prev[fileKey];
        if (!current) return prev;
        return {
          ...prev,
          [fileKey]: {
            ...current,
            saving: false,
            error: message,
          },
        };
      });
      toast(message);
      return false;
    }
  }, [
    applyWorkspaceSnapshotToState,
    clearWorkspaceFileAutoSaveTimer,
    findProjectFolderById,
    persistWorkspaceFileDocument,
    toast,
  ]);

  const scheduleWorkspaceFileAutoSave = useCallback((fileKey: string | null) => {
    if (!fileKey) return;

    clearWorkspaceFileAutoSaveTimer(fileKey);
    if (!codeEditorAutoSaveEnabled) return;

    workspaceFileAutoSaveTimersRef.current[fileKey] = window.setTimeout(() => {
      delete workspaceFileAutoSaveTimersRef.current[fileKey];
      void saveWorkspaceFileDraft(fileKey, { showToast: false });
    }, WORKSPACE_FILE_AUTO_SAVE_DELAY_MS);
  }, [clearWorkspaceFileAutoSaveTimer, codeEditorAutoSaveEnabled, saveWorkspaceFileDraft]);

  useEffect(() => {
    if (!codeEditorAutoSaveEnabled) {
      clearAllWorkspaceFileAutoSaveTimers();
      return;
    }

    for (const [fileKey, draft] of Object.entries(workspaceFileDraftsRef.current)) {
      if (draft.content !== draft.savedContent && !draft.loading && !draft.saving) {
        scheduleWorkspaceFileAutoSave(fileKey);
      }
    }
  }, [
    clearAllWorkspaceFileAutoSaveTimers,
    codeEditorAutoSaveEnabled,
    scheduleWorkspaceFileAutoSave,
  ]);

  const handleChangeActiveWorkspaceFile = useCallback((nextContent: string) => {
    if (!activeWorkspaceFileKey) return;

    setWorkspaceFileDrafts((prev) => {
      const current = prev[activeWorkspaceFileKey];
      if (!current) return prev;
      return {
        ...prev,
        [activeWorkspaceFileKey]: {
          ...current,
          content: nextContent,
          sizeBytes: measureStringBytes(nextContent),
          error: null,
        },
      };
    });
    scheduleWorkspaceFileAutoSave(activeWorkspaceFileKey);
  }, [activeWorkspaceFileKey, scheduleWorkspaceFileAutoSave]);

  const handleRevertActiveWorkspaceFile = useCallback(() => {
    if (!activeWorkspaceFileKey) return;
    clearWorkspaceFileAutoSaveTimer(activeWorkspaceFileKey);

    setWorkspaceFileDrafts((prev) => {
      const current = prev[activeWorkspaceFileKey];
      if (!current) return prev;
      return {
        ...prev,
        [activeWorkspaceFileKey]: {
          ...current,
          content: current.savedContent,
          sizeBytes: measureStringBytes(current.savedContent),
          error: null,
        },
      };
    });
  }, [activeWorkspaceFileKey, clearWorkspaceFileAutoSaveTimer]);

  const handleReloadActiveWorkspaceFile = useCallback(() => {
    if (!activeWorkspaceFile) return;

    const workspace = findWorkspaceGroup(codeWorkspaceGroups, activeWorkspaceFile.workspaceId);
    if (!workspace) {
      toast('That workspace is no longer available.');
      return;
    }

    void loadWorkspaceFileIntoDraft(workspace, activeWorkspaceFile.relativePath, { force: true });
  }, [activeWorkspaceFile, codeWorkspaceGroups, loadWorkspaceFileIntoDraft, toast]);

  const handleSaveActiveWorkspaceFile = useCallback(async () => {
    if (!activeWorkspaceFileKey) return;
    await saveWorkspaceFileDraft(activeWorkspaceFileKey, { showToast: true });
  }, [activeWorkspaceFileKey, saveWorkspaceFileDraft]);

  const handleCloseActiveWorkspaceFile = useCallback(() => {
    setActiveWorkspaceFileKey(null);
  }, []);

  const handleRenameWorkspaceFile = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
    nextName: string,
  ) => {
    let nextRelativePath = '';
    try {
      nextRelativePath = buildSiblingWorkspacePath(relativePath, nextName);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Enter a valid file name.');
      return;
    }

    const normalizedCurrentPath = normalizeWorkspacePath(relativePath);
    if (nextRelativePath === normalizedCurrentPath) {
      return;
    }

    const existingPaths = new Set(collectWorkspaceFilePaths(workspace.fileTree));
    if (existingPaths.has(nextRelativePath)) {
      toast(`A file named "${nextName.trim()}" already exists here.`);
      return;
    }

    const currentKey = buildWorkspaceFileKey(workspace.id, normalizedCurrentPath);
    const nextKey = buildWorkspaceFileKey(workspace.id, nextRelativePath);
    const existingDraft = workspaceFileDraftsRef.current[currentKey] ?? null;
    const shouldResumeAutoSave = Boolean(
      existingDraft
      && existingDraft.content !== existingDraft.savedContent
      && codeEditorAutoSaveEnabled,
    );

    try {
      const snapshot = await renameWorkspaceFileDocument(workspace, normalizedCurrentPath, nextRelativePath);

      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });

      clearWorkspaceFileAutoSaveTimer(currentKey);
      setWorkspaceFileDrafts((prev) => {
        const currentDraft = prev[currentKey];
        if (!currentDraft) return prev;

        const nextDrafts = { ...prev };
        delete nextDrafts[currentKey];
        nextDrafts[nextKey] = {
          ...currentDraft,
          relativePath: nextRelativePath,
          workspaceLabel: workspace.label,
          rootPath: workspace.rootPath,
          browserHandleId: workspace.browserHandleId,
          error: null,
        };
        return nextDrafts;
      });
      setActiveWorkspaceFileKey((current) => current === currentKey ? nextKey : current);
      if (shouldResumeAutoSave) {
        scheduleWorkspaceFileAutoSave(nextKey);
      }

      toast(`Renamed "${relativePath}" to "${nextRelativePath}".`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to rename that file.');
    }
  }, [
    applyWorkspaceSnapshotToState,
    clearWorkspaceFileAutoSaveTimer,
    codeEditorAutoSaveEnabled,
    renameWorkspaceFileDocument,
    scheduleWorkspaceFileAutoSave,
    toast,
  ]);

  const handleDuplicateWorkspaceFile = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
  ) => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const existingPaths = new Set(collectWorkspaceFilePaths(workspace.fileTree));
    let nextRelativePath = '';
    try {
      nextRelativePath = buildDuplicateWorkspacePath(normalizedPath, existingPaths);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to duplicate that file.');
      return;
    }

    const currentKey = buildWorkspaceFileKey(workspace.id, normalizedPath);
    const existingDraft = workspaceFileDraftsRef.current[currentKey] ?? null;

    try {
      const snapshot = existingDraft && existingDraft.content !== existingDraft.savedContent
        ? await createWorkspaceFileDocument(workspace, nextRelativePath, existingDraft.content)
        : await copyWorkspaceFileDocument(workspace, normalizedPath, nextRelativePath);

      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });

      const nextKey = buildWorkspaceFileKey(workspace.id, nextRelativePath);
      setActiveWorkspaceFileKey(nextKey);
      void loadWorkspaceFileIntoDraft(workspace, nextRelativePath, { force: true });
      navigate('/code');
      toast(`Duplicated "${relativePath}" as "${nextRelativePath}".`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to duplicate that file.');
    }
  }, [
    applyWorkspaceSnapshotToState,
    copyWorkspaceFileDocument,
    createWorkspaceFileDocument,
    loadWorkspaceFileIntoDraft,
    navigate,
    toast,
  ]);

  const handleDeleteWorkspaceFile = useCallback((workspace: WorkspaceGroup, relativePath: string) => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const fileKey = buildWorkspaceFileKey(workspace.id, normalizedPath);
    const existingDraft = workspaceFileDraftsRef.current[fileKey] ?? null;
    const hasUnsavedChanges = Boolean(existingDraft && existingDraft.content !== existingDraft.savedContent);

    requestConfirmation({
      title: 'Delete file',
      message: hasUnsavedChanges
        ? `Delete "${normalizedPath}"? Any unsaved edits in the editor will be lost.`
        : `Delete "${normalizedPath}" from this workspace? This cannot be undone.`,
      confirmLabel: 'Delete file',
      onConfirm: async () => {
        try {
          const snapshot = await deleteWorkspaceFileDocument(workspace, normalizedPath);

          clearWorkspaceFileAutoSaveTimer(fileKey);
          applyWorkspaceSnapshotToState({
            id: workspace.id,
            label: workspace.label,
            createdAt: workspace.createdAt,
            rootPath: workspace.rootPath,
            browserHandleId: workspace.browserHandleId,
          }, snapshot, { unarchive: true });

          setWorkspaceFileDrafts((prev) => {
            if (!prev[fileKey]) return prev;
            const nextDrafts = { ...prev };
            delete nextDrafts[fileKey];
            return nextDrafts;
          });
          setActiveWorkspaceFileKey((current) => current === fileKey ? null : current);
          toast(`Deleted "${normalizedPath}".`);
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Unable to delete that file.');
        }
      },
    });
  }, [
    applyWorkspaceSnapshotToState,
    clearWorkspaceFileAutoSaveTimer,
    deleteWorkspaceFileDocument,
    requestConfirmation,
    toast,
  ]);

  const handleCopyWorkspaceFilePath = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
  ) => {
    const clipboardPath = buildWorkspacePathForClipboard(workspace, relativePath);
    try {
      await copyTextToClipboard(clipboardPath);
      toast(workspace.rootPath ? 'Copied full file path.' : 'Copied workspace-relative file path.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to copy that file path.');
    }
  }, [toast]);

  const handleOpenWorkspaceFileOutsideApp = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
  ) => {
    try {
      await openWorkspaceFileOutsideApp(workspace, relativePath);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to open that file outside the app.');
    }
  }, [openWorkspaceFileOutsideApp, toast]);

  const handleCreateWorkspaceFileInFolder = useCallback(async (
    workspace: WorkspaceGroup,
    parentRelativePath: string | null,
  ) => {
    const existingPaths = new Set(collectWorkspaceEntryPaths(workspace.fileTree));
    let nextRelativePath = '';
    try {
      nextRelativePath = buildUniqueWorkspaceChildPath(parentRelativePath, 'untitled.txt', existingPaths);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to create a file there.');
      return;
    }

    try {
      const snapshot = await createWorkspaceFileDocument(workspace, nextRelativePath, '');
      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });

      const nextKey = buildWorkspaceFileKey(workspace.id, nextRelativePath);
      setActiveWorkspaceFileKey(nextKey);
      navigate('/code');
      void loadWorkspaceFileIntoDraft(workspace, nextRelativePath, { force: true });
      toast(`Created "${nextRelativePath}".`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to create that file.');
    }
  }, [
    applyWorkspaceSnapshotToState,
    createWorkspaceFileDocument,
    loadWorkspaceFileIntoDraft,
    navigate,
    toast,
  ]);

  const handleCreateWorkspaceFolderInFolder = useCallback(async (
    workspace: WorkspaceGroup,
    parentRelativePath: string | null,
  ) => {
    const existingPaths = new Set(collectWorkspaceEntryPaths(workspace.fileTree));
    let nextRelativePath = '';
    try {
      nextRelativePath = buildUniqueWorkspaceChildPath(parentRelativePath, 'new-folder', existingPaths);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to create a folder there.');
      return;
    }

    try {
      const snapshot = await createWorkspaceDirectoryDocument(workspace, nextRelativePath);
      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });
      toast(`Created folder "${nextRelativePath}".`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to create that folder.');
    }
  }, [
    applyWorkspaceSnapshotToState,
    createWorkspaceDirectoryDocument,
    toast,
  ]);

  const handleRenameWorkspaceFolder = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
    nextName: string,
  ) => {
    let nextRelativePath = '';
    try {
      nextRelativePath = buildSiblingWorkspacePath(relativePath, nextName);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Enter a valid folder name.');
      return;
    }

    const normalizedCurrentPath = normalizeWorkspacePath(relativePath);
    if (nextRelativePath === normalizedCurrentPath) {
      return;
    }

    const existingPaths = new Set(collectWorkspaceEntryPaths(workspace.fileTree));
    if (existingPaths.has(nextRelativePath)) {
      toast(`A folder named "${nextName.trim()}" already exists here.`);
      return;
    }

    try {
      const snapshot = await renameWorkspaceFileDocument(workspace, normalizedCurrentPath, nextRelativePath);
      applyWorkspaceSnapshotToState({
        id: workspace.id,
        label: workspace.label,
        createdAt: workspace.createdAt,
        rootPath: workspace.rootPath,
        browserHandleId: workspace.browserHandleId,
      }, snapshot, { unarchive: true });

      setWorkspaceFileDrafts((prev) => {
        let changed = false;
        const nextDrafts: Record<string, WorkspaceFileDraft> = {};

        for (const [draftKey, draft] of Object.entries(prev)) {
          if (draft.workspaceId !== workspace.id || !isWorkspacePathWithinTarget(draft.relativePath, normalizedCurrentPath)) {
            nextDrafts[draftKey] = draft;
            continue;
          }

          const nextDraftPath = `${nextRelativePath}${draft.relativePath.slice(normalizedCurrentPath.length)}`;
          const nextKey = buildWorkspaceFileKey(workspace.id, nextDraftPath);
          nextDrafts[nextKey] = {
            ...draft,
            relativePath: nextDraftPath,
            workspaceLabel: workspace.label,
            rootPath: workspace.rootPath,
            browserHandleId: workspace.browserHandleId,
          };
          clearWorkspaceFileAutoSaveTimer(draftKey);
          changed = true;
        }

        return changed ? nextDrafts : prev;
      });
      setActiveWorkspaceFileKey((current) => {
        if (!current) return current;
        const currentDraft = workspaceFileDraftsRef.current[current];
        if (!currentDraft || currentDraft.workspaceId !== workspace.id || !isWorkspacePathWithinTarget(currentDraft.relativePath, normalizedCurrentPath)) {
          return current;
        }
        const nextDraftPath = `${nextRelativePath}${currentDraft.relativePath.slice(normalizedCurrentPath.length)}`;
        return buildWorkspaceFileKey(workspace.id, nextDraftPath);
      });
      toast(`Renamed folder "${relativePath}" to "${nextRelativePath}".`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to rename that folder.');
    }
  }, [
    applyWorkspaceSnapshotToState,
    clearWorkspaceFileAutoSaveTimer,
    renameWorkspaceFileDocument,
    toast,
  ]);

  const handleDeleteWorkspaceFolder = useCallback((workspace: WorkspaceGroup, relativePath: string) => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const draftEntries = Object.entries(workspaceFileDraftsRef.current).filter(([, draft]) => (
      draft.workspaceId === workspace.id && isWorkspacePathWithinTarget(draft.relativePath, normalizedPath)
    ));
    const hasUnsavedChanges = draftEntries.some(([, draft]) => draft.content !== draft.savedContent);

    requestConfirmation({
      title: 'Delete folder',
      message: hasUnsavedChanges
        ? `Delete "${normalizedPath}"? Open files inside it have unsaved edits that will be lost.`
        : `Delete "${normalizedPath}" from this workspace? This cannot be undone.`,
      confirmLabel: 'Delete folder',
      onConfirm: async () => {
        try {
          const snapshot = await deleteWorkspaceFileDocument(workspace, normalizedPath);

          for (const [draftKey] of draftEntries) {
            clearWorkspaceFileAutoSaveTimer(draftKey);
          }
          applyWorkspaceSnapshotToState({
            id: workspace.id,
            label: workspace.label,
            createdAt: workspace.createdAt,
            rootPath: workspace.rootPath,
            browserHandleId: workspace.browserHandleId,
          }, snapshot, { unarchive: true });

          setWorkspaceFileDrafts((prev) => Object.fromEntries(
            Object.entries(prev).filter(([, draft]) => (
              draft.workspaceId !== workspace.id || !isWorkspacePathWithinTarget(draft.relativePath, normalizedPath)
            )),
          ));
          setActiveWorkspaceFileKey((current) => {
            if (!current) return current;
            const currentDraft = workspaceFileDraftsRef.current[current];
            if (!currentDraft || currentDraft.workspaceId !== workspace.id || !isWorkspacePathWithinTarget(currentDraft.relativePath, normalizedPath)) {
              return current;
            }
            return null;
          });
          toast(`Deleted folder "${normalizedPath}".`);
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Unable to delete that folder.');
        }
      },
    });
  }, [
    applyWorkspaceSnapshotToState,
    clearWorkspaceFileAutoSaveTimer,
    deleteWorkspaceFileDocument,
    requestConfirmation,
    toast,
  ]);

  const handleCopyWorkspaceFolderPath = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
  ) => {
    const clipboardPath = buildWorkspacePathForClipboard(workspace, relativePath);
    try {
      await copyTextToClipboard(clipboardPath);
      toast(workspace.rootPath ? 'Copied full folder path.' : 'Copied workspace-relative folder path.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to copy that folder path.');
    }
  }, [toast]);

  const handleOpenWorkspaceFolderOutsideApp = useCallback(async (
    workspace: WorkspaceGroup,
    relativePath: string,
  ) => {
    try {
      await openWorkspaceFileOutsideApp(workspace, relativePath);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to open that folder outside the app.');
    }
  }, [openWorkspaceFileOutsideApp, toast]);

  const handleToggleWorkspaceTerminal = useCallback((workspaceId: string) => {
    updateWorkspaceTerminalSession(workspaceId, (current) => ({
      ...current,
      open: !current.open,
    }));
  }, [updateWorkspaceTerminalSession]);

  const handleCloseWorkspaceTerminal = useCallback((workspaceId: string) => {
    updateWorkspaceTerminalSession(workspaceId, (current) => ({
      ...current,
      open: false,
    }));
  }, [updateWorkspaceTerminalSession]);

  const handleChangeWorkspaceTerminalDraft = useCallback((workspaceId: string, nextValue: string) => {
    updateWorkspaceTerminalSession(workspaceId, (current) => ({
      ...current,
      commandDraft: nextValue,
    }));
  }, [updateWorkspaceTerminalSession]);

  const handleClearWorkspaceTerminal = useCallback((workspaceId: string) => {
    updateWorkspaceTerminalSession(workspaceId, (current) => ({
      ...current,
      entries: [],
    }));
  }, [updateWorkspaceTerminalSession]);

  const runWorkspaceTerminalCommand = useCallback(async (
    workspace: WorkspaceGroup,
    command: string,
    options: { preserveDraft?: boolean; timeoutMs?: number } = {},
  ) => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) return;
    if (!workspace.rootPath) {
      toast('The embedded terminal is available for desktop-linked workspaces.');
      return;
    }

    const entryId = `terminal:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    updateWorkspaceTerminalSession(workspace.id, (current) => ({
      ...current,
      open: true,
      running: true,
      commandDraft: options.preserveDraft ? current.commandDraft : '',
      entries: [
        ...current.entries,
        {
          id: entryId,
          command: trimmedCommand,
          output: '',
          status: 'running',
        },
      ],
    }));

    try {
      const result = await runWorkspaceCommand(
        workspace.rootPath,
        trimmedCommand,
        options.timeoutMs ?? 120_000,
      );
      updateWorkspaceTerminalSession(workspace.id, (current) => ({
        ...current,
        running: false,
        entries: current.entries.map((entry) => (
          entry.id !== entryId
            ? entry
            : {
                ...entry,
                output: result.combinedOutput,
                status: result.exitCode === 0 && !result.timedOut ? 'completed' : 'error',
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut,
              }
        )),
      }));
    } catch (error) {
      updateWorkspaceTerminalSession(workspace.id, (current) => ({
        ...current,
        running: false,
        entries: current.entries.map((entry) => (
          entry.id !== entryId
            ? entry
            : {
                ...entry,
                output: error instanceof Error ? error.message : 'Unable to run that command.',
                status: 'error',
              }
        )),
      }));
      toast(error instanceof Error ? error.message : 'Unable to run that command.');
    }
  }, [toast, updateWorkspaceTerminalSession]);

  const handleRunWorkspaceValidation = useCallback(async (workspace: WorkspaceGroup) => {
    const profile = await inspectWorkspaceRuntimeProfile(workspace);
    const validationCommand = pickWorkspaceValidationCommands(profile)[0] ?? null;
    if (!validationCommand) {
      toast('No automatic validation command was detected for this workspace.');
      return;
    }

    void runWorkspaceTerminalCommand(workspace, validationCommand.command, {
      timeoutMs: workspaceValidationTimeoutMs(validationCommand),
    });
  }, [inspectWorkspaceRuntimeProfile, runWorkspaceTerminalCommand, toast]);

  const handleCreateCodeThreadInFolder = useCallback(
    (folder: { id: string; label: string }) => handleCreateChatInFolder(folder, 'code'),
    [handleCreateChatInFolder],
  );
  const activeCodePanel = route.kind === 'chat' && activeThreadSurface === 'code'
    ? activePanel
    : null;

  useEffect(() => {
    if (route.kind !== 'chat' || activeThreadSurface !== 'code') return;

    const persistedChat = chats.find((chat) => chat.id === route.chatId);
    const activeWorkspaceId = persistedChat
      ? deriveWorkspaceFromChat(persistedChat).id
      : activeCodePanel?.projectId ?? null;
    const canonicalWorkspace = findWorkspaceGroup(codeWorkspaceGroups, activeWorkspaceId);

    if (!activeWorkspaceId) return;
    const nextWorkspaceId = canonicalWorkspace?.id ?? activeWorkspaceId;
    setSelectedCodeWorkspaceId((current) => current === nextWorkspaceId ? current : nextWorkspaceId);
  }, [activeCodePanel?.projectId, activeThreadSurface, chats, codeWorkspaceGroups, route]);

  useEffect(() => {
    if (selectedCodeWorkspaceId && !findWorkspaceGroup(codeWorkspaceGroups, selectedCodeWorkspaceId)) {
      setSelectedCodeWorkspaceId(null);
    }
  }, [codeWorkspaceGroups, selectedCodeWorkspaceId]);

  const embeddedChatStarterFrame = showEmbeddedChatStarter ? (
    <section className="chat-starter-frame">
      <div className="chat-starter-frame-head">
        <div className="chat-starter-frame-copy">
          <span className="chat-starter-frame-kicker">Composer</span>
          <strong>{chatLaunchTransition ? 'Starting a new chat' : 'New conversation'}</strong>
        </div>
        <span className="chat-starter-frame-meta">
          {chatLaunchTransition ? 'Generating...' : 'Prompt + model'}
        </span>
      </div>

      <div className="chat-starter-frame-body">
        <PromptLibraryView
          page="chat"
          embedded={true}
          chats={chatSurfaceChats}
          folders={projectFolders}
          defaultModel={resolvedDefaultModel}
          defaultChatPreset={defaultChatPreset}
          defaultReasoningEffort={defaultReasoningEffort}
          models={models}
          chatLaunchTransition={chatLaunchTransition ? {
            prompt: chatLaunchTransition.prompt,
            statusText: pendingChatLaunchStatusText,
          } : null}
          onStartChat={handleStartChatFromHome}
          onOpenChat={handleOpenFromHistory}
          onCreateChatInFolder={handleCreateCodeThreadInFolder}
          onOpenWorkspaceLauncher={openWorkspaceLauncher}
          onDeleteChat={requestDeleteChat}
          onDeleteWorkspace={requestDeleteWorkspace}
        />
      </div>
    </section>
  ) : null;
  const isCodeSurfaceRoute =
    route.kind === 'code-start' || (route.kind === 'chat' && activeThreadSurface === 'code');
  const handleCreateCodeChat = useCallback(() => {
    if (selectedCodeWorkspace) {
      handleCreateCodeThreadInFolder({ id: selectedCodeWorkspace.id, label: selectedCodeWorkspace.label });
      return;
    }

    void openWorkspaceLauncher();
  }, [handleCreateCodeThreadInFolder, openWorkspaceLauncher, selectedCodeWorkspace]);
  const activeChatSidebarId = route.kind === 'chat' && activeThreadSurface === 'chat'
    ? activePanel?.id ?? route.chatId
    : null;
  const activeCodeSidebarChatId = route.kind === 'chat' && activeThreadSurface === 'code'
    ? activePanel?.id ?? route.chatId
    : null;
  const activeCodeSidebarFilePath = activeWorkspaceFile && activeWorkspaceFile.workspaceId === selectedCodeWorkspaceId
    ? activeWorkspaceFile.relativePath
    : null;

  useEffect(() => {
    if (!isChatSurfaceRoute) return undefined;
    if (chatSurfacePanels.length <= 1) return undefined;
    if (confirmDialog) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      if (event.defaultPrevented) return;

      let direction = 0;
      if (event.key === 'ArrowLeft') {
        direction = -1;
      } else if (event.key === 'ArrowRight') {
        direction = 1;
      }

      if (!direction) return;
      if (isEditableKeyboardTarget(event.target) && !isChatPanelKeyboardTarget(event.target)) return;

      const fallbackIndex = chatSurfacePanels.length - 1;
      const anchorId = chatViewportAnchorId ?? chatSurfacePanels[fallbackIndex]?.id ?? null;
      const anchorIndex = anchorId
        ? chatSurfacePanels.findIndex((panel) => panel.id === anchorId)
        : -1;
      const currentIndex = anchorIndex === -1 ? fallbackIndex : anchorIndex;
      const nextIndex = Math.max(0, Math.min(chatSurfacePanels.length - 1, currentIndex + direction));
      if (nextIndex === currentIndex) return;

      event.preventDefault();
      activatePanel(chatSurfacePanels[nextIndex].id);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activatePanel,
    chatSurfacePanels,
    chatViewportAnchorId,
    confirmDialog,
    isChatSurfaceRoute,
  ]);

  useEffect(() => {
    if (!isChatSurfaceRoute && chatStarterVisible) {
      setChatStarterVisible(false);
    }
  }, [chatStarterVisible, isChatSurfaceRoute]);

  useEffect(() => {
    if (!chatLaunchTransition) return;
    if (!isChatSurfaceRoute) {
      setChatLaunchTransition(null);
    }
  }, [chatLaunchTransition, isChatSurfaceRoute]);

  useEffect(() => {
    if (!chatLaunchTransition) return;
    if (pendingChatLaunchPanel) return;
    setChatLaunchTransition(null);
  }, [chatLaunchTransition, pendingChatLaunchPanel]);

  useEffect(() => {
    if (!chatStarterPanelId) return;
    if (panels.some((panel) => panel.id === chatStarterPanelId)) return;
    setChatStarterPanelId(null);
    setChatStarterVisible(false);
  }, [chatStarterPanelId, panels]);

  useEffect(() => {
    if (!chatLaunchTransition || !pendingChatLaunchPanel || !pendingChatLaunchHasResponse) return undefined;

    const remainingDelay = Math.max(
      0,
      CHAT_FORM_TRANSITION_MIN_MS - (Date.now() - chatLaunchTransition.startedAt),
    );

    const timeout = window.setTimeout(() => {
      setChatStarterVisible(false);
      setChatStarterPanelId(null);
      setChatLaunchTransition((current) =>
        current?.chatId === pendingChatLaunchPanel.id ? null : current,
      );
      navigate(buildChatPath(pendingChatLaunchPanel.id));
    }, remainingDelay);

    return () => window.clearTimeout(timeout);
  }, [chatLaunchTransition, navigate, pendingChatLaunchHasResponse, pendingChatLaunchPanel]);

  const ollamaProvider = providers.find((provider) => provider.provider === 'ollama');
  const openAIProvider = providers.find((provider) => provider.provider === 'openai');
  const anthropicProvider = providers.find((provider) => provider.provider === 'anthropic');
  const onlineProviders = providers.filter((provider) => provider.online);
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const connectedProviders = PROVIDER_ORDER.filter((provider) => {
    if (provider === 'openai') return Boolean(openAIApiKey.trim());
    if (provider === 'anthropic') return Boolean(anthropicApiKey.trim());
    return Boolean(ollamaProvider?.online);
  });

  const statusLabel =
    status === 'connecting' ? 'checking providers...' :
    onlineProviders.length
      ? `${onlineProviders.map((provider) => provider.label).join(', ')} / ${models.length} model${models.length !== 1 ? 's' : ''}`
      : connectedProviders.length
        ? 'providers saved but not responding'
        : enabledProviders.length
          ? 'providers configured but unavailable'
          : 'no providers connected';

  const ollamaStatusLabel =
    !ollamaProvider ? 'checking...' :
    ollamaProvider.online ? `${ollamaProvider.modelCount} model${ollamaProvider.modelCount !== 1 ? 's' : ''} available` :
    'offline';

  const openAIStatusLabel =
    !openAIApiKey ? 'No key saved' :
    !openAIProvider ? 'checking...' :
    openAIProvider.online
      ? `${openAIProvider.mode === 'sample' ? 'Sample catalog' : 'Live catalog'} · ${openAIProvider.modelCount} model${openAIProvider.modelCount !== 1 ? 's' : ''}`
      :
    openAIProvider.error || 'Unable to connect';

  const anthropicStatusLabel =
    !anthropicApiKey ? 'No key saved' :
    !anthropicProvider ? 'checking...' :
    anthropicProvider.online
      ? `${anthropicProvider.mode === 'sample' ? 'Sample catalog' : 'Live catalog'} · ${anthropicProvider.modelCount} model${anthropicProvider.modelCount !== 1 ? 's' : ''}`
      :
    anthropicProvider.error || 'Unable to connect';

  const openAIStatusText = openAIStatusLabel.replace('Â·', '·');
  const anthropicStatusText = anthropicStatusLabel.replace('Â·', '·');
  const openAIProviderStatusText =
    !openAIApiKey ? 'No key saved' :
    !openAIProvider ? 'checking...' :
    openAIProvider.online
      ? `${openAIProvider.mode === 'sample' ? 'Sample catalog' : 'Live catalog'} · ${openAIProvider.modelCount} model${openAIProvider.modelCount !== 1 ? 's' : ''}`
      :
    openAIProvider.error || 'Unable to connect';
  const anthropicProviderStatusText =
    !anthropicApiKey ? 'No key saved' :
    !anthropicProvider ? 'checking...' :
    anthropicProvider.online
      ? `${anthropicProvider.mode === 'sample' ? 'Sample catalog' : 'Live catalog'} · ${anthropicProvider.modelCount} model${anthropicProvider.modelCount !== 1 ? 's' : ''}`
      :
    anthropicProvider.error || 'Unable to connect';
  void ollamaStatusLabel;
  void openAIStatusLabel;
  void anthropicStatusLabel;
  void openAIStatusText;
  void anthropicStatusText;
  void openAIProviderStatusText;
  void anthropicProviderStatusText;
  const defaultChatPresetMeta = CHAT_DEFAULT_PRESETS.find((preset) => preset.id === defaultChatPreset) ?? CHAT_DEFAULT_PRESETS[0];
  const defaultModelLabel = resolvedDefaultModel ? getModelDisplayLabel(resolvedDefaultModel) : 'No model ready';
  const defaultReasoningLabel = getReasoningEffortLabel(defaultReasoningEffort);
  const configuredHostedProviders = Number(Boolean(openAIApiKey)) + Number(Boolean(anthropicApiKey));
  const defaultModelProvider = resolvedDefaultModel ? getModelProvider(resolvedDefaultModel) : null;
  const connectedProviderCards = PROVIDER_ORDER
    .filter((provider) => connectedProviders.includes(provider))
    .map((provider) => {
      const state = provider === 'openai'
        ? openAIProvider
        : provider === 'anthropic'
          ? anthropicProvider
          : ollamaProvider;
      const preference = providerSettings[provider];
      const liveModelCount = providerModelCatalog[provider].length;
      const enabledModelCount = preference.selectedModels.length || liveModelCount;
      const statusCopy =
        provider === 'openai' && !openAIProvider
          ? 'Checking connection'
          : provider === 'anthropic' && !anthropicProvider
            ? 'Checking connection'
            : provider === 'ollama' && !ollamaProvider
              ? 'Checking local host'
              : state?.online
                ? `${enabledModelCount || liveModelCount} model${(enabledModelCount || liveModelCount) === 1 ? '' : 's'} available`
                : state?.error || 'Connected details saved';

      return {
        provider,
        providerName: PROVIDER_UI_META[provider].providerName,
        statusCopy,
        isDefault: defaultModelProvider === provider,
      };
    });
  const addProviderCards = PROVIDER_ORDER.filter((provider) => !connectedProviders.includes(provider));
  const isMacPlatform = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const starterSubmitShortcutKeys = isMacPlatform ? ['Cmd/Ctrl', 'Enter'] : ['Ctrl', 'Enter'];
  const shortcutInsightGroups: ShortcutInsightGroup[] = [
    {
      id: 'navigation',
      title: 'Tabs',
      items: [
        {
          keys: ['Ctrl', 'Shift', 'Left'],
          action: 'Show the previous open chat tab',
        },
        {
          keys: ['Ctrl', 'Shift', 'Right'],
          action: 'Show the next open chat tab',
        },
      ],
    },
    {
      id: 'compose',
      title: 'Chat',
      items: [
        {
          keys: ['Enter'],
          action: 'Send the current message',
        },
        {
          keys: ['Shift', 'Enter'],
          action: 'Insert a new line',
        },
      ],
    },
    {
      id: 'launchers',
      title: 'Starters',
      items: [
        {
          keys: starterSubmitShortcutKeys,
          action: 'Start the drafted chat',
        },
      ],
    },
    {
      id: 'dismiss',
      title: 'Close',
      items: [
        {
          keys: ['Escape'],
          action: 'Close overlays, panels, or picker menus',
        },
      ],
    },
  ];
  const shortcutInsightCount = shortcutInsightGroups.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  const settingsTabs = [
    {
      id: 'workspace' as const,
      label: SETTINGS_TAB_META.workspace.label,
      title: SETTINGS_TAB_META.workspace.title,
      description: SETTINGS_TAB_META.workspace.description,
      summary: `${defaultChatPresetMeta.label} · ${defaultReasoningLabel}`,
    },
    {
      id: 'editor' as const,
      label: SETTINGS_TAB_META.editor.label,
      title: SETTINGS_TAB_META.editor.title,
      description: SETTINGS_TAB_META.editor.description,
      summary: `${codeEditorAutoSaveEnabled ? 'Autosave on' : 'Manual save'} / ${codeEditorIndentGuidesEnabled ? 'Guides on' : 'Guides off'} / ${codeEditorDependencyInstallEnabled ? 'Fresh installs on' : 'Fresh installs off'} / ${codeEditorSetupGuideEnabled ? 'Setup guide on' : 'Setup guide off'}`,
    },
    {
      id: 'providers' as const,
      label: SETTINGS_TAB_META.providers.label,
      title: SETTINGS_TAB_META.providers.title,
      description: SETTINGS_TAB_META.providers.description,
      summary: `${connectedProviders.length} connected`,
    },
    {
      id: 'data' as const,
      label: SETTINGS_TAB_META.data.label,
      title: SETTINGS_TAB_META.data.title,
      description: SETTINGS_TAB_META.data.description,
      summary: `${chats.length} chats · ${projectFolders.length} workspaces`,
    },
    {
      id: 'shortcuts' as const,
      label: SETTINGS_TAB_META.shortcuts.label,
      title: SETTINGS_TAB_META.shortcuts.title,
      description: SETTINGS_TAB_META.shortcuts.description,
      summary: `${shortcutInsightCount} live shortcuts`,
    },
    {
      id: 'advanced' as const,
      label: SETTINGS_TAB_META.advanced.label,
      title: SETTINGS_TAB_META.advanced.title,
      description: SETTINGS_TAB_META.advanced.description,
      summary: `${[developerToolsEnabled, advancedUseEnabled].filter(Boolean).length} controls enabled`,
    },
  ];
  const activeSettingsTabMeta = settingsTabs.find((tab) => tab.id === settingsTab) ?? settingsTabs[0];
  const localPersistenceLabel = desktopRuntime ? 'local app database' : 'browser';
  const storageSystemLabel = desktopRuntime ? 'local SQL database' : 'IndexedDB';
  const storageMeterLabel = desktopRuntime ? 'Local SQL database' : 'Browser storage';

  const getProviderCredentialValue = useCallback((provider: ModelProvider) => {
    if (provider === 'openai') return openAIApiKey;
    if (provider === 'anthropic') return anthropicApiKey;
    return ollamaEndpoint;
  }, [anthropicApiKey, ollamaEndpoint, openAIApiKey]);

  const openProviderDialogFor = useCallback((provider: ModelProvider, mode: ProviderDialogMode) => {
    const preference = cloneProviderSettingsMap(providerSettings)[provider];
    const currentOptions = providerModelOptions[provider];
    const selectedModels = preference.selectedModels.filter((model) => currentOptions.includes(model));

    setProviderDialog({
      provider,
      mode,
      credentialValue: getProviderCredentialValue(provider),
      selectedModels: selectedModels.length ? selectedModels : [...currentOptions],
      autoUpdate: preference.autoUpdate,
    });
  }, [getProviderCredentialValue, providerModelOptions, providerSettings]);

  const closeProviderDialog = useCallback(() => {
    setProviderDialog(null);
  }, []);

  const toggleProviderDialogModel = useCallback((modelHandle: string) => {
    setProviderDialog((current) => {
      if (!current) return current;

      const nextSelectedModels = current.selectedModels.includes(modelHandle)
        ? current.selectedModels.filter((model) => model !== modelHandle)
        : [...current.selectedModels, modelHandle];

      return {
        ...current,
        selectedModels: nextSelectedModels,
      };
    });
  }, []);

  const selectAllProviderDialogModels = useCallback(() => {
    setProviderDialog((current) => {
      if (!current) return current;
      return {
        ...current,
        selectedModels: [...providerModelOptions[current.provider]],
      };
    });
  }, [providerModelOptions]);

  const handleSaveProviderDialog = useCallback(() => {
    if (!providerDialog) return;

    const { provider } = providerDialog;
    const normalizedCredential = provider === 'ollama'
      ? normalizeOllamaBase(providerDialog.credentialValue)
      : providerDialog.credentialValue.trim();

    if ((provider === 'openai' || provider === 'anthropic') && !normalizedCredential) {
      toast(`Enter a ${PROVIDER_UI_META[provider].fieldLabel.toLowerCase()} before connecting ${PROVIDER_UI_META[provider].providerName}.`);
      return;
    }

    if (provider === 'openai') {
      setOpenAIApiKey(normalizedCredential);
    } else if (provider === 'anthropic') {
      setAnthropicApiKey(normalizedCredential);
    } else {
      setOllamaEndpoint(normalizedCredential);
    }

    setProviderSettings((current) => {
      const next = cloneProviderSettingsMap(current);
      next[provider] = {
        ...next[provider],
        selectedModels: providerDialog.selectedModels.length
          ? providerDialog.selectedModels
          : [...providerModelOptions[provider]],
        autoUpdate: providerDialog.autoUpdate,
      };
      return next;
    });

    toast(`${PROVIDER_UI_META[provider].providerName} ${providerDialog.mode === 'connect' ? 'connected' : 'updated'} in the ${localPersistenceLabel}.`);
    setProviderDialog(null);
  }, [localPersistenceLabel, providerDialog, providerModelOptions, toast]);

  const handleDisconnectProvider = useCallback(() => {
    if (!providerDialog) return;

    const { provider } = providerDialog;
    if (provider === 'openai') {
      setOpenAIApiKey('');
    } else if (provider === 'anthropic') {
      setAnthropicApiKey('');
    } else {
      setOllamaEndpoint(DEFAULT_OLLAMA_BASE);
    }

    setProviderSettings((current) => {
      const next = cloneProviderSettingsMap(current);
      next[provider] = createDefaultProviderSettingsMap()[provider];
      return next;
    });

    toast(`${PROVIDER_UI_META[provider].providerName} connection removed.`);
    setProviderDialog(null);
  }, [providerDialog, toast]);

  const providerDialogModelOptions = providerDialog ? providerModelOptions[providerDialog.provider] : [];
  const providerDialogCanSubmit = providerDialog
    ? Boolean(providerDialog.provider === 'ollama'
      ? providerDialog.credentialValue.trim()
      : providerDialog.credentialValue.trim())
    : false;
  const providerDialogHasExistingConnection = providerDialog
    ? connectedProviders.includes(providerDialog.provider)
    : false;

  const handleRunDeepResearchSearchEngineTest = useCallback(async () => {
    setDeepResearchSearchTestRunning(true);
    setDeepResearchSearchTestResult(null);

    try {
      const result = await runDeepResearchSearchEngineTest();
      setDeepResearchSearchTestResult(result);
      toast(result.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackResult: DeepResearchSearchEngineTestResult = {
        status: 'fail',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        summary: 'The deep research fetch diagnostic failed before it could finish.',
        reasoning: message,
        reportText: [
          'Deep Research Search Engine Test',
          'Status: FAIL',
          `Reasoning: ${message}`,
        ].join('\n'),
        probes: [],
      };
      setDeepResearchSearchTestResult(fallbackResult);
      toast(fallbackResult.summary);
    } finally {
      setDeepResearchSearchTestRunning(false);
    }
  }, [toast]);

  const handleDownloadDeepResearchSearchEngineTest = useCallback(() => {
    if (!deepResearchSearchTestResult) return;

    const fileName = `deep-research-search-engine-test-${deepResearchSearchTestResult.status}-${formatDiagnosticFilenameTimestamp(deepResearchSearchTestResult.completedAt)}.md`;
    const blob = new Blob([deepResearchSearchTestResult.reportText], { type: 'text/markdown;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    toast(`Downloaded ${fileName}`);
  }, [deepResearchSearchTestResult, toast]);

  const handleAddSearchEngineSeed = useCallback(async () => {
    const url = localSearchSeedUrlDraft.trim();
    const label = localSearchSeedLabelDraft.trim();
    if (!url) {
      toast('Enter a site root URL to seed the local search engine.');
      return;
    }

    setLocalSearchBusy(true);
    try {
      const seed = await addSearchEngineSeed(url, label);
      setLocalSearchSeedUrlDraft('');
      setLocalSearchSeedLabelDraft('');
      await refreshLocalSearchPanel();
      toast(`Added ${seed.host} to the local search engine.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add that search seed.');
    } finally {
      setLocalSearchBusy(false);
    }
  }, [localSearchSeedLabelDraft, localSearchSeedUrlDraft, refreshLocalSearchPanel, toast]);

  const handleDeleteSearchEngineSeed = useCallback(async (seed: LocalSearchSeed) => {
    setLocalSearchBusy(true);
    try {
      await deleteSearchEngineSeed(seed.id);
      await refreshLocalSearchPanel();
      toast(`Removed ${seed.host} from the local search engine.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove that search seed.');
    } finally {
      setLocalSearchBusy(false);
    }
  }, [refreshLocalSearchPanel, toast]);

  const handleCrawlSearchEngine = useCallback(async () => {
    if (!localSearchStatus) {
      toast('The local search engine is only available in the desktop runtime.');
      return;
    }
    if (!localSearchSeeds.length) {
      toast('Add at least one seed URL before starting a crawl.');
      return;
    }

    const requestedMaxPages = Number.parseInt(localSearchMaxPagesDraft, 10);
    const requestedMaxDepth = Number.parseInt(localSearchMaxDepthDraft, 10);
    const maxPages = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
      ? requestedMaxPages
      : localSearchStatus.defaultMaxPages;
    const maxDepth = Number.isFinite(requestedMaxDepth) && requestedMaxDepth >= 0
      ? requestedMaxDepth
      : localSearchStatus.defaultMaxDepth;

    setLocalSearchCrawlRunning(true);
    try {
      const crawl = await crawlSearchEngine({
        maxPages,
        maxDepth,
      });
      if (crawl) {
        setLocalSearchLastCrawl(crawl);
      }
      await refreshLocalSearchPanel();
      toast(crawl
        ? `Local search crawl indexed ${crawl.indexedCount} page${crawl.indexedCount === 1 ? '' : 's'} from a ${maxPages.toLocaleString()}-page pass.`
        : 'Local search crawl completed.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The local search crawl did not finish.');
    } finally {
      setLocalSearchCrawlRunning(false);
    }
  }, [
    localSearchMaxDepthDraft,
    localSearchMaxPagesDraft,
    localSearchSeeds.length,
    localSearchStatus,
    refreshLocalSearchPanel,
    toast,
  ]);
  const chatHistoryBytes = ready ? measurePersistedBytes(chats) : 0;
  const workspaceStorageBytes = measurePersistedBytes(projectFolders);
  const workspaceDefaultStorageBytes = measurePersistedBytes({
    defaultModel: defaultModel || undefined,
    defaultChatPreset: defaultChatPreset !== DEFAULT_PRESET_ID ? defaultChatPreset : undefined,
    defaultReasoningEffort: defaultReasoningEffort !== DEFAULT_REASONING_EFFORT ? defaultReasoningEffort : undefined,
    developerToolsEnabled: developerToolsEnabled || undefined,
    advancedUseEnabled: advancedUseEnabled || undefined,
    codeEditorAutoSaveEnabled: codeEditorAutoSaveEnabled ? undefined : false,
    codeEditorIndentGuidesEnabled: codeEditorIndentGuidesEnabled ? undefined : false,
    codeEditorSetupGuideEnabled: codeEditorSetupGuideEnabled ? true : undefined,
    codeEditorDependencyInstallEnabled: codeEditorDependencyInstallEnabled ? true : undefined,
  });
  const providerConnectionStorageBytes = measurePersistedBytes({
    ollamaEndpoint: ollamaEndpoint !== DEFAULT_OLLAMA_BASE ? ollamaEndpoint : undefined,
    openAIApiKey: openAIApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    providerSettings: JSON.stringify(providerSettings) !== JSON.stringify(createDefaultProviderSettingsMap())
      ? providerSettings
      : undefined,
  });
  const replyPreferenceStorageBytes = measurePersistedBytes(replyPreferences);
  const likedReplyPreferenceCount = replyPreferences.filter((entry) => entry.feedback === 'liked').length;
  const dislikedReplyPreferenceCount = replyPreferences.filter((entry) => entry.feedback === 'disliked').length;
  const customPresetStorage = getCustomPresetStorageUsage(desktopRuntime);
  const appStorageBytes =
    chatHistoryBytes +
    workspaceStorageBytes +
    workspaceDefaultStorageBytes +
    providerConnectionStorageBytes +
    replyPreferenceStorageBytes +
    customPresetStorage.bytes;
  const storageBuckets = [
    {
      id: 'history',
      label: 'Chat history',
      bytes: chatHistoryBytes,
      note: ready
        ? `${chats.length} saved chat${chats.length !== 1 ? 's' : ''} in ${storageSystemLabel}`
        : `Reading saved chats from ${storageSystemLabel}...`,
      color: '#5ea7ff',
    },
    {
      id: 'workspaces',
      label: 'Workspaces',
      bytes: workspaceStorageBytes,
      note: `${projectFolders.length} workspace${projectFolders.length !== 1 ? 's' : ''} with workspace metadata and imported file maps`,
      color: '#6ed7b7',
    },
    {
      id: 'workspace-defaults',
      label: 'Workspace defaults',
      bytes: workspaceDefaultStorageBytes,
      note: workspaceDefaultStorageBytes
        ? `${defaultModel ? getModelDisplayLabel(defaultModel) : 'Smart model default'}, ${defaultChatPresetMeta.label}, ${defaultReasoningLabel}${advancedUseEnabled || developerToolsEnabled ? ' plus UI toggles' : ''}`
        : 'No non-default workspace preferences stored yet',
      color: '#f2b668',
    },
    {
      id: 'connections',
      label: 'Provider access',
      bytes: providerConnectionStorageBytes,
      note: providerConnectionStorageBytes
        ? `${configuredHostedProviders} hosted provider key${configuredHostedProviders === 1 ? '' : 's'} saved${ollamaEndpoint !== DEFAULT_OLLAMA_BASE ? ' with a custom Ollama endpoint' : ''}`
        : 'Using the default local Ollama endpoint with no hosted provider keys saved',
      color: '#6fc0ff',
    },
    {
      id: 'reply-preferences',
      label: 'Reply preferences',
      bytes: replyPreferenceStorageBytes,
      note: replyPreferences.length
        ? `${replyPreferences.length} rated repl${replyPreferences.length === 1 ? 'y' : 'ies'} stored in the ${localPersistenceLabel} (${likedReplyPreferenceCount} liked, ${dislikedReplyPreferenceCount} disliked)`
        : 'No reply feedback memory stored yet',
      color: '#7c8cff',
    },
    {
      id: 'presets',
      label: 'Custom presets',
      bytes: customPresetStorage.bytes,
      note: customPresetStorage.count
        ? `${customPresetStorage.count} preset storage entr${customPresetStorage.count === 1 ? 'y' : 'ies'} detected`
        : 'No custom preset storage detected yet',
      color: '#c08cff',
    },
  ];
  const appQuotaRatio =
    !desktopRuntime &&
    browserStorage.supported &&
    browserStorage.quota != null &&
    browserStorage.quota > 0
      ? Math.min(100, (appStorageBytes / browserStorage.quota) * 100)
      : null;
  const storageMeterSegments = buildStorageVisualSegments(storageBuckets);
  const storageSegmentFloorPercent = storageMeterSegments.length
    ? Math.min(12, 100 / storageMeterSegments.length)
    : 0;
  const storageMeterMinimumWidthPx = storageSegmentFloorPercent > 0
    ? Math.ceil(14 / (storageSegmentFloorPercent / 100))
    : 0;
  const browserStorageBarWidth =
    appStorageBytes > 0 && appQuotaRatio != null
      ? `max(${appQuotaRatio}%, ${storageMeterMinimumWidthPx}px)`
      : '0%';
  const hoveredStorageBucket = storageMeterSegments.find((bucket) => bucket.id === hoveredStorageBucketId) ?? null;
  const handleShowChatStarter = useCallback(() => {
    setChatLaunchTransition(null);
    setChatStarterVisible(true);
    const existingStarterPanel = chatStarterPanelId
      ? panels.find((panel) => panel.id === chatStarterPanelId) ?? null
      : null;

    if (existingStarterPanel && resolveThreadSurface(existingStarterPanel) === 'chat' && existingStarterPanel.messages.length === 0) {
      const cleanedStarterPanel = resetPanelRunState(existingStarterPanel, {
        title: existingStarterPanel.title || 'New Chat',
        preset: existingStarterPanel.preset || defaultChatPreset,
        reasoningEffort: existingStarterPanel.reasoningEffort ?? defaultReasoningEffort,
        threadType: 'chat',
        projectId: undefined,
        projectLabel: undefined,
      });
      setPanels((prev) => prev.map((panel) => panel.id === existingStarterPanel.id ? cleanedStarterPanel : panel));
      setQueuedLaunchPrompts((prev) => {
        if (!(existingStarterPanel.id in prev)) return prev;
        const next = { ...prev };
        delete next[existingStarterPanel.id];
        return next;
      });
      void persistWorkspaceChat({
        id: cleanedStarterPanel.id,
        title: cleanedStarterPanel.title,
        model: cleanedStarterPanel.model,
        preset: cleanedStarterPanel.preset,
        reasoningEffort: cleanedStarterPanel.reasoningEffort,
        threadType: cleanedStarterPanel.threadType,
        messages: [],
        updatedAt: Date.now(),
        fileEntries: [],
        latestWorkspaceBackup: null,
        interruptedTask: null,
      });
      navigate(buildChatPath(existingStarterPanel.id));
      return;
    }

    const starterPanelId = openDraftChat({
      title: 'New Chat',
      preset: defaultChatPreset,
      reasoningEffort: defaultReasoningEffort,
      threadType: 'chat',
      navigateOnCreate: false,
    });
    setChatStarterPanelId(starterPanelId);
    navigate(buildChatPath(starterPanelId));
  }, [chatStarterPanelId, defaultChatPreset, defaultReasoningEffort, navigate, openDraftChat, panels, persistWorkspaceChat]);
  const chatSidebar = selectedCodeWorkspace ? (
    <Sidebar
      mode="code"
      workspaces={codeWorkspaceGroups}
      activeWorkspaceId={selectedCodeWorkspace.id}
      activeChatId={activeChatSidebarId}
      activeFilePath={activeCodeSidebarFilePath}
      onCreateWorkspace={() => void openWorkspaceLauncher()}
      onSelectWorkspace={handleSelectSidebarWorkspace}
      onClearActiveWorkspace={handleClearChatSidebarWorkspace}
      onCreateChat={handleCreateCodeChat}
      onOpenChat={handleOpenFromHistory}
      onOpenFile={handleOpenWorkspaceFile}
      onCreateFileInFolder={handleCreateWorkspaceFileInFolder}
      onCreateFolderInFolder={handleCreateWorkspaceFolderInFolder}
      onRenameFile={handleRenameWorkspaceFile}
      onRenameFolder={handleRenameWorkspaceFolder}
      onDuplicateFile={handleDuplicateWorkspaceFile}
      onDeleteFile={handleDeleteWorkspaceFile}
      onDeleteFolder={handleDeleteWorkspaceFolder}
      onCopyFilePath={handleCopyWorkspaceFilePath}
      onCopyFolderPath={handleCopyWorkspaceFolderPath}
      onOpenFileOutsideApp={handleOpenWorkspaceFileOutsideApp}
      onOpenFolderOutsideApp={handleOpenWorkspaceFolderOutsideApp}
      onArchiveChat={requestArchiveChat}
      onRenameWorkspace={handleRenameWorkspace}
      onArchiveWorkspace={requestArchiveWorkspace}
      onOpenWorkspaceInExplorer={handleOpenWorkspaceInExplorer}
      onRefreshWorkspace={handleRefreshWorkspace}
      onOpenSettings={() => navigate('/settings')}
    />
  ) : (
    <Sidebar
      mode="chat"
      chats={chatSurfaceChats}
      workspaces={codeWorkspaceGroups}
      activeChatId={activeChatSidebarId}
      openPanelIds={chatSurfaceOpenPanelIds}
      onCreateWorkspace={() => void openWorkspaceLauncher()}
      onCreateChat={handleShowChatStarter}
      onSelectWorkspace={handleSelectSidebarWorkspace}
      onArchiveWorkspace={requestArchiveWorkspace}
      onOpenChat={handleOpenFromHistory}
      onArchiveChat={requestArchiveChat}
      onOpenSettings={() => navigate('/settings')}
    />
  );
  const settingsSidebar = (
    <Sidebar
      mode="settings"
      tabs={settingsTabs}
      activeTabId={settingsTab}
      onSelectTab={(tabId) => {
        if (isSettingsTabId(tabId)) {
          setSettingsTab(tabId);
        }
      }}
      onBackToChat={() => navigate('/chat')}
    />
  );
  const codeWorkbenchMenubar = selectedCodeWorkspace ? (
    <WorkspaceIdeMenubar
      workspaceLabel={selectedCodeWorkspace.label}
      activePath={activeWorkspaceFile?.relativePath ?? null}
      terminalOpen={Boolean(activeWorkspaceTerminal?.open)}
      showIndentGuides={codeEditorIndentGuidesEnabled}
      canSaveFile={Boolean(activeWorkspaceFile && activeWorkspaceFile.content !== activeWorkspaceFile.savedContent && !activeWorkspaceFile.loading && !activeWorkspaceFile.saving)}
      canReloadFile={Boolean(activeWorkspaceFile && !activeWorkspaceFile.saving)}
      canRevertFile={Boolean(activeWorkspaceFile && activeWorkspaceFile.content !== activeWorkspaceFile.savedContent && !activeWorkspaceFile.saving)}
      canOpenActivePath={Boolean(activeWorkspaceFile)}
      canRunValidation={Boolean(selectedCodeWorkspace.rootPath)}
      onNewFile={() => handleCreateWorkspaceFileInFolder(selectedCodeWorkspace, null)}
      onNewFolder={() => handleCreateWorkspaceFolderInFolder(selectedCodeWorkspace, null)}
      onSaveFile={() => { void handleSaveActiveWorkspaceFile(); }}
      onReloadFile={handleReloadActiveWorkspaceFile}
      onRevertFile={handleRevertActiveWorkspaceFile}
      onCopyActivePath={() => {
        if (!activeWorkspaceFile) return;
        void handleCopyWorkspaceFilePath(selectedCodeWorkspace, activeWorkspaceFile.relativePath);
      }}
      onOpenActivePath={() => {
        if (!activeWorkspaceFile) return;
        void handleOpenWorkspaceFileOutsideApp(selectedCodeWorkspace, activeWorkspaceFile.relativePath);
      }}
      onRefreshWorkspace={() => handleRefreshWorkspace(selectedCodeWorkspace)}
      onToggleTerminal={() => handleToggleWorkspaceTerminal(selectedCodeWorkspace.id)}
      onToggleIndentGuides={() => setCodeEditorIndentGuidesEnabled((current) => !current)}
      onRunValidation={() => { void handleRunWorkspaceValidation(selectedCodeWorkspace); }}
    />
  ) : null;
  const codeWorkbenchTerminal = selectedCodeWorkspace && activeWorkspaceTerminal?.open ? (
    <WorkspaceTerminalPanel
      workspaceLabel={selectedCodeWorkspace.label}
      available={Boolean(selectedCodeWorkspace.rootPath)}
      commandDraft={activeWorkspaceTerminal.commandDraft}
      running={activeWorkspaceTerminal.running}
      entries={activeWorkspaceTerminal.entries}
      onCommandDraftChange={(value) => handleChangeWorkspaceTerminalDraft(selectedCodeWorkspace.id, value)}
      onRun={() => {
        void runWorkspaceTerminalCommand(selectedCodeWorkspace, activeWorkspaceTerminal.commandDraft, {
          preserveDraft: false,
        });
      }}
      onClear={() => handleClearWorkspaceTerminal(selectedCodeWorkspace.id)}
      onClose={() => handleCloseWorkspaceTerminal(selectedCodeWorkspace.id)}
    />
  ) : null;

  return (
    <div id="app">
      <input
        ref={importLogsSettingsRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void handleImportLogs(files);
        }}
      />
      <input
        ref={importWorkspaceLauncherRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!files.length) return;
          void handleImportDirectory(files);
        }}
      />

      <div id="app-shell" className="route-shell">
        <div id="main-content">
          {route.kind === 'settings' ? (
            <div className="workbench-route-shell chat-route-shell settings-route-shell">
              {settingsSidebar}
              <div className="workbench-route-main settings-route-main">
                <div id="settings-view">
                  <div className="settings-stage">
                    <div className="settings-header">
                      <span className="settings-eyebrow">Settings</span>
                      <h2>App settings</h2>
                      <p>Pick defaults for new chats, manage models, review local data, and keep the app&apos;s shortcut system easy to discover.</p>

                      <div className="settings-overview-grid">
                    <article className="settings-overview-card">
                      <span className="settings-overview-icon" aria-hidden="true">
                        <IconMessageSquare size={18} />
                      </span>
                      <span className="settings-overview-label">New chats</span>
                      <strong>{defaultModelLabel}</strong>
                      <p>{defaultChatPresetMeta.label} preset · {defaultReasoningLabel} reasoning</p>
                    </article>

                    <article className="settings-overview-card">
                      <span className="settings-overview-icon" aria-hidden="true">
                        <IconSearch size={18} />
                      </span>
                      <span className="settings-overview-label">Models</span>
                      <strong>{connectedProviders.length} connected</strong>
                      <p>{statusLabel}</p>
                    </article>

                    <article className="settings-overview-card">
                      <span className="settings-overview-icon" aria-hidden="true">
                        <IconDownload size={18} />
                      </span>
                      <span className="settings-overview-label">Local data</span>
                      <strong>{formatStorageSize(appStorageBytes)}</strong>
                      <p>{chats.length} chats, {projectFolders.length} workspaces, {replyPreferences.length} reply memories</p>
                    </article>
                  </div>
                </div>

                <section className="settings-panel">
                  <div className={`settings-panel-head${settingsTab === 'providers' ? ' settings-panel-head-hidden' : ''}`}>
                    <div>
                      <span className="settings-panel-kicker">{activeSettingsTabMeta.label}</span>
                      <h3>{activeSettingsTabMeta.title}</h3>
                    </div>
                    <p>{activeSettingsTabMeta.description}</p>
                  </div>

                  <div className="settings-panel-body">
                    {settingsTab === 'workspace' && (
                    <>
                      <div className="settings-card-grid settings-card-grid-two">
                        <section className="settings-card settings-card-spacious">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">Defaults</span>
                              <h4>New session defaults</h4>
                            </div>
                            <span className="settings-badge settings-badge-soft">{defaultModelLabel}</span>
                          </div>

                          <div className="settings-control-grid">
                            <label className="settings-field settings-control-card">
                              <span>Default model</span>
                              <select
                                className="settings-select"
                                value={resolvedDefaultModel}
                                onChange={(e) => setDefaultModel(e.target.value)}
                                disabled={!models.length}
                              >
                                {models.length ? (
                                  models.map((model) => (
                                    <option key={model} value={model}>
                                      {getModelDisplayLabel(model)}
                                    </option>
                                  ))
                                ) : (
                                  <option value="">No models available</option>
                                )}
                              </select>
                              <p className="settings-inline-note">Used whenever you start a new session and do not pick a model manually.</p>
                            </label>

                            <label className="settings-field settings-control-card">
                              <span>Default chat preset</span>
                              <select
                                className="settings-select"
                                value={defaultChatPreset}
                                onChange={(e) => setDefaultChatPreset(e.target.value)}
                              >
                                {CHAT_DEFAULT_PRESETS.map((preset) => (
                                  <option key={preset.id} value={preset.id}>
                                    {preset.label}
                                  </option>
                                ))}
                              </select>
                              <p className="settings-inline-note">{describePreset(defaultChatPreset)}</p>
                            </label>

                            <label className="settings-field settings-control-card">
                              <span>Default reasoning</span>
                              <select
                                className="settings-select"
                                value={defaultReasoningEffort}
                                onChange={(e) => {
                                  if (isChatReasoningEffort(e.target.value)) {
                                    setDefaultReasoningEffort(e.target.value);
                                  }
                                }}
                              >
                                {REASONING_EFFORT_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <p className="settings-inline-note">Applies to new sessions before you change the reasoning control in the composer.</p>
                            </label>
                          </div>

                          <div className="settings-actions">
                            <button className="btn settings-secondary-btn" onClick={resetWorkspaceDefaults}>
                              Reset Defaults
                            </button>
                          </div>
                        </section>

                        <section className="settings-card settings-card-spacious">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">Setup</span>
                              <h4>Import and workspace shortcuts</h4>
                            </div>
                            <span className="settings-badge settings-badge-soft">{projectFolders.length} workspaces</span>
                          </div>

                          <div className="settings-split">
                            <div className="settings-stack">
                              <strong>Chat logs</strong>
                              <p className="settings-inline-note">Bring exported Markdown chats back into the app whenever you need to restore or merge history.</p>
                              <div className="settings-actions">
                                <button className="btn" onClick={() => importLogsSettingsRef.current?.click()}>
                                  <IconUpload size={14} />
                                  Import Logs
                                </button>
                              </div>
                            </div>

                            <div className="settings-stack">
                              <strong>Workspaces</strong>
                              <p className="settings-inline-note">Add a real local folder before starting code threads so the sidebar can manage that workspace directly.</p>
                              <div className="settings-actions">
                                <button className="btn" onClick={() => void openWorkspaceLauncher()}>
                                  <IconFolderPlus size={14} />
                                  Add workspace folder
                                </button>
                              </div>
                            </div>
                          </div>
                        </section>
                      </div>

                      <section className="settings-card settings-card-spacious">
                        <div className="settings-card-head">
                          <div>
                            <span className="settings-card-kicker">Catalog</span>
                            <h4>Available models right now</h4>
                          </div>
                          <span className="settings-badge settings-badge-soft">
                            {models.length ? `${models.length} ready` : 'No models'}
                          </span>
                        </div>

                        <p className="settings-inline-note">
                          {models.length
                            ? `Current provider state: ${statusLabel}. Code and debug threads still use the fixed Code preset.`
                            : 'Connect Ollama or add hosted provider keys to populate the model catalog.'}
                        </p>

                        <div className="settings-model-list">
                          {models.length ? (
                            models.map((model) => (
                              <span
                                key={model}
                                className={`settings-model-chip${model === resolvedDefaultModel ? ' active' : ''}`}
                              >
                                {getModelDisplayLabel(model)}
                              </span>
                            ))
                          ) : (
                            <span className="settings-model-empty">No models available right now.</span>
                          )}
                        </div>
                      </section>
                    </>
                  )}

                  {settingsTab === 'editor' && (
                    <>
                      <section className="settings-card settings-card-spacious">
                        <div className="settings-card-head">
                          <div>
                            <span className="settings-card-kicker">Behavior</span>
                            <h4>Workspace editor defaults</h4>
                          </div>
                          <span className="settings-badge settings-badge-soft">
                            {codeEditorAutoSaveEnabled ? 'Autosave enabled' : 'Manual save'}
                          </span>
                        </div>

                        <div className="settings-toggle-grid">
                          <div className="settings-developer-tools-card">
                            <div className="settings-developer-tools-copy">
                              <span className="settings-developer-tools-icon" aria-hidden="true">
                                <IconClock3 size={18} />
                              </span>
                              <div className="settings-developer-tools-text">
                                <strong>Autosave after 2 seconds</strong>
                                <p>Save workspace file edits automatically after <code>2 seconds</code> pass without another keystroke.</p>
                              </div>
                            </div>

                            <button
                              type="button"
                              className={`settings-developer-tools-toggle${codeEditorAutoSaveEnabled ? ' active' : ''}`}
                              aria-pressed={codeEditorAutoSaveEnabled}
                              onClick={() => setCodeEditorAutoSaveEnabled((current) => !current)}
                            >
                              <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                                <span className="settings-developer-tools-toggle-thumb" />
                              </span>
                              <span className="settings-developer-tools-toggle-state">
                                {codeEditorAutoSaveEnabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </button>
                          </div>

                          <div className="settings-developer-tools-card">
                            <div className="settings-developer-tools-copy">
                              <span className="settings-developer-tools-icon" aria-hidden="true">
                                <IconFileText size={18} />
                              </span>
                              <div className="settings-developer-tools-text">
                                <strong>Indent guides</strong>
                                <p>Show vertical spacing guides in the file editor so nested blocks are easier to scan at a glance.</p>
                              </div>
                            </div>

                            <button
                              type="button"
                              className={`settings-developer-tools-toggle${codeEditorIndentGuidesEnabled ? ' active' : ''}`}
                              aria-pressed={codeEditorIndentGuidesEnabled}
                              onClick={() => setCodeEditorIndentGuidesEnabled((current) => !current)}
                            >
                              <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                                <span className="settings-developer-tools-toggle-thumb" />
                              </span>
                              <span className="settings-developer-tools-toggle-state">
                                {codeEditorIndentGuidesEnabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </button>
                          </div>

                          <div className="settings-developer-tools-card">
                            <div className="settings-developer-tools-copy">
                              <span className="settings-developer-tools-icon" aria-hidden="true">
                                <IconSettings size={18} />
                              </span>
                              <div className="settings-developer-tools-text">
                                <strong>Setup guide</strong>
                                <p>After each workspace request, update <code>setup.md</code> when it exists, or create it with current setup and run instructions when it does not.</p>
                              </div>
                            </div>

                            <button
                              type="button"
                              className={`settings-developer-tools-toggle${codeEditorSetupGuideEnabled ? ' active' : ''}`}
                              aria-pressed={codeEditorSetupGuideEnabled}
                              onClick={() => setCodeEditorSetupGuideEnabled((current) => !current)}
                            >
                              <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                                <span className="settings-developer-tools-toggle-thumb" />
                              </span>
                              <span className="settings-developer-tools-toggle-state">
                                {codeEditorSetupGuideEnabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </button>
                          </div>

                          <div className="settings-developer-tools-card">
                            <div className="settings-developer-tools-copy">
                              <span className="settings-developer-tools-icon" aria-hidden="true">
                                <IconRefreshCw size={18} />
                              </span>
                              <div className="settings-developer-tools-text">
                                <strong>Automatic dependency install on-run</strong>
                                <p>Whenever the AI edits a live workspace, remove the local dependency folder when one exists and reinstall packages fresh before validation.</p>
                              </div>
                            </div>

                            <button
                              type="button"
                              className={`settings-developer-tools-toggle${codeEditorDependencyInstallEnabled ? ' active' : ''}`}
                              aria-pressed={codeEditorDependencyInstallEnabled}
                              onClick={() => setCodeEditorDependencyInstallEnabled((current) => !current)}
                            >
                              <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                                <span className="settings-developer-tools-toggle-thumb" />
                              </span>
                              <span className="settings-developer-tools-toggle-state">
                                {codeEditorDependencyInstallEnabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </button>
                          </div>
                        </div>
                      </section>

                      <section className="settings-card settings-card-spacious">
                        <div className="settings-card-head">
                          <div>
                            <span className="settings-card-kicker">Flow</span>
                            <h4>How the editor behaves</h4>
                          </div>
                        </div>

                        <div className="settings-split">
                          <div className="settings-stack">
                            <strong>Manual save still works</strong>
                            <p className="settings-inline-note">The Save button and <code>Ctrl/Cmd+S</code> stay available even when autosave is turned on.</p>
                          </div>

                          <div className="settings-stack">
                            <strong>Sidebar file actions</strong>
                            <p className="settings-inline-note">Right-click a workspace file to rename it, duplicate it, copy its path, open it outside Larry, or delete it.</p>
                          </div>
                        </div>
                      </section>
                    </>
                  )}

                  {settingsTab === 'providers' && (
                    <section className="models-settings-page">
                      <div className="models-settings-hero">
                        <span className="models-settings-hero-icon" aria-hidden="true">
                          <IconSettings size={24} />
                        </span>
                        <div className="models-settings-hero-copy">
                          <h4>Language Models</h4>
                          <p>Connect providers, choose a default model, and control which models stay visible across the app.</p>
                        </div>
                      </div>

                      <div className="models-settings-divider" />

                      <section className="models-settings-section">
                        <div className="models-default-card">
                          <div className="models-default-copy">
                            <strong>Default Model</strong>
                            <span>This model will be used by Larry AI by default in your chats.</span>
                          </div>

                          <label className="models-default-select-wrap">
                            <select
                              className="models-default-select"
                              value={resolvedDefaultModel}
                              onChange={(e) => setDefaultModel(e.target.value)}
                              disabled={!models.length}
                            >
                              {models.length ? (
                                models.map((model) => (
                                  <option key={model} value={model}>
                                    {getModelDisplayName(model)}
                                  </option>
                                ))
                              ) : (
                                <option value="">No models available</option>
                              )}
                            </select>
                          </label>
                        </div>
                      </section>

                      <section className="models-settings-section">
                        <div className="models-section-heading">
                          <h5>Available Providers</h5>
                        </div>

                        {connectedProviderCards.length ? (
                          <div className="models-connected-list">
                            {connectedProviderCards.map((provider) => (
                              <article key={provider.provider} className="models-provider-row">
                                <div className="models-provider-row-main">
                                  <span className="models-provider-row-icon" aria-hidden="true">
                                    <ProviderIcon provider={provider.provider} size={18} />
                                  </span>

                                  <div className="models-provider-row-copy">
                                    <div className="models-provider-row-title">
                                      <strong>{provider.providerName}</strong>
                                      {provider.isDefault && (
                                        <span className="models-provider-default-badge">Default</span>
                                      )}
                                    </div>
                                    <span>{provider.provider === 'ollama' ? 'Self-hosted models' : 'Hosted provider'}</span>
                                  </div>
                                </div>

                                <div className="models-provider-row-actions">
                                  <span className="models-provider-row-meta">{provider.statusCopy}</span>
                                  <button
                                    type="button"
                                    className="models-provider-row-edit"
                                    onClick={() => openProviderDialogFor(provider.provider, 'edit')}
                                    aria-label={`Edit ${provider.providerName} connection`}
                                  >
                                    <IconSettings size={15} />
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="models-empty-state">
                            <span className="models-empty-state-icon" aria-hidden="true">
                              <IconSettings size={18} />
                            </span>
                            <div className="models-empty-state-copy">
                              <strong>No providers connected</strong>
                              <p>Connect OpenAI, Anthropic, or Ollama to make models available here.</p>
                            </div>
                          </div>
                        )}
                      </section>

                      <div className="models-settings-divider" />

                      <section className="models-settings-section">
                        <div className="models-section-heading models-section-heading-copy">
                          <div>
                            <h5>Add Provider</h5>
                            <p>Larry AI supports both popular hosted providers and self-hosted local models.</p>
                          </div>
                        </div>

                        {addProviderCards.length ? (
                          <div className="models-add-grid">
                            {addProviderCards.map((provider) => (
                              <button
                                key={provider}
                                type="button"
                                className="models-add-card"
                                onClick={() => openProviderDialogFor(provider, 'connect')}
                              >
                                <div className="models-add-card-main">
                                  <span className="models-add-card-icon" aria-hidden="true">
                                    <ProviderIcon provider={provider} size={18} />
                                  </span>
                                  <div className="models-add-card-copy">
                                    <strong>{PROVIDER_UI_META[provider].addCardLabel}</strong>
                                    <span>{PROVIDER_UI_META[provider].providerName}</span>
                                  </div>
                                </div>

                                <span className="models-add-card-action">
                                  Connect
                                  <span aria-hidden="true">↔</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="models-add-empty">
                            All supported providers are already connected.
                          </div>
                        )}
                      </section>
                    </section>
                  )}

                  {settingsTab === 'data' && (
                    <>
                      <div className="settings-card-grid settings-card-grid-three">
                        <article className="settings-card settings-summary-card">
                          <span className="settings-card-kicker">Chats</span>
                          <strong>{chats.length}</strong>
                          <p>Saved conversations in the {storageSystemLabel}.</p>
                        </article>

                        <article className="settings-card settings-summary-card">
                          <span className="settings-card-kicker">Workspaces</span>
                          <strong>{projectFolders.length}</strong>
                          <p>Workspace entries stored in the {localPersistenceLabel}.</p>
                        </article>

                        <article className="settings-card settings-summary-card">
                          <span className="settings-card-kicker">Reply memory</span>
                          <strong>{replyPreferences.length}</strong>
                          <p>Liked and disliked response examples saved in the {localPersistenceLabel} for future prompts.</p>
                        </article>
                      </div>

                      <section className="settings-card settings-card-spacious">
                        <div className="settings-card-head">
                          <div>
                            <span className="settings-card-kicker">Storage</span>
                            <h4>Local app footprint</h4>
                          </div>
                          <span className="settings-badge settings-badge-soft">
                            {browserStorage.supported && browserStorage.quota != null
                              ? `${formatStorageSize(appStorageBytes)} of ${formatStorageSize(browserStorage.quota)}`
                              : formatStorageSize(appStorageBytes)}
                          </span>
                        </div>

                        <div className="settings-storage">
                          <div className="settings-storage-meter-block">
                            <div className="settings-storage-meter-head">
                              <span className="settings-storage-meter-label">{storageMeterLabel}</span>
                              <span className="settings-storage-meter-total">
                                {browserStorage.supported && browserStorage.quota != null
                                  ? `${formatStorageSize(appStorageBytes)} of ${formatStorageSize(browserStorage.quota)}`
                                  : formatStorageSize(appStorageBytes)}
                              </span>
                            </div>

                            <div
                              className="settings-storage-meter-stack"
                              onMouseEnter={cancelStoragePopupHide}
                              onMouseLeave={scheduleStoragePopupHide}
                            >
                              <div className="settings-storage-meter" role="list" aria-label={`Larry AI ${storageMeterLabel.toLowerCase()} breakdown`}>
                                {appStorageBytes > 0 ? (
                                  <div className="settings-storage-meter-used" style={{ width: browserStorageBarWidth }}>
                                    {storageMeterSegments.map((bucket) => (
                                      <button
                                        type="button"
                                        key={bucket.id}
                                        className="settings-storage-meter-segment"
                                        onMouseEnter={() => {
                                          cancelStoragePopupHide();
                                          setHoveredStorageBucketId(bucket.id);
                                        }}
                                        onFocus={() => setHoveredStorageBucketId(bucket.id)}
                                        onBlur={scheduleStoragePopupHide}
                                        aria-label={`${bucket.label}, ${formatStorageSize(bucket.bytes)}, ${formatStoragePercent(bucket.contributionPercent)} of Larry AI storage`}
                                        style={{
                                          width: `${bucket.visualPercent}%`,
                                          background: bucket.color,
                                        }}
                                      />
                                    ))}
                                  </div>
                                ) : (
                                  <span className="settings-storage-meter-empty" />
                                )}
                              </div>

                              {hoveredStorageBucket && (
                                <div
                                  className="settings-storage-meter-popup"
                                  role="status"
                                  aria-live="polite"
                                  onMouseEnter={cancelStoragePopupHide}
                                  onMouseLeave={scheduleStoragePopupHide}
                                >
                                  <div className="settings-storage-meter-popup-head">
                                    <span
                                      className="settings-storage-dot settings-storage-dot-large"
                                      style={{ background: hoveredStorageBucket.color }}
                                      aria-hidden="true"
                                    />
                                    <strong>{hoveredStorageBucket.label}</strong>
                                  </div>
                                  <div className="settings-storage-meter-popup-line">
                                    <span>Stored</span>
                                    <strong>{formatStorageSize(hoveredStorageBucket.bytes)}</strong>
                                  </div>
                                  <div className="settings-storage-meter-popup-line">
                                    <span>Contribution</span>
                                    <strong>{formatStoragePercent(hoveredStorageBucket.contributionPercent)}</strong>
                                  </div>
                                  <p>{hoveredStorageBucket.note}</p>
                                </div>
                              )}
                            </div>

                            <div className="settings-storage-meter-caption">
                              {appQuotaRatio != null
                                ? `Larry AI is using about ${formatStoragePercent(appQuotaRatio)} of the browser storage limit. Hover a color segment to inspect what each category stores.`
                                : desktopRuntime
                                  ? 'Storage is tracked in the desktop database file, so browser quota limits do not apply here.'
                                  : 'Quota details are not exposed in this environment.'}
                            </div>
                          </div>

                          <div className="settings-storage-breakdown">
                            {storageBuckets.map((bucket) => (
                              <div key={bucket.id} className="settings-storage-row">
                                <div className="settings-storage-row-main">
                                  <span
                                    className="settings-storage-dot"
                                    style={{ background: bucket.color }}
                                    aria-hidden="true"
                                  />
                                  <div className="settings-storage-row-copy">
                                    <div className="settings-storage-item-head">
                                      <span className="settings-storage-label">{bucket.label}</span>
                                      <span className="settings-storage-value">
                                        {bucket.bytes > 0 ? `${formatStorageSize(bucket.bytes)}` : '0 B'}
                                      </span>
                                    </div>
                                    <p>{bucket.note}</p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>

                          {!customPresetStorage.count && (
                            <p className="settings-storage-footnote">
                              Custom presets are not being saved locally yet, so that category will stay at 0 B until preset persistence is added.
                            </p>
                          )}
                        </div>
                      </section>

                      <div className="settings-card-grid settings-card-grid-three">
                        <section className="settings-card">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">Transfer</span>
                              <h4>Import or export app data</h4>
                            </div>
                          </div>

                          <p className="settings-inline-note">Export includes chats, workspaces, reply memory, and defaults, but intentionally leaves provider keys out.</p>

                          <div className="settings-actions">
                            <button className="btn" onClick={() => importLogsSettingsRef.current?.click()}>
                              <IconUpload size={14} />
                              Import Logs
                            </button>
                            <button className="btn settings-secondary-btn" onClick={handleExportAppData}>
                              <IconDownload size={14} />
                              Export All Data
                            </button>
                          </div>
                        </section>

                        <section className="settings-card">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">Reply memory</span>
                              <h4>Manage learned preferences</h4>
                            </div>
                          </div>

                          <p className="settings-inline-note">
                            {replyPreferences.length
                              ? `${likedReplyPreferenceCount} liked and ${dislikedReplyPreferenceCount} disliked examples are stored in the ${localPersistenceLabel} for better future replies.`
                              : 'No reply memory is stored yet.'}
                          </p>

                          <div className="settings-actions">
                            <button
                              className="btn settings-secondary-btn"
                              onClick={requestClearReplyMemory}
                              disabled={!replyPreferences.length}
                            >
                              <IconTrash2 size={14} />
                              Clear Reply Memory
                            </button>
                          </div>
                        </section>

                        <section className="settings-card settings-card-danger">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">History</span>
                              <h4>Clear conversation history</h4>
                            </div>
                          </div>

                          <p className="settings-inline-note">Remove every saved conversation from the {localPersistenceLabel}. This cannot be undone.</p>

                          <div className="settings-actions">
                            <button className="btn danger settings-danger-btn" onClick={requestClearAll}>
                              <IconTrash2 size={14} />
                              Clear All Conversation History
                            </button>
                          </div>
                        </section>
                      </div>
                    </>
                  )}

                  {settingsTab === 'shortcuts' && (
                    <div className="settings-card-grid settings-card-grid-two">
                      {shortcutInsightGroups.map((group) => (
                        <section key={group.id} className="settings-card settings-card-spacious">
                          <div className="settings-card-head">
                            <div>
                              <span className="settings-card-kicker">Shortcuts</span>
                              <h4>{group.title}</h4>
                            </div>
                          </div>

                          <div className="settings-shortcut-list">
                            {group.items.map((shortcut) => (
                              <article
                                key={`${group.id}-${shortcut.action}`}
                                className="settings-shortcut-item"
                              >
                                <div className="settings-shortcut-keys" aria-label={`Shortcut ${shortcut.keys.join(' plus ')}`}>
                                  {shortcut.keys.map((key, index) => (
                                    <span key={`${shortcut.action}-${key}-${index}`} className="settings-shortcut-key-wrap">
                                      {index > 0 ? (
                                        <span className="settings-shortcut-plus" aria-hidden="true">
                                          +
                                        </span>
                                      ) : null}
                                      <kbd className="settings-shortcut-key">{key}</kbd>
                                    </span>
                                  ))}
                                </div>

                                <div className="settings-shortcut-copy">
                                  <strong>{shortcut.action}</strong>
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  )}

                  {settingsTab === 'advanced' && (
                    <section className="settings-card settings-card-spacious">
                      <div className="settings-card-head">
                        <div>
                          <span className="settings-card-kicker">Advanced</span>
                          <h4>Controls and diagnostics</h4>
                        </div>
                        <span className="settings-badge settings-badge-soft">
                          {[developerToolsEnabled, advancedUseEnabled].filter(Boolean).length} enabled
                        </span>
                      </div>

                      <div className="settings-developer-tools-card">
                        <div className="settings-developer-tools-copy">
                          <span className="settings-developer-tools-icon" aria-hidden="true">
                            <IconTerminal size={17} />
                          </span>

                          <div className="settings-developer-tools-text">
                            <strong>Developer tools</strong>
                            <p>Show reply timing and the pipeline inspector so loading and orchestration issues are easier to trace.</p>
                          </div>
                        </div>

                        <button
                          type="button"
                          className={`settings-developer-tools-toggle${developerToolsEnabled ? ' active' : ''}`}
                          aria-pressed={developerToolsEnabled}
                          onClick={() => setDeveloperToolsEnabled((current) => !current)}
                        >
                          <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                            <span className="settings-developer-tools-toggle-thumb" />
                          </span>
                          <span className="settings-developer-tools-toggle-state">
                            {developerToolsEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </button>
                      </div>

                      <div className="settings-developer-tools-card">
                        <div className="settings-developer-tools-copy">
                          <span className="settings-developer-tools-icon" aria-hidden="true">
                            <IconSettings size={17} />
                          </span>

                          <div className="settings-developer-tools-text">
                            <strong>Session controls</strong>
                            <p>Expose in-chat model, reasoning, and preset controls for people who want direct session-level control.</p>
                          </div>
                        </div>

                        <button
                          type="button"
                          className={`settings-developer-tools-toggle${advancedUseEnabled ? ' active' : ''}`}
                          aria-pressed={advancedUseEnabled}
                          onClick={() => setAdvancedUseEnabled((current) => !current)}
                        >
                          <span className="settings-developer-tools-toggle-track" aria-hidden="true">
                            <span className="settings-developer-tools-toggle-thumb" />
                          </span>
                          <span className="settings-developer-tools-toggle-state">
                            {advancedUseEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </button>
                      </div>

                      <div className="settings-developer-tools-card settings-diagnostic-card">
                        <div className="settings-developer-tools-copy">
                          <span className="settings-developer-tools-icon" aria-hidden="true">
                            <IconSearch size={17} />
                          </span>

                          <div className="settings-developer-tools-text">
                            <strong>Local Search Engine</strong>
                            <p>Crawls your chosen seed sites into a persistent Go-powered index, and the live research pipeline now checks that local index before falling back to DuckDuckGo and Google.</p>
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn settings-diagnostic-run-btn"
                          onClick={() => void handleCrawlSearchEngine()}
                          disabled={!localSearchAvailable || localSearchCrawlRunning || localSearchBusy || !localSearchSeeds.length}
                        >
                          <IconRefreshCw size={15} />
                          {localSearchCrawlRunning ? 'Crawling...' : localSearchSeeds.length ? 'Run Crawl' : 'Add Seed First'}
                        </button>
                      </div>

                      <div
                        className={`settings-diagnostic-results${localSearchAvailable ? '' : ' is-fail'}`}
                        aria-live="polite"
                      >
                        <div className="settings-diagnostic-results-head">
                          <span className={`settings-diagnostic-badge${localSearchAvailable ? ' pass' : ' fail'}`}>
                            {localSearchAvailable ? <IconCheck size={14} /> : <IconX size={14} />}
                            <span>{localSearchAvailable ? 'Integrated' : 'Unavailable'}</span>
                          </span>

                          <span className="settings-inline-note">
                            {localSearchAvailable
                              ? `${localSearchStatus?.documentCount ?? 0} indexed page${(localSearchStatus?.documentCount ?? 0) === 1 ? '' : 's'} • ${localSearchStatus?.seedCount ?? 0} seed${(localSearchStatus?.seedCount ?? 0) === 1 ? '' : 's'}`
                              : desktopRuntime
                                ? 'The app is running without the local-search bridge methods.'
                                : 'Desktop runtime required for the embedded Go search engine.'}
                          </span>
                        </div>

                        <p className="settings-diagnostic-summary">
                          {localSearchAvailable
                            ? 'Use seed URLs to bootstrap the local crawler. As deep-research runs, externally scraped pages are also fed back into this index so the in-house engine improves over time.'
                            : 'Local crawling and persistent indexing are only available when the app is running through the desktop runtime.'}
                        </p>

                        {localSearchAvailable && (
                          <>
                            <div className="settings-local-search-stats">
                              <span className="settings-local-search-stat">
                                <strong>{localSearchStatus?.defaultMaxPages ?? 0}</strong>
                                <span>default crawl pages</span>
                              </span>
                              <span className="settings-local-search-stat">
                                <strong>{localSearchStatus?.defaultMaxDepth ?? 0}</strong>
                                <span>default crawl depth</span>
                              </span>
                              <span className="settings-local-search-stat">
                                <strong>{localSearchStatus?.fetchConcurrency ?? 0}</strong>
                                <span>parallel fetch workers</span>
                              </span>
                              <span className="settings-local-search-stat">
                                <strong>{formatLocalSearchTimestamp(localSearchStatus?.lastIndexedAt)}</strong>
                                <span>last index refresh</span>
                              </span>
                            </div>

                            <div className="settings-local-search-controls">
                              <label className="settings-local-search-control">
                                <span>Next crawl pages</span>
                                <input
                                  className="settings-local-search-input"
                                  type="number"
                                  min={1}
                                  max={100000}
                                  step={100}
                                  value={localSearchMaxPagesDraft}
                                  onChange={(event) => setLocalSearchMaxPagesDraft(event.target.value)}
                                  disabled={localSearchBusy || localSearchCrawlRunning}
                                />
                              </label>
                              <label className="settings-local-search-control">
                                <span>Next crawl depth</span>
                                <input
                                  className="settings-local-search-input"
                                  type="number"
                                  min={0}
                                  max={6}
                                  step={1}
                                  value={localSearchMaxDepthDraft}
                                  onChange={(event) => setLocalSearchMaxDepthDraft(event.target.value)}
                                  disabled={localSearchBusy || localSearchCrawlRunning}
                                />
                              </label>
                            </div>

                            <p className="settings-inline-note">
                              Large docs and newsroom sites can now fan out through their sitemaps, so a single crawl can cover tens of thousands of indexed paths instead of stopping at a few linked pages.
                            </p>

                            <div className="settings-local-search-seed-form">
                              <input
                                className="settings-local-search-input"
                                type="url"
                                inputMode="url"
                                placeholder="https://example.com"
                                value={localSearchSeedUrlDraft}
                                onChange={(event) => setLocalSearchSeedUrlDraft(event.target.value)}
                                disabled={localSearchBusy || localSearchCrawlRunning}
                              />
                              <input
                                className="settings-local-search-input"
                                type="text"
                                placeholder="Optional label"
                                value={localSearchSeedLabelDraft}
                                onChange={(event) => setLocalSearchSeedLabelDraft(event.target.value)}
                                disabled={localSearchBusy || localSearchCrawlRunning}
                              />
                              <button
                                type="button"
                                className="btn settings-secondary-btn"
                                onClick={() => void handleAddSearchEngineSeed()}
                                disabled={localSearchBusy || localSearchCrawlRunning}
                              >
                                {localSearchBusy ? 'Saving...' : 'Add Seed'}
                              </button>
                            </div>

                            {localSearchSeeds.length ? (
                              <div className="settings-local-search-seeds">
                                {localSearchSeeds.map((seed) => (
                                  <div key={seed.id} className="settings-local-search-seed-chip">
                                    <div className="settings-local-search-seed-copy">
                                      <strong>{seed.label}</strong>
                                      <span>{seed.url}</span>
                                    </div>
                                    <button
                                      type="button"
                                      className="settings-local-search-seed-remove"
                                      onClick={() => void handleDeleteSearchEngineSeed(seed)}
                                      disabled={localSearchBusy || localSearchCrawlRunning}
                                      aria-label={`Remove ${seed.label}`}
                                    >
                                      <IconX size={13} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="settings-inline-note">No seed sites yet. Add a site root, docs portal, newsroom, or knowledge base to start building the local index.</p>
                            )}

                            {localSearchLastCrawl && (
                              <div className="settings-local-search-crawl-note">
                                <strong>Last crawl</strong>
                                <span>
                                  {formatLocalSearchTimestamp(localSearchLastCrawl.completedAt)} • {localSearchLastCrawl.indexedCount} indexed • {localSearchLastCrawl.crawledCount} fetched
                                  {localSearchLastCrawl.errorCount > 0 ? ` • ${localSearchLastCrawl.errorCount} error${localSearchLastCrawl.errorCount === 1 ? '' : 's'}` : ''}
                                </span>
                                {localSearchLastCrawl.lastError && (
                                  <span>{localSearchLastCrawl.lastError}</span>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <div className="settings-developer-tools-card settings-diagnostic-card">
                        <div className="settings-developer-tools-copy">
                          <span className="settings-developer-tools-icon" aria-hidden="true">
                            <IconSearch size={17} />
                          </span>

                          <div className="settings-developer-tools-text">
                            <strong>Deep Research Search Engine Test</strong>
                            <p>Runs DuckDuckGo and Google Search through the live deep-research fetch pipeline and only passes if search, scrape, and verification all succeed.</p>
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn settings-diagnostic-run-btn"
                          onClick={() => void handleRunDeepResearchSearchEngineTest()}
                          disabled={deepResearchSearchTestRunning}
                        >
                          <IconRefreshCw size={15} />
                          {deepResearchSearchTestRunning ? 'Running Test...' : deepResearchSearchTestResult ? 'Run Again' : 'Run Test'}
                        </button>
                      </div>

                      {(deepResearchSearchTestRunning || deepResearchSearchTestResult) && (
                        <div
                          className={`settings-diagnostic-results${deepResearchSearchTestResult?.status === 'fail' ? ' is-fail' : ''}`}
                          aria-live="polite"
                        >
                          <div className="settings-diagnostic-results-head">
                            <span className={`settings-diagnostic-badge${deepResearchSearchTestRunning ? ' running' : deepResearchSearchTestResult?.status === 'pass' ? ' pass' : ' fail'}`}>
                              {deepResearchSearchTestRunning ? (
                                <IconRefreshCw size={14} />
                              ) : deepResearchSearchTestResult?.status === 'pass' ? (
                                <IconCheck size={14} />
                              ) : (
                                <IconX size={14} />
                              )}
                              <span>
                                {deepResearchSearchTestRunning ? 'Running' : deepResearchSearchTestResult?.status === 'pass' ? 'Pass' : 'Fail'}
                              </span>
                            </span>

                            <span className="settings-inline-note">
                              {deepResearchSearchTestRunning
                                ? 'Checking DuckDuckGo and Google Search through the live /__fetch transport...'
                                : deepResearchSearchTestResult
                                  ? `Last run ${formatDiagnosticTimestamp(deepResearchSearchTestResult.completedAt)} • ${formatDiagnosticDuration(deepResearchSearchTestResult.durationMs)}`
                                  : ''}
                            </span>
                          </div>

                          {!deepResearchSearchTestRunning && deepResearchSearchTestResult && (
                            <>
                              <p className="settings-diagnostic-summary">{deepResearchSearchTestResult.summary}</p>

                              <div className="settings-diagnostic-actions">
                                <button
                                  type="button"
                                  className="btn settings-secondary-btn settings-diagnostic-download-btn"
                                  onClick={handleDownloadDeepResearchSearchEngineTest}
                                >
                                  <IconDownload size={14} />
                                  Download Report (.md)
                                </button>
                                <span className="settings-inline-note">
                                  Share the downloaded file directly with developers or upload it back here for debugging.
                                </span>
                              </div>

                              {deepResearchSearchTestResult.probes.length > 0 && (
                                <div className="settings-diagnostic-engine-grid">
                                  {deepResearchSearchTestResult.probes.map((probe) => (
                                    <div
                                      key={probe.engine}
                                      className={`settings-diagnostic-engine-card ${probe.status}`}
                                    >
                                      <div className="settings-diagnostic-engine-head">
                                        <strong>{probe.label}</strong>
                                        <span className={`settings-diagnostic-engine-status ${probe.status}`}>
                                          {probe.status === 'pass' ? 'Pass' : 'Fail'}
                                        </span>
                                      </div>

                                      {probe.rootCause && (
                                        <p className="settings-diagnostic-engine-cause">
                                          <strong>Root cause:</strong> {probe.rootCause}
                                        </p>
                                      )}

                                      <p>{probe.reasoning}</p>

                                      <div className="settings-diagnostic-engine-meta">
                                        <span>{probe.searchResultCount} parsed</span>
                                        <span>{probe.scrapedPageCount} scraped</span>
                                        <span>{formatDiagnosticDuration(probe.durationMs)}</span>
                                      </div>

                                      {probe.verifiedUrl && (
                                        <a
                                          className="settings-diagnostic-engine-link"
                                          href={probe.verifiedUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          {probe.verifiedTitle || probe.verifiedUrl}
                                        </a>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {deepResearchSearchTestResult.status === 'fail' && (
                                <div className="settings-diagnostic-report">
                                  <strong>Failure reasoning for developers</strong>
                                  <pre>{deepResearchSearchTestResult.reportText}</pre>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </section>
                  )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
          ) : route.kind === 'landing' ? (
            <PromptLibraryView
              page="landing"
              chats={chats}
              folders={projectFolders}
              defaultModel={resolvedDefaultModel}
              defaultChatPreset={defaultChatPreset}
              defaultReasoningEffort={defaultReasoningEffort}
              models={models}
              onStartChat={handleStartChatFromHome}
              onOpenChat={handleOpenFromHistory}
              onCreateChatInFolder={handleCreateCodeThreadInFolder}
              onOpenWorkspaceLauncher={openWorkspaceLauncher}
              onDeleteChat={requestDeleteChat}
              onDeleteWorkspace={requestDeleteWorkspace}
              onGoToChat={() => navigate('/chat')}
              onGoToCode={() => navigate('/code')}
            />
          ) : route.kind === 'chat-start' ? (
            <div className="workbench-route-shell chat-route-shell">
              {chatSidebar}
              <div className="workbench-route-main">
                <div id="workspace" className="chat-route-workspace chat-root-workspace">
                  <div id="panels-area" className={`chat-panel-strip panels-${chatDisplayFrameCount}`}>
                    {chatDisplayPanels.map((panel) => (
                      <ChatPanel
                        key={panel.id}
                        panel={panel}
                        models={models}
                        showAdvancedUse={advancedUseEnabled}
                        onUpdate={updatePanel}
                        onClose={closePanel}
                        onSave={savePanel}
                        selected={activePanelId === panel.id}
                        onActivate={activatePanel}
                        launchPrompt={queuedLaunchPrompts[panel.id] ?? null}
                        onConsumeLaunchPrompt={consumeLaunchPrompt}
                        onPrepareWorkspaceRun={prepareWorkspaceRun}
                        onReadWorkspaceContext={readWorkspaceRunContext}
                        onApplyWorkspaceStep={applyWorkspaceStepChange}
                        onCommitWorkspaceRun={commitWorkspaceRun}
                        onRestoreWorkspaceBackup={restoreWorkspaceRunBackup}
                        onImportWorkspaceFiles={(files) => {
                          if (!panel.projectId || !panel.projectLabel) return;
                          void handleImportDirectory(files, {
                            id: panel.projectId,
                            label: panel.projectLabel,
                          });
                        }}
                      />
                    ))}

                    {embeddedChatStarterFrame}
                  </div>
                </div>
              </div>
            </div>
          ) : route.kind === 'code-start' ? (
            <div className="workbench-route-shell code-route-shell">
              <Sidebar
                mode="code"
                workspaces={codeWorkspaceGroups}
                activeWorkspaceId={selectedCodeWorkspaceId}
                activeChatId={null}
                activeFilePath={activeCodeSidebarFilePath}
                onCreateWorkspace={() => void openWorkspaceLauncher()}
                onSelectWorkspace={handleSelectCodeWorkspace}
                onClearActiveWorkspace={handleClearSelectedCodeWorkspace}
                onCreateChat={handleCreateCodeChat}
                onOpenChat={handleOpenFromHistory}
                onOpenFile={handleOpenWorkspaceFile}
                onCreateFileInFolder={handleCreateWorkspaceFileInFolder}
                onCreateFolderInFolder={handleCreateWorkspaceFolderInFolder}
                onRenameFile={handleRenameWorkspaceFile}
                onRenameFolder={handleRenameWorkspaceFolder}
                onDuplicateFile={handleDuplicateWorkspaceFile}
                onDeleteFile={handleDeleteWorkspaceFile}
                onDeleteFolder={handleDeleteWorkspaceFolder}
                onCopyFilePath={handleCopyWorkspaceFilePath}
                onCopyFolderPath={handleCopyWorkspaceFolderPath}
                onOpenFileOutsideApp={handleOpenWorkspaceFileOutsideApp}
                onOpenFolderOutsideApp={handleOpenWorkspaceFolderOutsideApp}
                onArchiveChat={requestArchiveChat}
                onRenameWorkspace={handleRenameWorkspace}
                onArchiveWorkspace={requestArchiveWorkspace}
                onOpenWorkspaceInExplorer={handleOpenWorkspaceInExplorer}
                onRefreshWorkspace={handleRefreshWorkspace}
                onOpenSettings={() => navigate('/settings')}
              />
              <div className="workbench-route-main">
                <div className="code-workbench-shell">
                  {codeWorkbenchMenubar}
                  {activeWorkspaceFile ? (
                    <div id="workspace" className="chat-route-workspace explorer-chat-workspace code-workbench-workspace">
                      <div id="panels-area" className="code-workbench-panel-area">
                        <WorkspaceFileEditorPanel
                          document={activeWorkspaceFile}
                          autoSaveEnabled={codeEditorAutoSaveEnabled}
                          showIndentGuides={codeEditorIndentGuidesEnabled}
                          onChangeContent={handleChangeActiveWorkspaceFile}
                          onSave={() => void handleSaveActiveWorkspaceFile()}
                          onReload={handleReloadActiveWorkspaceFile}
                          onRevert={handleRevertActiveWorkspaceFile}
                          onClose={handleCloseActiveWorkspaceFile}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="code-workbench-stage">
                      <CodeWorkspaceStage
                        workspace={selectedCodeWorkspace}
                        onCreateChat={handleCreateCodeChat}
                        onOpenChat={handleOpenFromHistory}
                        onRefreshWorkspace={() => {
                          if (selectedCodeWorkspace) {
                            handleRefreshWorkspace(selectedCodeWorkspace);
                          }
                        }}
                        onOpenInExplorer={() => {
                          if (selectedCodeWorkspace) {
                            void handleOpenWorkspaceInExplorer(selectedCodeWorkspace);
                          }
                        }}
                      />
                    </div>
                  )}
                  {codeWorkbenchTerminal}
                </div>
              </div>
            </div>
          ) : route.kind === 'not-found' ? (
            <div id="workspace">
              <div id="no-panels" className="route-state">
                <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                  <IconHexagon size={72} />
                </div>
                <h2>Route not found</h2>
                <p>The path "{route.path}" does not match a local chat route.</p>
                <button className="btn" onClick={() => navigate('/chat')}>
                  Go to chat
                </button>
              </div>
            </div>
          ) : isCodeSurfaceRoute ? (
            <div className="workbench-route-shell code-route-shell">
              <Sidebar
                mode="code"
                workspaces={codeWorkspaceGroups}
                activeWorkspaceId={selectedCodeWorkspaceId}
                activeChatId={activeCodeSidebarChatId}
                activeFilePath={activeCodeSidebarFilePath}
                onCreateWorkspace={() => void openWorkspaceLauncher()}
                onSelectWorkspace={handleSelectCodeWorkspace}
                onClearActiveWorkspace={handleClearSelectedCodeWorkspace}
                onCreateChat={handleCreateCodeChat}
                onOpenChat={handleOpenFromHistory}
                onOpenFile={handleOpenWorkspaceFile}
                onCreateFileInFolder={handleCreateWorkspaceFileInFolder}
                onCreateFolderInFolder={handleCreateWorkspaceFolderInFolder}
                onRenameFile={handleRenameWorkspaceFile}
                onRenameFolder={handleRenameWorkspaceFolder}
                onDuplicateFile={handleDuplicateWorkspaceFile}
                onDeleteFile={handleDeleteWorkspaceFile}
                onDeleteFolder={handleDeleteWorkspaceFolder}
                onCopyFilePath={handleCopyWorkspaceFilePath}
                onCopyFolderPath={handleCopyWorkspaceFolderPath}
                onOpenFileOutsideApp={handleOpenWorkspaceFileOutsideApp}
                onOpenFolderOutsideApp={handleOpenWorkspaceFolderOutsideApp}
                onArchiveChat={requestArchiveChat}
                onRenameWorkspace={handleRenameWorkspace}
                onArchiveWorkspace={requestArchiveWorkspace}
                onOpenWorkspaceInExplorer={handleOpenWorkspaceInExplorer}
                onRefreshWorkspace={handleRefreshWorkspace}
                onOpenSettings={() => navigate('/settings')}
              />
              <div className="workbench-route-main">
                <div className="code-workbench-shell">
                  {codeWorkbenchMenubar}
                  <div id="workspace" className="chat-route-workspace explorer-chat-workspace code-workbench-workspace">
                    {activeWorkspaceFile ? (
                      <div id="panels-area" className="code-workbench-panel-area">
                        <WorkspaceFileEditorPanel
                          document={activeWorkspaceFile}
                          autoSaveEnabled={codeEditorAutoSaveEnabled}
                          showIndentGuides={codeEditorIndentGuidesEnabled}
                          onChangeContent={handleChangeActiveWorkspaceFile}
                          onSave={() => void handleSaveActiveWorkspaceFile()}
                          onReload={handleReloadActiveWorkspaceFile}
                          onRevert={handleRevertActiveWorkspaceFile}
                          onClose={handleCloseActiveWorkspaceFile}
                        />
                      </div>
                    ) : activeCodePanel ? (
                      <div id="panels-area" className="code-workbench-panel-area">
                        <ChatPanel
                          key={activeCodePanel.id}
                          panel={activeCodePanel}
                          models={models}
                          showAdvancedUse={advancedUseEnabled}
                          onUpdate={updatePanel}
                          onClose={closePanel}
                          onSave={savePanel}
                          selected={activePanelId === activeCodePanel.id}
                          onActivate={activatePanel}
                          launchPrompt={queuedLaunchPrompts[activeCodePanel.id] ?? null}
                          onConsumeLaunchPrompt={consumeLaunchPrompt}
                          onPrepareWorkspaceRun={prepareWorkspaceRun}
                          onReadWorkspaceContext={readWorkspaceRunContext}
                          onApplyWorkspaceStep={applyWorkspaceStepChange}
                          onCommitWorkspaceRun={commitWorkspaceRun}
                          onRestoreWorkspaceBackup={restoreWorkspaceRunBackup}
                          onImportWorkspaceFiles={(files) => {
                            if (!activeCodePanel.projectId || !activeCodePanel.projectLabel) return;
                            void handleImportDirectory(files, {
                              id: activeCodePanel.projectId,
                              label: activeCodePanel.projectLabel,
                            });
                          }}
                        />
                      </div>
                    ) : (
                      <div id="no-panels" className="route-state code-workbench-empty">
                        <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                          <IconHexagon size={72} />
                        </div>
                        <h2>{isMissingChatRoute ? 'Chat not found' : 'Opening chat'}</h2>
                        <p>
                          {isMissingChatRoute
                            ? 'That route does not match a saved code chat. Start a new prompt or reopen one from the sidebar.'
                            : `Loading the requested local chat from ${storageSystemLabel}.`}
                        </p>
                        <button className="btn" onClick={() => navigate('/code')}>
                          Return to code
                        </button>
                      </div>
                    )}
                  </div>
                  {codeWorkbenchTerminal}
                </div>
              </div>
            </div>
          ) : (
            <div className="workbench-route-shell chat-route-shell">
              {chatSidebar}
              <div className="workbench-route-main">
                <div id="workspace" className="chat-route-workspace">
                  {chatDisplayPanels.length || showEmbeddedChatStarter ? (
                    <div id="panels-area" className={`chat-panel-strip panels-${chatDisplayFrameCount}`}>
                      {chatDisplayPanels.map((panel) => (
                        <ChatPanel
                          key={panel.id}
                          panel={panel}
                          models={models}
                          showAdvancedUse={advancedUseEnabled}
                          onUpdate={updatePanel}
                          onClose={closePanel}
                          onSave={savePanel}
                          selected={activePanelId === panel.id}
                          onActivate={activatePanel}
                          launchPrompt={queuedLaunchPrompts[panel.id] ?? null}
                          onConsumeLaunchPrompt={consumeLaunchPrompt}
                          onPrepareWorkspaceRun={prepareWorkspaceRun}
                          onReadWorkspaceContext={readWorkspaceRunContext}
                          onApplyWorkspaceStep={applyWorkspaceStepChange}
                          onCommitWorkspaceRun={commitWorkspaceRun}
                          onRestoreWorkspaceBackup={restoreWorkspaceRunBackup}
                          onImportWorkspaceFiles={(files) => {
                            if (!panel.projectId || !panel.projectLabel) return;
                            void handleImportDirectory(files, {
                              id: panel.projectId,
                              label: panel.projectLabel,
                            });
                          }}
                        />
                      ))}

                      {embeddedChatStarterFrame}
                    </div>
                  ) : (
                    <div id="no-panels" className="route-state">
                      <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                        <IconHexagon size={72} />
                      </div>
                      <h2>{isMissingChatRoute ? 'Chat not found' : 'Opening chat'}</h2>
                      <p>
                        {isMissingChatRoute
                          ? 'That route does not match a saved local chat. Start a new prompt or reopen one from the sidebar.'
                          : `Loading the requested local chat from ${storageSystemLabel}.`}
                      </p>
                      <button className="btn" onClick={() => navigate('/chat')}>
                        Return to chat
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {chatLaunchTransition && pendingChatLaunchPanel && (
        <div className="chat-launch-background-runner" aria-hidden="true">
          <ChatPanel
            key={`launch-${pendingChatLaunchPanel.id}`}
            panel={pendingChatLaunchPanel}
            models={models}
            showAdvancedUse={advancedUseEnabled}
            onUpdate={updatePanel}
            onClose={closePanel}
            onSave={savePanel}
            backgroundMode={true}
            launchPrompt={queuedLaunchPrompts[pendingChatLaunchPanel.id] ?? null}
            onConsumeLaunchPrompt={consumeLaunchPrompt}
            onPrepareWorkspaceRun={prepareWorkspaceRun}
            onReadWorkspaceContext={readWorkspaceRunContext}
            onApplyWorkspaceStep={applyWorkspaceStepChange}
            onCommitWorkspaceRun={commitWorkspaceRun}
            onRestoreWorkspaceBackup={restoreWorkspaceRunBackup}
          />
        </div>
      )}

      {providerDialog && (
        <div className="models-provider-modal-layer" onClick={closeProviderDialog}>
          <div
            className="models-provider-modal"
            role="dialog"
            aria-modal="true"
            aria-label={PROVIDER_UI_META[providerDialog.provider].setupTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="models-provider-modal-header">
              <div className="models-provider-modal-title-wrap">
                <div className="models-provider-modal-copy">
                  <h2>{PROVIDER_UI_META[providerDialog.provider].setupTitle}</h2>
                  <p>{PROVIDER_UI_META[providerDialog.provider].setupDescription}</p>
                </div>
              </div>

              <button
                type="button"
                className="models-provider-modal-close"
                onClick={closeProviderDialog}
                aria-label="Close provider setup"
              >
                <IconX size={15} />
              </button>
            </div>

            <div className="models-provider-modal-body">
              <label className="models-provider-field">
                <span>{PROVIDER_UI_META[providerDialog.provider].fieldLabel}</span>
                <input
                  className="models-provider-input"
                  type={providerDialog.provider === 'ollama' ? 'text' : 'password'}
                  value={providerDialog.credentialValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    setProviderDialog((current) => current ? { ...current, credentialValue: value } : current);
                  }}
                  placeholder={PROVIDER_UI_META[providerDialog.provider].fieldPlaceholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <small>{PROVIDER_UI_META[providerDialog.provider].fieldHelp}</small>
              </label>

              <section className="models-provider-model-picker">
                <div className="models-provider-model-picker-head">
                  <div>
                    <strong>Models</strong>
                    <p>Select models to make available for this provider.</p>
                  </div>

                  <button
                    type="button"
                    className="models-provider-select-all"
                    onClick={selectAllProviderDialogModels}
                  >
                    Select All
                  </button>
                </div>

                <div className="models-provider-model-list">
                  {providerDialogModelOptions.map((model) => {
                    const checked = providerDialog.selectedModels.includes(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        className={`models-provider-model-row${checked ? ' selected' : ''}`}
                        onClick={() => toggleProviderDialogModel(model)}
                      >
                        <span className={`models-provider-model-check${checked ? ' checked' : ''}`} aria-hidden="true">
                          {checked && <IconCheck size={12} />}
                        </span>
                        <span>{getModelDisplayName(model)}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="models-provider-toggle-row">
                <div className="models-provider-toggle-copy">
                  <strong>Auto Update</strong>
                  <p>Update the available models when new models are released.</p>
                </div>

                <button
                  type="button"
                  className={`models-provider-toggle${providerDialog.autoUpdate ? ' active' : ''}`}
                  onClick={() => {
                    setProviderDialog((current) => current ? { ...current, autoUpdate: !current.autoUpdate } : current);
                  }}
                  aria-pressed={providerDialog.autoUpdate}
                >
                  <span className="models-provider-toggle-track" aria-hidden="true">
                    <span className="models-provider-toggle-thumb" />
                  </span>
                </button>
              </div>
            </div>

            <div className="models-provider-modal-footer">
              <div className="models-provider-modal-footer-side">
                {providerDialogHasExistingConnection && (
                  <button
                    type="button"
                    className="models-provider-disconnect"
                    onClick={handleDisconnectProvider}
                  >
                    Disconnect
                  </button>
                )}
              </div>

              <div className="models-provider-modal-footer-actions">
                <button type="button" className="models-provider-footer-btn secondary" onClick={closeProviderDialog}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="models-provider-footer-btn primary"
                  onClick={handleSaveProviderDialog}
                  disabled={!providerDialogCanSubmit}
                >
                  {providerDialog.mode === 'connect' ? 'Connect' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="confirm-backdrop" onClick={closeConfirmDialog}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>

            <div className="confirm-copy">
              <h2>{confirmDialog.title}</h2>
              <p>{confirmDialog.message}</p>
            </div>

            <div className="confirm-actions">
              <button className="confirm-btn" onClick={closeConfirmDialog} disabled={confirmBusy}>
                Cancel
              </button>
              <button
                className="confirm-btn danger"
                onClick={() => void handleConfirmAction()}
                disabled={confirmBusy}
              >
                {confirmBusy ? 'Deleting...' : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
