import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatRecord } from '../types';
import { IconMessageSquare, IconPlus, IconTrash2, IconX } from './Icon';

interface Props {
  chats: ChatRecord[];
  openPanelIds: string[];
  activeChatId: string | null;
  onOpen: (chat: ChatRecord) => void;
  onCreateNewConversation: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  anchoredToHeader?: boolean;
  shortcutLabel?: string;
}

function formatHistoryTimestamp(updatedAt: number): string {
  const date = new Date(updatedAt);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} / ${date.toLocaleTimeString([], {
    hour: '2-digit',
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

export function ChatHistoryDrawer({
  chats,
  openPanelIds,
  activeChatId,
  onOpen,
  onCreateNewConversation,
  onDelete,
  onClose,
  anchoredToHeader = false,
  shortcutLabel = 'Ctrl+Shift+O',
}: Props) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const storedCount = chats.length;
  const openCount = openPanelIds.length;

  useEffect(() => {
    searchRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const filteredChats = useMemo(() => {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return chats;

    return chats.filter((chat) => {
      const title = (chat.title || '').toLowerCase();
      const messageText = (chat.messages ?? [])
        .slice(-3)
        .map((message) => message.content.toLowerCase())
        .join(' ');
      return title.includes(cleanQuery) || messageText.includes(cleanQuery);
    });
  }, [chats, query]);

  return (
    <div
      className={`chat-history-drawer-backdrop${anchoredToHeader ? ' header-anchored' : ''}`}
      onClick={onClose}
    >
      <aside
        className={`chat-history-drawer${anchoredToHeader ? ' header-anchored' : ''}`}
        onClick={(event) => event.stopPropagation()}
        aria-label="Chat history popup"
        aria-modal="true"
        role="dialog"
        aria-labelledby="chat-history-overview-title"
      >
        <span className="chat-history-drawer-orb" aria-hidden="true" />

        <div className="chat-history-drawer-head">
          <div className="chat-history-drawer-title">
            <span className="chat-history-drawer-kicker">Chat Overview</span>
            <h2 id="chat-history-overview-title">Current and stored conversations</h2>
            <p>Jump between open chats, reopen stored local threads, or start a fresh conversation without leaving the workspace.</p>
          </div>

          <div className="chat-history-drawer-head-actions">
            <span className="chat-history-drawer-shortcut">
              <IconMessageSquare size={12} />
              <span>{shortcutLabel}</span>
            </span>
            <button
              type="button"
              className="chat-history-drawer-close"
              onClick={onClose}
              aria-label="Close chat overview"
              title="Close chat overview"
            >
              <IconX size={15} />
            </button>
          </div>
        </div>

        <div className="chat-history-drawer-toolbar">
          <div className="chat-history-drawer-toolbar-top">
            <button
              type="button"
              className="chat-history-drawer-create"
              onClick={onCreateNewConversation}
            >
              <IconPlus size={14} />
              <span>New conversation</span>
            </button>

            <div className="chat-history-drawer-stats">
              <span>{storedCount} stored</span>
              <span>{openCount} open</span>
            </div>
          </div>

          <label className="chat-history-drawer-search-shell">
            <input
              ref={searchRef}
              type="text"
              className="chat-history-drawer-search"
              placeholder="Search titles or recent messages..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <div className="chat-history-drawer-list">
          {filteredChats.length === 0 ? (
            <div className="chat-history-drawer-empty">
              No chat threads match this search yet.
            </div>
          ) : (
            <div className="chat-history-grid">
              {filteredChats.map((chat) => {
                const isOpen = openPanelIds.includes(chat.id);
                const isActive = activeChatId === chat.id;
                const latestMessage = findRecentMessage(chat);
                const latestUserMessage = findRecentMessage(chat, 'user');
                const latestAssistantMessage = findRecentMessage(chat, 'assistant');
                const cardTitle = compressPreviewText(
                  chat.title,
                  latestUserMessage?.content || 'Untitled conversation',
                );
                const userPreview = compressPreviewText(
                  latestUserMessage?.content,
                  'Open this conversation to keep going.',
                );
                const assistantPreview = compressPreviewText(
                  latestAssistantMessage?.content,
                  latestMessage?.content || 'Ready to continue from the latest saved state.',
                );

                return (
                  <article key={chat.id} className={`chat-history-card${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}>
                    <button
                      type="button"
                      className="chat-history-card-open"
                      onClick={() => onOpen(chat)}
                      title={cardTitle}
                    >
                      <div className="chat-history-card-top">
                        <span className="chat-history-card-icon">
                          <IconMessageSquare size={16} />
                        </span>

                        <span className="chat-history-card-badges">
                          {isOpen && (
                            <span className={`chat-history-badge${isActive ? ' active' : ''}`}>
                              {isActive ? 'active' : 'open'}
                            </span>
                          )}
                        </span>
                      </div>

                      <div className="chat-history-card-window" aria-hidden="true">
                        <div className="chat-history-card-window-bar">
                          <span className="chat-history-card-window-dots">
                            <span />
                            <span />
                            <span />
                          </span>
                          <span className="chat-history-card-window-title">{cardTitle}</span>
                        </div>

                        <div className="chat-history-card-window-body">
                          <span className="chat-history-card-bubble user">{userPreview}</span>
                          <span className="chat-history-card-bubble assistant">{assistantPreview}</span>
                        </div>
                      </div>

                      <span className="chat-history-card-copy">
                        <span className="chat-history-card-title">{cardTitle}</span>

                        <span className="chat-history-card-meta">
                          <span>{formatHistoryTimestamp(chat.updatedAt)}</span>
                          <span>{chat.messages?.length ?? 0} msgs</span>
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      className="chat-history-card-delete"
                      onClick={() => onDelete(chat.id)}
                      aria-label="Delete chat"
                      title="Delete chat"
                    >
                      <IconTrash2 size={12} />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
