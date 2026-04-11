import { DEFAULT_PRESET_ID } from './presets';
import {
  deleteChat as deleteBrowserChat,
  initDB,
  loadAllChats,
  saveChat as saveBrowserChat,
} from './db';
import type {
  AppSettings,
  ChatReasoningEffort,
  ChatRecord,
  PersistedAppSnapshot,
  ProjectFolder,
  ReplyPreferenceRecord,
  StorageMode,
} from '../types';

const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'balanced';

const FOLDERS_STORAGE_KEY = 'larry_project_folders_v1';
const DEFAULT_MODEL_STORAGE_KEY = 'larry_default_model_v1';
const DEFAULT_CHAT_PRESET_STORAGE_KEY = 'larry_default_chat_preset_v1';
const DEFAULT_REASONING_STORAGE_KEY = 'larry_default_reasoning_effort_v1';
const DEVELOPER_TOOLS_STORAGE_KEY = 'larry_developer_tools_v1';
const ADVANCED_USE_STORAGE_KEY = 'larry_advanced_use_v1';
const OLLAMA_BASE_STORAGE_KEY = 'larry_ollama_base_v1';
const OPENAI_API_KEY_STORAGE_KEY = 'larry_openai_api_key_v1';
const ANTHROPIC_API_KEY_STORAGE_KEY = 'larry_anthropic_api_key_v1';
const REPLY_PREFERENCES_STORAGE_KEY = 'larry_reply_preferences_v1';

interface DesktopBridge {
  GetStorageSnapshot(): Promise<Omit<PersistedAppSnapshot, 'storageMode'>>;
  LoadChats(): Promise<ChatRecord[]>;
  SaveChat(chat: ChatRecord): Promise<void>;
  DeleteChat(id: string): Promise<void>;
  DeleteAllChats(): Promise<void>;
  SaveAppSettings(settings: AppSettings): Promise<void>;
  SaveWorkspaces(workspaces: ProjectFolder[]): Promise<void>;
  LoadReplyPreferences(): Promise<ReplyPreferenceRecord[]>;
  ReplaceReplyPreferences(preferences: ReplyPreferenceRecord[]): Promise<void>;
  SeedFromBrowser(snapshot: Omit<PersistedAppSnapshot, 'storageMode'>): Promise<boolean>;
}

let cachedSettings: AppSettings = createDefaultSettings();
let initializationPromise: Promise<PersistedAppSnapshot> | null = null;

function normalizeOllamaBase(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return DEFAULT_OLLAMA_BASE;
  if (raw.startsWith('/')) return raw.replace(/\/$/, '') || '/';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  return `http://${raw.replace(/\/$/, '')}`;
}

function createDefaultSettings(): AppSettings {
  return {
    defaultModel: '',
    defaultChatPreset: DEFAULT_PRESET_ID,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    developerToolsEnabled: false,
    advancedUseEnabled: false,
    ollamaEndpoint: DEFAULT_OLLAMA_BASE,
    openAIApiKey: '',
    anthropicApiKey: '',
  };
}

function normaliseSettings(settings?: Partial<AppSettings> | null): AppSettings {
  const next = settings ?? {};
  const reasoning = next.defaultReasoningEffort;

  return {
    defaultModel: next.defaultModel?.trim() ?? '',
    defaultChatPreset: next.defaultChatPreset?.trim() || DEFAULT_PRESET_ID,
    defaultReasoningEffort:
      reasoning === 'light' || reasoning === 'balanced' || reasoning === 'high' || reasoning === 'extra-high'
        ? reasoning
        : DEFAULT_REASONING_EFFORT,
    developerToolsEnabled: Boolean(next.developerToolsEnabled),
    advancedUseEnabled: Boolean(next.advancedUseEnabled),
    ollamaEndpoint: normalizeOllamaBase(next.ollamaEndpoint),
    openAIApiKey: next.openAIApiKey?.trim() ?? '',
    anthropicApiKey: next.anthropicApiKey?.trim() ?? '',
  };
}

function withStorageMode(
  snapshot: Omit<PersistedAppSnapshot, 'storageMode'>,
  storageMode: StorageMode,
): PersistedAppSnapshot {
  const normalisedSnapshot: PersistedAppSnapshot = {
    settings: normaliseSettings(snapshot.settings),
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
    chats: Array.isArray(snapshot.chats) ? snapshot.chats : [],
    replyPreferences: Array.isArray(snapshot.replyPreferences) ? snapshot.replyPreferences : [],
    storageMode,
  };

  cachedSettings = normalisedSnapshot.settings;
  return normalisedSnapshot;
}

function stripStorageMode(snapshot: PersistedAppSnapshot): Omit<PersistedAppSnapshot, 'storageMode'> {
  const { storageMode: _storageMode, ...rest } = snapshot;
  return rest;
}

function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;

  const app = window.go?.main?.App;
  if (!app) return null;

  const requiredMethods: Array<keyof DesktopBridge> = [
    'GetStorageSnapshot',
    'LoadChats',
    'SaveChat',
    'DeleteChat',
    'DeleteAllChats',
    'SaveAppSettings',
    'SaveWorkspaces',
    'LoadReplyPreferences',
    'ReplaceReplyPreferences',
    'SeedFromBrowser',
  ];

  return requiredMethods.every((method) => typeof app[method] === 'function')
    ? app
    : null;
}

export function isDesktopRuntime(): boolean {
  return Boolean(getDesktopBridge());
}

export function getStorageMode(): StorageMode {
  return isDesktopRuntime() ? 'desktop-sql' : 'browser';
}

export function getCachedSettings(): AppSettings {
  return cachedSettings;
}

function parseJsonArray<T>(value: string | null, validate: (entry: unknown) => entry is T): T[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validate);
  } catch {
    return [];
  }
}

function isProjectFolder(entry: unknown): entry is ProjectFolder {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof (entry as ProjectFolder).id === 'string' &&
      typeof (entry as ProjectFolder).label === 'string',
  );
}

function sanitizeWorkspaceForPersistence(workspace: ProjectFolder): ProjectFolder {
  if (!workspace.rootPath && !workspace.browserHandleId) {
    return workspace;
  }

  return {
    ...workspace,
    fileEntries: undefined,
  };
}

function isReplyPreference(entry: unknown): entry is ReplyPreferenceRecord {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof (entry as ReplyPreferenceRecord).id === 'string' &&
      typeof (entry as ReplyPreferenceRecord).prompt === 'string' &&
      typeof (entry as ReplyPreferenceRecord).reply === 'string' &&
      ((entry as ReplyPreferenceRecord).feedback === 'liked' ||
        (entry as ReplyPreferenceRecord).feedback === 'disliked'),
  );
}

function readLocalStorageValue(key: string): string {
  if (typeof window === 'undefined') return '';

  try {
    return window.localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function writeLocalStorageValue(key: string, value: string) {
  if (typeof window === 'undefined') return;

  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore browser storage failures and let the in-memory state win for the session.
  }
}

function writeBooleanStorage(key: string, value: boolean) {
  writeLocalStorageValue(key, value ? '1' : '');
}

async function loadBrowserSnapshot(): Promise<PersistedAppSnapshot> {
  const settings = normaliseSettings({
    defaultModel: readLocalStorageValue(DEFAULT_MODEL_STORAGE_KEY),
    defaultChatPreset: readLocalStorageValue(DEFAULT_CHAT_PRESET_STORAGE_KEY) || DEFAULT_PRESET_ID,
    defaultReasoningEffort: readLocalStorageValue(DEFAULT_REASONING_STORAGE_KEY) as ChatReasoningEffort,
    developerToolsEnabled: /^(?:1|true)$/i.test(readLocalStorageValue(DEVELOPER_TOOLS_STORAGE_KEY)),
    advancedUseEnabled: /^(?:1|true)$/i.test(readLocalStorageValue(ADVANCED_USE_STORAGE_KEY)),
    ollamaEndpoint: readLocalStorageValue(OLLAMA_BASE_STORAGE_KEY) || DEFAULT_OLLAMA_BASE,
    openAIApiKey: readLocalStorageValue(OPENAI_API_KEY_STORAGE_KEY),
    anthropicApiKey: readLocalStorageValue(ANTHROPIC_API_KEY_STORAGE_KEY),
  });

  const workspaces = parseJsonArray<ProjectFolder>(
    readLocalStorageValue(FOLDERS_STORAGE_KEY),
    isProjectFolder,
  );
  let chats: ChatRecord[] = [];

  try {
    await initDB();
    chats = await loadAllChats();
  } catch {
    chats = [];
  }

  const replyPreferences = parseJsonArray<ReplyPreferenceRecord>(
    readLocalStorageValue(REPLY_PREFERENCES_STORAGE_KEY),
    isReplyPreference,
  ).sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    settings,
    workspaces,
    chats,
    replyPreferences,
    storageMode: 'browser',
  };
}

function snapshotHasMeaningfulData(snapshot: PersistedAppSnapshot): boolean {
  const defaults = createDefaultSettings();
  const settings = normaliseSettings(snapshot.settings);

  return (
    snapshot.chats.length > 0 ||
    snapshot.workspaces.length > 0 ||
    snapshot.replyPreferences.length > 0 ||
    settings.defaultModel !== defaults.defaultModel ||
    settings.defaultChatPreset !== defaults.defaultChatPreset ||
    settings.defaultReasoningEffort !== defaults.defaultReasoningEffort ||
    settings.developerToolsEnabled !== defaults.developerToolsEnabled ||
    settings.advancedUseEnabled !== defaults.advancedUseEnabled ||
    settings.ollamaEndpoint !== defaults.ollamaEndpoint ||
    settings.openAIApiKey !== defaults.openAIApiKey ||
    settings.anthropicApiKey !== defaults.anthropicApiKey
  );
}

async function initialisePersistenceInternal(): Promise<PersistedAppSnapshot> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    return loadBrowserSnapshot();
  }

  let desktopSnapshot = withStorageMode(await desktopBridge.GetStorageSnapshot(), 'desktop-sql');
  if (!snapshotHasMeaningfulData(desktopSnapshot)) {
    try {
      const browserSnapshot = await loadBrowserSnapshot();
      if (snapshotHasMeaningfulData(browserSnapshot)) {
        const seeded = await desktopBridge.SeedFromBrowser(stripStorageMode(browserSnapshot));
        if (seeded) {
          desktopSnapshot = withStorageMode(await desktopBridge.GetStorageSnapshot(), 'desktop-sql');
        }
      }
    } catch {
      // If browser stores are unavailable there is nothing to migrate, so keep the empty desktop snapshot.
    }
  }

  return desktopSnapshot;
}

export async function initializePersistence(): Promise<PersistedAppSnapshot> {
  initializationPromise ??= initialisePersistenceInternal();
  return initializationPromise;
}

export async function loadStorageSnapshot(
  options: { forceRefresh?: boolean } = {},
): Promise<PersistedAppSnapshot> {
  if (!options.forceRefresh) {
    return initializePersistence();
  }

  initializationPromise = null;
  return initializePersistence();
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await initializePersistence();

  const next = normaliseSettings(settings);
  cachedSettings = next;

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.SaveAppSettings(next);
    return;
  }

  if (next.defaultModel) {
    writeLocalStorageValue(DEFAULT_MODEL_STORAGE_KEY, next.defaultModel);
  } else {
    writeLocalStorageValue(DEFAULT_MODEL_STORAGE_KEY, '');
  }

  if (next.defaultChatPreset && next.defaultChatPreset !== DEFAULT_PRESET_ID) {
    writeLocalStorageValue(DEFAULT_CHAT_PRESET_STORAGE_KEY, next.defaultChatPreset);
  } else {
    writeLocalStorageValue(DEFAULT_CHAT_PRESET_STORAGE_KEY, '');
  }

  if (next.defaultReasoningEffort !== DEFAULT_REASONING_EFFORT) {
    writeLocalStorageValue(DEFAULT_REASONING_STORAGE_KEY, next.defaultReasoningEffort);
  } else {
    writeLocalStorageValue(DEFAULT_REASONING_STORAGE_KEY, '');
  }

  writeBooleanStorage(DEVELOPER_TOOLS_STORAGE_KEY, next.developerToolsEnabled);
  writeBooleanStorage(ADVANCED_USE_STORAGE_KEY, next.advancedUseEnabled);

  if (next.ollamaEndpoint !== DEFAULT_OLLAMA_BASE) {
    writeLocalStorageValue(OLLAMA_BASE_STORAGE_KEY, next.ollamaEndpoint);
  } else {
    writeLocalStorageValue(OLLAMA_BASE_STORAGE_KEY, '');
  }

  writeLocalStorageValue(OPENAI_API_KEY_STORAGE_KEY, next.openAIApiKey);
  writeLocalStorageValue(ANTHROPIC_API_KEY_STORAGE_KEY, next.anthropicApiKey);
}

export async function saveWorkspaces(workspaces: ProjectFolder[]): Promise<void> {
  await initializePersistence();

  const sanitizedWorkspaces = workspaces.map(sanitizeWorkspaceForPersistence);

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.SaveWorkspaces(sanitizedWorkspaces);
    return;
  }

  writeLocalStorageValue(FOLDERS_STORAGE_KEY, JSON.stringify(sanitizedWorkspaces));
}

export async function loadChats(): Promise<ChatRecord[]> {
  await initializePersistence();

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    const chats = await desktopBridge.LoadChats();
    return chats.filter((chat) => !(typeof chat.archivedAt === 'number' && chat.archivedAt > 0));
  }

  const chats = await loadAllChats();
  return chats.filter((chat) => !(typeof chat.archivedAt === 'number' && chat.archivedAt > 0));
}

export async function saveChat(chat: ChatRecord): Promise<void> {
  await initializePersistence();

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.SaveChat(chat);
    return;
  }

  await saveBrowserChat(chat);
}

export async function removeChat(id: string): Promise<void> {
  await initializePersistence();

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.DeleteChat(id);
    return;
  }

  await deleteBrowserChat(id);
}

export async function clearChats(): Promise<void> {
  await initializePersistence();

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.DeleteAllChats();
    return;
  }

  const chats = await loadAllChats();
  await Promise.all(chats.map((chat) => deleteBrowserChat(chat.id)));
}

export async function loadReplyPreferences(): Promise<ReplyPreferenceRecord[]> {
  await initializePersistence();

  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    return desktopBridge.LoadReplyPreferences();
  }

  return parseJsonArray<ReplyPreferenceRecord>(
    readLocalStorageValue(REPLY_PREFERENCES_STORAGE_KEY),
    isReplyPreference,
  ).sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function replaceReplyPreferences(preferences: ReplyPreferenceRecord[]): Promise<void> {
  await initializePersistence();

  const sorted = [...preferences].sort((left, right) => right.updatedAt - left.updatedAt);
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    await desktopBridge.ReplaceReplyPreferences(sorted);
    return;
  }

  if (sorted.length) {
    writeLocalStorageValue(REPLY_PREFERENCES_STORAGE_KEY, JSON.stringify(sorted));
  } else {
    writeLocalStorageValue(REPLY_PREFERENCES_STORAGE_KEY, '');
  }
}
