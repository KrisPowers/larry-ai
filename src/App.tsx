import React, { useState, useCallback } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { HistoryModal } from './components/HistoryModal';
import { useOllama } from './hooks/useOllama';
import { useDB } from './hooks/useDB';
import { useToast } from './hooks/useToast';
import { createRegistry, updateRegistry } from './lib/fileRegistry';
import { DEFAULT_PRESET_ID } from './lib/presets';
import { IconMenu, IconPlus, IconHexagon } from './components/Icon';
import type { Panel, ChatRecord } from './types';
import type { FileRegistry } from './lib/fileRegistry';

function restoreRegistry(chatData?: ChatRecord): FileRegistry {
  const reg = createRegistry();
  if (!chatData?.fileEntries?.length) return reg;
  return updateRegistry(reg, chatData.fileEntries, 0);
}

function newPanel(index: number, models: string[], chatData?: ChatRecord): Panel {
  return {
    id: chatData?.id ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: chatData?.title ?? `Chat ${index + 1}`,
    model: chatData?.model ?? models[0] ?? '',
    preset: chatData?.preset ?? DEFAULT_PRESET_ID,
    messages: chatData?.messages ?? [],
    streaming: false,
    streamingContent: '',
    fileRegistry: restoreRegistry(chatData),
    prevRegistry: new Map(),
    streamingPhase: null,
  };
}

export default function App() {
  const { models, status } = useOllama();
  const { chats, save, remove, clearAll } = useDB();
  const { toast } = useToast();
  const [panels, setPanels] = useState<Panel[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const createPanel = useCallback((chatData?: ChatRecord) => {
    setPanels(prev => {
      if (prev.length >= 3) { toast('Max 3 panels open at once.'); return prev; }
      return [...prev, newPanel(prev.length, models, chatData)];
    });
  }, [models, toast]);

  const closePanel = useCallback((id: string) => {
    setPanels(prev => prev.filter(p => p.id !== id));
  }, []);

  const updatePanel = useCallback((id: string, patch: Partial<Panel>) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  const savePanel = useCallback((panel: Panel) => {
    const fileEntries = [...panel.fileRegistry.values()];
    save({
      id: panel.id,
      title: panel.title,
      model: panel.model,
      preset: panel.preset,
      messages: panel.messages,
      updatedAt: Date.now(),
      fileEntries,
    });
  }, [save]);

  function handleOpenFromHistory(chat: ChatRecord) {
    const existing = panels.find(p => p.id === chat.id);
    if (!existing) createPanel(chat);
    setHistoryOpen(false);
  }

  async function handleDeleteChat(id: string) {
    await remove(id);
    closePanel(id);
    toast('Chat deleted.');
  }

  async function handleClearAll() {
    await clearAll();
    setPanels([]);
    toast('History cleared.');
  }

  const statusLabel =
    status === 'connecting' ? 'connecting...' :
    status === 'online' ? `ollama · ${models.length} model${models.length !== 1 ? 's' : ''}` :
    'ollama offline';

  return (
    <div id="app">
      <div id="topbar">
        <div className={`status-dot ${status}`} />
        <span id="status-label">{statusLabel}</span>
        <div id="topbar-right">
          <button className="btn" onClick={() => setHistoryOpen(true)}>
            <IconMenu size={13} /> History
          </button>
          <button className="btn primary" onClick={() => createPanel()}>
            <IconPlus size={13} /> New Chat
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <div id="workspace">
          {panels.length === 0 ? (
            <div id="no-panels">
              <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                <IconHexagon size={72} />
              </div>
              <h2>No chats open</h2>
              <p>Click <strong>New Chat</strong> to start a session.<br />Up to 3 panels side-by-side.</p>
            </div>
          ) : (
            <div id="panels-area">
              {panels.map(panel => (
                <ChatPanel
                  key={panel.id}
                  panel={panel}
                  models={models}
                  onUpdate={updatePanel}
                  onClose={closePanel}
                  onSave={savePanel}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {historyOpen && (
        <HistoryModal
          chats={chats}
          openPanelIds={panels.map(p => p.id)}
          onOpen={handleOpenFromHistory}
          onDelete={handleDeleteChat}
          onClearAll={handleClearAll}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
