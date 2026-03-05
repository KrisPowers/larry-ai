import React, { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileRegistryPanel } from './FileRegistryPanel';
import { streamChat, BASE_SYSTEM_PROMPT } from '../lib/ollama';
import { updateRegistry } from '../lib/fileRegistry';
import { extractCodeBlocksForRegistry } from '../lib/markdown';
import { registryToSystemPrompt } from '../lib/fileRegistry';
import type { Panel, Message } from '../types';

interface Props {
  panel: Panel;
  models: string[];
  onUpdate: (id: string, patch: Partial<Panel>) => void;
  onClose: (id: string) => void;
  onSave: (panel: Panel) => void;
}

export function ChatPanel({ panel, models, onUpdate, onClose, onSave }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [panel.messages, panel.streamingContent]);

  useEffect(() => {
    if (!panel.streaming) inputRef.current?.focus();
  }, [panel.streaming]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || panel.streaming) return;
    setInputValue('');

    const userMsg: Message = { role: 'user', content: text };
    const updatedMessages = [...panel.messages, userMsg];

    onUpdate(panel.id, { messages: updatedMessages, streaming: true, streamingContent: '' });

    const abort = new AbortController();
    abortRef.current = abort;

    // Build system prompt: base instructions + current file registry
    const systemPrompt = BASE_SYSTEM_PROMPT + registryToSystemPrompt(panel.fileRegistry);

    let accumulated = '';

    try {
      const gen = streamChat(panel.model || models[0] || 'llama3', updatedMessages, systemPrompt, abort.signal);
      for await (const chunk of gen) {
        accumulated += chunk;
        onUpdate(panel.id, { streamingContent: accumulated });
      }

      const assistantMsg: Message = { role: 'assistant', content: accumulated };
      const finalMessages = [...updatedMessages, assistantMsg];

      // Update the file registry with any new/edited files from this response
      const newBlocks = extractCodeBlocksForRegistry(accumulated);
      const updatedRegistry = updateRegistry(panel.fileRegistry, newBlocks, finalMessages.length - 1);

      const updated: Panel = {
        ...panel,
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        fileRegistry: updatedRegistry,
      };

      onUpdate(panel.id, {
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        fileRegistry: updatedRegistry,
      });
      onSave(updated);

    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        if (accumulated) {
          const assistantMsg: Message = { role: 'assistant', content: accumulated + '\n\n_[stopped]_' };
          const finalMessages = [...updatedMessages, assistantMsg];
          const newBlocks = extractCodeBlocksForRegistry(accumulated);
          const updatedRegistry = updateRegistry(panel.fileRegistry, newBlocks, finalMessages.length - 1);
          onUpdate(panel.id, { messages: finalMessages, streaming: false, streamingContent: '', fileRegistry: updatedRegistry });
          onSave({ ...panel, messages: finalMessages, fileRegistry: updatedRegistry });
        } else {
          onUpdate(panel.id, { streaming: false, streamingContent: '' });
        }
      } else {
        const errMsg: Message = {
          role: 'assistant',
          content: `⚠ Error: ${(err as Error).message}\n\nMake sure Ollama is running with CORS enabled:\n\`\`\`bash\nOLLAMA_ORIGINS=* ollama serve\n\`\`\``,
        };
        onUpdate(panel.id, { messages: [...updatedMessages, errMsg], streaming: false, streamingContent: '' });
      }
    }
  }, [inputValue, panel, models, onUpdate, onSave]);

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleClear() {
    onUpdate(panel.id, { messages: [], fileRegistry: new Map() });
    onSave({ ...panel, messages: [], fileRegistry: new Map() });
  }

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="panel-header">
        <input
          className="panel-title"
          value={panel.title}
          placeholder="Chat name..."
          onChange={e => onUpdate(panel.id, { title: e.target.value })}
          onBlur={() => onSave(panel)}
        />
        <select
          className="model-select"
          value={panel.model}
          onChange={e => onUpdate(panel.id, { model: e.target.value })}
        >
          {models.length === 0
            ? <option value="">No models</option>
            : models.map(m => <option key={m} value={m}>{m}</option>)
          }
        </select>
        <button className="panel-btn" onClick={handleClear} title="Clear messages">↺</button>
        <button className="panel-btn close" onClick={() => onClose(panel.id)} title="Close panel">✕</button>
      </div>

      {/* Messages */}
      <div className="messages">
        {panel.messages.length === 0 && !panel.streaming ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <h3>Ready</h3>
            <p>Ask me to write code, generate docs, or debug anything.</p>
          </div>
        ) : (
          <>
            {panel.messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} withDownload={true} />
            ))}
            {panel.streaming && (
              panel.streamingContent ? (
                <MessageBubble
                  message={{ role: 'assistant', content: panel.streamingContent }}
                  withDownload={false}
                />
              ) : (
                <div className="thinking">
                  <div className="thinking-dots"><span /><span /><span /></div>
                  <span>thinking...</span>
                </div>
              )
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* File Registry — shown above the input when files exist */}
      <FileRegistryPanel registry={panel.fileRegistry} chatTitle={panel.title} />

      {/* Input */}
      <div className="panel-input">
        <div className="input-row">
          <textarea
            ref={inputRef}
            className="msg-input"
            rows={1}
            placeholder="Ask anything… (Shift+Enter for newline)"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={panel.streaming}
          />
          {panel.streaming ? (
            <button className="send-btn stop" onClick={handleStop} title="Stop generation">■</button>
          ) : (
            <button className="send-btn" onClick={handleSend} disabled={!inputValue.trim()}>➤</button>
          )}
        </div>
      </div>
    </div>
  );
}
