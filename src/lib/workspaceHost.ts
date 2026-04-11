import type { WorkspaceSelection, WorkspaceSnapshot } from '../types';

interface WorkspaceHostBridge {
  PickWorkspaceDirectory(): Promise<WorkspaceSelection>;
  CreateManagedWorkspaceDirectory(label: string): Promise<WorkspaceSelection>;
  ScanWorkspace(rootPath: string): Promise<WorkspaceSnapshot>;
  OpenWorkspaceInExplorer(rootPath: string): Promise<void>;
  CreateWorkspaceDirectory(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
  CreateWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  WriteWorkspaceFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSnapshot>;
  DeleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot>;
}

function getWorkspaceBridge(): WorkspaceHostBridge | null {
  if (typeof window === 'undefined') return null;
  const app = window.go?.main?.App;
  if (!app) return null;

  const requiredMethods: Array<keyof WorkspaceHostBridge> = [
    'PickWorkspaceDirectory',
    'CreateManagedWorkspaceDirectory',
    'ScanWorkspace',
    'OpenWorkspaceInExplorer',
    'CreateWorkspaceDirectory',
    'CreateWorkspaceFile',
    'WriteWorkspaceFile',
    'DeleteWorkspaceEntry',
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

export async function openWorkspaceInExplorer(rootPath: string): Promise<void> {
  return requireWorkspaceBridge().OpenWorkspaceInExplorer(rootPath);
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

export async function deleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<WorkspaceSnapshot> {
  return requireWorkspaceBridge().DeleteWorkspaceEntry(rootPath, relativePath);
}
