import { IconTerminal, IconTrash2, IconX } from './Icon';

export interface WorkspaceTerminalEntryView {
  id: string;
  command: string;
  output: string;
  status: 'running' | 'completed' | 'error';
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
}

interface Props {
  workspaceLabel: string;
  available: boolean;
  commandDraft: string;
  running: boolean;
  entries: WorkspaceTerminalEntryView[];
  onCommandDraftChange: (value: string) => void;
  onRun: () => void;
  onClear: () => void;
  onClose: () => void;
}

function formatTerminalDuration(durationMs?: number): string | null {
  if (!durationMs || durationMs <= 0) return null;
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function stripAnsiSequences(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function WorkspaceTerminalPanel({
  workspaceLabel,
  available,
  commandDraft,
  running,
  entries,
  onCommandDraftChange,
  onRun,
  onClear,
  onClose,
}: Props) {
  return (
    <section className="workspace-terminal-panel" aria-label="Workspace terminal">
      <div className="workspace-terminal-header">
        <div className="workspace-terminal-window-chrome" aria-hidden="true">
          <span className="workspace-terminal-window-dot close" />
          <span className="workspace-terminal-window-dot minimize" />
          <span className="workspace-terminal-window-dot maximize" />
        </div>

        <div className="workspace-terminal-title">
          <div className="workspace-terminal-tab">
            <span className="workspace-terminal-icon" aria-hidden="true">
              <IconTerminal size={15} />
            </span>
            <div className="workspace-terminal-copy">
              <strong>Terminal</strong>
              <span>{workspaceLabel}</span>
            </div>
          </div>
        </div>

        <div className="workspace-terminal-actions">
          <button
            type="button"
            className="panel-btn"
            onClick={onClear}
            title="Clear terminal history"
          >
            <IconTrash2 size={13} />
          </button>
          <button
            type="button"
            className="panel-btn close"
            onClick={onClose}
            title="Close terminal"
          >
            <IconX size={13} />
          </button>
        </div>
      </div>

      {!available ? (
        <div className="workspace-terminal-empty">
          The embedded terminal is available for desktop-linked workspaces.
        </div>
      ) : (
        <>
          <div className="workspace-terminal-history">
            {entries.length === 0 ? (
              <div className="workspace-terminal-empty">
                Run a command here to inspect the workspace just like a lightweight IDE terminal.
              </div>
            ) : (
              entries.map((entry) => (
                <article key={entry.id} className={`workspace-terminal-entry ${entry.status}`}>
                  <div className="workspace-terminal-entry-head">
                    <div className="workspace-terminal-entry-command">
                      <span className="workspace-terminal-entry-glyph" aria-hidden="true">$</span>
                      <code>{entry.command}</code>
                    </div>
                    <span className="workspace-terminal-entry-meta">
                      {entry.status === 'running'
                        ? 'Running'
                        : entry.timedOut
                          ? 'Timed out'
                          : entry.exitCode != null
                            ? `Exit ${entry.exitCode}`
                            : 'Done'}
                      {formatTerminalDuration(entry.durationMs) ? ` · ${formatTerminalDuration(entry.durationMs)}` : ''}
                    </span>
                  </div>
                  <pre>{stripAnsiSequences(entry.output) || '(no output)'}</pre>
                </article>
              ))
            )}
          </div>

          <div className="workspace-terminal-compose">
            <span className="workspace-terminal-compose-glyph" aria-hidden="true">$</span>
            <input
              className="workspace-terminal-input"
              value={commandDraft}
              onChange={(event) => onCommandDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                if (!running && commandDraft.trim()) {
                  onRun();
                }
              }}
              placeholder="npm run build"
              spellCheck={false}
            />
            <button
              type="button"
              className="workspace-terminal-run"
              onClick={onRun}
              disabled={!commandDraft.trim() || running}
            >
              {running ? 'Running...' : 'Run'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
