import { unzipSync, zipSync } from 'fflate';
import type { FileEntry } from './fileRegistry';
import type {
  ProjectFolder,
  WorkspaceBackupReference,
  WorkspaceFileDocument,
  WorkspaceFileNode,
  WorkspaceSnapshot,
} from '../types';

const HANDLE_DB_NAME = 'LarryAIWorkspaceHandles';
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = 'workspace-handles';
const MAX_INDEXED_FILE_SIZE = 256 * 1024;
const browserWorkspaceBackups = new Map<string, {
  bytes: Uint8Array;
  createdAt: number;
  label: string;
}>();

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

type BrowserWorkspacePermissionDescriptor = {
  mode?: 'read' | 'readwrite';
};

type BrowserDirectoryHandleWithRemove = FileSystemDirectoryHandle & {
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>;
};

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

function normalizeRelativeWorkspacePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);

  if (!segments.length) {
    throw new Error('A workspace file path is required.');
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Workspace paths must stay inside the selected folder.');
  }

  return segments.join('/');
}

async function ensureHandlePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'read',
): Promise<void> {
  const permissionHandle = handle as FileSystemHandle & {
    queryPermission?: (descriptor?: BrowserWorkspacePermissionDescriptor) => Promise<PermissionState>;
    requestPermission?: (descriptor?: BrowserWorkspacePermissionDescriptor) => Promise<PermissionState>;
  };

  const descriptor: BrowserWorkspacePermissionDescriptor = { mode };
  const current = permissionHandle.queryPermission
    ? await permissionHandle.queryPermission(descriptor)
    : 'granted';
  if (current === 'granted') return;

  const next = permissionHandle.requestPermission
    ? await permissionHandle.requestPermission(descriptor)
    : current;
  if (next !== 'granted') {
    throw new Error(`Browser workspace access for ${mode === 'readwrite' ? 'editing' : 'reading'} was denied.`);
  }
}

async function getBrowserWorkspaceRootHandle(
  browserHandleId: string,
  permissionMode: 'read' | 'readwrite' = 'read',
): Promise<FileSystemDirectoryHandle> {
  const handle = await loadBrowserWorkspaceHandle(browserHandleId);
  if (!handle) {
    throw new Error('Browser folder access is no longer available for this workspace. Re-link the folder.');
  }

  await ensureHandlePermission(handle, permissionMode);
  return handle;
}

async function resolveBrowserWorkspaceParentDirectory(
  browserHandleId: string,
  relativePath: string,
  options?: {
    createParentDirectories?: boolean;
    permissionMode?: 'read' | 'readwrite';
  },
): Promise<{
  directoryHandle: FileSystemDirectoryHandle;
  entryName: string;
  normalizedPath: string;
}> {
  const handle = await getBrowserWorkspaceRootHandle(browserHandleId, options?.permissionMode ?? 'read');

  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const segments = normalizedPath.split('/');
  const entryName = segments.pop();
  if (!entryName) {
    throw new Error('A workspace file path is required.');
  }

  let directoryHandle = handle;
  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, {
      create: options?.createParentDirectories ?? false,
    });
  }

  return {
    directoryHandle,
    entryName,
    normalizedPath,
  };
}

async function resolveBrowserWorkspaceFileHandle(
  browserHandleId: string,
  relativePath: string,
  options?: {
    create?: boolean;
    permissionMode?: 'read' | 'readwrite';
  },
): Promise<FileSystemFileHandle> {
  const { directoryHandle, entryName } = await resolveBrowserWorkspaceParentDirectory(browserHandleId, relativePath, {
    createParentDirectories: options?.create ?? false,
    permissionMode: options?.permissionMode,
  });

  return directoryHandle.getFileHandle(entryName, { create: options?.create ?? false });
}

async function resolveBrowserWorkspaceDirectoryHandle(
  browserHandleId: string,
  relativePath: string,
  options?: {
    create?: boolean;
    permissionMode?: 'read' | 'readwrite';
  },
): Promise<FileSystemDirectoryHandle> {
  const rootHandle = await getBrowserWorkspaceRootHandle(browserHandleId, options?.permissionMode ?? 'read');
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const segments = normalizedPath.split('/');

  let directoryHandle = rootHandle;
  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, {
      create: options?.create ?? false,
    });
  }

  return directoryHandle;
}

async function resolveBrowserWorkspaceEntryHandle(
  browserHandleId: string,
  relativePath: string,
  options?: {
    permissionMode?: 'read' | 'readwrite';
  },
): Promise<FileSystemHandle> {
  try {
    return await resolveBrowserWorkspaceFileHandle(browserHandleId, relativePath, {
      permissionMode: options?.permissionMode,
    });
  } catch {
    return resolveBrowserWorkspaceDirectoryHandle(browserHandleId, relativePath, {
      permissionMode: options?.permissionMode,
    });
  }
}

async function copyBrowserWorkspaceHandleRecursive(
  browserHandleId: string,
  sourceHandle: FileSystemHandle,
  nextRelativePath: string,
): Promise<void> {
  const normalizedTargetPath = normalizeRelativeWorkspacePath(nextRelativePath);

  if (sourceHandle.kind === 'directory') {
    await resolveBrowserWorkspaceDirectoryHandle(browserHandleId, normalizedTargetPath, {
      create: true,
      permissionMode: 'readwrite',
    });
    const iterableHandle = sourceHandle as FileSystemDirectoryHandle as unknown as AsyncIterable<FileSystemHandle>;
    for await (const entry of iterableHandle) {
      const childRelativePath = `${normalizedTargetPath}/${entry.name}`;
      await copyBrowserWorkspaceHandleRecursive(browserHandleId, entry, childRelativePath);
    }
    return;
  }

  const sourceFile = await (sourceHandle as FileSystemFileHandle).getFile();
  const targetHandle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedTargetPath, {
    create: true,
    permissionMode: 'readwrite',
  });
  const writable = await targetHandle.createWritable();
  await writable.write(await sourceFile.arrayBuffer());
  await writable.close();
}

async function buildBrowserWorkspaceDocument(
  handle: FileSystemFileHandle,
  normalizedPath: string,
): Promise<WorkspaceFileDocument> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) {
    throw new Error('This file looks binary and cannot be opened in the workspace editor yet.');
  }

  let content = '';
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be opened in the workspace editor right now.');
  }

  return {
    path: normalizedPath,
    content,
    lang: languageFromPath(normalizedPath),
    sizeBytes: file.size,
    modifiedAt: file.lastModified || Date.now(),
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

async function collectDirectoryBytesForBackup(
  handle: FileSystemDirectoryHandle,
  relativeBase = '',
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const iterableHandle = handle as unknown as AsyncIterable<FileSystemHandle>;

  for await (const entry of iterableHandle) {
    const nextRelativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      if (shouldSkipDirectory(entry.name)) continue;
      Object.assign(files, await collectDirectoryBytesForBackup(entry as FileSystemDirectoryHandle, nextRelativePath));
      continue;
    }

    const file = await (entry as FileSystemFileHandle).getFile();
    files[nextRelativePath] = new Uint8Array(await file.arrayBuffer());
  }

  return files;
}

async function clearBrowserWorkspaceForRestore(handle: FileSystemDirectoryHandle): Promise<void> {
  const removableHandle = handle as BrowserDirectoryHandleWithRemove;
  if (typeof removableHandle.removeEntry !== 'function') {
    throw new Error('Restoring browser workspace backups is not supported in this browser.');
  }

  const iterableHandle = handle as unknown as AsyncIterable<FileSystemHandle>;
  for await (const entry of iterableHandle) {
    if (entry.kind === 'directory' && shouldSkipDirectory(entry.name)) {
      continue;
    }

    await removableHandle.removeEntry(entry.name, { recursive: true });
  }
}

function createBrowserWorkspaceBackupId(label: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `browser-backup:${label}:${crypto.randomUUID()}`;
  }

  return `browser-backup:${label}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

export async function readBrowserWorkspaceFile(
  browserHandleId: string,
  relativePath: string,
): Promise<WorkspaceFileDocument> {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedPath);
  return buildBrowserWorkspaceDocument(handle, normalizedPath);
}

export async function createBrowserWorkspaceFile(
  browserHandleId: string,
  relativePath: string,
  content = '',
): Promise<WorkspaceSnapshot> {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const existingHandle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedPath, {
    permissionMode: 'read',
  }).catch(() => null);
  if (existingHandle) {
    throw new Error(`File "${normalizedPath}" already exists.`);
  }

  const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedPath, {
    create: true,
    permissionMode: 'readwrite',
  });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return scanBrowserWorkspace(browserHandleId);
}

export async function createBrowserWorkspaceDirectory(
  browserHandleId: string,
  relativePath: string,
): Promise<WorkspaceSnapshot> {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const existingHandle = await resolveBrowserWorkspaceEntryHandle(browserHandleId, normalizedPath, {
    permissionMode: 'read',
  }).catch(() => null);
  if (existingHandle) {
    throw new Error(`Folder "${normalizedPath}" already exists.`);
  }

  await resolveBrowserWorkspaceDirectoryHandle(browserHandleId, normalizedPath, {
    create: true,
    permissionMode: 'readwrite',
  });
  return scanBrowserWorkspace(browserHandleId);
}

export async function copyBrowserWorkspaceEntry(
  browserHandleId: string,
  relativePath: string,
  nextRelativePath: string,
): Promise<WorkspaceSnapshot> {
  const sourceHandle = await resolveBrowserWorkspaceEntryHandle(browserHandleId, relativePath, {
    permissionMode: 'read',
  });
  const normalizedTargetPath = normalizeRelativeWorkspacePath(nextRelativePath);
  if (normalizeRelativeWorkspacePath(relativePath) === normalizedTargetPath) {
    throw new Error('Copy destination must be different from the source path.');
  }

  const existingHandle = await resolveBrowserWorkspaceEntryHandle(browserHandleId, normalizedTargetPath, {
    permissionMode: 'read',
  }).catch(() => null);
  if (existingHandle) {
    throw new Error(`"${normalizedTargetPath}" already exists.`);
  }

  await copyBrowserWorkspaceHandleRecursive(browserHandleId, sourceHandle, normalizedTargetPath);
  return scanBrowserWorkspace(browserHandleId);
}

export async function writeBrowserWorkspaceFile(
  browserHandleId: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceSnapshot> {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedPath, {
    create: true,
    permissionMode: 'readwrite',
  });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return scanBrowserWorkspace(browserHandleId);
}

export async function writeBrowserWorkspaceFileDocument(
  browserHandleId: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceFileDocument> {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, normalizedPath, {
    create: true,
    permissionMode: 'readwrite',
  });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return readBrowserWorkspaceFile(browserHandleId, normalizedPath);
}

export async function renameBrowserWorkspaceFile(
  browserHandleId: string,
  relativePath: string,
  nextRelativePath: string,
): Promise<WorkspaceSnapshot> {
  return renameBrowserWorkspaceEntry(browserHandleId, relativePath, nextRelativePath);
}

export async function renameBrowserWorkspaceEntry(
  browserHandleId: string,
  relativePath: string,
  nextRelativePath: string,
): Promise<WorkspaceSnapshot> {
  if (normalizeRelativeWorkspacePath(relativePath) === normalizeRelativeWorkspacePath(nextRelativePath)) {
    return scanBrowserWorkspace(browserHandleId);
  }

  await copyBrowserWorkspaceEntry(browserHandleId, relativePath, nextRelativePath);
  await deleteBrowserWorkspaceEntry(browserHandleId, relativePath);
  return scanBrowserWorkspace(browserHandleId);
}

export async function deleteBrowserWorkspaceEntry(
  browserHandleId: string,
  relativePath: string,
): Promise<WorkspaceSnapshot> {
  const { directoryHandle, entryName } = await resolveBrowserWorkspaceParentDirectory(browserHandleId, relativePath, {
    permissionMode: 'readwrite',
  });

  const removableDirectoryHandle = directoryHandle as BrowserDirectoryHandleWithRemove;
  if (typeof removableDirectoryHandle.removeEntry !== 'function') {
    throw new Error('Deleting browser workspace files is not supported in this browser.');
  }

  await removableDirectoryHandle.removeEntry(entryName, { recursive: true });
  return scanBrowserWorkspace(browserHandleId);
}

export async function openBrowserWorkspaceFileExternal(
  browserHandleId: string,
  relativePath: string,
): Promise<void> {
  const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, relativePath, {
    permissionMode: 'read',
  });
  const file = await handle.getFile();
  const objectUrl = URL.createObjectURL(file);
  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 60_000);
}

export async function createBrowserWorkspaceBackup(
  browserHandleId: string,
  label: string,
): Promise<WorkspaceBackupReference> {
  const handle = await getBrowserWorkspaceRootHandle(browserHandleId, 'read');
  const files = await collectDirectoryBytesForBackup(handle);
  const createdAt = Date.now();
  const backupId = createBrowserWorkspaceBackupId(label || 'workspace');
  browserWorkspaceBackups.set(backupId, {
    bytes: Uint8Array.from(zipSync(files, { level: 6 })),
    createdAt,
    label: label || 'Workspace',
  });

  return {
    id: backupId,
    label: label || 'Workspace',
    createdAt,
    browserBackupId: backupId,
  };
}

export async function restoreBrowserWorkspaceBackup(
  browserHandleId: string,
  backupId: string,
): Promise<WorkspaceSnapshot> {
  const backup = browserWorkspaceBackups.get(backupId);
  if (!backup) {
    throw new Error('This browser workspace backup is no longer available in the current session.');
  }

  const rootHandle = await getBrowserWorkspaceRootHandle(browserHandleId, 'readwrite');
  await clearBrowserWorkspaceForRestore(rootHandle);

  const restoredEntries = unzipSync(backup.bytes);
  for (const [relativePath, bytes] of Object.entries(restoredEntries)) {
    if (!relativePath || relativePath.endsWith('/')) continue;

    const handle = await resolveBrowserWorkspaceFileHandle(browserHandleId, relativePath, {
      create: true,
      permissionMode: 'readwrite',
    });
    const writable = await handle.createWritable();
    const outputBytes = new Uint8Array(bytes.byteLength);
    outputBytes.set(bytes);
    await writable.write(outputBytes);
    await writable.close();
  }

  return scanBrowserWorkspace(browserHandleId);
}
