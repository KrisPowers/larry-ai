// FILE: src/components/ChatPanel.tsx
import React, { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileRegistryPanel } from './FileRegistryPanel';
import { ChecklistIndicator } from './ChecklistIndicator';
import { streamChat } from '../lib/ollama';
import { buildDeepPlan, buildStepUserMessage, getStepExecutorSystem, buildSummaryUserMessage, getSummarySystem } from '../lib/deepPlanner';
import type { DeepStep } from '../lib/deepPlanner';
import { updateRegistry, registryToSystemPrompt } from '../lib/fileRegistry';
import { extractCodeBlocksForRegistry } from '../lib/markdown';
import { PRESETS, getPreset, DEFAULT_PRESET_ID } from '../lib/presets';
import { readZipEntries } from '../lib/zip';
import {
  IconSend, IconStop, IconRotateCcw, IconX,
  IconPaperclip, IconFolder, IconHexagon,
  IconCode2, IconMessageSquare, IconSparkles,
  IconDownload,
} from './Icon';
import type { Panel, Message } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  panel: Panel;
  models: string[];
  onUpdate: (id: string, patch: Partial<Panel>) => void;
  onClose: (id: string) => void;
  onSave: (panel: Panel) => void;
}

function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
    py: 'py', html: 'html', css: 'css', scss: 'scss',
    json: 'json', md: 'md', sh: 'sh', bash: 'bash',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql',
    go: 'go', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp',
  };
  return map[ext] ?? ext ?? 'text';
}

const PRESET_ICONS: Record<string, React.ReactNode> = {
  code:     <IconCode2 size={12} />,
  chatbot:  <IconMessageSquare size={12} />,
  creative: <IconSparkles size={12} />,
};

function exportChatAsMarkdown(panel: Panel): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    `# Chat Log — ${panel.title}`, ``,
    `**Model:** ${panel.model || 'unknown'}  `,
    `**Preset:** ${panel.preset || 'code'}  `,
    `**Exported:** ${date}  `,
    ``, `---`, ``,
  ];
  for (const msg of panel.messages) {
    lines.push(msg.role === 'user' ? '### You' : '### Assistant', '', msg.content, '', '---', '');
  }
  return lines.join('\n');
}

export function ChatPanel({ panel, models, onUpdate, onClose, onSave }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const dirInputRef    = useRef<HTMLInputElement>(null);
  const abortRef       = useRef<AbortController | null>(null);
  const [inputValue, setInputValue] = useState('');

  const [checklistSteps,       setChecklistSteps]       = useState<DeepStep[]>([]);
  const [checklistCurrentStep, setChecklistCurrentStep] = useState(0);
  const [checklistPlanning,    setChecklistPlanning]     = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [panel.messages, panel.streamingContent]);

  useEffect(() => {
    if (!panel.streaming) {
      inputRef.current?.focus();
      setChecklistSteps([]);
      setChecklistCurrentStep(0);
      setChecklistPlanning(false);
    }
  }, [panel.streaming]);

  function handleExportLog() {
    const blob = new Blob([exportChatAsMarkdown(panel)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${panel.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'chat'}_log.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || panel.streaming) return;
    setInputValue('');

    const userMsg: Message               = { role: 'user', content: text };
    const updatedMessages                = [...panel.messages, userMsg];
    const snapshotRegistry: FileRegistry = new Map(panel.fileRegistry);
    const presetId                       = panel.preset ?? DEFAULT_PRESET_ID;
    const isCodePreset                   = presetId === 'code';
    const modelName                      = panel.model || models[0] || 'llama3';

    onUpdate(panel.id, {
      messages: updatedMessages,
      streaming: true,
      streamingContent: '',
      prevRegistry: snapshotRegistry,
      streamingPhase: { label: 'Planning…', stepIndex: 0, totalSteps: 0 },
    });

    const abort = new AbortController();
    abortRef.current = abort;

    // ── Non-code presets — single pass ────────────────────────────────────
    if (!isCodePreset) {
      const preset       = getPreset(presetId);
      const systemPrompt = preset.systemPrompt + registryToSystemPrompt(panel.fileRegistry);
      let accumulated    = '';
      try {
        const gen = streamChat(modelName, updatedMessages, systemPrompt, abort.signal);
        for await (const chunk of gen) {
          accumulated += chunk;
          onUpdate(panel.id, { streamingContent: accumulated, streamingPhase: null });
        }
        await finaliseResponse(accumulated, updatedMessages, snapshotRegistry, panel.fileRegistry);
      } catch (err) {
        handleError(err, updatedMessages);
      }
      return;
    }

    // ── Code preset: plan → execute each step independently ──────────────
    try {
      // ── Phase 1: planning ────────────────────────────────────────────────
      setChecklistPlanning(true);
      setChecklistSteps([]);
      setChecklistCurrentStep(0);

      const plan = await buildDeepPlan(text, panel.messages, modelName, abort.signal);

      setChecklistPlanning(false);
      setChecklistSteps(plan.steps);
      setChecklistCurrentStep(1);

      // Executor system prompt — lean, code-first, no prose-before-code rules
      const executorSystem = getStepExecutorSystem()
        + registryToSystemPrompt(panel.fileRegistry);

      let combinedContent = '';
      let currentRegistry = panel.fileRegistry;
      const alreadyWritten: Array<{ path: string; exports: string[] }> = [];

      // ── Phase 2: one request per step ────────────────────────────────────
      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        setChecklistCurrentStep(si + 1);

        onUpdate(panel.id, {
          streamingPhase: {
            label:      `Step ${si + 1} of ${plan.steps.length} — ${step.filePath}`,
            stepIndex:  si + 1,
            totalSteps: plan.steps.length,
          },
        });

        // Each step is a fresh conversation: system = executor rules,
        // user turn = original request + project context + this file's spec.
        // Keeping the conversation short prevents context-window overflow and
        // stops the model from being distracted by earlier code output.
        const stepUserMsg = buildStepUserMessage(plan, step, alreadyWritten);

        const stepMessages: Message[] = [
          // Always include the original user request so the model understands
          // the broader goal, then the specific step instruction
          { role: 'user', content: text },
          { role: 'assistant', content: `Understood. I will implement the project step by step. Starting step ${si + 1}: ${step.filePath}` },
          { role: 'user', content: stepUserMsg },
        ];

        let stepContent = '';
        const gen = streamChat(modelName, stepMessages, executorSystem, abort.signal);
        for await (const token of gen) {
          stepContent += token;
          onUpdate(panel.id, { streamingContent: combinedContent + stepContent });
        }

        // Update registry so subsequent steps can reference written files
        const newBlocks = extractCodeBlocksForRegistry(stepContent);
        currentRegistry = updateRegistry(currentRegistry, newBlocks, updatedMessages.length);
        for (const b of newBlocks) {
          const planned = plan.steps.find(s => s.filePath === b.path);
          alreadyWritten.push({ path: b.path, exports: planned?.exports ?? [] });
        }

        const separator = si < plan.steps.length - 1
          ? `\n\n<!-- step-break: ${si + 1}/${plan.steps.length} -->\n\n`
          : '';
        combinedContent += stepContent + separator;
      }

      setChecklistCurrentStep(plan.steps.length + 1);

      // ── Phase 3: automatic summary follow-up ─────────────────────────────
      // Build the list of files the model actually wrote (from the registry)
      const filesWritten = [...currentRegistry.values()].map(e => ({ path: e.path }));

      onUpdate(panel.id, {
        streamingPhase: {
          label: 'Writing summary…',
          stepIndex: plan.steps.length + 1,
          totalSteps: plan.steps.length + 1,
        },
        streamingContent: combinedContent,
      });

      const summaryUserMsg = buildSummaryUserMessage(text, plan.projectSummary, filesWritten);
      const summaryMessages: Message[] = [
        { role: 'user', content: summaryUserMsg },
      ];

      let summaryContent = '';
      const summaryGen = streamChat(modelName, summaryMessages, getSummarySystem(), abort.signal);
      for await (const token of summaryGen) {
        summaryContent += token;
        onUpdate(panel.id, { streamingContent: combinedContent + '\n\n<!-- summary -->\n\n' + summaryContent });
      }

      const fullContent = combinedContent + '\n\n<!-- summary -->\n\n' + summaryContent;
      await finaliseResponse(fullContent, updatedMessages, snapshotRegistry, currentRegistry);

    } catch (err) {
      handleError(err, updatedMessages);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    async function finaliseResponse(
      content: string,
      msgs: Message[],
      snapReg: FileRegistry,
      baseReg: FileRegistry,
    ) {
      const assistantMsg: Message = { role: 'assistant', content };
      const finalMessages         = [...msgs, assistantMsg];
      const newBlocks             = extractCodeBlocksForRegistry(content);
      const updatedReg            = updateRegistry(baseReg, newBlocks, finalMessages.length - 1);

      onUpdate(panel.id, {
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
      });
      onSave({
        ...panel,
        messages: finalMessages,
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
      });
    }

    function handleError(err: unknown, msgs: Message[]) {
      if ((err as Error)?.name === 'AbortError') {
        const content = panel.streamingContent;
        if (content) {
          const assistantMsg: Message = { role: 'assistant', content: content + '\n\n_[stopped]_' };
          const finalMessages         = [...msgs, assistantMsg];
          const newBlocks             = extractCodeBlocksForRegistry(content);
          const updatedReg            = updateRegistry(panel.fileRegistry, newBlocks, finalMessages.length - 1);
          onUpdate(panel.id, { messages: finalMessages, streaming: false, streamingContent: '', fileRegistry: updatedReg, streamingPhase: null });
          onSave({ ...panel, messages: finalMessages, fileRegistry: updatedReg, streamingPhase: null });
        } else {
          onUpdate(panel.id, { streaming: false, streamingContent: '', streamingPhase: null });
        }
      } else {
        const errMsg: Message = {
          role: 'assistant',
          content: `Error: ${(err as Error).message}\n\nMake sure Ollama is running:\n\`\`\`bash\nOLLAMA_ORIGINS=* ollama serve\n\`\`\``,
        };
        onUpdate(panel.id, { messages: [...msgs, errMsg], streaming: false, streamingContent: '', streamingPhase: null });
      }
    }

  }, [inputValue, panel, models, onUpdate, onSave]);

  // ── File / dir upload ─────────────────────────────────────────────────────
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = '';
    let added = 0;
    let reg = new Map(panel.fileRegistry);
    for (const file of files) {
      const uint8 = new Uint8Array(await file.arrayBuffer());
      if (file.name.endsWith('.zip')) {
        for (const entry of readZipEntries(uint8)) {
          reg = updateRegistry(reg, [{ path: entry.path, content: entry.content, lang: langFromPath(entry.path) }], 0);
          added++;
        }
      } else {
        const content = new TextDecoder('utf-8', { fatal: false }).decode(uint8);
        if (!content.includes('\0')) {
          reg = updateRegistry(reg, [{ path: file.name, content, lang: langFromPath(file.name) }], 0);
          added++;
        }
      }
    }
    const sysMsg: Message = { role: 'assistant', content: `_Uploaded ${added} file${added !== 1 ? 's' : ''} into the project registry._` };
    const finalMessages = [...panel.messages, sysMsg];
    onUpdate(panel.id, { messages: finalMessages, fileRegistry: reg });
    onSave({ ...panel, messages: finalMessages, fileRegistry: reg });
  }

  async function handleDirImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = '';
    let reg = new Map(panel.fileRegistry);
    let added = 0;
    for (const file of files) {
      const rel       = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
      const parts     = rel.split('/');
      const cleanPath = parts.length > 1 ? parts.slice(1).join('/') : rel;
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz|lock)$/.test(cleanPath)) continue;
      if (/node_modules|\.git|\.next|dist\/|build\//.test(cleanPath)) continue;
      const fileText = await file.text();
      if (fileText.includes('\0')) continue;
      reg = updateRegistry(reg, [{ path: cleanPath, content: fileText, lang: langFromPath(cleanPath) }], 0);
      added++;
    }
    const sysMsg: Message = { role: 'assistant', content: `_Imported ${added} file${added !== 1 ? 's' : ''} from directory into the project registry._` };
    const finalMessages = [...panel.messages, sysMsg];
    onUpdate(panel.id, { messages: finalMessages, fileRegistry: reg });
    onSave({ ...panel, messages: finalMessages, fileRegistry: reg });
  }

  function handleStop()  { abortRef.current?.abort(); }
  function handleClear() {
    onUpdate(panel.id, { messages: [], fileRegistry: new Map(), prevRegistry: new Map(), streamingPhase: null });
    onSave({ ...panel, messages: [], fileRegistry: new Map(), prevRegistry: new Map(), streamingPhase: null });
  }
  function handlePresetChange(id: string) {
    onUpdate(panel.id, { preset: id });
    onSave({ ...panel, preset: id });
  }
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
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

  const currentPreset   = panel.preset ?? DEFAULT_PRESET_ID;
  const isCodeStreaming  = panel.streaming && currentPreset === 'code';
  const hasMessages      = panel.messages.length > 0;

  return (
    <div className="chat-panel">
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
        <div className="preset-tabs">
          {PRESETS.map(p => (
            <button
              key={p.id}
              className={`preset-tab${currentPreset === p.id ? ' active' : ''}`}
              onClick={() => handlePresetChange(p.id)}
              title={p.label}
            >
              {PRESET_ICONS[p.id]} {p.label}
            </button>
          ))}
        </div>
        {hasMessages && (
          <button className="panel-btn" onClick={handleExportLog} title="Export chat log as Markdown">
            <IconDownload size={13} />
          </button>
        )}
        <button className="panel-btn" onClick={handleClear} title="Clear messages">
          <IconRotateCcw size={13} />
        </button>
        <button className="panel-btn close" onClick={() => onClose(panel.id)} title="Close panel">
          <IconX size={13} />
        </button>
      </div>

      <div className="messages">
        {!hasMessages && !panel.streaming ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconHexagon size={52} /></div>
            <h3>Ready</h3>
            <p>Ask me to write code, generate docs, or debug anything.</p>
          </div>
        ) : (
          <>
            {panel.messages.map((msg, i) => {
              const isCodeAssistant = msg.role === 'assistant' && currentPreset === 'code';
              return (
                <MessageBubble
                  key={i}
                  message={msg}
                  withDownload={true}
                  prevRegistry={panel.prevRegistry}
                  currentRegistry={panel.fileRegistry}
                  model={panel.model}
                  hideCodeBlocks={isCodeAssistant}
                />
              );
            })}

            {panel.streaming && (
              <>
                {isCodeStreaming && (
                  <div className="checklist-wrap">
                    <ChecklistIndicator
                      steps={checklistSteps}
                      currentStep={checklistCurrentStep}
                      isPlanning={checklistPlanning}
                    />
                  </div>
                )}

                {panel.streamingContent ? (
                  <div className="streaming-wrap">
                    {(() => {
                      // During code preset streaming, suppress the bubble entirely
                      // until the summary marker arrives — the checklist is the
                      // only visible indicator during the step phase.
                      // Once the summary starts, MessageBubble handles the split
                      // internally (full content for file pills, display portion
                      // for prose rendering).
                      const summaryMarker = '\n\n<!-- summary -->\n\n';
                      const hasSummary = isCodeStreaming &&
                        panel.streamingContent.includes(summaryMarker);
                      if (isCodeStreaming && !hasSummary) return null;
                      return (
                        <MessageBubble
                          message={{ role: 'assistant', content: panel.streamingContent }}
                          withDownload={false}
                          prevRegistry={panel.prevRegistry}
                          currentRegistry={panel.fileRegistry}
                          model={panel.model}
                          hideCodeBlocks={isCodeStreaming}
                        />
                      );
                    })()}
                  </div>
                ) : !isCodeStreaming ? (
                  <div className="thinking">
                    <div className="thinking-dots"><span /><span /><span /></div>
                    <span>thinking...</span>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <FileRegistryPanel registry={panel.fileRegistry} chatTitle={panel.title} />

      <div className="panel-input">
        <div className="input-row">
          <input ref={fileInputRef} type="file" multiple accept="*/*" style={{ display: 'none' }} onChange={handleFileUpload} />
          <input ref={dirInputRef} type="file"
            // @ts-ignore
            webkitdirectory="" multiple style={{ display: 'none' }} onChange={handleDirImport} />
          <div className="input-actions">
            <button className="input-action-btn" onClick={() => fileInputRef.current?.click()} title="Upload files or zip" disabled={panel.streaming}>
              <IconPaperclip size={14} />
            </button>
            <button className="input-action-btn" onClick={() => dirInputRef.current?.click()} title="Import project directory" disabled={panel.streaming}>
              <IconFolder size={14} />
            </button>
          </div>
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
            <button className="send-btn stop" onClick={handleStop} title="Stop generation">
              <IconStop size={14} />
            </button>
          ) : (
            <button className="send-btn" onClick={handleSend} disabled={!inputValue.trim()}>
              <IconSend size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
