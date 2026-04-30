import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { findWorkspaceGroup, workspaceHasLinkedSource, type WorkspaceGroup } from '../lib/workspaces';
import type { ChatRecord, WorkspaceFileNode } from '../types';
import {
  IconArchive,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGripHorizontal,
  IconListChecks,
  IconMessageSquare,
  IconRefreshCw,
  IconSearch,
  IconSettings,
  IconSlidersHorizontal,
  IconSquarePen,
  IconTerminal,
  IconTrash2,
  IconX,
} from './Icon';

type CodeSidebarProps = {
  mode: 'code';
  workspaces: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  activeChatId: string | null;
  activeFilePath: string | null;
  onCreateWorkspace: () => void;
  onSelectWorkspace: (workspace: WorkspaceGroup) => void;
  onClearActiveWorkspace: () => void;
  onCreateChat: () => void;
  onOpenChat: (chat: ChatRecord) => void;
  onOpenFile: (workspace: WorkspaceGroup, relativePath: string) => void;
  onCreateFileInFolder: (workspace: WorkspaceGroup, parentRelativePath: string | null) => void;
  onCreateFolderInFolder: (workspace: WorkspaceGroup, parentRelativePath: string | null) => void;
  onRenameFile: (workspace: WorkspaceGroup, relativePath: string, nextName: string) => void;
  onRenameFolder: (workspace: WorkspaceGroup, relativePath: string, nextName: string) => void;
  onDuplicateFile: (workspace: WorkspaceGroup, relativePath: string) => void;
  onDeleteFile: (workspace: WorkspaceGroup, relativePath: string) => void;
  onDeleteFolder: (workspace: WorkspaceGroup, relativePath: string) => void;
  onCopyFilePath: (workspace: WorkspaceGroup, relativePath: string) => void;
  onCopyFolderPath: (workspace: WorkspaceGroup, relativePath: string) => void;
  onOpenFileOutsideApp: (workspace: WorkspaceGroup, relativePath: string) => void;
  onOpenFolderOutsideApp: (workspace: WorkspaceGroup, relativePath: string) => void;
  onArchiveChat: (id: string) => void;
  onRenameWorkspace: (workspace: WorkspaceGroup, nextLabel: string) => void;
  onArchiveWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenWorkspaceInExplorer: (workspace: WorkspaceGroup) => void;
  onRefreshWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenSettings: () => void;
};

type ChatSidebarProps = {
  mode: 'chat';
  chats: ChatRecord[];
  workspaces: WorkspaceGroup[];
  activeChatId: string | null;
  openPanelIds: string[];
  onCreateWorkspace: () => void;
  onCreateChat: () => void;
  onSelectWorkspace: (workspace: WorkspaceGroup) => void;
  onArchiveWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenChat: (chat: ChatRecord) => void;
  onArchiveChat: (id: string) => void;
  onOpenSettings: () => void;
};

type SettingsSidebarTab = {
  id: string;
  label: string;
  title: string;
  description: string;
  summary: string;
};

type SettingsSidebarProps = {
  mode: 'settings';
  tabs: SettingsSidebarTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onBackToChat: () => void;
};

type Props = CodeSidebarProps | ChatSidebarProps | SettingsSidebarProps;

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

function getWorkspaceEntryName(path: string): string {
  const normalizedPath = path.replace(/\\/g, '/');
  return normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
}

function findWorkspaceNodeByPath(
  nodes: WorkspaceFileNode[] | undefined,
  targetPath: string,
): WorkspaceFileNode | null {
  if (!nodes?.length) return null;

  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === targetPath) return node;
    if (node.kind === 'directory' && node.children?.length) {
      stack.push(...node.children);
    }
  }

  return null;
}

function getWorkspaceLastChatUpdatedAt(workspace: WorkspaceGroup): number | null {
  if (!workspace.chats.length) return null;
  return workspace.chats.reduce(
    (latest, chat) => Math.max(latest, chat.updatedAt),
    workspace.chats[0]?.updatedAt ?? 0,
  );
}

function findRecentMessage(chat: ChatRecord, role?: 'user' | 'assistant') {
  return [...(chat.messages ?? [])]
    .reverse()
    .find((message) => message.content.trim() && (!role || message.role === role));
}

function getSettingsTabIcon(tabId: string) {
  switch (tabId) {
    case 'workspace':
      return IconSlidersHorizontal;
    case 'editor':
      return IconFileText;
    case 'providers':
      return IconSearch;
    case 'data':
      return IconDownload;
    case 'shortcuts':
      return IconListChecks;
    case 'advanced':
      return IconTerminal;
    default:
      return IconSettings;
  }
}

const SETTINGS_SIDEBAR_SECTION_ORDER: Array<{
  id: string;
  label: string;
  tabIds: string[];
}> = [
  {
    id: 'workspace-models',
    label: 'Workspace & Models',
    tabIds: ['workspace', 'editor', 'providers'],
  },
  {
    id: 'data-behavior',
    label: 'Data & Behavior',
    tabIds: ['data'],
  },
  {
    id: 'documents-knowledge',
    label: 'Documents & Knowledge',
    tabIds: ['shortcuts'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    tabIds: ['advanced'],
  },
];

function buildSettingsSidebarSections(tabs: SettingsSidebarTab[]) {
  const tabMap = new Map(tabs.map((tab) => [tab.id, tab]));
  const claimed = new Set<string>();
  const sections = SETTINGS_SIDEBAR_SECTION_ORDER.map((section) => {
    const sectionTabs = section.tabIds
      .map((tabId) => {
        const tab = tabMap.get(tabId);
        if (tab) claimed.add(tabId);
        return tab;
      })
      .filter((tab): tab is SettingsSidebarTab => Boolean(tab));

    return {
      id: section.id,
      label: section.label,
      tabs: sectionTabs,
    };
  }).filter((section) => section.tabs.length > 0);

  const uncategorizedTabs = tabs.filter((tab) => !claimed.has(tab.id));
  if (uncategorizedTabs.length > 0) {
    sections.push({
      id: 'more',
      label: 'More',
      tabs: uncategorizedTabs,
    });
  }

  return sections;
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
  activeFilePath,
  editingFilePath,
  editingFileName,
  collapsedPaths,
  onEditingFileNameChange,
  onCancelRenamingFile,
  onCommitRenamingFile,
  onToggleDirectory,
  onOpenFile,
  onOpenFileContextMenu,
}: {
  nodes: WorkspaceFileNode[];
  activeFilePath: string | null;
  editingFilePath: string | null;
  editingFileName: string;
  collapsedPaths: Set<string>;
  onEditingFileNameChange: (value: string) => void;
  onCancelRenamingFile: () => void;
  onCommitRenamingFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    path: string,
    kind: WorkspaceFileNode['kind'],
  ) => void;
}) {
  return (
    <div className="code-file-tree-list" role="tree" aria-label="Workspace files">
      {nodes.map((node) => (
        <WorkspaceFileTreeNode
          key={node.path}
          node={node}
          depth={0}
          activeFilePath={activeFilePath}
          editingFilePath={editingFilePath}
          editingFileName={editingFileName}
          collapsedPaths={collapsedPaths}
          onEditingFileNameChange={onEditingFileNameChange}
          onCancelRenamingFile={onCancelRenamingFile}
          onCommitRenamingFile={onCommitRenamingFile}
          onToggleDirectory={onToggleDirectory}
          onOpenFile={onOpenFile}
          onOpenFileContextMenu={onOpenFileContextMenu}
        />
      ))}
    </div>
  );
}

function WorkspaceFileTreeNode({
  node,
  depth,
  activeFilePath,
  editingFilePath,
  editingFileName,
  collapsedPaths,
  onEditingFileNameChange,
  onCancelRenamingFile,
  onCommitRenamingFile,
  onToggleDirectory,
  onOpenFile,
  onOpenFileContextMenu,
}: {
  node: WorkspaceFileNode;
  depth: number;
  activeFilePath: string | null;
  editingFilePath: string | null;
  editingFileName: string;
  collapsedPaths: Set<string>;
  onEditingFileNameChange: (value: string) => void;
  onCancelRenamingFile: () => void;
  onCommitRenamingFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    path: string,
    kind: WorkspaceFileNode['kind'],
  ) => void;
}) {
  const isDirectory = node.kind === 'directory';
  const isCollapsed = isDirectory && collapsedPaths.has(node.path);
  const isActiveFile = !isDirectory && activeFilePath === node.path;
  const isEditingEntry = editingFilePath === node.path;
  const paddingLeft = 12 + (depth * 16);

  return (
    <div className="code-file-tree-node">
      {isEditingEntry ? (
        <div className="code-file-tree-edit" style={{ paddingLeft }}>
          <span className="code-file-tree-toggle placeholder" aria-hidden="true" />
          <span className="code-file-tree-icon" aria-hidden="true">
            {isDirectory ? <IconFolder size={14} /> : <IconFileText size={14} />}
          </span>

          <input
            autoFocus
            className="code-file-tree-input"
            value={editingFileName}
            onChange={(event) => onEditingFileNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommitRenamingFile(node.path);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancelRenamingFile();
              }
            }}
          />

          <div className="code-file-tree-edit-actions">
            <button
              type="button"
              className="workbench-thread-section-tool"
              onClick={() => onCommitRenamingFile(node.path)}
              title="Save file name"
            >
              <IconCheck size={13} />
            </button>
            <button
              type="button"
              className="workbench-thread-section-tool"
              onClick={onCancelRenamingFile}
              title="Cancel rename"
            >
              <IconX size={13} />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`code-file-tree-item${isDirectory ? ' directory' : ''}${isActiveFile ? ' active' : ''}`}
          style={{ paddingLeft }}
          onClick={() => {
            if (isDirectory) {
              onToggleDirectory(node.path);
              return;
            }

            onOpenFile(node.path);
          }}
          onContextMenu={(event) => onOpenFileContextMenu(event, node.path, node.kind)}
          aria-expanded={isDirectory ? !isCollapsed : undefined}
          aria-current={isActiveFile ? 'page' : undefined}
          role="treeitem"
          title={node.path}
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
      )}

      {isDirectory && !isCollapsed && node.children?.length ? (
        <div role="group">
          {node.children.map((child) => (
            <WorkspaceFileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              editingFilePath={editingFilePath}
              editingFileName={editingFileName}
              collapsedPaths={collapsedPaths}
              onEditingFileNameChange={onEditingFileNameChange}
              onCancelRenamingFile={onCancelRenamingFile}
              onCommitRenamingFile={onCommitRenamingFile}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onOpenFileContextMenu={onOpenFileContextMenu}
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
  activeFilePath,
  onCreateWorkspace,
  onSelectWorkspace,
  onClearActiveWorkspace,
  onCreateChat,
  onOpenChat,
  onOpenFile,
  onCreateFileInFolder,
  onCreateFolderInFolder,
  onRenameFile,
  onRenameFolder,
  onDuplicateFile,
  onDeleteFile,
  onDeleteFolder,
  onCopyFilePath,
  onCopyFolderPath,
  onOpenFileOutsideApp,
  onOpenFolderOutsideApp,
  onArchiveChat,
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
    () => findWorkspaceGroup(sortedWorkspaces, activeWorkspaceId),
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
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState('');
  const [fileContextMenu, setFileContextMenu] = useState<{
    path: string;
    kind: WorkspaceFileNode['kind'];
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    setCollapsedPaths(new Set());
    setEditingFilePath(null);
    setEditingFileName('');
    setFileContextMenu(null);
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

  const closeFileContextMenu = useCallback(() => {
    setFileContextMenu(null);
  }, []);

  const beginFileEditing = useCallback((path: string) => {
    setEditingFilePath(path);
    setEditingFileName(getWorkspaceEntryName(path));
    closeFileContextMenu();
  }, [closeFileContextMenu]);

  const cancelFileEditing = useCallback(() => {
    setEditingFilePath(null);
    setEditingFileName('');
  }, []);

  const commitFileEditing = useCallback((path: string) => {
    if (!activeWorkspace) return;
    const nextName = editingFileName.trim();
    if (!nextName) return;
    const node = findWorkspaceNodeByPath(activeWorkspace.fileTree, path);
    if (node?.kind === 'directory') {
      onRenameFolder(activeWorkspace, path, nextName);
    } else {
      onRenameFile(activeWorkspace, path, nextName);
    }
    setEditingFilePath(null);
    setEditingFileName('');
  }, [activeWorkspace, editingFileName, onRenameFile, onRenameFolder]);

  const openFileContextMenu = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    path: string,
    kind: WorkspaceFileNode['kind'],
  ) => {
    event.preventDefault();
    setEditingFilePath(null);
    setEditingFileName('');
    setFileContextMenu({
      path,
      kind,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const fileContextMenuPosition = useMemo(() => {
    if (!fileContextMenu || typeof window === 'undefined') return null;
    const menuWidth = 224;
    const menuHeight = fileContextMenu.kind === 'directory' ? 276 : 228;
    return {
      left: Math.max(12, Math.min(fileContextMenu.x, window.innerWidth - menuWidth - 12)),
      top: Math.max(12, Math.min(fileContextMenu.y, window.innerHeight - menuHeight - 12)),
    };
  }, [fileContextMenu]);

  useEffect(() => {
    if (!fileContextMenu && !editingFilePath) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeFileContextMenu();
      cancelFileEditing();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cancelFileEditing, closeFileContextMenu, editingFilePath, fileContextMenu]);

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
                        className="workbench-thread-item-action"
                        onClick={() => onArchiveChat(chat.id)}
                        aria-label={`Archive ${title}`}
                        title="Archive chat"
                      >
                        <IconArchive size={12} />
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
                </span>
              </div>

              <div className="workbench-thread-section-tools">
                <button
                  type="button"
                  className="workbench-thread-section-tool"
                  onClick={() => onCreateFileInFolder(activeWorkspace, null)}
                  title="New file"
                >
                  <IconFileText size={15} />
                </button>
                <button
                  type="button"
                  className="workbench-thread-section-tool"
                  onClick={() => onCreateFolderInFolder(activeWorkspace, null)}
                  title="New folder"
                >
                  <IconFolderPlus size={15} />
                </button>
              </div>
            </div>

            <div className="workbench-thread-list code-file-tree-shell">
              {activeWorkspace.fileTree?.length ? (
                <WorkspaceFileTree
                  nodes={activeWorkspace.fileTree}
                  activeFilePath={activeFilePath}
                  editingFilePath={editingFilePath}
                  editingFileName={editingFileName}
                  collapsedPaths={collapsedPaths}
                  onEditingFileNameChange={setEditingFileName}
                  onCancelRenamingFile={cancelFileEditing}
                  onCommitRenamingFile={commitFileEditing}
                  onToggleDirectory={toggleDirectory}
                  onOpenFile={(relativePath) => onOpenFile(activeWorkspace, relativePath)}
                  onOpenFileContextMenu={openFileContextMenu}
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

      {fileContextMenu && fileContextMenuPosition && (
        <div className="code-file-context-backdrop" onClick={closeFileContextMenu}>
          <div
            className="code-file-context-menu"
            style={fileContextMenuPosition}
            role="menu"
            aria-label={`Actions for ${getWorkspaceEntryName(fileContextMenu.path)}`}
            onClick={(event) => event.stopPropagation()}
          >
            {fileContextMenu.kind === 'directory' ? (
              <>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onCreateFileInFolder(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconFileText size={14} />
                  <span>New File</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onCreateFolderInFolder(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconFolderPlus size={14} />
                  <span>New Folder</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onOpenFolderOutsideApp(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconArrowUpRight size={14} />
                  <span>Open Outside Larry</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => beginFileEditing(fileContextMenu.path)}
                >
                  <IconSquarePen size={14} />
                  <span>Rename</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onCopyFolderPath(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconCopy size={14} />
                  <span>Copy Path</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item danger"
                  onClick={() => {
                    closeFileContextMenu();
                    onDeleteFolder(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconTrash2 size={14} />
                  <span>Delete</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onOpenFileOutsideApp(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconArrowUpRight size={14} />
                  <span>Open Outside Larry</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onDuplicateFile(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconCopy size={14} />
                  <span>Duplicate</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => beginFileEditing(fileContextMenu.path)}
                >
                  <IconSquarePen size={14} />
                  <span>Rename</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item"
                  onClick={() => {
                    closeFileContextMenu();
                    onCopyFilePath(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconCopy size={14} />
                  <span>Copy Path</span>
                </button>
                <button
                  type="button"
                  className="code-file-context-menu-item danger"
                  onClick={() => {
                    closeFileContextMenu();
                    onDeleteFile(activeWorkspace, fileContextMenu.path);
                  }}
                >
                  <IconTrash2 size={14} />
                  <span>Delete</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function ChatSidebar({
  chats,
  workspaces,
  activeChatId,
  openPanelIds,
  onCreateWorkspace,
  onCreateChat,
  onSelectWorkspace,
  onArchiveWorkspace,
  onOpenChat,
  onArchiveChat,
  onOpenSettings,
}: Omit<ChatSidebarProps, 'mode'>) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const openIds = useMemo(() => new Set(openPanelIds), [openPanelIds]);
  const sortedWorkspaces = useMemo(
    () => [...workspaces]
      .filter((workspace) => workspace.id !== 'project:general')
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaces],
  );
  const sortedChats = useMemo(
    () => [...chats].sort((left, right) => right.updatedAt - left.updatedAt),
    [chats],
  );
  const cleanQuery = query.trim().toLowerCase();
  const libraryItems = useMemo(() => {
    const workspaceItems = sortedWorkspaces
      .filter((workspace) => {
        if (!cleanQuery) return true;
        const label = (workspace.label || '').toLowerCase();
        const path = (workspace.rootPath || '').toLowerCase();
        return label.includes(cleanQuery) || path.includes(cleanQuery);
      })
      .map((workspace) => ({
        kind: 'workspace' as const,
        id: workspace.id,
        updatedAt: getWorkspaceLastChatUpdatedAt(workspace) ?? workspace.updatedAt,
        workspace,
      }));

    const chatItems = sortedChats
      .filter((chat) => {
        if (!cleanQuery) return true;
        const title = (chat.title || '').toLowerCase();
        const messageText = (chat.messages ?? [])
          .slice(-3)
          .map((message) => message.content.toLowerCase())
          .join(' ');
        return title.includes(cleanQuery) || messageText.includes(cleanQuery);
      })
      .map((chat) => ({
        kind: 'chat' as const,
        id: chat.id,
        updatedAt: chat.updatedAt,
        chat,
      }));

    return [...workspaceItems, ...chatItems].sort((left, right) => right.updatedAt - left.updatedAt);
  }, [cleanQuery, sortedChats, sortedWorkspaces]);
  const libraryItemCount = sortedWorkspaces.length + sortedChats.length;

  return (
    <aside className="workbench-sidebar workbench-sidebar-chat workbench-sidebar-library" aria-label="Chat sidebar">
      <div className="workbench-sidebar-main">
        <section className="workbench-thread-section" aria-label="Chats and workspaces">
          <div className="workbench-thread-section-head workbench-thread-section-head-chat">
            <div className="workbench-thread-section-copy">
              <span className="workbench-thread-section-title">Library</span>
              <span className="workbench-thread-section-caption">
                {libraryItemCount} item{libraryItemCount === 1 ? '' : 's'}
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
                title="Search chats and workspaces"
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
              placeholder="Search chats and workspaces"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="workbench-sidebar-library-scroll">
            <div className="workbench-thread-list workbench-chat-thread-list workbench-sidebar-library-list">
              {libraryItems.length === 0 ? (
                <div className="workbench-thread-empty">
                  {cleanQuery ? 'No chats or workspaces match this search.' : 'No chats or workspaces yet.'}
                </div>
              ) : (
                libraryItems.map((item) => {
                  if (item.kind === 'workspace') {
                    const { workspace } = item;
                    const label = workspace.label || 'Untitled workspace';
                    const lastChatUpdatedAt = getWorkspaceLastChatUpdatedAt(workspace);
                    const updatedLabel = lastChatUpdatedAt ? formatHistoryTimestamp(lastChatUpdatedAt) : 'new';
                    const updatedDetail = lastChatUpdatedAt
                      ? formatHistoryTimestampDetail(lastChatUpdatedAt)
                      : 'No chats in this workspace yet.';

                    return (
                      <article
                        key={workspace.id}
                        className="workbench-chat-thread-entry workbench-library-entry workbench-library-entry-workspace"
                      >
                        <button
                          type="button"
                          className="workbench-thread-item workbench-thread-item-chat workbench-thread-item-library workbench-thread-item-library-workspace"
                          onClick={() => onSelectWorkspace(workspace)}
                          aria-label={`Open workspace ${label}, ${updatedDetail}`}
                          title={`${label} - ${updatedDetail}`}
                        >
                          <span className="workbench-thread-item-icon workbench-thread-item-kind workspace" aria-hidden="true">
                            <IconFolder size={14} />
                          </span>

                          <span className="workbench-thread-item-copy">
                            <span className="workbench-thread-item-chat-main workbench-thread-item-library-main">
                              <span className="workbench-thread-item-label">{label}</span>
                              <time
                                className="workbench-thread-item-timestamp"
                                dateTime={lastChatUpdatedAt ? new Date(lastChatUpdatedAt).toISOString() : undefined}
                                title={updatedDetail}
                              >
                                {updatedLabel}
                              </time>
                            </span>
                          </span>
                        </button>

                        <button
                          type="button"
                          className="workbench-thread-item-action"
                          onClick={() => onArchiveWorkspace(workspace)}
                          aria-label={`Archive ${label}`}
                          title="Archive workspace"
                        >
                          <IconArchive size={12} />
                        </button>
                      </article>
                    );
                  }

                  const { chat } = item;
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
                      className={`workbench-chat-thread-entry workbench-library-entry workbench-library-entry-chat${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}
                    >
                      <button
                        type="button"
                        className={`workbench-thread-item workbench-thread-item-chat workbench-thread-item-library${isActive ? ' active' : ''}`}
                        onClick={() => onOpenChat(chat)}
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={accessibilityLabel}
                        title={`${title} - ${updatedDetail}`}
                      >
                        <span className="workbench-thread-item-icon workbench-thread-item-kind chat" aria-hidden="true">
                          <IconMessageSquare size={14} />
                        </span>

                        <span className="workbench-thread-item-copy">
                          <span className="workbench-thread-item-chat-main workbench-thread-item-library-main">
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
                        className="workbench-thread-item-action"
                        onClick={() => onArchiveChat(chat.id)}
                        aria-label={`Archive ${title}`}
                        title="Archive chat"
                      >
                        <IconArchive size={12} />
                      </button>
                    </article>
                  );
                })
              )}
            </div>
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

function SettingsSidebar({
  tabs,
  activeTabId,
  onSelectTab,
  onBackToChat,
}: Omit<SettingsSidebarProps, 'mode'>) {
  const sections = useMemo(() => buildSettingsSidebarSections(tabs), [tabs]);

  return (
    <aside
      className="workbench-sidebar workbench-sidebar-chat workbench-sidebar-library workbench-sidebar-settings"
      aria-label="Settings sidebar"
    >
      <div className="workbench-sidebar-main">
        <section className="settings-sidebar-shell" aria-label="Settings sections">
          <div className="settings-sidebar-head">
            <span className="settings-sidebar-kicker">Settings</span>
            <span className="settings-sidebar-title">Control center</span>
          </div>

          <div className="settings-sidebar-sections">
            {sections.map((section) => (
              <div key={section.id} className="settings-sidebar-section">
                <span className="settings-sidebar-section-label">{section.label}</span>

                <div className="settings-sidebar-section-list">
                  {section.tabs.map((tab) => {
                  const isActive = activeTabId === tab.id;
                  const Icon = getSettingsTabIcon(tab.id);

                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={`settings-sidebar-item${isActive ? ' active' : ''}`}
                      onClick={() => onSelectTab(tab.id)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={`${tab.label}. ${tab.description}`}
                      title={`${tab.title} - ${tab.description}`}
                    >
                      <span className="settings-sidebar-item-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span className="settings-sidebar-item-label">{tab.label}</span>
                    </button>
                  );
                })}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="workbench-sidebar-footer">
        <button
          type="button"
          className="workbench-sidebar-utility"
          onClick={onBackToChat}
        >
          <IconChevronLeft size={15} />
          <span>Back to chat</span>
        </button>
      </div>
    </aside>
  );
}

export function Sidebar(props: Props) {
  if (props.mode === 'chat') {
    return <ChatSidebar {...props} />;
  }

  if (props.mode === 'settings') {
    return <SettingsSidebar {...props} />;
  }

  return <CodeSidebar {...props} />;
}
