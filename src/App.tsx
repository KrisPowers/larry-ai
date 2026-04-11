import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { CodeWorkspaceStage } from './components/CodeWorkspaceStage';
import { PromptLibraryView } from './components/PromptLibraryView';
import { Sidebar } from './components/Sidebar';
import { useOllama } from './hooks/useOllama';
import { useDB } from './hooks/useDB';
import { useReplyPreferences } from './hooks/useReplyPreferences';
import { useToast } from './hooks/useToast';
import { createRegistry, updateRegistry } from './lib/fileRegistry';
import { mergeStoredFileEntries } from './lib/chatAttachments';
import { runDeepResearchSearchEngineTest } from './lib/fetcher';
import { isBrowserWorkspacePickerAvailable, pickBrowserWorkspaceDirectory, scanBrowserWorkspace } from './lib/browserWorkspaceHost';
import {
  ANTHROPIC_UI_SAMPLE_KEY,
  DEFAULT_OLLAMA_BASE,
  getModelDisplayLabel,
  OPENAI_UI_SAMPLE_KEY,
  normalizeModelHandle,
  normalizeOllamaBase,
  resolveModelHandle,
} from './lib/ollama';
import { DEFAULT_PRESET_ID, PRESETS, describePreset } from './lib/presets';
import { clearReplyPreferences } from './lib/replyPreferences';
import { isDesktopRuntime, loadStorageSnapshot, saveAppSettings, saveChat as persistChatRecord, saveWorkspaces } from './lib/persistence';
import { createManagedWorkspaceDirectory, isWorkspaceHostAvailable, openWorkspaceInExplorer, pickWorkspaceDirectory, scanWorkspace } from './lib/workspaceHost';
import { IconCheck, IconDownload, IconFolderPlus, IconHexagon, IconMessageSquare, IconRefreshCw, IconSearch, IconSettings, IconTerminal, IconTrash2, IconUpload, IconX } from './components/Icon';
import { applyWorkspaceSnapshot, buildWorkspaceGroups, buildWorkspaceIdFromPath, deriveWorkspaceFromChat, findWorkspaceGroup, normaliseProjectId, workspaceHasLinkedSource, type WorkspaceGroup } from './lib/workspaces';
import { ProviderIcon } from './components/ProviderIcon';
import type { AppSettings, ChatReasoningEffort, Panel, ChatRecord, ProjectFolder, ThreadType, WorkspaceSnapshot } from './types';
import type { FileRegistry } from './lib/fileRegistry';
import type { DeepResearchSearchEngineTestResult } from './lib/fetcher';

const MAX_VISIBLE_CHAT_PANELS = 2;
const CHAT_FORM_TRANSITION_MIN_MS = 2000;
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'balanced';
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

type SettingsTabId = 'workspace' | 'providers' | 'data' | 'shortcuts' | 'advanced';

type ShortcutInsight = {
  keys: string[];
  action: string;
};

type ShortcutInsightGroup = {
  id: string;
  title: string;
  items: ShortcutInsight[];
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
  providers: {
    label: 'Providers',
    title: 'Connections and catalogs',
    description: 'Manage Ollama, hosted provider keys, and the model catalogs they unlock.',
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
    return { kind: 'landing' };
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
    fileRegistry: restoreRegistry(chatData),
    prevRegistry: new Map(),
    streamingPhase: null,
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
        const content = s.replace(/^###\s+Assistant\s*\n/, '').trim();
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

export default function App() {
  const desktopRuntime = isDesktopRuntime();
  const [ollamaEndpoint, setOllamaEndpoint] = useState(DEFAULT_OLLAMA_BASE);
  const [ollamaEndpointDraft, setOllamaEndpointDraft] = useState(DEFAULT_OLLAMA_BASE);
  const [openAIApiKey, setOpenAIApiKey] = useState('');
  const [openAIApiKeyDraft, setOpenAIApiKeyDraft] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicApiKeyDraft, setAnthropicApiKeyDraft] = useState('');
  const { models, providers, status } = useOllama({
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
  const [deepResearchSearchTestResult, setDeepResearchSearchTestResult] = useState<DeepResearchSearchEngineTestResult | null>(null);
  const [deepResearchSearchTestRunning, setDeepResearchSearchTestRunning] = useState(false);
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageSnapshot>({
    supported: true,
  });
  const [hoveredStorageBucketId, setHoveredStorageBucketId] = useState<string | null>(null);
  const storagePopupHideTimeoutRef = useRef<number | null>(null);
  const importLogsSettingsRef = useRef<HTMLInputElement>(null);
  const importWorkspaceLauncherRef = useRef<HTMLInputElement>(null);
  const [selectedCodeWorkspaceId, setSelectedCodeWorkspaceId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [chatStarterVisible, setChatStarterVisible] = useState(false);
  const [chatStarterPanelId, setChatStarterPanelId] = useState<string | null>(null);
  const [chatLaunchTransition, setChatLaunchTransition] = useState<ChatLaunchTransitionState | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('workspace');
  const [settingsReady, setSettingsReady] = useState(false);
  const workspaceMergeInFlightRef = useRef(false);

  const findProjectFolderById = useCallback((projectId?: string | null) => (
    projectId
      ? projectFolders.find((folder) => folder.id === projectId) ?? null
      : null
  ), [projectFolders]);

  const buildPersistedChatRecord = useCallback((
    chat: Omit<ChatRecord, 'updatedAt'> & { updatedAt?: number },
  ): ChatRecord => {
    const linkedWorkspace = findProjectFolderById(chat.projectId);

    return {
      ...chat,
      reasoningEffort: chat.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      updatedAt: chat.updatedAt ?? Date.now(),
      fileEntries: linkedWorkspace && workspaceHasLinkedSource(linkedWorkspace)
        ? undefined
        : cloneFileEntries(chat.fileEntries),
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

  const resolvedDefaultModel = resolveModelHandle(defaultModel, models);

  const navigate = useCallback((path: string, replace = false) => {
    const nextRoute = parseAppRoute(path);
    if (window.location.pathname !== path) {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    }
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseAppRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
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
      setOllamaEndpoint(snapshot.settings.ollamaEndpoint);
      setOpenAIApiKey(snapshot.settings.openAIApiKey);
      setAnthropicApiKey(snapshot.settings.anthropicApiKey);
      setSettingsReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setOllamaEndpointDraft(ollamaEndpoint);
  }, [ollamaEndpoint]);

  useEffect(() => {
    setOpenAIApiKeyDraft(openAIApiKey);
  }, [openAIApiKey]);

  useEffect(() => {
    setAnthropicApiKeyDraft(anthropicApiKey);
  }, [anthropicApiKey]);

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
      ollamaEndpoint,
      openAIApiKey,
      anthropicApiKey,
    };

    void saveAppSettings(nextSettings);
  }, [
    advancedUseEnabled,
    anthropicApiKey,
    defaultChatPreset,
    defaultModel,
    defaultReasoningEffort,
    developerToolsEnabled,
    ollamaEndpoint,
    openAIApiKey,
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
    setProjectFolders((prev) => {
      const nextEntries = folder.fileEntries ? cloneFileEntries(folder.fileEntries) : undefined;
      const existing = prev.find((candidate) => candidate.id === folder.id);
      if (!existing) {
        return [
          ...prev,
          {
            id: folder.id,
            label: folder.label,
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
        if (candidate.id !== folder.id) return candidate;
        return {
          ...candidate,
          label: folder.label,
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
  }, []);

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
    if (!workspaceHasLinkedSource(workspace)) {
      if (!options.silent) {
        toast('This workspace is not linked to a local folder yet.');
      }
      return null;
    }

    try {
      const snapshot = workspace.rootPath
        ? await scanWorkspace(workspace.rootPath)
        : await scanBrowserWorkspace(workspace.browserHandleId!);
      applyWorkspaceSnapshotToState(workspace, snapshot, { unarchive: true });
      if (!options.silent) {
        toast(`Refreshed "${workspace.label}".`);
      }
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh that workspace.';
      if (!options.silent) {
        toast(message);
      }
      return null;
    }
  }, [applyWorkspaceSnapshotToState, toast]);

  const ensureWorkspaceContext = useCallback((workspaceId?: string | null) => {
    const workspace = findProjectFolderById(workspaceId);
    if (!workspace?.rootPath) return;

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

      if (isWorkspaceHostAvailable()) {
        const selection = await pickWorkspaceDirectory();
        if (!selection) return;

        const duplicate = projectFolders.find((folder) => (
          folder.rootPath?.toLowerCase() === selection.rootPath.toLowerCase()
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

        const duplicate = selection.existingWorkspaceId
          ? projectFolders.find((folder) => folder.id === selection.existingWorkspaceId)
          : (
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
    void syncWorkspaceFolder({
      id: workspace.id,
      label: workspace.label,
      createdAt: workspace.createdAt,
      rootPath: workspace.rootPath,
      browserHandleId: workspace.browserHandleId,
    }, { silent: true });
  }, [syncWorkspaceFolder]);

  const handleClearSelectedCodeWorkspace = useCallback(() => {
    setSelectedCodeWorkspaceId(null);
    const currentRecord = route.kind === 'chat'
      ? panels.find((panel) => panel.id === route.chatId) ?? chats.find((chat) => chat.id === route.chatId)
      : null;
    if (route.kind === 'chat' && resolveThreadSurface(currentRecord) === 'code') {
      navigate('/code');
    }
  }, [chats, navigate, panels, route]);

  const handleClearChatSidebarWorkspace = useCallback(() => {
    setSelectedCodeWorkspaceId(null);
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
    const workspaceEntries = cloneFileEntries(
      projectFolders.find((workspace) => workspace.id === folder.id)?.fileEntries,
    );
    upsertProjectFolder({ id: folder.id, label: folder.label });
    openDraftChat({
      title: `${folder.label} ${threadType === 'debug' ? 'Debug' : 'Chat'}`,
      preset: 'code',
      threadType,
      projectId: folder.id,
      projectLabel: folder.label,
      fileEntries: workspaceEntries,
    });
    ensureWorkspaceContext(folder.id);
  }, [ensureWorkspaceContext, openDraftChat, projectFolders, upsertProjectFolder]);

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
    });
  }, [findProjectFolderById, persistWorkspaceChat, upsertProjectFolder]);

  function handleOpenFromHistory(chat: ChatRecord) {
    const existing = panels.find((panel) => panel.id === chat.id);
    if (!existing) {
      const workspaceEntries = chat.projectId
        ? projectFolders.find((folder) => folder.id === chat.projectId)?.fileEntries
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
        ? projectFolders.find((folder) => folder.id === targetFolder.id)
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
        navigate('/');
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
    const workspaceEntries = options.workspace
      ? cloneFileEntries(projectFolders.find((folder) => folder.id === options.workspace?.id)?.fileEntries)
      : [];
    const launchFileEntries = mergeStoredFileEntries(workspaceEntries, cloneFileEntries(options.fileEntries));

    if (options.workspace) {
      upsertProjectFolder({ id: options.workspace.id, label: options.workspace.label });
    }

    const shouldUseChatLaunchTransition =
      options.threadType === 'chat' &&
      (route.kind === 'chat-start' || chatStarterVisible);

    const starterHostPanel = shouldUseChatLaunchTransition && chatStarterPanelId
      ? panels.find((panel) => panel.id === chatStarterPanelId) ?? null
      : null;

    let createdChatId: string;

    if (starterHostPanel && resolveThreadSurface(starterHostPanel) === 'chat' && starterHostPanel.messages.length === 0) {
      const updatedStarterPanel: Panel = {
        ...starterHostPanel,
        title: options.title,
        model: options.model || resolvedDefaultModel,
        preset: options.preset,
        reasoningEffort: options.reasoningEffort ?? starterHostPanel.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        threadType: options.threadType,
        projectId: options.workspace?.id,
        projectLabel: options.workspace?.label,
        fileRegistry: registryFromEntries(launchFileEntries),
      };

      setPanels((prev) => prev.map((panel) => panel.id === starterHostPanel.id
        ? {
            ...panel,
            title: updatedStarterPanel.title,
            model: updatedStarterPanel.model,
            preset: updatedStarterPanel.preset,
            reasoningEffort: updatedStarterPanel.reasoningEffort,
            threadType: updatedStarterPanel.threadType,
            projectId: updatedStarterPanel.projectId,
            projectLabel: updatedStarterPanel.projectLabel,
            fileRegistry: updatedStarterPanel.fileRegistry,
          }
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
        messages: updatedStarterPanel.messages,
        updatedAt: Date.now(),
        fileEntries: launchFileEntries,
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
        projectId: options.workspace?.id,
        projectLabel: options.workspace?.label,
        fileEntries: launchFileEntries,
        initialPrompt: options.prompt,
        navigateOnCreate: !shouldUseChatLaunchTransition,
      });
    }

    ensureWorkspaceContext(options.workspace?.id);

    if (shouldUseChatLaunchTransition) {
      setChatStarterVisible(true);
      setChatLaunchTransition({
        chatId: createdChatId,
        prompt: options.prompt,
        startedAt: Date.now(),
      });
    }

    return true;
  }, [chatStarterPanelId, chatStarterVisible, ensureWorkspaceContext, openDraftChat, panels, persistWorkspaceChat, projectFolders, resolvedDefaultModel, route.kind, upsertProjectFolder]);

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
      ? projectFolders.find((folder) => folder.id === chat.projectId)?.fileEntries
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
    () => findWorkspaceGroup(codeWorkspaceGroups, selectedCodeWorkspaceId),
    [codeWorkspaceGroups, selectedCodeWorkspaceId],
  );
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
  const isChatRouteActive = route.kind === 'chat-start' || (route.kind === 'chat' && activeThreadSurface === 'chat');
  const isCodeRouteActive = isCodeSurfaceRoute;
  const activeChatSidebarId = route.kind === 'chat' && activeThreadSurface === 'chat'
    ? activePanel?.id ?? route.chatId
    : null;
  const activeCodeSidebarChatId = route.kind === 'chat' && activeThreadSurface === 'code'
    ? activePanel?.id ?? route.chatId
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

  const statusLabel =
    status === 'connecting' ? 'checking providers...' :
    onlineProviders.length
      ? `${onlineProviders.map((provider) => provider.label).join(', ')} / ${models.length} model${models.length !== 1 ? 's' : ''}`
      : enabledProviders.length
        ? 'no providers available'
        : 'no providers configured';

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
  void openAIStatusText;
  void anthropicStatusText;
  const defaultChatPresetMeta = CHAT_DEFAULT_PRESETS.find((preset) => preset.id === defaultChatPreset) ?? CHAT_DEFAULT_PRESETS[0];
  const defaultModelLabel = resolvedDefaultModel ? getModelDisplayLabel(resolvedDefaultModel) : 'No model ready';
  const defaultReasoningLabel = getReasoningEffortLabel(defaultReasoningEffort);
  const configuredHostedProviders = Number(Boolean(openAIApiKey)) + Number(Boolean(anthropicApiKey));
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
      id: 'providers' as const,
      label: SETTINGS_TAB_META.providers.label,
      title: SETTINGS_TAB_META.providers.title,
      description: SETTINGS_TAB_META.providers.description,
      summary: `${onlineProviders.length}/${providers.length || 3} online`,
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

  const applyOllamaEndpoint = useCallback(() => {
    const next = normalizeOllamaBase(ollamaEndpointDraft);
    setOllamaEndpoint(next);
    setOllamaEndpointDraft(next);
    toast(`Ollama endpoint set to ${next}`);
  }, [ollamaEndpointDraft, toast]);

  const resetOllamaEndpoint = useCallback(() => {
    const next = normalizeOllamaBase(DEFAULT_OLLAMA_BASE);
    setOllamaEndpoint(next);
    setOllamaEndpointDraft(next);
    toast('Ollama endpoint reset to the default local address.');
  }, [toast]);

  const applyOpenAIKey = useCallback(() => {
    const next = openAIApiKeyDraft.trim();
    setOpenAIApiKey(next);
    toast(next ? `OpenAI API key saved to the ${localPersistenceLabel}.` : 'OpenAI API key removed.');
  }, [localPersistenceLabel, openAIApiKeyDraft, toast]);

  const clearOpenAIKey = useCallback(() => {
    setOpenAIApiKey('');
    setOpenAIApiKeyDraft('');
    toast('OpenAI API key cleared.');
  }, [toast]);

  const useSampleOpenAIKey = useCallback(() => {
    const next = OPENAI_UI_SAMPLE_KEY;
    setOpenAIApiKey(next);
    setOpenAIApiKeyDraft(next);
    toast('OpenAI sample UI key applied.');
  }, [toast]);

  const applyAnthropicKey = useCallback(() => {
    const next = anthropicApiKeyDraft.trim();
    setAnthropicApiKey(next);
    toast(next ? `Anthropic API key saved to the ${localPersistenceLabel}.` : 'Anthropic API key removed.');
  }, [anthropicApiKeyDraft, localPersistenceLabel, toast]);

  const clearAnthropicKey = useCallback(() => {
    setAnthropicApiKey('');
    setAnthropicApiKeyDraft('');
    toast('Anthropic API key cleared.');
  }, [toast]);

  const useSampleAnthropicKey = useCallback(() => {
    const next = ANTHROPIC_UI_SAMPLE_KEY;
    setAnthropicApiKey(next);
    setAnthropicApiKeyDraft(next);
    toast('Anthropic sample UI key applied.');
  }, [toast]);

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
  const chatHistoryBytes = ready ? measurePersistedBytes(chats) : 0;
  const workspaceStorageBytes = measurePersistedBytes(projectFolders);
  const workspaceDefaultStorageBytes = measurePersistedBytes({
    defaultModel: defaultModel || undefined,
    defaultChatPreset: defaultChatPreset !== DEFAULT_PRESET_ID ? defaultChatPreset : undefined,
    defaultReasoningEffort: defaultReasoningEffort !== DEFAULT_REASONING_EFFORT ? defaultReasoningEffort : undefined,
    developerToolsEnabled: developerToolsEnabled || undefined,
    advancedUseEnabled: advancedUseEnabled || undefined,
  });
  const providerConnectionStorageBytes = measurePersistedBytes({
    ollamaEndpoint: ollamaEndpoint !== DEFAULT_OLLAMA_BASE ? ollamaEndpoint : undefined,
    openAIApiKey: openAIApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
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
  }, [chatStarterPanelId, defaultChatPreset, defaultReasoningEffort, navigate, openDraftChat, panels]);
  const chatSidebar = selectedCodeWorkspace ? (
    <Sidebar
      mode="code"
      workspaces={codeWorkspaceGroups}
      activeWorkspaceId={selectedCodeWorkspace.id}
      activeChatId={activeChatSidebarId}
      onCreateWorkspace={() => void openWorkspaceLauncher()}
      onSelectWorkspace={handleSelectSidebarWorkspace}
      onClearActiveWorkspace={handleClearChatSidebarWorkspace}
      onCreateChat={handleCreateCodeChat}
      onOpenChat={handleOpenFromHistory}
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
        <header className="route-header">
          <button className="route-brand" onClick={() => navigate('/')} title="Home">
            Larry AI
          </button>

          <div className="route-header-nav">
            <button
              className={`route-link${route.kind === 'landing' ? ' active' : ''}`}
              onClick={() => navigate('/')}
            >
              Home
            </button>
            <button
              className={`route-link${isChatRouteActive ? ' active' : ''}`}
              onClick={() => navigate('/chat')}
            >
              Chat
            </button>
            <button
              className={`route-link${isCodeRouteActive ? ' active' : ''}`}
              onClick={() => navigate('/code')}
            >
              Code
            </button>
          </div>
        </header>

        <div id="main-content">
          {route.kind === 'settings' ? (
            <div id="settings-view">
              <div className="settings-stage">
                <div className="settings-header">
                    <span className="settings-eyebrow">Settings</span>
                    <h2>Workspace controls</h2>
                    <p>Pick defaults for new chats, manage providers, review local data, and keep the app&apos;s shortcut system easy to discover.</p>

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
                      <span className="settings-overview-label">Providers</span>
                      <strong>{onlineProviders.length} online</strong>
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

                <div className="settings-tab-strip" role="tablist" aria-label="Settings categories">
                  {settingsTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={settingsTab === tab.id}
                      className={`settings-tab-pill${settingsTab === tab.id ? ' active' : ''}`}
                      onClick={() => setSettingsTab(tab.id)}
                    >
                      <span className="settings-tab-pill-label">{tab.label}</span>
                      <span className="settings-tab-pill-summary">{tab.summary}</span>
                    </button>
                  ))}
                </div>

                <section className="settings-panel">
                  <div className="settings-panel-head">
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

                  {settingsTab === 'providers' && (
                    <>
                      <section className="settings-card settings-card-spacious">
                        <div className="settings-card-head">
                          <div>
                            <span className="settings-card-kicker">Readiness</span>
                            <h4>Provider status</h4>
                          </div>
                          <span className="settings-badge settings-badge-soft">
                            {onlineProviders.length} online
                          </span>
                        </div>

                        <div className="settings-provider-status-grid">
                          {providers.map((provider) => {
                            const providerSummary = provider.online
                              ? `${provider.modelCount} model${provider.modelCount !== 1 ? 's' : ''} available`
                              : provider.enabled
                                ? provider.error || 'Configured but currently unavailable'
                                : provider.provider === 'ollama'
                                  ? 'Local endpoint not reachable yet'
                                  : 'No key saved';

                            return (
                              <article
                                key={provider.provider}
                                className={`settings-provider-status-card${provider.online ? ' is-online' : provider.enabled ? ' is-enabled' : ''}`}
                              >
                                <div className="settings-provider-status-head">
                                  <span className="settings-provider-status-icon" aria-hidden="true">
                                    <ProviderIcon provider={provider.provider} size={20} />
                                  </span>

                                  <div className="settings-provider-status-copy">
                                    <strong>{provider.label}</strong>
                                    <span>{providerSummary}</span>
                                  </div>

                                  <span className={`settings-badge ${provider.online ? 'settings-badge-success' : provider.enabled ? 'settings-badge-warning' : 'settings-badge-soft'}`}>
                                    {provider.online ? 'Online' : provider.enabled ? 'Issue' : 'Inactive'}
                                  </span>
                                </div>

                                {provider.mode === 'sample' && (
                                  <p className="settings-inline-note">Using sample catalog mode for UI-only testing.</p>
                                )}
                              </article>
                            );
                          })}
                        </div>
                      </section>

                      <div className="settings-provider-grid">
                        <div className="settings-provider-card">
                          <div className="settings-provider-card-head">
                            <strong>Ollama</strong>
                            <span className="settings-inline-note">{ollamaStatusLabel}</span>
                          </div>

                          <label className="settings-field">
                            <span>Endpoint</span>
                            <input
                              className="settings-select settings-input"
                              type="text"
                              value={ollamaEndpointDraft}
                              onChange={(e) => setOllamaEndpointDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  applyOllamaEndpoint();
                                }
                              }}
                              placeholder={DEFAULT_OLLAMA_BASE}
                              spellCheck={false}
                              autoCapitalize="off"
                              autoCorrect="off"
                            />
                          </label>

                          <p className="settings-inline-note">
                            Use a hosted URL for remote instances, or keep <code>{DEFAULT_OLLAMA_BASE}</code> for the standard local setup.
                          </p>

                          <div className="settings-actions">
                            <button className="btn" onClick={applyOllamaEndpoint}>
                              Apply Endpoint
                            </button>
                            <button className="btn settings-secondary-btn" onClick={resetOllamaEndpoint}>
                              Use Default Local Endpoint
                            </button>
                          </div>
                        </div>

                        <div className="settings-provider-card">
                          <div className="settings-provider-card-head">
                            <strong>OpenAI</strong>
                            <span className="settings-inline-note">{openAIProviderStatusText}</span>
                          </div>

                          <label className="settings-field">
                            <span>API key</span>
                            <input
                              className="settings-select settings-input"
                              type="password"
                              value={openAIApiKeyDraft}
                              onChange={(e) => setOpenAIApiKeyDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  applyOpenAIKey();
                                }
                              }}
                              placeholder="sk-..."
                              spellCheck={false}
                              autoCapitalize="off"
                              autoCorrect="off"
                            />
                          </label>

                          <p className="settings-inline-note">
                            Saved in the {localPersistenceLabel}. Use <code>{OPENAI_UI_SAMPLE_KEY}</code> if you only need the catalog visible for UI testing.
                          </p>

                          <div className="settings-actions">
                            <button className="btn" onClick={applyOpenAIKey}>
                              Save Key
                            </button>
                            <button className="btn settings-secondary-btn" onClick={useSampleOpenAIKey}>
                              Use Sample Key
                            </button>
                            <button className="btn settings-secondary-btn" onClick={clearOpenAIKey}>
                              Clear Key
                            </button>
                          </div>
                        </div>

                        <div className="settings-provider-card">
                          <div className="settings-provider-card-head">
                            <strong>Anthropic</strong>
                            <span className="settings-inline-note">{anthropicProviderStatusText}</span>
                          </div>

                          <label className="settings-field">
                            <span>API key</span>
                            <input
                              className="settings-select settings-input"
                              type="password"
                              value={anthropicApiKeyDraft}
                              onChange={(e) => setAnthropicApiKeyDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  applyAnthropicKey();
                                }
                              }}
                              placeholder="sk-ant-..."
                              spellCheck={false}
                              autoCapitalize="off"
                              autoCorrect="off"
                            />
                          </label>

                          <p className="settings-inline-note">
                            Saved in the {localPersistenceLabel}. Use <code>{ANTHROPIC_UI_SAMPLE_KEY}</code> if you only need the Claude catalog unlocked for UI testing.
                          </p>

                          <div className="settings-actions">
                            <button className="btn" onClick={applyAnthropicKey}>
                              Save Key
                            </button>
                            <button className="btn settings-secondary-btn" onClick={useSampleAnthropicKey}>
                              Use Sample Key
                            </button>
                            <button className="btn settings-secondary-btn" onClick={clearAnthropicKey}>
                              Clear Key
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
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
                onCreateWorkspace={() => void openWorkspaceLauncher()}
                onSelectWorkspace={handleSelectCodeWorkspace}
                onClearActiveWorkspace={handleClearSelectedCodeWorkspace}
                onCreateChat={handleCreateCodeChat}
                onOpenChat={handleOpenFromHistory}
                onArchiveChat={requestArchiveChat}
                onRenameWorkspace={handleRenameWorkspace}
                onArchiveWorkspace={requestArchiveWorkspace}
                onOpenWorkspaceInExplorer={handleOpenWorkspaceInExplorer}
                onRefreshWorkspace={handleRefreshWorkspace}
                onOpenSettings={() => navigate('/settings')}
              />
              <div className="workbench-route-main">
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
                <button className="btn" onClick={() => navigate('/')}>
                  Go home
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
                onCreateWorkspace={() => void openWorkspaceLauncher()}
                onSelectWorkspace={handleSelectCodeWorkspace}
                onClearActiveWorkspace={handleClearSelectedCodeWorkspace}
                onCreateChat={handleCreateCodeChat}
                onOpenChat={handleOpenFromHistory}
                onArchiveChat={requestArchiveChat}
                onRenameWorkspace={handleRenameWorkspace}
                onArchiveWorkspace={requestArchiveWorkspace}
                onOpenWorkspaceInExplorer={handleOpenWorkspaceInExplorer}
                onRefreshWorkspace={handleRefreshWorkspace}
                onOpenSettings={() => navigate('/settings')}
              />
              <div className="workbench-route-main">
                <div id="workspace" className="chat-route-workspace explorer-chat-workspace code-workbench-workspace">
                  {activeCodePanel ? (
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
          />
        </div>
      )}

      {confirmDialog && (
        <div className="confirm-backdrop" onClick={closeConfirmDialog}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head">
              <span className="confirm-icon">
                <IconTrash2 size={18} />
              </span>
              <button
                className="confirm-close"
                onClick={closeConfirmDialog}
                title="Close confirmation"
                disabled={confirmBusy}
              >
                <IconX size={14} />
              </button>
            </div>

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
