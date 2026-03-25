import { useMemo, useRef, useState } from 'react';
import type { ChatRecord, ProjectFolder } from '../types';
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconMenu,
  IconMessageSquare,
  IconPlus,
  IconTrash2,
  IconUpload,
} from './Icon';

interface Props {
  collapsed: boolean;
  view: 'chats' | 'settings';
  folders: ProjectFolder[];
  chats: ChatRecord[];
  openPanelIds: string[];
  status: 'connecting' | 'online' | 'error';
  statusLabel: string;
  onToggleCollapsed: () => void;
  onChangeView: (view: 'chats' | 'settings') => void;
  onCreateFolder: () => void;
  onCreateChatInFolder: (folder: { id: string; label: string }) => void;
  onCreateChat: () => void;
  onOpenChat: (chat: ChatRecord) => void;
  onDeleteChat: (id: string) => void;
  onImportLogs: (files: File[]) => void;
  onImportDirectory: (files: File[]) => void;
  onImportDirectoryToFolder: (folder: { id: string; label: string }, files: File[]) => void;
}

interface ChatGroup {
  id: string;
  label: string;
  chats: ChatRecord[];
  updatedAt: number;
}

function normaliseProjectId(label: string): string {
  return `project:${label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-')}`;
}

function deriveProjectFromEntries(chat: ChatRecord): { id: string; label: string } {
  if (chat.projectId && chat.projectLabel) {
    return { id: chat.projectId, label: chat.projectLabel };
  }

  const entries = chat.fileEntries ?? [];
  if (!entries.length) return { id: 'project:general', label: 'General' };

  const counts = new Map<string, number>();
  for (const e of entries) {
    const top = e.path.split('/')[0]?.trim();
    if (!top) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }

  if (!counts.size) return { id: 'project:general', label: 'General' };

  const [label] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { id: normaliseProjectId(label), label };
}

export function Sidebar({
  collapsed,
  view,
  folders,
  chats,
  openPanelIds,
  status,
  statusLabel,
  onToggleCollapsed,
  onChangeView,
  onCreateFolder,
  onCreateChatInFolder,
  onCreateChat,
  onOpenChat,
  onDeleteChat,
  onImportLogs,
  onImportDirectory,
  onImportDirectoryToFolder,
}: Props) {
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const importLogsRef = useRef<HTMLInputElement>(null);
  const importDirRef = useRef<HTMLInputElement>(null);
  const folderImportRef = useRef<HTMLInputElement>(null);
  const [folderImportTarget, setFolderImportTarget] = useState<string | null>(null);

  const filtered = query
    ? chats.filter((c) => (c.title || '').toLowerCase().includes(query.toLowerCase()))
    : chats;

  const groups = useMemo<ChatGroup[]>(() => {
    const map = new Map<string, ChatGroup>();
    for (const chat of filtered) {
      const project = deriveProjectFromEntries(chat);
      const existing = map.get(project.id);
      if (!existing) {
        map.set(project.id, {
          id: project.id,
          label: project.label,
          chats: [chat],
          updatedAt: chat.updatedAt,
        });
      } else {
        existing.chats.push(chat);
        existing.updatedAt = Math.max(existing.updatedAt, chat.updatedAt);
      }
    }

    for (const folder of folders) {
      if (!map.has(folder.id)) {
        map.set(folder.id, {
          id: folder.id,
          label: folder.label,
          chats: [],
          updatedAt: folder.createdAt,
        });
      }
    }

    return [...map.values()].sort((a, b) => {
      if (a.id === 'project:general') return 1;
      if (b.id === 'project:general') return -1;
      return b.updatedAt - a.updatedAt;
    });
  }, [filtered, folders]);

  return (
    <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-top">
        <button className="sidebar-icon-btn" onClick={onToggleCollapsed} title="Toggle sidebar">
          <IconMenu size={14} />
        </button>
        {!collapsed && (
          <>
            <div className={`sidebar-status-dot ${status}`} />
            <span className="sidebar-status-label">{statusLabel}</span>
          </>
        )}
      </div>

      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab${view === 'chats' ? ' active' : ''}`}
          onClick={() => onChangeView('chats')}
          title="Chats"
        >
          <IconMessageSquare size={14} />
          {!collapsed && <span>Chats</span>}
        </button>
        <button
          className={`sidebar-tab${view === 'settings' ? ' active' : ''}`}
          onClick={() => onChangeView('settings')}
          title="Settings"
        >
          <IconChevronRight size={14} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>

      {view === 'chats' && (
        <>
          <div className="sidebar-actions">
            <input
              ref={importLogsRef}
              type="file"
              accept=".md,text/markdown"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) onImportLogs(files);
              }}
            />
            <input
              ref={importDirRef}
              type="file"
              // @ts-ignore
              webkitdirectory=""
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) onImportDirectory(files);
              }}
            />
            <input
              ref={folderImportRef}
              type="file"
              // @ts-ignore
              webkitdirectory=""
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length && folderImportTarget) {
                  const target = groups.find(g => g.id === folderImportTarget);
                  if (target) onImportDirectoryToFolder({ id: target.id, label: target.label }, files);
                }
                setFolderImportTarget(null);
              }}
            />

            <div className="sidebar-action-row">
              <button className="sidebar-action-icon primary" onClick={onCreateFolder} title="New folder" data-tip="New Folder">
                <IconPlus size={13} />
              </button>
              <button className="sidebar-action-icon" onClick={() => importLogsRef.current?.click()} title="Import chat logs" data-tip="Import Logs">
                <IconUpload size={13} />
              </button>
              <button className="sidebar-action-icon" onClick={() => importDirRef.current?.click()} title="Import project directory" data-tip="Import Project">
                <IconFolder size={13} />
              </button>
              <button className="sidebar-action-icon" onClick={onCreateChat} title="New chat" data-tip="New Chat">
                <IconMessageSquare size={13} />
              </button>
            </div>
          </div>

          {!collapsed && (
            <>
              <div className="sidebar-history-head">
                <span>Conversation History</span>
              </div>
              <input
                className="sidebar-search"
                placeholder="Search chats..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </>
          )}

          <div className="sidebar-history">
            {filtered.length === 0 ? (
              !collapsed && <div className="sidebar-empty">No chats found.</div>
            ) : collapsed ? (
              filtered.slice(0, 18).map(chat => (
                <div key={chat.id} className={`sidebar-history-item${openPanelIds.includes(chat.id) ? ' open' : ''}`}>
                  <button
                    className="sidebar-history-open"
                    onClick={() => onOpenChat(chat)}
                    title={chat.title || 'Untitled'}
                  >
                    <IconMessageSquare size={13} />
                  </button>
                </div>
              ))
            ) : (
              groups.map(group => {
                const isCollapsed = collapsedGroups[group.id] ?? false;
                return (
                  <div key={group.id} className="sidebar-group">
                    <div className="sidebar-group-header">
                      <button
                        className="sidebar-group-toggle"
                        onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.id]: !isCollapsed }))}
                      >
                      <span className="sidebar-group-chevron">
                        {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                      </span>
                      <span className="sidebar-group-icon">
                        {isCollapsed ? <IconFolder size={13} /> : <IconFolderOpen size={13} />}
                      </span>
                      <span className="sidebar-group-label">{group.label}</span>
                      <span className="sidebar-group-count">{group.chats.length}</span>
                      </button>
                      <div className="sidebar-group-actions">
                        <button
                          className="sidebar-group-action"
                          title="Select project folder"
                          onClick={() => {
                            setFolderImportTarget(group.id);
                            folderImportRef.current?.click();
                          }}
                        >
                          <IconFolder size={12} />
                        </button>
                        <button
                          className="sidebar-group-action"
                          title="New chat in folder"
                          onClick={() => onCreateChatInFolder({ id: group.id, label: group.label })}
                        >
                          <IconPlus size={12} />
                        </button>
                      </div>
                    </div>

                    {!isCollapsed && (
                      <div className="sidebar-group-list">
                        {group.chats.map((chat) => {
                          const isOpen = openPanelIds.includes(chat.id);
                          const d = new Date(chat.updatedAt);
                          const dateStr =
                            d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
                            ' · ' +
                            d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                          return (
                            <div key={chat.id} className={`sidebar-history-item${isOpen ? ' open' : ''}`}>
                              <button
                                className="sidebar-history-open"
                                onClick={() => onOpenChat(chat)}
                                title={chat.title || 'Untitled'}
                              >
                                <IconMessageSquare size={13} />
                                <span className="sidebar-history-item-info">
                                  <span className="sidebar-history-item-title">{chat.title || 'Untitled'}</span>
                                  <span className="sidebar-history-item-date">{dateStr}</span>
                                </span>
                              </button>
                              <button
                                className="sidebar-history-delete"
                                title="Delete chat"
                                onClick={() => onDeleteChat(chat.id)}
                              >
                                <IconTrash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {!collapsed && filtered.length > 0 && (
            <div className="sidebar-history-footer">
              <span>{filtered.length} chat{filtered.length !== 1 ? 's' : ''} in {groups.length} project folder{groups.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </>
      )}

      {view === 'settings' && !collapsed && (
        <div className="sidebar-settings-placeholder">
          Settings is ready for presets, skills, theme, and model controls.
        </div>
      )}
    </aside>
  );
}
