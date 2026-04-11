import type { FileEntry } from './fileRegistry';
import type { ProjectFolder, WorkspaceFileNode, WorkspaceSnapshot } from '../types';

const HANDLE_DB_NAME = 'LarryAIWorkspaceHandles';
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = 'workspace-handles';
const MAX_INDEXED_FILE_SIZE = 256 * 1024;

const ignoredDirectories = new Set([
  '.git',
  '.idea',
  '.next',
  '.turbo',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const ignoredExtensions = new Set([
  '.avi',
  '.bmp',
  '.dll',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lock',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.pyc',
  '.so',
  '.svgz',
  '.tar',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

export interface BrowserWorkspaceSelection {
  label: string;
  browserHandleId: string;
  snapshot: WorkspaceSnapshot;
  existingWorkspaceId?: string;
}

function getPickerWindow() {
  return window as Window & typeof globalThis & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };
}

function createBrowserHandleId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';

  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `browser-workspace:${slug}-${crypto.randomUUID()}`;
  }

  return `browser-workspace:${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    py: 'py',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    md: 'md',
    sh: 'sh',
    bash: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    go: 'go',
    rs: 'rs',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
  };
  return map[ext] ?? (ext || 'text');
}

function shouldSkipDirectory(name: string): boolean {
  return ignoredDirectories.has(name.toLowerCase());
}

function shouldSkipFile(name: string): boolean {
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : '';
  return ignoredExtensions.has(extension);
}

function sortWorkspaceNodes(nodes: WorkspaceFileNode[]) {
  nodes.sort((left, right) => {
    if (left.kind === right.kind) {
      return left.path.localeCompare(right.path, undefined, { sensitivity: 'base' });
    }

    return left.kind === 'directory' ? -1 : 1;
  });
}

function sortFileEntries(entries: FileEntry[]) {
  entries.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
}

async function readTextFile(handle: FileSystemFileHandle, normalizedPath: string): Promise<FileEntry | null> {
  const file = await handle.getFile();
  if (file.size > MAX_INDEXED_FILE_SIZE) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) return null;

  const content = new TextDecoder().decode(bytes);
  return {
    path: normalizedPath,
    content,
    lang: languageFromPath(normalizedPath),
    updatedAt: 0,
  };
}

async function scanDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  relativeBase = '',
): Promise<{
  fileTree: WorkspaceFileNode[];
  fileEntries: FileEntry[];
  fileCount: number;
  directoryCount: number;
}> {
  const discoveredEntries: Array<[string, FileSystemHandle]> = [];
  const iterableHandle = handle as unknown as AsyncIterable<FileSystemHandle>;
  for await (const entry of iterableHandle) {
    discoveredEntries.push([entry.name, entry]);
  }

  const fileTree: WorkspaceFileNode[] = [];
  const fileEntries: FileEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;

  for (const [name, entry] of discoveredEntries) {
    if (entry.kind === 'directory') {
      if (shouldSkipDirectory(name)) continue;

      const nextRelativePath = relativeBase ? `${relativeBase}/${name}` : name;
      const childDirectory = await scanDirectoryHandle(entry as FileSystemDirectoryHandle, nextRelativePath);
      fileTree.push({
        name,
        path: nextRelativePath,
        kind: 'directory',
        children: childDirectory.fileTree,
      });
      fileEntries.push(...childDirectory.fileEntries);
      fileCount += childDirectory.fileCount;
      directoryCount += childDirectory.directoryCount + 1;
      continue;
    }

    if (shouldSkipFile(name)) continue;

    const normalizedPath = relativeBase ? `${relativeBase}/${name}` : name;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
    fileTree.push({
      name,
      path: normalizedPath,
      kind: 'file',
      extension,
    });
    fileCount += 1;

    const fileEntry = await readTextFile(entry as FileSystemFileHandle, normalizedPath);
    if (fileEntry) {
      fileEntries.push(fileEntry);
    }
  }

  sortWorkspaceNodes(fileTree);
  sortFileEntries(fileEntries);

  return {
    fileTree,
    fileEntries,
    fileCount,
    directoryCount,
  };
}

async function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveBrowserWorkspaceHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadBrowserWorkspaceHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const request = tx.objectStore(HANDLE_STORE).get(id);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function findMatchingWorkspaceHandle(
  workspaces: ProjectFolder[],
  nextHandle: FileSystemDirectoryHandle,
): Promise<ProjectFolder | null> {
  const linkedWorkspaces = workspaces.filter((workspace) => workspace.browserHandleId);

  for (const workspace of linkedWorkspaces) {
    const existingHandle = await loadBrowserWorkspaceHandle(workspace.browserHandleId!);
    if (!existingHandle) continue;

    if (await existingHandle.isSameEntry(nextHandle)) {
      return workspace;
    }
  }

  return null;
}

async function buildBrowserSnapshot(handle: FileSystemDirectoryHandle): Promise<WorkspaceSnapshot> {
  const scanned = await scanDirectoryHandle(handle);
  return {
    rootPath: '',
    fileTree: scanned.fileTree,
    fileEntries: scanned.fileEntries,
    fileCount: scanned.fileCount,
    directoryCount: scanned.directoryCount,
    syncedAt: Date.now(),
  };
}

export function isBrowserWorkspacePickerAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof indexedDB === 'undefined') return false;
  return typeof getPickerWindow().showDirectoryPicker === 'function';
}

export async function pickBrowserWorkspaceDirectory(
  workspaces: ProjectFolder[],
): Promise<BrowserWorkspaceSelection | null> {
  if (!isBrowserWorkspacePickerAvailable()) return null;

  const handle = await getPickerWindow().showDirectoryPicker!();
  const existingWorkspace = await findMatchingWorkspaceHandle(workspaces, handle);
  const browserHandleId = existingWorkspace?.browserHandleId ?? createBrowserHandleId(handle.name);

  await saveBrowserWorkspaceHandle(browserHandleId, handle);
  const snapshot = await buildBrowserSnapshot(handle);

  return {
    label: handle.name || existingWorkspace?.label || 'Workspace',
    browserHandleId,
    snapshot,
    existingWorkspaceId: existingWorkspace?.id,
  };
}

export async function scanBrowserWorkspace(browserHandleId: string): Promise<WorkspaceSnapshot> {
  const handle = await loadBrowserWorkspaceHandle(browserHandleId);
  if (!handle) {
    throw new Error('Browser folder access is no longer available for this workspace. Re-link the folder.');
  }

  return buildBrowserSnapshot(handle);
}
