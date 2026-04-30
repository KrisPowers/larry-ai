import type {
  WorkspaceBackupReference,
  WorkspaceCommandResult,
  WorkspaceFileDocument,
  WorkspaceRuntimeProfile,
  WorkspaceSelection,
  WorkspaceSnapshot,
} from '../types';

interface WorkspaceHostBridge {
  PickWorkspaceDirectory(): Promise<WorkspaceSelection>;
  CreateManagedWorkspaceDirectory(label: string): Promise<WorkspaceSelection>;
  ScanWorkspace(rootPath: string): Promise<WorkspaceSnapshot>;
  ReadWorkspaceFile(rootPath: string, relativePath: string): Promise<WorkspaceFileDocument>;
  WriteWorkspaceFileDocument(rootPath: string, relativePath: string, content: string): Promise<WorkspaceFileDocument>;
  OpenWorkspaceInExplorer(rootPath: string): Promise<void>;
  OpenWorkspaceEntry(rootPath: string, relativePath: string): Promise<void>;
  CreateWorkspaceDirectory(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
  CreateWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  WriteWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  RenameWorkspaceEntry(rootPath: string, relativePath: string, nextRelativePath: string): Promise<WorkspaceSnapshot>;
  CopyWorkspaceEntry(rootPath: string, relativePath: string, nextRelativePath: string): Promise<WorkspaceSnapshot>;
  DeleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
  CreateWorkspaceBackup(rootPath: string, workspaceID: string, label: string): Promise<WorkspaceBackupReference>;
  RestoreWorkspaceBackup(rootPath: string, archivePath: string): Promise<WorkspaceSnapshot>;
  InspectWorkspaceRuntime(rootPath: string): Promise<WorkspaceRuntimeProfile>;
  RunWorkspaceCommand(rootPath: string, command: string, timeoutMs: number): Promise<WorkspaceCommandResult>;
  RunWorkspaceWebPreview(rootPath: string, command: string, timeoutMs: number): Promise<WorkspaceCommandResult>;
}

function getWorkspaceBridge(): WorkspaceHostBridge | null {
  if (typeof window === 'undefined') return null;
  const app = window.go?.main?.App;
  if (!app) return null;

  const requiredMethods: Array<keyof WorkspaceHostBridge> = [
    'PickWorkspaceDirectory',
    'CreateManagedWorkspaceDirectory',
    'ScanWorkspace',
    'ReadWorkspaceFile',
    'WriteWorkspaceFileDocument',
    'OpenWorkspaceInExplorer',
    'OpenWorkspaceEntry',
    'CreateWorkspaceDirectory',
    'CreateWorkspaceFile',
    'WriteWorkspaceFile',
    'RenameWorkspaceEntry',
    'CopyWorkspaceEntry',
    'DeleteWorkspaceEntry',
    'CreateWorkspaceBackup',
    'RestoreWorkspaceBackup',
    'InspectWorkspaceRuntime',
    'RunWorkspaceCommand',
  ];

  return requiredMethods.every((method) => typeof app[method] === 'function')
    ? (app as WorkspaceHostBridge)
    : null;
}

function requireWorkspaceBridge(): WorkspaceHostBridge {
  const bridge = getWorkspaceBridge();
  if (!bridge) {
    throw new Error('Workspace host features are only available in the desktop runtime.');
  }

  return bridge;
}

export function isWorkspaceHostAvailable(): boolean {
  return Boolean(getWorkspaceBridge());
}

export async function pickWorkspaceDirectory(): Promise<WorkspaceSelection | null> {
  const bridge = getWorkspaceBridge();
  if (!bridge) return null;

  const selection = await bridge.PickWorkspaceDirectory();
  if (!selection?.rootPath) return null;
  return selection;
}

export async function createManagedWorkspaceDirectory(label: string): Promise<WorkspaceSelection> {
  return requireWorkspaceBridge().CreateManagedWorkspaceDirectory(label);
}

export async function scanWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().ScanWorkspace(rootPath);
}

export async function readWorkspaceFile(rootPath: string, relativePath: string): Promise<WorkspaceFileDocument> {
  return requireWorkspaceBridge().ReadWorkspaceFile(rootPath, relativePath);
}

export async function openWorkspaceInExplorer(rootPath: string): Promise<void> {
  return requireWorkspaceBridge().OpenWorkspaceInExplorer(rootPath);
}

export async function openWorkspaceEntry(rootPath: string, relativePath: string): Promise<void> {
  return requireWorkspaceBridge().OpenWorkspaceEntry(rootPath, relativePath);
}

export async function createWorkspaceDirectory(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().CreateWorkspaceDirectory(rootPath, relativePath);
}

export async function createWorkspaceFile(
  rootPath: string,
  relativePath: string,
  content = '',
): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().CreateWorkspaceFile(rootPath, relativePath, content);
}

export async function writeWorkspaceFile(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().WriteWorkspaceFile(rootPath, relativePath, content);
}

export async function writeWorkspaceFileDocument(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceFileDocument> {
  return requireWorkspaceBridge().WriteWorkspaceFileDocument(rootPath, relativePath, content);
}

export async function renameWorkspaceEntry(
  rootPath: string,
  relativePath: string,
  nextRelativePath: string,
): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().RenameWorkspaceEntry(rootPath, relativePath, nextRelativePath);
}

export async function copyWorkspaceEntry(
  rootPath: string,
  relativePath: string,
  nextRelativePath: string,
): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().CopyWorkspaceEntry(rootPath, relativePath, nextRelativePath);
}

export async function deleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().DeleteWorkspaceEntry(rootPath, relativePath);
}

export async function createWorkspaceBackup(
  rootPath: string,
  workspaceID: string,
  label: string,
): Promise<WorkspaceBackupReference> {
  return requireWorkspaceBridge().CreateWorkspaceBackup(rootPath, workspaceID, label);
}

export async function restoreWorkspaceBackup(rootPath: string, archivePath: string): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().RestoreWorkspaceBackup(rootPath, archivePath);
}

export async function inspectWorkspaceRuntime(rootPath: string): Promise<WorkspaceRuntimeProfile> {
  return requireWorkspaceBridge().InspectWorkspaceRuntime(rootPath);
}

export async function runWorkspaceCommand(
  rootPath: string,
  command: string,
  timeoutMs = 60_000,
): Promise<WorkspaceCommandResult> {
  return requireWorkspaceBridge().RunWorkspaceCommand(rootPath, command, timeoutMs);
}

export async function runWorkspaceWebPreview(
  rootPath: string,
  command: string,
  timeoutMs = 60_000,
): Promise<WorkspaceCommandResult> {
  return requireWorkspaceBridge().RunWorkspaceWebPreview(rootPath, command, timeoutMs);
}
