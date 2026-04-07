import { useEffect, useMemo, useState } from 'react';
import { buildWorkspaceGroups } from '../lib/workspaces';
import type { ChatRecord, ProjectFolder } from '../types';
import {
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconMessageSquare,
  IconTrash2,
  IconUpload,
} from './Icon';

interface Props {
  mode: 'code' | 'debug';
  folders: ProjectFolder[];
  chats: ChatRecord[];
  activeChatId: string | null;
  onOpenWorkspaceLauncher: (mode?: 'create' | 'import') => void;
  onCreateChatInFolder: (folder: { id: string; label: string }) => void;
  onOpenChat: (chat: ChatRecord) => void;
  onDeleteChat: (id: string) => void;
  onDeleteWorkspace: (workspace: { id: string; label: string }) => void;
}

function formatSidebarAge(updatedAt: number): string {
  const deltaMinutes = Math.max(1, Math.floor((Date.now() - updatedAt) / 60000));
  if (deltaMinutes < 60) return `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d`;

  return new Date(updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Sidebar({
  mode,
  folders,
  chats,
  activeChatId,
  onOpenWorkspaceLauncher,
  onCreateChatInFolder,
  onOpenChat,
  onDeleteChat,
  onDeleteWorkspace,
}: Props) {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  const groups = useMemo(
    () => buildWorkspaceGroups(chats, folders).filter((group) => group.id !== 'project:general'),
    [chats, folders],
  );
  const modeLabel = mode === 'debug' ? 'Debug Explorer' : 'Code Explorer';
  const threadLabel = mode === 'debug' ? 'debug' : 'code';

  useEffect(() => {
    if (activeChatId) {
      const workspace = groups.find((group) => group.chats.some((chat) => chat.id === activeChatId));
      if (workspace) {
        setActiveWorkspaceId(workspace.id);
        return;
      }
    }

    setActiveWorkspaceId((current) => {
      if (current && groups.some((group) => group.id === current)) return current;
      return groups[0]?.id ?? null;
    });
  }, [activeChatId, groups]);

  return (
    <aside className="workspace-sidebar">
      <div className="workspace-sidebar-head">
        <span className="workspace-sidebar-eyebrow">{modeLabel}</span>
        <h2>Project threads</h2>
        <p>Workspaces hold folders and saved {threadLabel} threads.</p>
      </div>

      <div className="workspace-sidebar-actions">
        <button
          type="button"
          className="workspace-sidebar-btn primary"
          onClick={() => onOpenWorkspaceLauncher('create')}
        >
          <IconFolderPlus size={14} />
          <span>New workspace</span>
        </button>
        <button
          type="button"
          className="workspace-sidebar-btn"
          onClick={() => onOpenWorkspaceLauncher('import')}
        >
          <IconUpload size={14} />
          <span>Import folder</span>
        </button>
      </div>

      <div className="workspace-sidebar-list">
        {groups.length === 0 ? (
          <div className="workspace-sidebar-empty">
            Create or import a workspace to start keeping {threadLabel} threads in the explorer.
          </div>
        ) : (
          groups.map((group) => {
            const isActive = activeWorkspaceId === group.id;
            return (
              <section key={group.id} className={`workspace-tree${isActive ? ' active' : ''}`}>
                <div className="workspace-tree-head">
                  <button
                    type="button"
                    className={`workspace-tree-toggle${isActive ? ' active' : ''}`}
                    aria-expanded={isActive}
                    onClick={() => setActiveWorkspaceId((current) => (current === group.id ? null : group.id))}
                    title={group.label}
                  >
                    <span className="workspace-tree-icon">
                      {isActive ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
                    </span>
                    <span className="workspace-tree-label">{group.label}</span>
                    <span className="workspace-tree-count">{group.chats.length}</span>
                  </button>

                  <div className="workspace-tree-tools">
                    <button
                      type="button"
                      className="workspace-tree-tool primary"
                      onClick={() => onCreateChatInFolder({ id: group.id, label: group.label })}
                      title={`New ${threadLabel} thread`}
                    >
                      <IconMessageSquare size={13} />
                    </button>
                    <button
                      type="button"
                      className="workspace-tree-tool danger"
                      onClick={() => onDeleteWorkspace({ id: group.id, label: group.label })}
                      title="Delete workspace"
                    >
                      <IconTrash2 size={12} />
                    </button>
                  </div>
                </div>

                {isActive && (
                  <div className="workspace-tree-body">
                    {group.chats.length ? (
                      <div className="workspace-thread-list">
                        {group.chats.map((chat) => {
                          const isOpen = activeChatId === chat.id;
                          return (
                            <div key={chat.id} className={`workspace-thread-row${isOpen ? ' open' : ''}`}>
                              <button
                                type="button"
                                className="workspace-thread-open"
                                onClick={() => onOpenChat(chat)}
                                title={chat.title || 'Untitled'}
                              >
                                <span className="workspace-thread-title">{chat.title || 'Untitled'}</span>
                                <span className="workspace-thread-time">{formatSidebarAge(chat.updatedAt)}</span>
                              </button>
                              <button
                                type="button"
                                className="workspace-thread-delete"
                                title="Delete chat"
                                onClick={() => onDeleteChat(chat.id)}
                              >
                                <IconTrash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="workspace-tree-empty">
                        This workspace does not have any saved {threadLabel} threads yet.
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
