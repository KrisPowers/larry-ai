import { useMemo } from 'react';
import type { WorkspaceGroup } from '../lib/workspaces';
import {
  IconDotsGrid,
  IconFolder,
  IconFolderPlus,
  IconSettings,
  IconSlidersHorizontal,
  IconSquarePen,
} from './Icon';

interface Props {
  workspaces: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  onCreateWorkspace: () => void;
  onCreateChat: () => void;
  onOpenWorkspace: (workspace: WorkspaceGroup) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  onCreateWorkspace,
  onCreateChat,
  onOpenWorkspace,
  onOpenSettings,
}: Props) {
  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaces],
  );

  return (
    <aside className="workbench-sidebar" aria-label="Code sidebar">
      <div className="workbench-sidebar-main">
        <nav className="workbench-sidebar-utilities" aria-label="Sidebar actions">
          <button
            type="button"
            className="workbench-sidebar-utility"
            onClick={onCreateWorkspace}
          >
            <IconFolderPlus size={15} />
            <span>New workspace</span>
          </button>

          <button
            type="button"
            className="workbench-sidebar-utility"
            title="Skills coming soon"
          >
            <IconDotsGrid size={15} />
            <span>Skills</span>
          </button>
        </nav>

        <section className="workbench-thread-section" aria-label="Workspaces">
          <div className="workbench-thread-section-head">
            <span className="workbench-thread-section-title">Workspaces</span>
            <div className="workbench-thread-section-tools">
              <button
                type="button"
                className="workbench-thread-section-tool"
                onClick={onCreateChat}
                title="New code chat"
              >
                <IconSquarePen size={15} />
              </button>
              <button
                type="button"
                className="workbench-thread-section-tool"
                title="Filters coming soon"
              >
                <IconSlidersHorizontal size={15} />
              </button>
            </div>
          </div>

          <div className="workbench-thread-list">
            {sortedWorkspaces.length === 0 ? (
              <div className="workbench-thread-empty">
                No workspaces yet
              </div>
            ) : (
              sortedWorkspaces.map((workspace) => {
                const isActive = activeWorkspaceId === workspace.id;
                const fileLabel = workspace.fileCount === 1 ? '1 file' : `${workspace.fileCount} files`;
                const chatLabel = workspace.chats.length === 1 ? '1 chat' : `${workspace.chats.length} chats`;

                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className={`workbench-thread-item${isActive ? ' active' : ''}`}
                    onClick={() => onOpenWorkspace(workspace)}
                    title={workspace.label || 'Untitled workspace'}
                  >
                    <span className="workbench-thread-item-icon">
                      <IconFolder size={15} />
                    </span>
                    <span className="workbench-thread-item-label">{workspace.label || 'Untitled workspace'}</span>
                    {isActive ? (
                      <span className="workbench-thread-item-meta">
                        <span className="workbench-thread-item-project">{fileLabel} · {chatLabel}</span>
                      </span>
                    ) : null}
                  </button>
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
