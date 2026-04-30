import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconCheck, IconFileText, IconRefreshCw, IconRotateCcw, IconX } from './Icon';
import { highlightWorkspaceFileContent } from '../lib/workspaceSyntax';

export interface WorkspaceEditorDocumentView {
  workspaceLabel: string;
  relativePath: string;
  content: string;
  savedContent: string;
  lang: string;
  sizeBytes: number;
  modifiedAt?: number;
  loading: boolean;
  saving: boolean;
  error?: string | null;
}

interface Props {
  document: WorkspaceEditorDocumentView | null;
  autoSaveEnabled: boolean;
  showIndentGuides: boolean;
  onChangeContent: (value: string) => void;
  onSave: () => void;
  onReload: () => void;
  onRevert: () => void;
  onClose: () => void;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getCursorLocation(value: string, selectionStart: number) {
  const beforeCursor = normalizeLineEndings(value.slice(0, selectionStart));
  const lines = beforeCursor.split('\n');
  return {
    line: Math.max(1, lines.length),
    column: (lines[lines.length - 1] ?? '').length + 1,
  };
}

function getLineCount(value: string): number {
  const normalized = normalizeLineEndings(value);
  return normalized.length ? normalized.split('\n').length : 1;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }

  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function formatModifiedAt(value?: number): string {
  if (!value) return 'Not saved yet';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getFileName(relativePath: string): string {
  return relativePath.split('/').pop() || relativePath;
}

export function WorkspaceFileEditorPanel({
  document,
  autoSaveEnabled,
  showIndentGuides,
  onChangeContent,
  onSave,
  onReload,
  onRevert,
  onClose,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const renderRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  const isDirty = Boolean(document && document.content !== document.savedContent);
  const lineCount = getLineCount(document?.content ?? '');
  const visibleLines = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1),
    [lineCount],
  );
  const cursor = useMemo(
    () => getCursorLocation(document?.content ?? '', selection.start),
    [document?.content, selection.start],
  );
  const highlightedHtml = useMemo(
    () => highlightWorkspaceFileContent(document?.content ?? '', document?.lang ?? 'text'),
    [document?.content, document?.lang],
  );
  const selectionLength = Math.max(0, selection.end - selection.start);
  const lineEnding = document?.content.includes('\r\n') ? 'CRLF' : 'LF';

  useEffect(() => {
    setSelection({ start: 0, end: 0 });
    if (textareaRef.current) {
      textareaRef.current.scrollTop = 0;
      textareaRef.current.scrollLeft = 0;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = 0;
    }
    if (renderRef.current) {
      renderRef.current.scrollTop = 0;
      renderRef.current.scrollLeft = 0;
    }
  }, [document?.relativePath]);

  const syncSelection = () => {
    const editor = textareaRef.current;
    if (!editor) return;

    setSelection({
      start: editor.selectionStart,
      end: editor.selectionEnd,
    });
  };

  const updateSelection = (start: number, end = start) => {
    requestAnimationFrame(() => {
      const editor = textareaRef.current;
      if (!editor) return;
      editor.selectionStart = start;
      editor.selectionEnd = end;
      setSelection({ start, end });
      editor.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!document) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!document.saving && isDirty) {
        onSave();
      }
      return;
    }

    if (event.key !== 'Tab') return;

    event.preventDefault();
    const target = event.currentTarget;
    const { selectionStart, selectionEnd } = target;
    const before = document.content.slice(0, selectionStart);
    const after = document.content.slice(selectionEnd);
    const nextValue = `${before}\t${after}`;
    onChangeContent(nextValue);
    updateSelection(selectionStart + 1);
  };

  if (!document) {
    return null;
  }

  const showEmptyState = document.loading && !document.content && !document.error;
  const syncEditorScroll = (scrollTop: number, scrollLeft: number) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
    if (renderRef.current) {
      renderRef.current.scrollTop = scrollTop;
      renderRef.current.scrollLeft = scrollLeft;
    }
  };

  return (
    <div className="chat-panel workspace-file-panel">
      <div className="panel-header workspace-file-panel-header">
        <div className="workspace-file-panel-title">
          <span className="workspace-file-panel-icon" aria-hidden="true">
            <IconFileText size={15} />
          </span>

          <div className="workspace-file-panel-copy">
            <div className="workspace-file-panel-copy-head">
              <strong>{getFileName(document.relativePath)}</strong>
              <span className={`workspace-file-panel-state${isDirty ? ' dirty' : ''}`}>
                {document.saving
                  ? 'Saving...'
                  : document.loading
                    ? 'Loading...'
                    : isDirty
                      ? 'Unsaved'
                      : 'Saved'}
              </span>
            </div>
            <span className="workspace-file-panel-path">{document.relativePath}</span>
          </div>
        </div>

        <div className="workspace-file-panel-actions">
          <button
            type="button"
            className="panel-btn"
            onClick={onReload}
            title={isDirty ? 'Reload from disk. Unsaved changes stay in memory until you revert.' : 'Reload from disk'}
            disabled={document.saving}
          >
            <IconRefreshCw size={14} />
          </button>
          <button
            type="button"
            className="panel-btn"
            onClick={onRevert}
            title="Revert to the last saved version"
            disabled={!isDirty || document.saving}
          >
            <IconRotateCcw size={14} />
          </button>
          <button
            type="button"
            className="workspace-file-panel-save"
            onClick={onSave}
            disabled={!isDirty || document.loading || document.saving}
            title="Save file"
          >
            <IconCheck size={14} />
            <span>Save</span>
          </button>
          <button
            type="button"
            className="panel-btn close"
            onClick={onClose}
            title="Close file editor"
          >
            <IconX size={13} />
          </button>
        </div>
      </div>

      {document.error ? (
        <div className="workspace-file-panel-banner error">
          {document.error}
        </div>
      ) : null}

      <div className="workspace-file-editor-shell">
        {showEmptyState ? (
          <div className="empty-state workspace-file-empty-state">
            <div className="empty-state-icon">
              <IconFileText size={42} />
            </div>
            <h3>Opening file</h3>
            <p>Loading the latest contents from this workspace.</p>
          </div>
        ) : (
          <div className={`workspace-file-editor${showIndentGuides ? '' : ' hide-indent-guides'}`}>
            <div ref={gutterRef} className="workspace-file-editor-gutter" aria-hidden="true">
              {visibleLines.map((lineNumber) => (
                <span
                  key={lineNumber}
                  className={`workspace-file-editor-line-number${lineNumber === cursor.line ? ' active' : ''}`}
                >
                  {lineNumber}
                </span>
              ))}
            </div>

            <div className="workspace-file-editor-main">
              <div ref={renderRef} className="workspace-file-editor-render" aria-hidden="true">
                <pre className="workspace-file-editor-render-content">
                  <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                </pre>
              </div>

              <textarea
                ref={textareaRef}
                className="workspace-file-editor-textarea"
                value={document.content}
                onChange={(event) => {
                  onChangeContent(event.target.value);
                  setSelection({
                    start: event.target.selectionStart,
                    end: event.target.selectionEnd,
                  });
                }}
                onClick={syncSelection}
                onKeyUp={syncSelection}
                onSelect={syncSelection}
                onScroll={(event) => {
                  syncEditorScroll(event.currentTarget.scrollTop, event.currentTarget.scrollLeft);
                }}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                readOnly={document.saving}
              />
            </div>
          </div>
        )}
      </div>

      <div className="workspace-file-statusbar">
        <span className="workspace-file-status-item">{document.workspaceLabel}</span>
        <span className="workspace-file-status-item">{(document.lang || 'text').toUpperCase()}</span>
        <span className="workspace-file-status-item">{lineCount} lines</span>
        <span className="workspace-file-status-item">{formatFileSize(document.sizeBytes)}</span>
        <span className="workspace-file-status-item">{lineEnding}</span>
        <span className="workspace-file-status-item">{autoSaveEnabled ? 'Autosave 2s' : 'Manual save'}</span>
        <span className="workspace-file-status-item">Ln {cursor.line}, Col {cursor.column}</span>
        {selectionLength > 0 ? (
          <span className="workspace-file-status-item">Sel {selectionLength}</span>
        ) : null}
        <span className="workspace-file-status-item">Modified {formatModifiedAt(document.modifiedAt)}</span>
      </div>
    </div>
  );
}
