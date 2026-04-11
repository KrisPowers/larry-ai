import { workspaceHasLinkedSource, type WorkspaceGroup } from '../lib/workspaces';
import type { ChatRecord } from '../types';
import {
  IconArrowUpRight,
  IconFileText,
  IconFolderOpen,
  IconMessageSquare,
  IconRefreshCw,
  IconSquarePen,
} from './Icon';

type Props = {
  workspace: WorkspaceGroup | null;
  onCreateChat: () => void;
  onOpenChat: (chat: ChatRecord) => void;
  onRefreshWorkspace: () => void;
  onOpenInExplorer: () => void;
};

function formatStageTimestamp(value?: number) {
  if (!value) return 'Not synced yet';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CodeWorkspaceStage({
  workspace,
  onCreateChat,
  onOpenChat,
  onRefreshWorkspace,
  onOpenInExplorer,
}: Props) {
  if (!workspace) {
    return (
      <section className="code-stage-shell code-stage-shell-empty">
        <div className="code-stage-poster">
          <div className="code-stage-copy">
            <span className="launch-kicker">Code workspaces</span>
            <h1>Point `/code` at a real folder, then let chats stay tied to that project.</h1>
            <p>
              Add a workspace folder from the sidebar. Once one is selected, the sidebar turns into a split view for
              project chats and indexed files, and the Go backend keeps that folder ready for file actions.
            </p>
          </div>

          <div className="code-stage-visual" aria-hidden="true">
            <div className="code-stage-visual-orbit" />
            <div className="code-stage-visual-sheet">
              <span><IconFolderOpen size={16} /> Local root</span>
              <span><IconMessageSquare size={16} /> Workspace chats</span>
              <span><IconFileText size={16} /> Indexed files</span>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const recentChats = [...workspace.chats].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5);
  const linkedSourceCopy = workspace.rootPath
    || (workspaceHasLinkedSource(workspace)
      ? 'Linked through browser directory access.'
      : 'This workspace is ready, but it is not linked to a local folder path yet.');

  return (
    <section className="code-stage-shell">
      <div className="code-stage-hero">
        <div className="code-stage-copy">
          <span className="launch-kicker">Active workspace</span>
          <h1>{workspace.label}</h1>
          <p>{linkedSourceCopy}</p>
        </div>

        <div className="code-stage-actions">
          <button className="btn" type="button" onClick={onCreateChat}>
            <IconSquarePen size={14} />
            <span>New code chat</span>
          </button>
          <button className="btn settings-secondary-btn" type="button" onClick={onRefreshWorkspace}>
            <IconRefreshCw size={14} />
            <span>Refresh files</span>
          </button>
          <button className="btn settings-secondary-btn" type="button" onClick={onOpenInExplorer} disabled={!workspace.rootPath}>
            <IconArrowUpRight size={14} />
            <span>Open in explorer</span>
          </button>
        </div>
      </div>

      <div className="code-stage-grid">
        <section className="code-stage-panel">
          <div className="code-stage-panel-head">
            <strong>Workspace activity</strong>
            <span>{recentChats.length} recent chat{recentChats.length === 1 ? '' : 's'}</span>
          </div>

          {recentChats.length ? (
            <div className="code-stage-chat-list">
              {recentChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="code-stage-chat-item"
                  onClick={() => onOpenChat(chat)}
                >
                  <span>{chat.title || 'Untitled conversation'}</span>
                  <time>{formatStageTimestamp(chat.updatedAt)}</time>
                </button>
              ))}
            </div>
          ) : (
            <p className="code-stage-empty-copy">
              No saved chats are attached to this workspace yet. Start one and the sidebar will pin it to this folder.
            </p>
          )}
        </section>

        <section className="code-stage-panel code-stage-panel-metrics">
          <div className="code-stage-panel-head">
            <strong>Folder state</strong>
            <span>Last sync {formatStageTimestamp(workspace.syncedAt)}</span>
          </div>

          <div className="code-stage-metric-list">
            <div className="code-stage-metric">
              <span>Files</span>
              <strong>{workspace.fileCount}</strong>
            </div>
            <div className="code-stage-metric">
              <span>Folders</span>
              <strong>{workspace.directoryCount}</strong>
            </div>
            <div className="code-stage-metric">
              <span>Saved chats</span>
              <strong>{workspace.chats.length}</strong>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
