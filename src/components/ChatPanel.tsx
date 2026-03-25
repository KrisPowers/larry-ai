// FILE: src/components/ChatPanel.tsx
import React, { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileRegistryPanel } from './FileRegistryPanel';
import { ChecklistIndicator } from './ChecklistIndicator';
import { streamChat } from '../lib/ollama';
import { buildDeepPlan, buildStepUserMessage, getStepExecutorSystem, buildSummaryUserMessage, getSummarySystem, packageVersionsToSystemInject } from '../lib/deepPlanner';
import type { DeepStep } from '../lib/deepPlanner';
import { registryToSystemPrompt, updateRegistry } from '../lib/fileRegistry';
import { extractCodeBlocksForRegistry } from '../lib/markdown';
import { fetchUrlsFromPrompt, fetchGlobalContext, urlContextToSystemInject, globalContextToSystemInject, globalContextToConversationInject, contextsToSystemInject } from '../lib/fetcher';
import type { FetchedContext } from '../lib/fetcher';
import { PRESETS, getPreset, DEFAULT_PRESET_ID } from '../lib/presets';
import {
  IconSend, IconStop, IconRotateCcw, IconX,
  IconHexagon,
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
  selected?: boolean;
  onActivate?: (id: string) => void;
}

function exportChatAsMarkdown(panel: Panel): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    `# Chat Log — ${panel.title}`, ``,
    `**Model:** ${panel.model || 'unknown'}  `,
    `**Preset:** ${panel.preset || 'code'}  `,
    ...(panel.projectLabel ? [`**Project:** ${panel.projectLabel}  `] : []),
    `**Exported:** ${date}  `,
    ``, `---`, ``,
  ];
  for (const msg of panel.messages) {
    lines.push(msg.role === 'user' ? '### You' : '### Assistant', '', msg.content, '', '---', '');
  }
  return lines.join('\n');
}

export function ChatPanel({ panel, models, onUpdate, onClose, onSave, selected, onActivate }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const abortRef       = useRef<AbortController | null>(null);
  const [inputValue, setInputValue] = useState('');

  const [checklistSteps,       setChecklistSteps]       = useState<DeepStep[]>([]);
  const [checklistCurrentStep, setChecklistCurrentStep] = useState(0);
  const [checklistPlanning,    setChecklistPlanning]     = useState(false);
  const [checklistClassifying, setChecklistClassifying] = useState(false);
  const [checklistMode,        setChecklistMode]        = useState<import('../lib/deepPlanner').RequestMode | undefined>();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [panel.messages, panel.streamingContent]);

  useEffect(() => {
    if (!panel.streaming) {
      inputRef.current?.focus();
      setChecklistSteps([]);
      setChecklistCurrentStep(0);
      setChecklistPlanning(false);
      setChecklistClassifying(false);
      setChecklistMode(undefined);
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

  // ── Send ────────────────────────────────────────────────────────────────────
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
      streamingPhase: { label: 'Fetching context…', stepIndex: 0, totalSteps: 0 },
    });

    const abort = new AbortController();
    abortRef.current = abort;

    // ── Auto-fetch: URLs in the prompt + global knowledge sources ───────────
    // Pass the full conversation history so follow-up questions ("what is the
    // US involvement?") can inherit topics from prior messages ("Iran").
    // Global context is injected BOTH into the system prompt AND as a synthetic
    // assistant prefill turn in the conversation, so even small models that
    // deprioritise system prompts will see and use the live data.
    let urlInject    = '';
    let globalInject = '';
    let contextTurns: Array<{ role: string; content: string }> = [];
    try {
      const [promptContexts, globalContexts] = await Promise.all([
        fetchUrlsFromPrompt(text),
        isCodePreset ? Promise.resolve([]) : fetchGlobalContext(text, panel.messages),
      ]);
      urlInject    = urlContextToSystemInject(promptContexts);
      globalInject = globalContextToSystemInject(globalContexts);
      contextTurns = globalContextToConversationInject(globalContexts, text);
    } catch { /* network failure is non-fatal */ }

    // ── Non-code presets — single pass ──────────────────────────────────────
    if (!isCodePreset) {
      const preset = getPreset(presetId);
      const systemPrompt = preset.systemPrompt
        + registryToSystemPrompt(panel.fileRegistry)
        + urlInject
        + globalInject;

      // Build the message array: history + [assistant context prefill] + user message.
      // The context prefill makes the model "own" the research and answer from it
      // rather than ignoring it. It's positioned as the last assistant turn so the
      // model continues naturally from "Based on the above, I will now answer..."
      const priorHistory = updatedMessages.slice(0, -1); // everything before the new user msg
      const messagesWithContext = [
        ...priorHistory,
        ...contextTurns,   // synthetic assistant turn with live research
        userMsg,           // the user's actual question
      ];

      let accumulated = '';
      try {
        const gen = streamChat(modelName, messagesWithContext, systemPrompt, abort.signal);
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

    // ── Code preset: plan → execute each step independently ─────────────────
    try {
      setChecklistClassifying(true);
      setChecklistPlanning(false);
      setChecklistSteps([]);
      setChecklistCurrentStep(0);
      onUpdate(panel.id, { streamingPhase: { label: 'Analysing request…', stepIndex: 0, totalSteps: 0 } });

      const plan = await buildDeepPlan(text, panel.messages, modelName, abort.signal);

      setChecklistClassifying(false);
      setChecklistPlanning(false);
      setChecklistMode(plan.mode);
      setChecklistSteps(plan.steps);
      setChecklistCurrentStep(1);

      const pkgVersionInject = packageVersionsToSystemInject(plan.resolvedPackages ?? []);
      const executorSystem = getStepExecutorSystem()
        + registryToSystemPrompt(panel.fileRegistry)
        + urlInject
        + pkgVersionInject;

      let combinedContent = '';
      let currentRegistry = panel.fileRegistry;
      const alreadyWritten: Array<{ path: string; exports: string[] }> = [];

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

        const stepUserMsg = buildStepUserMessage(plan, step, alreadyWritten);
        const stepMessages: Message[] = [
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

  const currentPreset  = panel.preset ?? DEFAULT_PRESET_ID;
  const isCodeStreaming = panel.streaming && currentPreset === 'code';
  const hasMessages     = panel.messages.length > 0;

  return (
    <div className={`chat-panel${selected ? ' active' : ''}`} onMouseDown={() => onActivate?.(panel.id)}>
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

        {/* Preset as compact dropdown */}
        <select
          className="preset-select"
          value={currentPreset}
          onChange={e => handlePresetChange(e.target.value)}
          title="Switch preset"
        >
          {PRESETS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

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
                  suppressNoCodeWarning={currentPreset !== 'code'}
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
                      isClassifying={checklistClassifying}
                      mode={checklistMode}
                    />
                  </div>
                )}

                {panel.streamingContent ? (
                  <div className="streaming-wrap">
                    {(() => {
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
                          suppressNoCodeWarning={true}
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
          <textarea
            ref={inputRef}
            className="msg-input"
            rows={1}
            placeholder="Ask anything… paste a URL and it'll be fetched automatically. Shift+Enter for newline."
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
