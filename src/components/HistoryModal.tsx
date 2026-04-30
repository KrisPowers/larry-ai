import React, { useState, useEffect, useRef } from 'react';
import type { ChatRecord } from '../types';
import { stripExportedChatMetadata } from '../lib/chatLog';
import { IconX, IconMessageSquare, IconTrash2, IconUpload } from './Icon';

interface Props {
  chats: ChatRecord[];
  openPanelIds: string[];
  onOpen: (chat: ChatRecord) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
  onImport: (chat: ChatRecord) => void;
}

/**
 * Parse an exported Markdown chat log back into a ChatRecord.
 * Expected format (as produced by exportChatAsMarkdown in ChatPanel):
 *
 *   # Chat Log - <title>
 *   **Model:** <model>
 *   **Preset:** <preset>
 *   **Exported:** <date>
 *   ---
 *   ### You
 *   <user message>
 *   ---
 *   ### Assistant
 *   <assistant message>
 *   ---
 */
function parseChatLog(md: string, filename: string): ChatRecord | null {
  try {
    const lines = md.split('\n');
    const title = lines[0]?.replace(/^#\s*Chat Log\s*[\u2014\u2013-]\s*/, '').trim() || filename.replace(/\.md$/, '');

    const modelLine  = lines.find(l => l.startsWith('**Model:**'));
    const presetLine = lines.find(l => l.startsWith('**Preset:**'));

    const model  = modelLine  ? modelLine.replace(/\*\*Model:\*\*\s*/, '').trim()  : '';
    const preset = presetLine ? presetLine.replace(/\*\*Preset:\*\*\s*/, '').trim() : 'chatbot';

    // Split into sections by '---' dividers
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const sections = md.split(/\n---\n/);

    for (const section of sections) {
      const s = section.trim();
      if (s.startsWith('### You')) {
        const content = s.replace(/^###\s+You\s*\n/, '').trim();
        if (content) messages.push({ role: 'user', content });
      } else if (s.startsWith('### Assistant')) {
        const content = stripExportedChatMetadata(s.replace(/^###\s+Assistant\s*\n/, '').trim());
        if (content) messages.push({ role: 'assistant', content });
      }
    }

    if (!messages.length) return null;

    return {
      id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      model,
      preset,
      messages,
      updatedAt: Date.now(),
      fileEntries: [],
    };
  } catch {
    return null;
  }
}

export function HistoryModal({ chats, openPanelIds, onOpen, onDelete, onClearAll, onClose, onImport }: Props) {
  const [query, setQuery] = useState('');
  const [importError, setImportError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = query
    ? chats.filter((c) => (c.title || '').toLowerCase().includes(query.toLowerCase()))
    : chats;

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleClearAll() {
    if (!confirm('Delete all chat history? This cannot be undone.')) return;
    onClearAll();
    onClose();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setImportError('');

    let imported = 0;
    for (const file of files) {
      const text = await file.text();
      const chat = parseChatLog(text, file.name);
      if (chat) {
        onImport(chat);
        imported++;
      }
    }

    if (!imported) {
      setImportError('Could not parse any chat logs. Make sure they are in Larry AI Markdown export format.');
    }
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div id="history-modal">
        <div id="history-modal-header">
          <h2>Chat History</h2>
          <input
            ref={searchRef}
            id="history-search"
            type="text"
            placeholder="Search chats..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="panel-btn close" onClick={onClose} title="Close">
            <IconX size={13} />
          </button>
        </div>

        <div id="history-list">
          {filtered.length === 0 ? (
            <div style={{ padding: '16px', color: 'var(--muted)', fontSize: '11px', textAlign: 'center' }}>
              No chats found.
            </div>
          ) : (
            filtered.map((chat) => {
              const isOpen = openPanelIds.includes(chat.id);
              const d = new Date(chat.updatedAt);
              const dateStr =
                d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
                ' / ' +
                d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

              return (
                <div
                  key={chat.id}
                  className={`history-item${isOpen ? ' active' : ''}`}
                  onClick={() => onOpen(chat)}
                >
                  <div className="history-item-icon">
                    <IconMessageSquare size={15} />
                  </div>
                  <div className="history-item-info">
                    <div className="history-item-name">{chat.title || 'Untitled'}</div>
                    <div className="history-item-date">
                      {dateStr} / {chat.messages?.length ?? 0} msgs
                    </div>
                  </div>
                  {isOpen && (
                    <span style={{
                      fontSize: '10px', color: 'var(--accent)',
                      padding: '2px 6px', border: '1px solid var(--accent)',
                      borderRadius: '4px', flexShrink: 0,
                    }}>
                      open
                    </span>
                  )}
                  <button
                    className="history-delete"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(chat.id); }}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {importError && (
          <div style={{
            padding: '8px 16px',
            background: 'rgba(247,106,106,0.08)',
            borderTop: '1px solid var(--border)',
            color: 'var(--danger)',
            fontSize: '11px',
          }}>
            {importError}
          </div>
        )}

        <div id="history-modal-footer">
          <span id="history-count">
            {filtered.length} chat{filtered.length !== 1 ? 's' : ''}
          </span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              ref={importRef}
              type="file"
              accept=".md,text/markdown"
              multiple
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button
              className="btn"
              onClick={() => importRef.current?.click()}
              title="Import chat log from .md file"
            >
              <IconUpload size={12} /> Import .md
            </button>
            <button className="btn danger" onClick={handleClearAll}>
              <IconTrash2 size={12} /> Clear All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
