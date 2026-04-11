import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceHasLinkedSource, type WorkspaceGroup } from '../lib/workspaces';
import type { ChatRecord, WorkspaceFileNode } from '../types';
import {
  IconArchive,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGripHorizontal,
  IconMessageSquare,
  IconRefreshCw,
  IconSearch,
  IconSettings,
  IconSquarePen,
  IconTrash2,
  IconX,
} from './Icon';

type CodeSidebarProps = {
  mode: 'code';
  workspaces: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  activeChatId: string | null;
  onCreateWorkspace: () => void;
  onSelectWorkspace: (workspace: WorkspaceGroup) => void;
  onClearActiveWorkspace: () => void;
  onCreateChat: () => void;
  onOpenChat: (chat: ChatRecord) => void;
  onDeleteChat: (id: string) => void;
  onRenameWorkspace: (workspace: WorkspaceGroup, nextLabel: string) => void;
  onArchiveWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenWorkspaceInExplorer: (workspace: WorkspaceGroup) => void;
  onRefreshWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenSettings: () => void;
};

type ChatSidebarProps = {
  mode: 'chat';
  chats: ChatRecord[];
  activeChatId: string | null;
  openPanelIds: string[];
  onCreateChat: () => void;
  onOpenChat: (chat: ChatRecord) => void;
  onDeleteChat: (id: string) => void;
  onOpenSettings: () => void;
};

type Props = CodeSidebarProps | ChatSidebarProps;

function formatHistoryTimestamp(updatedAt: number): string {
  const elapsedMs = Math.max(0, Date.now() - updatedAt);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  if (elapsedMs < minuteMs) return 'now';
  if (elapsedMs < hourMs) return `${Math.max(1, Math.floor(elapsedMs / minuteMs))}m`;
  if (elapsedMs < dayMs) return `${Math.max(1, Math.floor(elapsedMs / hourMs))}h`;
  if (elapsedMs < weekMs) return `${Math.max(1, Math.floor(elapsedMs / dayMs))}d`;

  const date = new Date(updatedAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function formatHistoryTimestampDetail(updatedAt: number): string {
  const date = new Date(updatedAt);
  return `Updated ${date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })} at ${date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function compressPreviewText(value?: string, fallback = ''): string {
  const compact = (value ?? fallback).replace(/\s+/g, ' ').trim();
  return compact || fallback;
}

function findRecentMessage(chat: ChatRecord, role?: 'user' | 'assistant') {
  return [...(chat.messages ?? [])]
    .reverse()
    .find((message) => message.content.trim() && (!role || message.role === role));
}

function WorkspaceRow({
  workspace,
  selected,
  isEditing,
  editingLabel,
  onEditingLabelChange,
  onStartEditing,
  onCancelEditing,
  onCommitEditing,
  onSelectWorkspace,
  onArchiveWorkspace,
  onOpenWorkspaceInExplorer,
}: {
  workspace: WorkspaceGroup;
  selected: boolean;
  isEditing: boolean;
  editingLabel: string;
  onEditingLabelChange: (value: string) => void;
  onStartEditing: (workspace: WorkspaceGroup) => void;
  onCancelEditing: () => void;
  onCommitEditing: (workspace: WorkspaceGroup) => void;
  onSelectWorkspace: (workspace: WorkspaceGroup) => void;
  onArchiveWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenWorkspaceInExplorer: (workspace: WorkspaceGroup) => void;
}) {
  if (isEditing) {
    return (
      <article className={`workbench-workspace-row${selected ? ' active' : ''}`}>
        <div className="workbench-workspace-edit">
          <input
            autoFocus
            className="workbench-workspace-input"
            value={editingLabel}
            onChange={(event) => onEditingLabelChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommitEditing(workspace);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancelEditing();
              }
            }}
          />

          <div className="workbench-workspace-actions inline">
            <button
              type="button"
              className="workbench-thread-section-tool"
              onClick={() => onCommitEditing(workspace)}
              title="Save workspace name"
            >
              <IconCheck size={14} />
            </button>
            <button
              type="button"
              className="workbench-thread-section-tool"
              onClick={onCancelEditing}
              title="Cancel rename"
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`workbench-workspace-row${selected ? ' active' : ''}`}>
      <button
        type="button"
        className={`workbench-thread-item workbench-thread-item-workspace${selected ? ' active' : ''}`}
        onClick={() => onSelectWorkspace(workspace)}
        title={workspace.label || 'Untitled workspace'}
      >
        <span className="workbench-thread-item-icon">
          <IconFolder size={15} />
        </span>
        <span className="workbench-thread-item-label">{workspace.label || 'Untitled workspace'}</span>
      </button>

      <div className="workbench-workspace-actions">
        <button
          type="button"
          className="workbench-thread-section-tool"
          onClick={() => onStartEditing(workspace)}
          title="Rename workspace"
        >
          <IconSquarePen size={14} />
        </button>
        <button
          type="button"
          className="workbench-thread-section-tool"
          onClick={() => onArchiveWorkspace(workspace)}
          title="Archive workspace"
        >
          <IconArchive size={14} />
        </button>
        <button
          type="button"
          className="workbench-thread-section-tool"
          onClick={() => onOpenWorkspaceInExplorer(workspace)}
          title={workspace.rootPath ? 'Open in file explorer' : 'No linked folder yet'}
          disabled={!workspace.rootPath}
        >
          <IconArrowUpRight size={14} />
        </button>
      </div>
    </article>
  );
}

function WorkspaceFileTree({
  nodes,
  collapsedPaths,
  onToggleDirectory,
}: {
  nodes: WorkspaceFileNode[];
  collapsedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
}) {
  return (
    <div className="code-file-tree-list" role="tree" aria-label="Workspace files">
      {nodes.map((node) => (
        <WorkspaceFileTreeNode
          key={node.path}
          node={node}
          depth={0}
          collapsedPaths={collapsedPaths}
          onToggleDirectory={onToggleDirectory}
        />
      ))}
    </div>
  );
}

function WorkspaceFileTreeNode({
  node,
  depth,
  collapsedPaths,
  onToggleDirectory,
}: {
  node: WorkspaceFileNode;
  depth: number;
  collapsedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
}) {
  const isDirectory = node.kind === 'directory';
  const isCollapsed = isDirectory && collapsedPaths.has(node.path);
  const paddingLeft = 12 + (depth * 16);

  return (
    <div className="code-file-tree-node">
      <button
        type="button"
        className={`code-file-tree-item${isDirectory ? ' directory' : ''}`}
        style={{ paddingLeft }}
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(node.path);
          }
        }}
        aria-expanded={isDirectory ? !isCollapsed : undefined}
        role="treeitem"
      >
        {isDirectory ? (
          <span className="code-file-tree-toggle" aria-hidden="true">
            {isCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
          </span>
        ) : (
          <span className="code-file-tree-toggle placeholder" aria-hidden="true" />
        )}

        <span className="code-file-tree-icon" aria-hidden="true">
          {isDirectory
            ? (isCollapsed ? <IconFolder size={14} /> : <IconFolderOpen size={14} />)
            : <IconFileText size={14} />}
        </span>

        <span className="code-file-tree-label">{node.name}</span>
      </button>

      {isDirectory && !isCollapsed && node.children?.length ? (
        <div role="group">
          {node.children.map((child) => (
            <WorkspaceFileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsedPaths={collapsedPaths}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CodeSidebar({
  workspaces,
  activeWorkspaceId,
  activeChatId,
  onCreateWorkspace,
  onSelectWorkspace,
  onClearActiveWorkspace,
  onCreateChat,
  onOpenChat,
  onDeleteChat,
  onRenameWorkspace,
  onArchiveWorkspace,
  onOpenWorkspaceInExplorer,
  onRefreshWorkspace,
  onOpenSettings,
}: Omit<CodeSidebarProps, 'mode'>) {
  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaces],
  );
  const activeWorkspace = useMemo(
    () => sortedWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, sortedWorkspaces],
  );
  const workspaceChats = useMemo(
    () => activeWorkspace ? [...activeWorkspace.chats].sort((left, right) => right.updatedAt - left.updatedAt) : [],
    [activeWorkspace],
  );
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceLabel, setEditingWorkspaceLabel] = useState('');
  const splitShellRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.44);
  const [splitDragging, setSplitDragging] = useState(false);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsedPaths(new Set());
  }, [activeWorkspaceId]);

  const beginWorkspaceEditing = useCallback((workspace: WorkspaceGroup) => {
    setEditingWorkspaceId(workspace.id);
    setEditingWorkspaceLabel(workspace.label);
  }, []);

  const cancelWorkspaceEditing = useCallback(() => {
    setEditingWorkspaceId(null);
    setEditingWorkspaceLabel('');
  }, []);

  const commitWorkspaceEditing = useCallback((workspace: WorkspaceGroup) => {
    const nextLabel = editingWorkspaceLabel.trim();
    if (!nextLabel) return;
    onRenameWorkspace(workspace, nextLabel);
    setEditingWorkspaceId(null);
    setEditingWorkspaceLabel('');
  }, [editingWorkspaceLabel, onRenameWorkspace]);

  const updateSplitRatio = useCallback((clientY: number) => {
    const shell = splitShellRef.current;
    if (!shell) return;

    const rect = shell.getBoundingClientRect();
    const nextRatio = (clientY - rect.top) / rect.height;
    setSplitRatio(Math.min(0.74, Math.max(0.24, nextRatio)));
  }, []);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  if (!activeWorkspace) {
    return (
      <aside className="workbench-sidebar workbench-sidebar-code" data-view="workspaces" aria-label="Code sidebar">
        <div className="workbench-sidebar-main">

          <section className="workbench-thread-section" aria-label="Workspaces">
            <div className="workbench-thread-section-head">
              <div className="workbench-thread-section-copy">
                <span className="workbench-thread-section-title">Workspaces</span>
                <span className="workbench-thread-section-caption">
                  {sortedWorkspaces.length} linked folder{sortedWorkspaces.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="workbench-thread-section-tools">
                <button
                  type="button"
                  className="workbench-thread-section-tool"
                  onClick={onCreateWorkspace}
                  title="Add a workspace folder"
                >
                  <IconFolderPlus size={15} />
                </button>
              </div>
            </div>

            <div className="workbench-thread-list workbench-code-workspace-list">
              {sortedWorkspaces.length === 0 ? (
                <div className="workbench-thread-empty">
                  Select a local folder to create the first code workspace.
                </div>
              ) : (
                sortedWorkspaces.map((workspace) => (
                  <WorkspaceRow
                    key={workspace.id}
                    workspace={workspace}
                    selected={false}
                    isEditing={editingWorkspaceId === workspace.id}
                    editingLabel={editingWorkspaceLabel}
                    onEditingLabelChange={setEditingWorkspaceLabel}
                    onStartEditing={beginWorkspaceEditing}
                    onCancelEditing={cancelWorkspaceEditing}
                    onCommitEditing={commitWorkspaceEditing}
                    onSelectWorkspace={onSelectWorkspace}
                    onArchiveWorkspace={onArchiveWorkspace}
                    onOpenWorkspaceInExplorer={onOpenWorkspaceInExplorer}
                  />
                ))
              )}
            </div>
          </section>
        </div>

        <div className="workbench-sidebar-footer">
          <button
            type="button"
            className="workbench-sidebar-utility"
            onClick={onOpenSettings}
          >
            <IconSettings size={15} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="workbench-sidebar workbench-sidebar-code active-workspace" data-view="workspace" aria-label="Code sidebar">
      <div className="workbench-sidebar-main">
        <div ref={splitShellRef} className="code-sidebar-split-shell">
          <section
            className="code-sidebar-pane"
            style={{ flexBasis: `${Math.round(splitRatio * 100)}%` }}
            aria-label="Workspace chats"
          >
            <div className="code-sidebar-workspace-shell">
              <div className="workbench-thread-section-head workbench-thread-section-head-chat code-sidebar-workspace-head">
                <div className="code-sidebar-workspace-title-row">
                  <button
                    type="button"
                    className="workbench-thread-section-tool code-sidebar-back-inline"
                    onClick={onClearActiveWorkspace}
                    title="Back to workspace catalog"
                    aria-label="Back to workspace catalog"
                  >
                    <IconChevronLeft size={14} />
                  </button>

                  {editingWorkspaceId === activeWorkspace.id ? (
                    <div className="code-sidebar-workspace-copy edit-mode">
                      <input
                        autoFocus
                        className="workbench-workspace-input"
                        value={editingWorkspaceLabel}
                        onChange={(event) => setEditingWorkspaceLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitWorkspaceEditing(activeWorkspace);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelWorkspaceEditing();
                          }
                        }}
                      />
                      <span className="workbench-thread-section-caption">
                        {workspaceChats.length} saved
                      </span>
                    </div>
                  ) : (
                    <div className="code-sidebar-workspace-copy">
                      <strong className="code-sidebar-workspace-name">{activeWorkspace.label}</strong>
                      <span className="workbench-thread-section-caption">
                        {workspaceChats.length} saved
                      </span>
                    </div>
                  )}
                </div>

                <div className="workbench-thread-section-tools">
                  {editingWorkspaceId === activeWorkspace.id ? (
                    <>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={() => commitWorkspaceEditing(activeWorkspace)}
                        title="Save workspace name"
                      >
                        <IconCheck size={14} />
                      </button>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={cancelWorkspaceEditing}
                        title="Cancel rename"
                      >
                        <IconX size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={onCreateChat}
                        title="New workspace chat"
                      >
                        <IconMessageSquare size={15} />
                      </button>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={() => beginWorkspaceEditing(activeWorkspace)}
                        title="Rename workspace"
                      >
                        <IconSquarePen size={14} />
                      </button>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={() => onRefreshWorkspace(activeWorkspace)}
                        title="Refresh folder contents"
                      >
                        <IconRefreshCw size={14} />
                      </button>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={() => onArchiveWorkspace(activeWorkspace)}
                        title="Archive workspace"
                      >
                        <IconArchive size={14} />
                      </button>
                      <button
                        type="button"
                        className="workbench-thread-section-tool"
                        onClick={() => onOpenWorkspaceInExplorer(activeWorkspace)}
                        title={activeWorkspace.rootPath ? 'Open in file explorer' : 'No linked folder yet'}
                        disabled={!activeWorkspace.rootPath}
                      >
                        <IconArrowUpRight size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="workbench-thread-list workbench-chat-thread-list">
              {workspaceChats.length === 0 ? (
                <div className="workbench-thread-empty">
                  No chats in this workspace yet.
                </div>
              ) : (
                workspaceChats.map((chat) => {
                  const isActive = activeChatId === chat.id;
                  const latestUserMessage = findRecentMessage(chat, 'user');
                  const title = compressPreviewText(
                    chat.title,
                    latestUserMessage?.content || 'Untitled conversation',
                  );
                  const updatedLabel = formatHistoryTimestamp(chat.updatedAt);
                  const updatedDetail = formatHistoryTimestampDetail(chat.updatedAt);
                  const accessibilityLabel = `${title}, ${updatedDetail}${isActive ? ', active chat' : ''}`;

                  return (
                    <article
                      key={chat.id}
                      className={`workbench-chat-thread-entry${isActive ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        className={`workbench-thread-item workbench-thread-item-chat${isActive ? ' active' : ''}`}
                        onClick={() => onOpenChat(chat)}
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={accessibilityLabel}
                        title={`${title} - ${updatedDetail}`}
                      >
                        <span className="workbench-thread-item-copy">
                          <span className="workbench-thread-item-chat-main">
                            <span className="workbench-thread-item-label">{title}</span>
                            <time
                              className="workbench-thread-item-timestamp"
                              dateTime={new Date(chat.updatedAt).toISOString()}
                              title={updatedDetail}
                            >
                              {updatedLabel}
                            </time>
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className="workbench-thread-item-delete"
                        onClick={() => onDeleteChat(chat.id)}
                        aria-label={`Delete ${title}`}
                        title="Delete chat"
                      >
                        <IconTrash2 size={12} />
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <div
            className={`code-sidebar-splitter${splitDragging ? ' active' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize chats and files panels"
            onPointerDown={(event) => {
              setSplitDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              updateSplitRatio(event.clientY);
            }}
            onPointerMove={(event) => {
              if (!splitDragging) return;
              updateSplitRatio(event.clientY);
            }}
            onPointerUp={(event) => {
              setSplitDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              setSplitDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            <span className="code-sidebar-splitter-grip" aria-hidden="true">
              <IconGripHorizontal size={12} />
            </span>
          </div>

          <section className="code-sidebar-pane code-sidebar-pane-files" aria-label="Workspace files">
            <div className="workbench-thread-section-head">
              <div className="workbench-thread-section-copy">
                <span className="workbench-thread-section-title">Files</span>
                <span className="workbench-thread-section-caption">
                  {activeWorkspace.fileCount} file{activeWorkspace.fileCount === 1 ? '' : 's'}
                  {activeWorkspace.syncedAt ? ` · synced ${formatHistoryTimestamp(activeWorkspace.syncedAt)}` : ''}
                </span>
              </div>

              <div className="workbench-thread-section-tools">
                <button
                  type="button"
                  className="workbench-thread-section-tool"
                  onClick={() => onRefreshWorkspace(activeWorkspace)}
                  title="Refresh files"
                >
                  <IconRefreshCw size={15} />
                </button>
              </div>
            </div>

            <div className="workbench-thread-list code-file-tree-shell">
              {activeWorkspace.fileTree?.length ? (
                <WorkspaceFileTree
                  nodes={activeWorkspace.fileTree}
                  collapsedPaths={collapsedPaths}
                  onToggleDirectory={toggleDirectory}
                />
              ) : workspaceHasLinkedSource(activeWorkspace) ? (
                <div className="workbench-thread-empty">
                  No source files were indexed in this folder yet.
                </div>
              ) : (
                <div className="workbench-thread-empty">
                  This workspace is not linked to a local folder yet.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="workbench-sidebar-footer">
        <button
          type="button"
          className="workbench-sidebar-utility"
          onClick={onOpenSettings}
        >
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function ChatSidebar({
  chats,
  activeChatId,
  openPanelIds,
  onCreateChat,
  onOpenChat,
  onDeleteChat,
  onOpenSettings,
}: Omit<ChatSidebarProps, 'mode'>) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const openIds = useMemo(() => new Set(openPanelIds), [openPanelIds]);
  const sortedChats = useMemo(
    () => [...chats].sort((left, right) => right.updatedAt - left.updatedAt),
    [chats],
  );
  const filteredChats = useMemo(() => {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return sortedChats;

    return sortedChats.filter((chat) => {
      const title = (chat.title || '').toLowerCase();
      const messageText = (chat.messages ?? [])
        .slice(-3)
        .map((message) => message.content.toLowerCase())
        .join(' ');
      return title.includes(cleanQuery) || messageText.includes(cleanQuery);
    });
  }, [query, sortedChats]);

  return (
    <aside className="workbench-sidebar workbench-sidebar-chat" aria-label="Chat sidebar">
      <div className="workbench-sidebar-main">
        <section className="workbench-thread-section" aria-label="Chats">
          <div className="workbench-thread-section-head workbench-thread-section-head-chat">
            <div className="workbench-thread-section-copy">
              <span className="workbench-thread-section-title">Chats</span>
              <span className="workbench-thread-section-caption">
                {sortedChats.length} stored / {openPanelIds.length} open
              </span>
            </div>
            <div className="workbench-thread-section-tools">
              <button
                type="button"
                className="workbench-thread-section-tool"
                onClick={onCreateChat}
                title="New conversation"
              >
                <IconSquarePen size={15} />
              </button>
              <button
                type="button"
                className="workbench-thread-section-tool"
                onClick={() => searchRef.current?.focus()}
                title="Search chats"
              >
                <IconSearch size={15} />
              </button>
            </div>
          </div>

          <label className="workbench-thread-search-shell">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              type="text"
              className="workbench-thread-search"
              placeholder="Search conversations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="workbench-thread-list workbench-chat-thread-list">
            {filteredChats.length === 0 ? (
              <div className="workbench-thread-empty">
                {query.trim() ? 'No saved chats match this search.' : 'No chats yet'}
              </div>
            ) : (
              filteredChats.map((chat) => {
                const isActive = activeChatId === chat.id;
                const isOpen = openIds.has(chat.id);
                const latestUserMessage = findRecentMessage(chat, 'user');
                const title = compressPreviewText(
                  chat.title,
                  latestUserMessage?.content || 'Untitled conversation',
                );
                const updatedLabel = formatHistoryTimestamp(chat.updatedAt);
                const updatedDetail = formatHistoryTimestampDetail(chat.updatedAt);
                const accessibilityLabel = `${title}, ${updatedDetail}${isActive ? ', active chat' : isOpen ? ', open chat' : ''}`;

                return (
                  <article
                    key={chat.id}
                    className={`workbench-chat-thread-entry${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}
                  >
                    <button
                      type="button"
                      className={`workbench-thread-item workbench-thread-item-chat${isActive ? ' active' : ''}`}
                      onClick={() => onOpenChat(chat)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={accessibilityLabel}
                      title={`${title} - ${updatedDetail}`}
                    >
                      <span className="workbench-thread-item-copy">
                        <span className="workbench-thread-item-chat-main">
                          <span className="workbench-thread-item-label">{title}</span>
                          <time
                            className="workbench-thread-item-timestamp"
                            dateTime={new Date(chat.updatedAt).toISOString()}
                            title={updatedDetail}
                          >
                            {updatedLabel}
                          </time>
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      className="workbench-thread-item-delete"
                      onClick={() => onDeleteChat(chat.id)}
                      aria-label={`Delete ${title}`}
                      title="Delete chat"
                    >
                      <IconTrash2 size={12} />
                    </button>
                  </article>
                );
              })
            )}
          </div>
        </section>
      </div>

      <div className="workbench-sidebar-footer">
        <button
          type="button"
          className="workbench-sidebar-utility"
          onClick={onOpenSettings}
        >
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

export function Sidebar(props: Props) {
  if (props.mode === 'chat') {
    return <ChatSidebar {...props} />;
  }

  return <CodeSidebar {...props} />;
}
