import React, { useState, useEffect, useRef } from 'react';
import type { ChatRecord, Panel } from '../types';

interface Props {
  chats: ChatRecord[];
  openPanelIds: string[];
  onOpen: (chat: ChatRecord) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}

export function HistoryModal({ chats, openPanelIds, onOpen, onDelete, onClearAll, onClose }: Props) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

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
          <button className="panel-btn close" onClick={onClose} title="Close">✕</button>
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
                ' · ' +
                d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

              return (
                <div
                  key={chat.id}
                  className={`history-item${isOpen ? ' active' : ''}`}
                  onClick={() => onOpen(chat)}
                >
                  <div className="history-item-icon">💬</div>
                  <div className="history-item-info">
                    <div className="history-item-name">{chat.title || 'Untitled'}</div>
                    <div className="history-item-date">
                      {dateStr} · {chat.messages?.length ?? 0} msgs
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
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div id="history-modal-footer">
          <span id="history-count">
            {filtered.length} chat{filtered.length !== 1 ? 's' : ''}
          </span>
          <button className="btn danger" onClick={handleClearAll}>🗑 Clear All</button>
        </div>
      </div>
    </div>
  );
}
