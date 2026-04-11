import type { ChatRecord, ProjectFolder, WorkspaceSnapshot } from '../types';

export interface WorkspaceGroup {
  id: string;
  aliases: string[];
  label: string;
  chats: ChatRecord[];
  updatedAt: number;
  createdAt: number;
  fileCount: number;
  directoryCount: number;
  rootPath?: string;
  browserHandleId?: string;
  fileTree?: ProjectFolder['fileTree'];
  fileEntries?: ProjectFolder['fileEntries'];
  syncedAt?: number;
}

export function workspaceHasLinkedSource(
  workspace: Pick<ProjectFolder, 'rootPath' | 'browserHandleId'> | Pick<WorkspaceGroup, 'rootPath' | 'browserHandleId'>,
): boolean {
  return Boolean(workspace.rootPath || workspace.browserHandleId);
}

export function normaliseProjectId(label: string): string {
  return `project:${label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-')}`;
}

export function buildWorkspaceIdFromPath(rootPath: string, label?: string): string {
  const cleanPath = rootPath.replace(/\\/g, '/').trim().toLowerCase();
  let hash = 0;

  for (let index = 0; index < cleanPath.length; index += 1) {
    hash = ((hash << 5) - hash + cleanPath.charCodeAt(index)) >>> 0;
  }

  const slugSource = (label || cleanPath.split('/').filter(Boolean).pop() || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';

  return `workspace:${slugSource}-${hash.toString(36)}`;
}

export function applyWorkspaceSnapshot<T extends Pick<ProjectFolder, 'rootPath' | 'browserHandleId'>>(
  folder: T,
  snapshot: WorkspaceSnapshot,
) {
  return {
    ...folder,
    rootPath: snapshot.rootPath || folder.rootPath,
    browserHandleId: folder.browserHandleId,
    fileTree: snapshot.fileTree,
    fileEntries: snapshot.fileEntries,
    fileCount: snapshot.fileCount,
    directoryCount: snapshot.directoryCount,
    syncedAt: snapshot.syncedAt,
  };
}

export function deriveWorkspaceFromChat(
  chat: Pick<ChatRecord, 'projectId' | 'projectLabel' | 'fileEntries'>,
): { id: string; label: string } {
  if (chat.projectId && chat.projectLabel) {
    return { id: chat.projectId, label: chat.projectLabel };
  }

  const entries = chat.fileEntries ?? [];
  if (!entries.length) return { id: 'project:general', label: 'General' };

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const top = entry.path.split('/')[0]?.trim();
    if (!top) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }

  if (!counts.size) return { id: 'project:general', label: 'General' };

  const [label] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { id: normaliseProjectId(label), label };
}

function normalizeWorkspaceLabel(label: string): string {
  return label.trim().toLowerCase();
}

function mergeWorkspaceGroup(target: WorkspaceGroup, source: WorkspaceGroup) {
  target.aliases = [...new Set([...target.aliases, ...source.aliases, source.id])];
  target.label = target.label || source.label;
  target.chats = [...target.chats, ...source.chats];
  target.updatedAt = Math.max(target.updatedAt, source.updatedAt);
  target.createdAt = Math.min(target.createdAt, source.createdAt);
  target.fileCount = Math.max(target.fileCount, source.fileCount);
  target.directoryCount = Math.max(target.directoryCount, source.directoryCount);
  target.rootPath = target.rootPath ?? source.rootPath;
  target.browserHandleId = target.browserHandleId ?? source.browserHandleId;
  target.fileTree = target.fileTree ?? source.fileTree;
  target.fileEntries = target.fileEntries?.length ? target.fileEntries : source.fileEntries;
  target.syncedAt = target.syncedAt ?? source.syncedAt;
}

export function findWorkspaceGroup(
  groups: WorkspaceGroup[],
  workspaceId: string | null | undefined,
): WorkspaceGroup | null {
  if (!workspaceId) return null;
  return groups.find((group) => group.id === workspaceId || group.aliases.includes(workspaceId)) ?? null;
}

export function buildWorkspaceGroups(chats: ChatRecord[], folders: ProjectFolder[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();
  const archivedIds = new Set(
    folders
      .filter((folder) => typeof folder.archivedAt === 'number' && folder.archivedAt > 0)
      .map((folder) => folder.id),
  );

  for (const chat of chats) {
    const workspace = deriveWorkspaceFromChat(chat);
    if (archivedIds.has(workspace.id)) continue;
    const existing = map.get(workspace.id);

    if (!existing) {
      map.set(workspace.id, {
        id: workspace.id,
        aliases: [workspace.id],
        label: workspace.label,
        chats: [chat],
        updatedAt: chat.updatedAt,
        createdAt: chat.updatedAt,
        fileCount: 0,
        directoryCount: 0,
      });
      continue;
    }

    existing.chats.push(chat);
    existing.updatedAt = Math.max(existing.updatedAt, chat.updatedAt);
  }

  for (const folder of folders) {
    if (archivedIds.has(folder.id)) continue;
    const existing = map.get(folder.id);
    const fileCount = folder.fileCount ?? folder.fileEntries?.length ?? 0;
    const directoryCount = folder.directoryCount ?? 0;

    if (!existing) {
      map.set(folder.id, {
        id: folder.id,
        aliases: [folder.id],
        label: folder.label,
        chats: [],
        updatedAt: folder.createdAt,
        createdAt: folder.createdAt,
        fileCount,
        directoryCount,
        rootPath: folder.rootPath,
        browserHandleId: folder.browserHandleId,
        fileTree: folder.fileTree,
        fileEntries: folder.fileEntries,
        syncedAt: folder.syncedAt,
      });
      continue;
    }

    existing.label = folder.label;
    existing.createdAt = Math.min(existing.createdAt, folder.createdAt);
    existing.fileCount = Math.max(existing.fileCount, fileCount);
    existing.directoryCount = Math.max(existing.directoryCount, directoryCount);
    existing.rootPath = folder.rootPath;
    existing.browserHandleId = folder.browserHandleId;
    existing.fileTree = folder.fileTree;
    existing.fileEntries = folder.fileEntries;
    existing.syncedAt = folder.syncedAt;
  }

  const groups = [...map.values()];
  const folderBackedByLabel = new Map<string, WorkspaceGroup[]>();

  for (const group of groups) {
    if (!workspaceHasLinkedSource(group)) continue;
    const labelKey = normalizeWorkspaceLabel(group.label);
    const existing = folderBackedByLabel.get(labelKey);
    if (existing) {
      existing.push(group);
    } else {
      folderBackedByLabel.set(labelKey, [group]);
    }
  }

  const merged = new Map<string, WorkspaceGroup>(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    if (workspaceHasLinkedSource(group)) continue;
    if (!merged.has(group.id)) continue;

    const labelMatches = folderBackedByLabel.get(normalizeWorkspaceLabel(group.label)) ?? [];
    const canonical = labelMatches.length === 1
      ? labelMatches[0]
      : labelMatches.find((candidate) => normaliseProjectId(candidate.label) === group.id);
    if (!canonical || canonical.id === group.id) continue;

    mergeWorkspaceGroup(canonical, group);
    merged.delete(group.id);
  }

  return [...merged.values()].sort((a, b) => {
    if (a.id === 'project:general') return 1;
    if (b.id === 'project:general') return -1;
    return b.updatedAt - a.updatedAt;
  });
}
