// FILE: src/types/index.ts
import type { FileEntry, FileRegistry } from '../lib/fileRegistry';

export type ThreadType = 'chat' | 'code' | 'debug';
export type ReplyFeedback = 'liked' | 'disliked';
export type ChatReasoningEffort = 'light' | 'balanced' | 'high' | 'extra-high';
export type ModelProvider = 'ollama' | 'openai' | 'anthropic';
export type ModelCatalogStatus = 'connecting' | 'online' | 'error';

export interface ModelProviderState {
  provider: ModelProvider;
  label: string;
  enabled: boolean;
  online: boolean;
  modelCount: number;
  mode?: 'live' | 'sample';
  error?: string;
}

export interface ProviderConnectionSettings {
  selectedModels: string[];
  autoUpdate: boolean;
}

export interface ProviderSettingsMap {
  ollama: ProviderConnectionSettings;
  openai: ProviderConnectionSettings;
  anthropic: ProviderConnectionSettings;
}

export interface ResponseTraceMetric {
  label: string;
  value: string;
}

export type SearchDiscoveryEngine = 'duckduckgo' | 'google' | 'local';

export interface ResponseTraceSource {
  id: string;
  kind: 'prompt-url' | 'live-context';
  title: string;
  url: string;
  status: 'fetched' | 'error';
  durationMs?: number;
  preview?: string;
  error?: string;
  provider?: string;
  sourceType?: 'search' | 'news' | 'official' | 'reference' | 'community';
  credibility?: 'official' | 'major-news' | 'reference' | 'search' | 'community';
  publishedAt?: string;
  discoveryEngines?: SearchDiscoveryEngine[];
  host?: string;
  path?: string;
  contextOrigin?: 'page' | 'search-result' | 'local-index';
  promptSelected?: boolean;
}

export interface ResponseTracePackage {
  name: string;
  ecosystem: string;
  version: string;
  description?: string;
}

export interface ResponseTracePlannerStep {
  stepNumber: number;
  label: string;
  filePath: string;
  purpose: string;
  status: 'planned' | 'executed';
}

export interface ResponseTracePhase {
  id: string;
  label: string;
  detail?: string;
  status: 'running' | 'completed' | 'error' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  metrics?: ResponseTraceMetric[];
}

export interface ResponseTrace {
  version: 1;
  prompt: string;
  surface: ThreadType;
  preset: string;
  reasoningEffort?: ChatReasoningEffort;
  chatMode?: string;
  chatModeConfidence?: string;
  model: string;
  pipeline: 'single-pass' | 'deep-plan';
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  firstTokenDurationMs?: number;
  totalDurationMs?: number;
  orchestrationSummary: string;
  reasoningSummary?: string;
  phases: ResponseTracePhase[];
  sources?: ResponseTraceSource[];
  packages?: ResponseTracePackage[];
  plannerMode?: string;
  plannerConfidence?: string;
  plannerSummary?: string;
  plannerSteps?: ResponseTracePlannerStep[];
}

export interface MessageFileChange {
  path: string;
  lang: string;
  previousContent?: string;
  nextContent?: string;
}

export interface MessageWorkspaceChangeSet {
  files: MessageFileChange[];
  backup?: WorkspaceBackupReference | null;
}

export interface ChatExchangeMemory {
  topic: string;
  promptSummary: string;
  replySummary: string;
  keyTerms: string[];
  keyPhrases: string[];
  keyFacts: string[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  exchangeMemory?: ChatExchangeMemory;
  workspaceChanges?: MessageWorkspaceChangeSet | null;
  responseTimeMs?: number;
  responseFirstTokenMs?: number;
  responseStartedAt?: number;
  responseFirstTokenAt?: number;
  responseCompletedAt?: number;
  responseTrace?: ResponseTrace;
}

export interface ReplyPreferenceRecord {
  id: string;
  chatId: string;
  chatTitle?: string;
  prompt: string;
  reply: string;
  conversationContext?: string;
  feedback: ReplyFeedback;
  surface: ThreadType;
  preset: string;
  model: string;
  traceSummary?: string;
  sourceUrls?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  defaultModel: string;
  defaultChatPreset: string;
  defaultReasoningEffort: ChatReasoningEffort;
  developerToolsEnabled: boolean;
  advancedUseEnabled: boolean;
  codeEditorAutoSaveEnabled: boolean;
  codeEditorIndentGuidesEnabled: boolean;
  codeEditorSetupGuideEnabled: boolean;
  codeEditorDependencyInstallEnabled: boolean;
  ollamaEndpoint: string;
  openAIApiKey: string;
  anthropicApiKey: string;
  providerSettings: ProviderSettingsMap;
}

export interface WorkspaceBackupReference {
  id: string;
  label: string;
  createdAt: number;
  archivePath?: string;
  browserBackupId?: string;
}

export interface WorkspaceRuntimeCommand {
  kind: 'build' | 'test' | 'start' | 'lint' | 'install';
  label: string;
  command: string;
}

export interface WorkspaceRuntimeProfile {
  ecosystem: string;
  label: string;
  detectedFiles: string[];
  commands: WorkspaceRuntimeCommand[];
}

export interface WorkspaceCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  durationMs: number;
  timedOut: boolean;
}

export interface WorkspaceValidationSummary {
  profile: WorkspaceRuntimeProfile | null;
  command: WorkspaceCommandResult | null;
}

export interface InterruptedTaskState {
  prompt: string;
  startedAt: number;
  assistantMessageCountAtStart: number;
  threadType: ThreadType;
  projectId?: string;
  projectLabel?: string;
  lastPhaseLabel?: string;
  resumePrompt?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  model: string;
  preset: string;
  reasoningEffort?: ChatReasoningEffort;
  threadType?: ThreadType;
  projectId?: string;
  projectLabel?: string;
  messages: Message[];
  updatedAt: number;
  archivedAt?: number;
  fileEntries?: FileEntry[];
  latestWorkspaceBackup?: WorkspaceBackupReference | null;
  interruptedTask?: InterruptedTaskState | null;
}

export interface WorkspaceFileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  extension?: string;
  children?: WorkspaceFileNode[];
}

export interface WorkspaceSnapshot {
  rootPath: string;
  fileTree: WorkspaceFileNode[];
  fileEntries: FileEntry[];
  fileCount: number;
  directoryCount: number;
  syncedAt: number;
}

export interface WorkspaceFileDocument {
  path: string;
  content: string;
  lang: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface WorkspaceSelection {
  label: string;
  rootPath: string;
  snapshot: WorkspaceSnapshot;
}

export interface ProjectFolder {
  id: string;
  label: string;
  createdAt: number;
  rootPath?: string;
  browserHandleId?: string;
  fileTree?: WorkspaceFileNode[];
  fileCount?: number;
  directoryCount?: number;
  syncedAt?: number;
  archivedAt?: number;
  fileEntries?: FileEntry[];
}

/**
 * Describes the current multi-phase streaming state shown in the UI.
 * Null when no multi-phase operation is in progress.
 */
export interface StreamingPhase {
  /** Full label shown in the indicator, e.g. "Step 2 of 5 — src/lib" */
  label: string;
  /** 0 = planning, 1+ = implementation steps */
  stepIndex: number;
  /** Total number of implementation steps (0 during planning) */
  totalSteps: number;
}

export interface Panel {
  id: string;
  title: string;
  model: string;
  preset: string;
  reasoningEffort?: ChatReasoningEffort;
  threadType?: ThreadType;
  projectId?: string;
  projectLabel?: string;
  messages: Message[];
  streaming: boolean;
  streamingContent: string;
  streamingTrace: ResponseTrace | null;
  fileRegistry: FileRegistry;
  prevRegistry: FileRegistry;
  streamingPhase: StreamingPhase | null;
  latestWorkspaceBackup?: WorkspaceBackupReference | null;
  interruptedTask?: InterruptedTaskState | null;
}

export type OllamaStatus = ModelCatalogStatus;
export type StorageMode = 'browser' | 'desktop-sql';

export interface PersistedAppSnapshot {
  settings: AppSettings;
  workspaces: ProjectFolder[];
  chats: ChatRecord[];
  replyPreferences: ReplyPreferenceRecord[];
  storageMode: StorageMode;
}
