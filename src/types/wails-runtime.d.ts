import type {
  AppSettings,
  ChatRecord,
  PersistedAppSnapshot,
  ProjectFolder,
  ReplyPreferenceRecord,
  WorkspaceBackupReference,
  WorkspaceCommandResult,
  WorkspaceFileDocument,
  WorkspaceRuntimeProfile,
  WorkspaceSelection,
  WorkspaceSnapshot,
} from './index';

interface WailsAppBridge {
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
  PickWorkspaceDirectory(): Promise<WorkspaceSelection>;
  CreateManagedWorkspaceDirectory(label: string): Promise<WorkspaceSelection>;
  ScanWorkspace(rootPath: string): Promise<WorkspaceSnapshot>;
  ReadWorkspaceFile(rootPath: string, relativePath: string): Promise<WorkspaceFileDocument>;
  WriteWorkspaceFileDocument(rootPath: string, relativePath: string, content: string): Promise<WorkspaceFileDocument>;
  OpenWorkspaceInExplorer(rootPath: string): Promise<void>;
  CreateWorkspaceDirectory(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
  CreateWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  WriteWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  RenameWorkspaceEntry(rootPath: string, relativePath: string, nextRelativePath: string): Promise<WorkspaceSnapshot>;
  CopyWorkspaceEntry(rootPath: string, relativePath: string, nextRelativePath: string): Promise<WorkspaceSnapshot>;
  DeleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
  OpenWorkspaceEntry(rootPath: string, relativePath: string): Promise<void>;
  CreateWorkspaceBackup(rootPath: string, workspaceID: string, label: string): Promise<WorkspaceBackupReference>;
  RestoreWorkspaceBackup(rootPath: string, archivePath: string): Promise<WorkspaceSnapshot>;
  InspectWorkspaceRuntime(rootPath: string): Promise<WorkspaceRuntimeProfile>;
  RunWorkspaceCommand(rootPath: string, command: string, timeoutMs: number): Promise<WorkspaceCommandResult>;
  RunWorkspaceWebPreview(rootPath: string, command: string, timeoutMs: number): Promise<WorkspaceCommandResult>;
  FetchOllamaModels(endpoint: string): Promise<string[]>;
  ChatOllama(
    endpoint: string,
    requestId: string,
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<string>;
  StartOllamaChatStream(
    endpoint: string,
    requestId: string,
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<void>;
  CancelOllamaRequest(requestId: string): Promise<void>;
}

declare global {
  interface Window {
    go?: {
      main?: {
        App?: WailsAppBridge;
      };
    };
  }
}

export {};
