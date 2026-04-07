import type { ChatRecord, ProjectFolder } from '../types';

export interface WorkspaceGroup {
  id: string;
  label: string;
  chats: ChatRecord[];
  updatedAt: number;
  createdAt: number;
  fileCount: number;
}

export function normaliseProjectId(label: string): string {
  return `project:${label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-')}`;
}

export function deriveWorkspaceFromChat(chat: ChatRecord): { id: string; label: string } {
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

export function buildWorkspaceGroups(chats: ChatRecord[], folders: ProjectFolder[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();

  for (const chat of chats) {
    const workspace = deriveWorkspaceFromChat(chat);
    const existing = map.get(workspace.id);

    if (!existing) {
      map.set(workspace.id, {
        id: workspace.id,
        label: workspace.label,
        chats: [chat],
        updatedAt: chat.updatedAt,
        createdAt: chat.updatedAt,
        fileCount: 0,
      });
      continue;
    }

    existing.chats.push(chat);
    existing.updatedAt = Math.max(existing.updatedAt, chat.updatedAt);
  }

  for (const folder of folders) {
    const existing = map.get(folder.id);
    const fileCount = folder.fileEntries?.length ?? 0;

    if (!existing) {
      map.set(folder.id, {
        id: folder.id,
        label: folder.label,
        chats: [],
        updatedAt: folder.createdAt,
        createdAt: folder.createdAt,
        fileCount,
      });
      continue;
    }

    existing.label = folder.label;
    existing.createdAt = Math.min(existing.createdAt, folder.createdAt);
    existing.fileCount = Math.max(existing.fileCount, fileCount);
  }

  return [...map.values()].sort((a, b) => {
    if (a.id === 'project:general') return 1;
    if (b.id === 'project:general') return -1;
    return b.updatedAt - a.updatedAt;
  });
}
