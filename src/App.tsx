import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { ChatHistoryDrawer } from './components/ChatHistoryDrawer';
import { PromptLibraryView } from './components/PromptLibraryView';
import { Sidebar } from './components/Sidebar';
import { useOllama } from './hooks/useOllama';
import { useDB } from './hooks/useDB';
import { useReplyPreferences } from './hooks/useReplyPreferences';
import { useToast } from './hooks/useToast';
import { createRegistry, updateRegistry } from './lib/fileRegistry';
import { mergeStoredFileEntries } from './lib/chatAttachments';
import { runDeepResearchSearchEngineTest } from './lib/fetcher';
import {
  ANTHROPIC_API_KEY_STORAGE_KEY,
  ANTHROPIC_UI_SAMPLE_KEY,
  DEFAULT_OLLAMA_BASE,
  getAnthropicApiKey,
  getModelDisplayLabel,
  getOpenAIApiKey,
  getOllamaBase,
  OLLAMA_BASE_STORAGE_KEY,
  OPENAI_UI_SAMPLE_KEY,
  OPENAI_API_KEY_STORAGE_KEY,
  normalizeModelHandle,
  resolveModelHandle,
  setAnthropicApiKey as persistAnthropicApiKey,
  setOllamaBase as persistOllamaBase,
  setOpenAIApiKey as persistOpenAIApiKey,
} from './lib/ollama';
import { DEFAULT_PRESET_ID, PRESETS, describePreset } from './lib/presets';
import { REPLY_PREFERENCES_STORAGE_KEY, clearReplyPreferences } from './lib/replyPreferences';
import { IconCheck, IconDownload, IconFolderPlus, IconHexagon, IconMessageSquare, IconRefreshCw, IconSearch, IconSettings, IconTerminal, IconTrash2, IconUpload, IconX } from './components/Icon';
import { deriveWorkspaceFromChat, normaliseProjectId } from './lib/workspaces';
import { ProviderIcon } from './components/ProviderIcon';
import type { ChatReasoningEffort, Panel, ChatRecord, ProjectFolder, ThreadType } from './types';
import type { FileRegistry } from './lib/fileRegistry';
import type { DeepResearchSearchEngineTestResult } from './lib/fetcher';

const FOLDERS_STORAGE_KEY = 'larry_project_folders_v1';
const DEFAULT_MODEL_STORAGE_KEY = 'larry_default_model_v1';
const DEFAULT_CHAT_PRESET_STORAGE_KEY = 'larry_default_chat_preset_v1';
const DEFAULT_REASONING_STORAGE_KEY = 'larry_default_reasoning_effort_v1';
const DEVELOPER_TOOLS_STORAGE_KEY = 'larry_developer_tools_v1';
const ADVANCED_USE_STORAGE_KEY = 'larry_advanced_use_v1';
const MAX_VISIBLE_CHAT_PANELS = 3;
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
  | { kind: 'debug-start' }
  | { kind: 'settings' }
  | { kind: 'chat'; chatId: string }
  | { kind: 'not-found'; path: string };

type SettingsTabId = 'workspace' | 'providers' | 'data' | 'advanced';

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
  advanced: {
    label: 'Advanced',
    title: 'Advanced controls and diagnostics',
    description: 'Expose extra UI controls and run fetch diagnostics when you need deeper visibility.',
  },
};

function buildStartPath(threadType: ThreadType): string {
  if (threadType === 'code') return '/code';
  if (threadType === 'debug') return '/debug';
  return '/chat';
}

function resolveThreadSurface(record?: Partial<Pick<ChatRecord, 'threadType' | 'preset' | 'projectId' | 'projectLabel'>> | null): ThreadType {
  if (record?.threadType === 'chat' || record?.threadType === 'code' || record?.threadType === 'debug') {
    return record.threadType;
  }

  if (record?.preset === 'code' && record.projectId && record.projectLabel) {
    return 'code';
  }

  return 'chat';
}

function measureStringBytes(value: string): number {
  return new Blob([value]).size;
}

function measureJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized ? measureStringBytes(serialized) : 0;
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

function getCustomPresetStorageUsage(): { bytes: number; count: number } {
  try {
    let bytes = 0;
    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || key === DEFAULT_MODEL_STORAGE_KEY || !/preset/i.test(key)) continue;
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
    return { kind: 'debug-start' };
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    target.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT'
  );
}

function isPinnedDraftChatPanel(panel: Panel): boolean {
  if (resolveThreadSurface(panel) !== 'chat') return false;

  const hasAssistantReply = panel.messages.some((message) => message.role === 'assistant');
  return !hasAssistantReply;
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
  const [ollamaEndpoint, setOllamaEndpoint] = useState(() => getOllamaBase());
  const [ollamaEndpointDraft, setOllamaEndpointDraft] = useState(() => getOllamaBase());
  const [openAIApiKey, setOpenAIApiKey] = useState(() => getOpenAIApiKey());
  const [openAIApiKeyDraft, setOpenAIApiKeyDraft] = useState(() => getOpenAIApiKey());
  const [anthropicApiKey, setAnthropicApiKey] = useState(() => getAnthropicApiKey());
  const [anthropicApiKeyDraft, setAnthropicApiKeyDraft] = useState(() => getAnthropicApiKey());
  const { models, providers, status } = useOllama({
    endpoint: ollamaEndpoint,
    openAIApiKey,
    anthropicApiKey,
  });
  const { chats, ready, save, remove, clearAll } = useDB();
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
  const [workspaceLauncherOpen, setWorkspaceLauncherOpen] = useState(false);
  const [workspaceLauncherMode, setWorkspaceLauncherMode] = useState<'create' | 'import'>(
    'create',
  );
  const [workspaceDraftName, setWorkspaceDraftName] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [chatHistoryDrawerOpen, setChatHistoryDrawerOpen] = useState(false);
  const [chatStarterVisible, setChatStarterVisible] = useState(false);
  const [chatStarterPanelId, setChatStarterPanelId] = useState<string | null>(null);
  const [chatLaunchTransition, setChatLaunchTransition] = useState<ChatLaunchTransitionState | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('workspace');

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
    try {
      const raw = localStorage.getItem(FOLDERS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ProjectFolder[];
      if (Array.isArray(parsed)) setProjectFolders(parsed);
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY);
      if (raw) setDefaultModel(raw);
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DEFAULT_CHAT_PRESET_STORAGE_KEY);
      if (raw && CHAT_DEFAULT_PRESETS.some((preset) => preset.id === raw)) {
        setDefaultChatPreset(raw);
      }
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DEFAULT_REASONING_STORAGE_KEY);
      if (isChatReasoningEffort(raw)) {
        setDefaultReasoningEffort(raw);
      }
    } catch {
      // ignore malformed local cache
    }
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
    try {
      const raw = localStorage.getItem(DEVELOPER_TOOLS_STORAGE_KEY);
      if (raw === '1' || raw === 'true') {
        setDeveloperToolsEnabled(true);
      }
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ADVANCED_USE_STORAGE_KEY);
      if (raw === '1' || raw === 'true') {
        setAdvancedUseEnabled(true);
      }
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(projectFolders));
  }, [projectFolders]);

  useEffect(() => {
    if (defaultModel) {
      localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, defaultModel);
    } else {
      localStorage.removeItem(DEFAULT_MODEL_STORAGE_KEY);
    }
  }, [defaultModel]);

  useEffect(() => {
    if (defaultChatPreset && defaultChatPreset !== DEFAULT_PRESET_ID) {
      localStorage.setItem(DEFAULT_CHAT_PRESET_STORAGE_KEY, defaultChatPreset);
    } else {
      localStorage.removeItem(DEFAULT_CHAT_PRESET_STORAGE_KEY);
    }
  }, [defaultChatPreset]);

  useEffect(() => {
    if (defaultReasoningEffort !== DEFAULT_REASONING_EFFORT) {
      localStorage.setItem(DEFAULT_REASONING_STORAGE_KEY, defaultReasoningEffort);
    } else {
      localStorage.removeItem(DEFAULT_REASONING_STORAGE_KEY);
    }
  }, [defaultReasoningEffort]);

  useEffect(() => {
    if (developerToolsEnabled) {
      localStorage.setItem(DEVELOPER_TOOLS_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(DEVELOPER_TOOLS_STORAGE_KEY);
    }
  }, [developerToolsEnabled]);

  useEffect(() => {
    if (advancedUseEnabled) {
      localStorage.setItem(ADVANCED_USE_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(ADVANCED_USE_STORAGE_KEY);
    }
  }, [advancedUseEnabled]);

  useEffect(() => {
    let cancelled = false;

    async function loadBrowserStorageEstimate() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
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
    defaultChatPreset,
    defaultModel,
    defaultReasoningEffort,
    developerToolsEnabled,
    ollamaEndpoint,
    openAIApiKey,
    projectFolders,
    replyPreferences.length,
  ]);

  useEffect(() => {
    if (!workspaceLauncherOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceLauncherOpen(false);
        setWorkspaceLauncherMode('create');
        setWorkspaceDraftName('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceLauncherOpen]);

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

  const closeWorkspaceLauncher = useCallback(() => {
    setWorkspaceLauncherOpen(false);
    setWorkspaceLauncherMode('create');
    setWorkspaceDraftName('');
  }, []);

  const openWorkspaceLauncher = useCallback((mode: 'create' | 'import' = 'create') => {
    setWorkspaceLauncherMode(mode);
    setWorkspaceDraftName('');
    setWorkspaceLauncherOpen(true);
  }, []);

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

    void save({
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
  }, [createPanel, defaultChatPreset, defaultReasoningEffort, navigate, resolvedDefaultModel, save]);

  const upsertProjectFolder = useCallback((folder: {
    id: string;
    label: string;
    createdAt?: number;
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
            fileEntries: nextEntries,
          },
        ];
      }

      return prev.map((candidate) => {
        if (candidate.id !== folder.id) return candidate;
        return {
          ...candidate,
          label: folder.label,
          fileEntries: nextEntries ?? candidate.fileEntries,
        };
      });
    });
  }, []);

  const handleCreateFolder = useCallback((label: string) => {
    const clean = label.trim();
    if (!clean) {
      toast('Enter a workspace name.');
      return false;
    }
    const id = normaliseProjectId(clean);
    upsertProjectFolder({ id, label: clean, fileEntries: [] });
    toast(`Created workspace "${clean}".`);
    return true;
  }, [toast, upsertProjectFolder]);

  const handleCreateChatInFolder = useCallback((folder: { id: string; label: string }, threadType: ThreadType = 'code') => {
    const workspaceEntries = cloneFileEntries(
      projectFolders.find((workspace) => workspace.id === folder.id)?.fileEntries,
    );
    upsertProjectFolder({ id: folder.id, label: folder.label });
    openDraftChat({
      title: `${folder.label} ${threadType === 'debug' ? 'Debug' : 'Code'}`,
      preset: 'code',
      threadType,
      projectId: folder.id,
      projectLabel: folder.label,
      fileEntries: workspaceEntries,
    });
  }, [openDraftChat, projectFolders, upsertProjectFolder]);

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
    if (panel.projectId && panel.projectLabel) {
      upsertProjectFolder({
        id: panel.projectId,
        label: panel.projectLabel,
        fileEntries,
      });
    }
    save({
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
  }, [save, upsertProjectFolder]);

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
    save({
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
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz|lock)$/.test(cleanPath)) continue;
      if (/node_modules|\.git|\.next|dist\/|build\//.test(cleanPath)) continue;
      const fileText = await file.text();
      if (fileText.includes('\0')) continue;
      reg = updateRegistry(reg, [{ path: cleanPath, content: fileText, lang: langFromPath(cleanPath) }], 0);
      added++;
    }

    if (!added) {
      toast('No importable source files found.');
      return;
    }

    const projectLabel = targetFolder?.label || labelOverride?.trim() || importedRoot || 'Project';
    const projectId = targetFolder?.id || normaliseProjectId(projectLabel);
    const workspaceEntries = entriesFromRegistry(reg);

    upsertProjectFolder({
      id: projectId,
      label: projectLabel,
      fileEntries: workspaceEntries,
    });

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
      onConfirm: () => {
        clearReplyPreferences();
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
      void save({
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

    if (shouldUseChatLaunchTransition) {
      setChatStarterVisible(true);
      setChatLaunchTransition({
        chatId: createdChatId,
        prompt: options.prompt,
        startedAt: Date.now(),
      });
    }

    return true;
  }, [chatStarterPanelId, chatStarterVisible, openDraftChat, panels, projectFolders, resolvedDefaultModel, route.kind, save, upsertProjectFolder]);

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
  }, [activePanelId, chats, createPanel, panels, projectFolders, ready, route]);

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
  const visibleChatPanels = useMemo(() => {
    if (!chatSurfacePanels.length) return [];

    if (chatSurfacePanels.length <= MAX_VISIBLE_CHAT_PANELS) {
      return chatSurfacePanels;
    }

    const activeId = activePanel?.id ?? activePanelId ?? null;
    const latestDraftPanel = [...chatSurfacePanels]
      .reverse()
      .find((panel) => isPinnedDraftChatPanel(panel)) ?? null;

    if (!latestDraftPanel) {
      const latestWindowStart = Math.max(0, chatSurfacePanels.length - MAX_VISIBLE_CHAT_PANELS);
      if (!activeId) {
        return chatSurfacePanels.slice(latestWindowStart);
      }

      const activeIndex = chatSurfacePanels.findIndex((panel) => panel.id === activeId);
      if (activeIndex === -1) {
        return chatSurfacePanels.slice(latestWindowStart);
      }

      const windowStart = activeIndex < latestWindowStart
        ? activeIndex
        : latestWindowStart;
      return chatSurfacePanels.slice(windowStart, windowStart + MAX_VISIBLE_CHAT_PANELS);
    }

    const chosenPanelIds = new Set<string>([latestDraftPanel.id]);
    if (activeId) {
      chosenPanelIds.add(activeId);
    }

    const latestDraftIndex = chatSurfacePanels.findIndex(
      (panel) => panel.id === latestDraftPanel.id,
    );

    for (let index = latestDraftIndex - 1; index >= 0 && chosenPanelIds.size < MAX_VISIBLE_CHAT_PANELS; index -= 1) {
      chosenPanelIds.add(chatSurfacePanels[index].id);
    }

    for (let index = chatSurfacePanels.length - 1; index >= 0 && chosenPanelIds.size < MAX_VISIBLE_CHAT_PANELS; index -= 1) {
      chosenPanelIds.add(chatSurfacePanels[index].id);
    }

    return chatSurfacePanels.filter((panel) => chosenPanelIds.has(panel.id)).slice(-MAX_VISIBLE_CHAT_PANELS);
  }, [activePanel?.id, activePanelId, chatSurfacePanels]);
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

    const activeChatPanelId =
      route.kind === 'chat' && activeThreadSurface === 'chat'
        ? activePanel?.id ?? route.chatId
        : activePanelId;

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
    activePanel?.id,
    activePanelId,
    activeThreadSurface,
    embeddedChatStarterPanelId,
    route,
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
  const debugSurfaceChats = useMemo(
    () => chats.filter((chat) => resolveThreadSurface(chat) === 'debug'),
    [chats],
  );
  const explorerMode = route.kind === 'code-start'
    ? 'code'
    : route.kind === 'debug-start'
      ? 'debug'
      : route.kind === 'chat' && activeThreadSurface !== 'chat'
        ? activeThreadSurface
        : null;
  const explorerChats = explorerMode === 'debug' ? debugSurfaceChats : codeSurfaceChats;
  const handleCreateCodeThreadInFolder = useCallback(
    (folder: { id: string; label: string }) => handleCreateChatInFolder(folder, 'code'),
    [handleCreateChatInFolder],
  );
  const handleCreateDebugThreadInFolder = useCallback(
    (folder: { id: string; label: string }) => handleCreateChatInFolder(folder, 'debug'),
    [handleCreateChatInFolder],
  );
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
  const isChatRouteActive = route.kind === 'chat-start' || (route.kind === 'chat' && activeThreadSurface === 'chat');
  const isCodeRouteActive = route.kind === 'code-start' || (route.kind === 'chat' && activeThreadSurface === 'code');
  const isDebugRouteActive = route.kind === 'debug-start' || (route.kind === 'chat' && activeThreadSurface === 'debug');
  const showChatHistoryDrawer =
    !chatLaunchTransition &&
    isChatSurfaceRoute;
  const activeChatHistoryId = route.kind === 'chat' && activeThreadSurface === 'chat'
    ? activePanel?.id ?? route.chatId
    : null;

  useEffect(() => {
    if (!showChatHistoryDrawer && chatHistoryDrawerOpen) {
      setChatHistoryDrawerOpen(false);
    }
  }, [chatHistoryDrawerOpen, showChatHistoryDrawer]);

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
      id: 'advanced' as const,
      label: SETTINGS_TAB_META.advanced.label,
      title: SETTINGS_TAB_META.advanced.title,
      description: SETTINGS_TAB_META.advanced.description,
      summary: `${[developerToolsEnabled, advancedUseEnabled].filter(Boolean).length} controls enabled`,
    },
  ];
  const activeSettingsTabMeta = settingsTabs.find((tab) => tab.id === settingsTab) ?? settingsTabs[0];

  const applyOllamaEndpoint = useCallback(() => {
    const next = persistOllamaBase(ollamaEndpointDraft);
    setOllamaEndpoint(next);
    setOllamaEndpointDraft(next);
    toast(`Ollama endpoint set to ${next}`);
  }, [ollamaEndpointDraft, toast]);

  const resetOllamaEndpoint = useCallback(() => {
    const next = persistOllamaBase(DEFAULT_OLLAMA_BASE);
    setOllamaEndpoint(next);
    setOllamaEndpointDraft(next);
    toast('Ollama endpoint reset to the default local address.');
  }, [toast]);

  const applyOpenAIKey = useCallback(() => {
    const next = persistOpenAIApiKey(openAIApiKeyDraft);
    setOpenAIApiKey(next);
    toast(next ? 'OpenAI API key saved for this browser.' : 'OpenAI API key removed.');
  }, [openAIApiKeyDraft, toast]);

  const clearOpenAIKey = useCallback(() => {
    persistOpenAIApiKey('');
    setOpenAIApiKey('');
    setOpenAIApiKeyDraft('');
    toast('OpenAI API key cleared.');
  }, [toast]);

  const useSampleOpenAIKey = useCallback(() => {
    const next = persistOpenAIApiKey(OPENAI_UI_SAMPLE_KEY);
    setOpenAIApiKey(next);
    setOpenAIApiKeyDraft(next);
    toast('OpenAI sample UI key applied.');
  }, [toast]);

  const applyAnthropicKey = useCallback(() => {
    const next = persistAnthropicApiKey(anthropicApiKeyDraft);
    setAnthropicApiKey(next);
    toast(next ? 'Anthropic API key saved for this browser.' : 'Anthropic API key removed.');
  }, [anthropicApiKeyDraft, toast]);

  const clearAnthropicKey = useCallback(() => {
    persistAnthropicApiKey('');
    setAnthropicApiKey('');
    setAnthropicApiKeyDraft('');
    toast('Anthropic API key cleared.');
  }, [toast]);

  const useSampleAnthropicKey = useCallback(() => {
    const next = persistAnthropicApiKey(ANTHROPIC_UI_SAMPLE_KEY);
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
  const chatHistoryBytes = ready ? measureJsonBytes(chats) : 0;
  const workspaceStorageBytes = estimateLocalStorageEntryBytes(
    FOLDERS_STORAGE_KEY,
    JSON.stringify(projectFolders),
  );
  const defaultModelStorageBytes = defaultModel
    ? estimateLocalStorageEntryBytes(DEFAULT_MODEL_STORAGE_KEY, defaultModel)
    : 0;
  const defaultChatPresetStorageBytes = defaultChatPreset !== DEFAULT_PRESET_ID
    ? estimateLocalStorageEntryBytes(DEFAULT_CHAT_PRESET_STORAGE_KEY, defaultChatPreset)
    : 0;
  const defaultReasoningStorageBytes = defaultReasoningEffort !== DEFAULT_REASONING_EFFORT
    ? estimateLocalStorageEntryBytes(DEFAULT_REASONING_STORAGE_KEY, defaultReasoningEffort)
    : 0;
  const developerToolsStorageBytes = developerToolsEnabled
    ? estimateLocalStorageEntryBytes(DEVELOPER_TOOLS_STORAGE_KEY, '1')
    : 0;
  const advancedUseStorageBytes = advancedUseEnabled
    ? estimateLocalStorageEntryBytes(ADVANCED_USE_STORAGE_KEY, '1')
    : 0;
  const providerConnectionStorageBytes =
    (ollamaEndpoint !== DEFAULT_OLLAMA_BASE
      ? estimateLocalStorageEntryBytes(OLLAMA_BASE_STORAGE_KEY, ollamaEndpoint)
      : 0) +
    (openAIApiKey
      ? estimateLocalStorageEntryBytes(OPENAI_API_KEY_STORAGE_KEY, openAIApiKey)
      : 0) +
    (anthropicApiKey
      ? estimateLocalStorageEntryBytes(ANTHROPIC_API_KEY_STORAGE_KEY, anthropicApiKey)
      : 0);
  const workspaceDefaultStorageBytes =
    defaultModelStorageBytes +
    defaultChatPresetStorageBytes +
    defaultReasoningStorageBytes +
    developerToolsStorageBytes +
    advancedUseStorageBytes;
  const replyPreferenceStorageBytes = replyPreferences.length
    ? estimateLocalStorageEntryBytes(
        REPLY_PREFERENCES_STORAGE_KEY,
        JSON.stringify(replyPreferences),
      )
    : 0;
  const likedReplyPreferenceCount = replyPreferences.filter((entry) => entry.feedback === 'liked').length;
  const dislikedReplyPreferenceCount = replyPreferences.filter((entry) => entry.feedback === 'disliked').length;
  const customPresetStorage = getCustomPresetStorageUsage();
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
        ? `${chats.length} saved chat${chats.length !== 1 ? 's' : ''} in IndexedDB`
        : 'Reading saved chats from IndexedDB...',
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
        ? `${replyPreferences.length} rated repl${replyPreferences.length === 1 ? 'y' : 'ies'} stored locally (${likedReplyPreferenceCount} liked, ${dislikedReplyPreferenceCount} disliked)`
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
  const chatOverviewShortcutLabel =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
      ? 'Cmd + Shift + O'
      : 'Ctrl + Shift + O';
  const handleShowChatStarter = useCallback(() => {
    setChatHistoryDrawerOpen(false);
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

  useEffect(() => {
    if (!showChatHistoryDrawer) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'o') return;

      event.preventDefault();
      setChatHistoryDrawerOpen((current) => !current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showChatHistoryDrawer]);

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
          const labelOverride = workspaceDraftName.trim();
          e.target.value = '';
          if (!files.length) return;
          closeWorkspaceLauncher();
          void handleImportDirectory(files, undefined, labelOverride || undefined);
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
            <button
              className={`route-link${isDebugRouteActive ? ' active' : ''}`}
              onClick={() => navigate('/debug')}
            >
              Debug
            </button>
          </div>

          <div className="route-header-meta">
            {showChatHistoryDrawer && (
              <button
                type="button"
                className={`route-icon-link route-history-trigger${chatHistoryDrawerOpen ? ' active open' : ''}`}
                onClick={() => setChatHistoryDrawerOpen((current) => !current)}
                aria-label={chatHistoryDrawerOpen ? 'Close chat history' : 'Open chat history'}
                aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
                title={`${chatHistoryDrawerOpen ? 'Close chat history' : 'Open chat history'} (${chatOverviewShortcutLabel})`}
              >
                <span className="route-history-trigger-stack" aria-hidden="true">
                  <span className="route-history-trigger-icon primary">
                    <IconMessageSquare size={16} />
                  </span>
                  <span className="route-history-trigger-icon secondary">
                    <IconX size={15} />
                  </span>
                </span>
                <span className="route-history-trigger-label">Chats</span>
                <span className="route-history-trigger-count">
                  {chatSurfaceChats.length}
                </span>
              </button>
            )}
            <button
              className={`route-icon-link${route.kind === 'settings' ? ' active' : ''}`}
              onClick={() => navigate('/settings')}
              title="Settings"
              aria-label="Settings"
            >
              <IconSettings size={16} />
            </button>
          </div>
        </header>

        <div id="main-content">
          {route.kind === 'settings' ? (
            <div id="settings-view">
              <div className="settings-stage">
                <div className="settings-header">
                    <span className="settings-eyebrow">Settings</span>
                    <h2>Workspace defaults</h2>
                    <p>Pick the defaults for new chats, manage providers, and adjust local app behavior without the extra noise.</p>

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
                              <p className="settings-inline-note">Create a blank workspace or import a local folder before starting code or debug threads.</p>
                              <div className="settings-actions">
                                <button className="btn" onClick={() => openWorkspaceLauncher('create')}>
                                  <IconFolderPlus size={14} />
                                  New Workspace
                                </button>
                                <button className="btn settings-secondary-btn" onClick={() => openWorkspaceLauncher('import')}>
                                  <IconUpload size={14} />
                                  Import Folder
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
                            Saved locally in this browser. Use <code>{OPENAI_UI_SAMPLE_KEY}</code> if you only need the catalog visible for UI testing.
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
                            Saved locally in this browser. Use <code>{ANTHROPIC_UI_SAMPLE_KEY}</code> if you only need the Claude catalog unlocked for UI testing.
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
                          <p>Saved conversations in IndexedDB.</p>
                        </article>

                        <article className="settings-card settings-summary-card">
                          <span className="settings-card-kicker">Workspaces</span>
                          <strong>{projectFolders.length}</strong>
                          <p>Workspace entries stored locally.</p>
                        </article>

                        <article className="settings-card settings-summary-card">
                          <span className="settings-card-kicker">Reply memory</span>
                          <strong>{replyPreferences.length}</strong>
                          <p>Liked and disliked response examples saved for future prompts.</p>
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
                              <span className="settings-storage-meter-label">Browser Storage</span>
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
                              <div className="settings-storage-meter" role="list" aria-label="Larry AI browser storage breakdown">
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
                              ? `${likedReplyPreferenceCount} liked and ${dislikedReplyPreferenceCount} disliked examples are stored locally for better future replies.`
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

                          <p className="settings-inline-note">Remove every saved conversation from this browser. This cannot be undone.</p>

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
              onGoToDebug={() => navigate('/debug')}
            />
          ) : route.kind === 'chat-start' ? (
            <div id="workspace" className="chat-route-workspace chat-root-workspace">
              <div id="panels-area" className={`chat-panel-strip panels-${chatDisplayFrameCount}`}>
                {chatDisplayPanels.map((panel) => (
                  <ChatPanel
                    key={panel.id}
                    panel={panel}
                    models={models}
                    showDeveloperTools={developerToolsEnabled}
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
          ) : route.kind === 'code-start' ? (
            <div className="workbench-route-shell">
              <Sidebar
                mode="code"
                folders={projectFolders}
                chats={codeSurfaceChats}
                activeChatId={null}
                onOpenWorkspaceLauncher={openWorkspaceLauncher}
                onCreateChatInFolder={handleCreateCodeThreadInFolder}
                onOpenChat={handleOpenFromHistory}
                onDeleteChat={requestDeleteChat}
                onDeleteWorkspace={requestDeleteWorkspace}
              />
              <div className="workbench-route-main">
                <PromptLibraryView
                  page="code"
                  chats={codeSurfaceChats}
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
                />
              </div>
            </div>
          ) : route.kind === 'debug-start' ? (
            <div className="workbench-route-shell">
              <Sidebar
                mode="debug"
                folders={projectFolders}
                chats={debugSurfaceChats}
                activeChatId={null}
                onOpenWorkspaceLauncher={openWorkspaceLauncher}
                onCreateChatInFolder={handleCreateDebugThreadInFolder}
                onOpenChat={handleOpenFromHistory}
                onDeleteChat={requestDeleteChat}
                onDeleteWorkspace={requestDeleteWorkspace}
              />
              <div className="workbench-route-main">
                <PromptLibraryView
                  page="debug"
                  chats={debugSurfaceChats}
                  folders={projectFolders}
                  defaultModel={resolvedDefaultModel}
                  defaultChatPreset={defaultChatPreset}
                  defaultReasoningEffort={defaultReasoningEffort}
                  models={models}
                  onStartChat={handleStartChatFromHome}
                  onOpenChat={handleOpenFromHistory}
                  onCreateChatInFolder={handleCreateDebugThreadInFolder}
                  onOpenWorkspaceLauncher={openWorkspaceLauncher}
                  onDeleteChat={requestDeleteChat}
                  onDeleteWorkspace={requestDeleteWorkspace}
                />
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
          ) : explorerMode ? (
            <div className="workbench-route-shell">
              <Sidebar
                mode={explorerMode}
                folders={projectFolders}
                chats={explorerChats}
                activeChatId={activePanel?.id ?? route.chatId}
                onOpenWorkspaceLauncher={openWorkspaceLauncher}
                onCreateChatInFolder={explorerMode === 'debug' ? handleCreateDebugThreadInFolder : handleCreateCodeThreadInFolder}
                onOpenChat={handleOpenFromHistory}
                onDeleteChat={requestDeleteChat}
                onDeleteWorkspace={requestDeleteWorkspace}
              />
              <div className="workbench-route-main">
                <div id="workspace" className="chat-route-workspace explorer-chat-workspace">
                  {activePanel ? (
                    <div id="panels-area">
                      <ChatPanel
                        key={activePanel.id}
                        panel={activePanel}
                        models={models}
                        showDeveloperTools={developerToolsEnabled}
                        showAdvancedUse={advancedUseEnabled}
                        onUpdate={updatePanel}
                        onClose={closePanel}
                        onSave={savePanel}
                        selected={activePanelId === activePanel.id}
                        onActivate={activatePanel}
                        launchPrompt={queuedLaunchPrompts[activePanel.id] ?? null}
                        onConsumeLaunchPrompt={consumeLaunchPrompt}
                        onImportWorkspaceFiles={(files) => {
                          if (!activePanel.projectId || !activePanel.projectLabel) return;
                          void handleImportDirectory(files, {
                            id: activePanel.projectId,
                            label: activePanel.projectLabel,
                          });
                        }}
                      />
                    </div>
                  ) : (
                    <div id="no-panels" className="route-state">
                      <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                        <IconHexagon size={72} />
                      </div>
                      <h2>{isMissingChatRoute ? 'Chat not found' : 'Opening chat'}</h2>
                      <p>
                        {isMissingChatRoute
                          ? 'That route does not match a saved local chat. Start a new prompt or open one from the explorer.'
                          : 'Loading the requested local chat from IndexedDB.'}
                      </p>
                      <button className="btn" onClick={() => navigate(buildStartPath(explorerMode))}>
                        Return to {explorerMode === 'debug' ? 'debug' : 'code'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div id="workspace" className="chat-route-workspace">
              {chatDisplayPanels.length || showEmbeddedChatStarter ? (
                <div id="panels-area" className={`chat-panel-strip panels-${chatDisplayFrameCount}`}>
                  {chatDisplayPanels.map((panel) => (
                    <ChatPanel
                      key={panel.id}
                      panel={panel}
                      models={models}
                      showDeveloperTools={developerToolsEnabled}
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
                      ? 'That route does not match a saved local chat. Start a new prompt or open one from the library.'
                      : 'Loading the requested local chat from IndexedDB.'}
                  </p>
                  <button className="btn" onClick={() => navigate('/')}>
                    Go home
                  </button>
                </div>
              )}
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
            showDeveloperTools={developerToolsEnabled}
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

      {showChatHistoryDrawer && chatHistoryDrawerOpen && (
        <ChatHistoryDrawer
          chats={chatSurfaceChats}
          openPanelIds={chatSurfaceOpenPanelIds}
          activeChatId={activeChatHistoryId}
          anchoredToHeader={true}
          shortcutLabel={chatOverviewShortcutLabel}
          onOpen={(chat) => {
            handleOpenFromHistory(chat);
            setChatHistoryDrawerOpen(false);
          }}
          onCreateNewConversation={handleShowChatStarter}
          onDelete={requestDeleteChat}
          onClose={() => setChatHistoryDrawerOpen(false)}
        />
      )}

      {workspaceLauncherOpen && (
        <div className="workspace-launcher-backdrop" onClick={closeWorkspaceLauncher}>
          <div className="workspace-launcher-modal" onClick={(e) => e.stopPropagation()}>
            <div className="workspace-launcher-head">
              <div
                className="workspace-launcher-toggle"
                data-mode={workspaceLauncherMode}
              >
                <span className="workspace-launcher-toggle-glider" />
                <button
                  className={`workspace-launcher-tab${workspaceLauncherMode === 'create' ? ' active' : ''}`}
                  onClick={() => setWorkspaceLauncherMode('create')}
                >
                  New workspace
                </button>
                <button
                  className={`workspace-launcher-tab${workspaceLauncherMode === 'import' ? ' active' : ''}`}
                  onClick={() => setWorkspaceLauncherMode('import')}
                >
                  Import folder
                </button>
              </div>

              <button
                className="workspace-launcher-close"
                onClick={closeWorkspaceLauncher}
                title="Close workspace launcher"
              >
                <IconX size={14} />
              </button>
            </div>

            <div
              className="workspace-launcher-stage"
              data-mode={workspaceLauncherMode}
            >
              <div className="workspace-launcher-track">
                <section className="workspace-launcher-panel">
                  <div className="workspace-launcher-hero">
                    <span className="workspace-launcher-icon">
                      <IconFolderPlus size={18} />
                    </span>
                    <div className="workspace-launcher-copy">
                      <h2>Create a workspace</h2>
                      <p>Name the workspace first. Chats and project files will live inside it.</p>
                    </div>
                  </div>

                  <label className="workspace-launcher-field">
                    <span>Workspace name</span>
                    <input
                      className="workspace-launcher-input"
                      value={workspaceDraftName}
                      onChange={(e) => setWorkspaceDraftName(e.target.value)}
                      placeholder="Enterprise Portal"
                    />
                  </label>

                  <div className="workspace-launcher-actions">
                    <button className="workspace-launcher-btn" onClick={closeWorkspaceLauncher}>
                      Cancel
                    </button>
                    <button
                      className="workspace-launcher-btn primary"
                      onClick={() => {
                        if (handleCreateFolder(workspaceDraftName)) {
                          closeWorkspaceLauncher();
                        }
                      }}
                    >
                      Create workspace
                    </button>
                  </div>
                </section>

                <section className="workspace-launcher-panel">
                  <div className="workspace-launcher-hero">
                    <span className="workspace-launcher-icon">
                      <IconUpload size={18} />
                    </span>
                    <div className="workspace-launcher-copy">
                      <h2>Import a project folder</h2>
                      <p>Select a file directory and Larry AI will build the workspace from it.</p>
                    </div>
                  </div>

                  <label className="workspace-launcher-field">
                    <span>Workspace name override</span>
                    <input
                      className="workspace-launcher-input"
                      value={workspaceDraftName}
                      onChange={(e) => setWorkspaceDraftName(e.target.value)}
                      placeholder="Optional - use folder name by default"
                    />
                  </label>

                  <p className="workspace-launcher-note">
                    Leave the name blank to use the selected directory name automatically.
                  </p>

                  <div className="workspace-launcher-actions">
                    <button className="workspace-launcher-btn" onClick={closeWorkspaceLauncher}>
                      Cancel
                    </button>
                    <button
                      className="workspace-launcher-btn primary"
                      onClick={() => importWorkspaceLauncherRef.current?.click()}
                    >
                      Select directory
                    </button>
                  </div>
                </section>
              </div>
            </div>
          </div>
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
