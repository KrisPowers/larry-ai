import { useEffect, useMemo, useRef, useState } from 'react';
import { buildWorkspaceGroups } from '../lib/workspaces';
import { getModelDisplayLabel, getModelDisplayName, getModelProviderLabel, resolveModelHandle } from '../lib/ollama';
import { PRESETS } from '../lib/presets';
import type { ChatRecord, ProjectFolder, ThreadType } from '../types';
import {
  IconCheck,
  IconChevronDown,
  IconCode2,
  IconFolder,
  IconFolderPlus,
  IconMessageSquare,
  IconTerminal,
  IconTrash2,
  IconUpload,
} from './Icon';

type PromptPage = 'landing' | 'chat' | 'code' | 'debug';

interface StartOptions {
  prompt: string;
  preset: string;
  title: string;
  threadType: ThreadType;
  model?: string;
  workspace?: { id: string; label: string };
}

interface Props {
  page: PromptPage;
  chats: ChatRecord[];
  folders: ProjectFolder[];
  defaultModel: string;
  models?: string[];
  embedded?: boolean;
  chatLaunchTransition?: {
    prompt: string;
    statusText: string;
  } | null;
  onStartChat: (options: StartOptions) => boolean;
  onOpenChat: (chat: ChatRecord) => void;
  onCreateChatInFolder: (folder: { id: string; label: string }) => void;
  onOpenWorkspaceLauncher: (mode?: 'create' | 'import') => void;
  onDeleteChat: (id: string) => void;
  onDeleteWorkspace: (workspace: { id: string; label: string }) => void;
  onGoToChat?: () => void;
  onGoToCode?: () => void;
  onGoToDebug?: () => void;
}

interface PageDefinition {
  kicker: string;
  title: string;
  description: string;
  promptLabel: string;
  placeholder: string;
  launchLabel: string;
  preset: string;
  threadType: ThreadType;
  requiresWorkspace: boolean;
  workspaceLabel?: string;
  workspaceHint?: string;
  emptyWorkspaceTitle?: string;
  emptyWorkspaceHint?: string;
  icon: typeof IconMessageSquare;
}

const PAGE_DEFINITIONS: Record<Exclude<PromptPage, 'landing'>, PageDefinition> = {
  chat: {
    kicker: 'Chat',
    title: 'Start a normal conversation.',
    description: 'Use the lightweight chat flow when you do not need project folders, file context, or thread management.',
    promptLabel: 'Opening prompt',
    placeholder: 'Ask a question, brainstorm an idea, summarize a topic, or start a normal chat...',
    launchLabel: 'Start chat',
    preset: 'chatbot',
    threadType: 'chat',
    requiresWorkspace: false,
    icon: IconMessageSquare,
  },
  code: {
    kicker: 'Code',
    title: 'Start a project thread.',
    description: 'Code threads belong to a workspace so the project explorer can hold files and implementation threads together.',
    promptLabel: 'Build brief',
    placeholder: 'Describe the feature, stack, constraints, and output you want built...',
    launchLabel: 'Start code thread',
    preset: 'code',
    threadType: 'code',
    requiresWorkspace: true,
    workspaceLabel: 'Project workspace',
    workspaceHint: 'Choose the workspace this build belongs to. New code threads stay attached to that project.',
    emptyWorkspaceTitle: 'No project workspace yet',
    emptyWorkspaceHint: 'Create a workspace or import a folder before starting a code thread.',
    icon: IconCode2,
  },
  debug: {
    kicker: 'Debug',
    title: 'Start a debugging thread.',
    description: 'Debug threads stay under the affected project so repro notes, fixes, and follow-up checks remain grouped in one place.',
    promptLabel: 'Bug report',
    placeholder: 'Describe the bug, expected behavior, reproduction steps, logs, and what you already tried...',
    launchLabel: 'Start debug thread',
    preset: 'code',
    threadType: 'debug',
    requiresWorkspace: true,
    workspaceLabel: 'Affected workspace',
    workspaceHint: 'Pick the workspace that owns the bug so the explorer keeps the troubleshooting threads under the right project.',
    emptyWorkspaceTitle: 'No affected workspace yet',
    emptyWorkspaceHint: 'Create a workspace or import a folder before starting a debug thread.',
    icon: IconTerminal,
  },
};

const ROUTE_LAUNCHERS = [
  {
    id: 'chat',
    label: 'Chat',
    description: 'Normal chatbot threads with no project setup.',
    icon: IconMessageSquare,
  },
  {
    id: 'code',
    label: 'Code',
    description: 'Project-based build threads with a workspace explorer.',
    icon: IconCode2,
  },
  {
    id: 'debug',
    label: 'Debug',
    description: 'Troubleshooting threads grouped by project workspace.',
    icon: IconTerminal,
  },
] as const;

const CHAT_START_PRESETS = PRESETS.filter((preset) => preset.id !== 'code');

function describeChatPreset(presetId: string): string {
  if (presetId === 'deep-research') {
    return 'Broader live retrieval, denser source comparison, and a longer answer when the prompt needs real research.';
  }

  if (presetId === 'auto-chat') {
    return 'Automatically routes between conversation, note-taking, and deeper research based on the prompt.';
  }

  if (presetId === 'note-taking') {
    return 'Organizes content into structured notes, key points, and action items.';
  }

  if (presetId === 'creative') {
    return 'Keeps the answer more open-ended, imaginative, and exploratory.';
  }

  return 'Balanced everyday chat responses with lightweight structure.';
}

function formatLibraryAge(updatedAt: number): string {
  const deltaMinutes = Math.max(1, Math.floor((Date.now() - updatedAt) / 60000));
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;

  return new Date(updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function resolveThreadLabel(chat: ChatRecord): string {
  if (chat.threadType === 'debug') return 'Debug';
  if (chat.threadType === 'code') return 'Code';
  if (chat.preset === 'code' && chat.projectId) return 'Code';
  return 'Chat';
}

export function PromptLibraryView({
  page,
  chats,
  folders,
  defaultModel,
  models = [],
  embedded = false,
  chatLaunchTransition,
  onStartChat,
  onOpenChat,
  onCreateChatInFolder,
  onOpenWorkspaceLauncher,
  onDeleteChat,
  onDeleteWorkspace,
  onGoToChat,
  onGoToCode,
  onGoToDebug,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [selectedChatModel, setSelectedChatModel] = useState(defaultModel || models[0] || '');
  const [selectedChatPreset, setSelectedChatPreset] = useState('auto-chat');
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const presetPickerRef = useRef<HTMLDivElement>(null);

  const showLibrary = page === 'landing';
  const definition = page === 'landing' ? null : PAGE_DEFINITIONS[page];
  const workspaceGroups = useMemo(() => buildWorkspaceGroups(chats, folders), [chats, folders]);
  const workspaceOptions = useMemo(
    () => workspaceGroups.filter((workspace) => workspace.id !== 'project:general'),
    [workspaceGroups],
  );
  const selectedWorkspace = workspaceOptions.find((workspace) => workspace.id === selectedWorkspaceId);

  useEffect(() => {
    if (!definition?.requiresWorkspace) return;
    if (selectedWorkspaceId && workspaceOptions.some((workspace) => workspace.id === selectedWorkspaceId)) return;
    setSelectedWorkspaceId(workspaceOptions[0]?.id ?? '');
  }, [definition?.requiresWorkspace, selectedWorkspaceId, workspaceOptions]);

  const stageOpacity = showLibrary ? Math.max(0.24, 1 - scrollTop / 320) : 1;
  const stageTranslate = showLibrary ? Math.min(44, scrollTop / 8) : 0;
  const stageScale = showLibrary ? Math.max(0.97, 1 - scrollTop / 2400) : 1;
  const libraryOpacity = showLibrary ? Math.min(1, 0.28 + scrollTop / 220) : 0;
  const libraryTranslate = showLibrary ? Math.max(0, 54 - scrollTop / 7) : 0;
  const canLaunch = Boolean(prompt.trim()) && (!definition?.requiresWorkspace || Boolean(selectedWorkspace));
  const resolvedChatModel = resolveModelHandle(selectedChatModel || defaultModel, models);
  const selectedModelLabel = getModelDisplayLabel(resolveModelHandle(defaultModel, models));
  const selectedChatModelLabel = getModelDisplayLabel(resolvedChatModel);
  const selectedChatPresetMeta = CHAT_START_PRESETS.find((preset) => preset.id === selectedChatPreset) ?? CHAT_START_PRESETS[0];

  useEffect(() => {
    if (page !== 'chat') return;
    if (selectedChatModel && models.includes(selectedChatModel)) return;
    setSelectedChatModel(defaultModel || models[0] || '');
  }, [defaultModel, models, page, selectedChatModel]);

  useEffect(() => {
    if (page !== 'chat') return;
    if (selectedChatPreset && CHAT_START_PRESETS.some((preset) => preset.id === selectedChatPreset)) return;
    setSelectedChatPreset(CHAT_START_PRESETS[0]?.id ?? 'auto-chat');
  }, [page, selectedChatPreset]);

  useEffect(() => {
    if (!modelPickerOpen && !presetPickerOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
      if (!presetPickerRef.current?.contains(event.target as Node)) {
        setPresetPickerOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPickerOpen(false);
        setPresetPickerOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelPickerOpen, presetPickerOpen]);

  const handleStartChat = () => {
    if (!definition) return;

    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    if (definition.requiresWorkspace && !selectedWorkspace) return;

    const title = definition.requiresWorkspace && selectedWorkspace
      ? `${selectedWorkspace.label} ${definition.threadType === 'debug' ? 'Debug' : 'Code'}`
      : selectedChatPreset === 'deep-research'
        ? 'New Deep Research Chat'
        : 'New Chat';

    const started = onStartChat({
      prompt: cleanPrompt,
      preset: page === 'chat' ? selectedChatPreset : definition.preset,
      title,
      threadType: definition.threadType,
      model: page === 'chat' ? resolvedChatModel : undefined,
      workspace: definition.requiresWorkspace ? selectedWorkspace : undefined,
    });

    if (started) {
      setPrompt('');
    }
  };

  if (showLibrary) {
    return (
      <div
        className="launch-shell landing"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        <section
          className="launch-stage landing-stage"
          style={{
            opacity: stageOpacity,
            transform: `translateY(-${stageTranslate}px) scale(${stageScale})`,
          }}
        >
          <div className="landing-stage-copy">
            <span className="launch-kicker">Workspace Home</span>
            <h1>Choose the workflow first, then drop into saved local threads.</h1>
            <p>
              Chat stays lightweight. Code and debug live in project workspaces with a proper explorer so threads behave like tracked work, not loose prompts.
            </p>
            <div className="landing-route-grid" role="navigation" aria-label="Start routes">
              {ROUTE_LAUNCHERS.map((route) => {
                const RouteIcon = route.icon;
                const handler = route.id === 'chat'
                  ? onGoToChat
                  : route.id === 'code'
                    ? onGoToCode
                    : onGoToDebug;
                return (
                  <button
                    key={route.id}
                    type="button"
                    className="landing-route-tile"
                    onClick={handler}
                  >
                    <span className="landing-route-icon">
                      <RouteIcon size={18} />
                    </span>
                    <strong>{route.label}</strong>
                    <span>{route.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="landing-stage-aside">
            <div className="landing-stage-note">
              <span className="landing-note-label">Default model</span>
              <strong>{selectedModelLabel}</strong>
            </div>
            <div className="landing-stage-note">
              <span className="landing-note-label">Routing</span>
              <strong>`/chat`, `/code`, `/debug`</strong>
            </div>
            <div className="landing-stage-note">
              <span className="landing-note-label">Storage</span>
              <strong>Chats stay in local IndexedDB</strong>
            </div>
          </div>
        </section>

        <section
          className="drive-library"
          style={{
            opacity: libraryOpacity,
            transform: `translateY(${libraryTranslate}px)`,
          }}
        >
          <div className="drive-library-head">
            <div>
              <span className="launch-kicker">My Drive</span>
              <h2>Projects and saved chats</h2>
              <p>Folders hold project workspaces. Local chats sit inside them as saved threads.</p>
            </div>
            <div className="drive-library-stats">
              <span>{workspaceGroups.length} folders</span>
              <span>{chats.length} chats</span>
            </div>
          </div>

          {workspaceGroups.length === 0 ? (
            <div className="drive-library-empty">
              <div className="drive-library-empty-icon">
                <IconFolder size={22} />
              </div>
              <h3>No folders yet</h3>
              <p>Create a workspace or import a project folder to populate the local library.</p>
            </div>
          ) : (
            <div className="drive-folder-grid">
              {workspaceGroups.map((workspace) => (
                <article key={workspace.id} className="drive-folder-tile">
                  <div className="drive-folder-tile-head">
                    <div className="drive-folder-tile-title">
                      <span className="drive-folder-glyph">
                        <IconFolder size={18} />
                      </span>
                      <div>
                        <strong>{workspace.label}</strong>
                        <span>
                          {workspace.chats.length} chat{workspace.chats.length !== 1 ? 's' : ''}
                          {' / '}
                          updated {formatLibraryAge(workspace.updatedAt)}
                        </span>
                      </div>
                    </div>

                    {workspace.id !== 'project:general' && (
                      <button
                        type="button"
                        className="drive-ghost-icon"
                        onClick={() => onDeleteWorkspace({ id: workspace.id, label: workspace.label })}
                        title="Delete folder"
                      >
                        <IconTrash2 size={13} />
                      </button>
                    )}
                  </div>

                  <div className="drive-folder-tile-actions">
                    <button
                      type="button"
                      className="drive-inline-btn primary"
                      onClick={() => onCreateChatInFolder({ id: workspace.id, label: workspace.label })}
                    >
                      <IconCode2 size={14} />
                      <span>New code thread</span>
                    </button>
                    {workspace.chats[0] && (
                      <button
                        type="button"
                        className="drive-inline-btn"
                        onClick={() => onOpenChat(workspace.chats[0])}
                      >
                        Open latest
                      </button>
                    )}
                  </div>

                  <div className="drive-chat-preview-list">
                    {workspace.chats.length ? (
                      workspace.chats.slice(0, 4).map((chat) => (
                        <div key={chat.id} className="drive-chat-preview-row">
                          <button
                            type="button"
                            className="drive-chat-preview-open"
                            onClick={() => onOpenChat(chat)}
                          >
                            <span className="drive-chat-preview-title">{chat.title || 'Untitled'}</span>
                            <span className="drive-chat-preview-meta">
                              {resolveThreadLabel(chat)}
                              {' / '}
                              {formatLibraryAge(chat.updatedAt)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="drive-ghost-icon"
                            onClick={() => onDeleteChat(chat.id)}
                            title="Delete chat"
                          >
                            <IconTrash2 size={12} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="drive-chat-preview-empty">
                        This folder is ready for its first project thread.
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  if (!definition) return null;

  const PageIcon = definition.icon;
  const isChatLaunchTransition = page === 'chat' && Boolean(chatLaunchTransition);

  if (isChatLaunchTransition && chatLaunchTransition) {
    return (
      <div className={`route-starter route-starter-${page} route-starter-chat-launch${embedded ? ' route-starter-embedded' : ''}`}>
        <section className="chat-launch-shell">
          <div className="chat-launch-visual" aria-hidden="true">
            <div className="chat-launch-loader">
              <span className="chat-launch-loader-ring ring-outer" />
              <span className="chat-launch-loader-ring ring-mid" />
              <span className="chat-launch-loader-ring ring-inner" />
              <span className="chat-launch-loader-core" />
              <span className="chat-launch-loader-pulse pulse-one" />
              <span className="chat-launch-loader-pulse pulse-two" />
              <span className="chat-launch-loader-scan scan-one" />
              <span className="chat-launch-loader-scan scan-two" />
            </div>
          </div>

          <div className="chat-launch-copy">
            <span className="launch-kicker">Launching Chat</span>
            <h1>Generating your first reply.</h1>
            <p>The new thread is being opened in the background. Once the first response lands, the conversation will slide into place.</p>

            <div className="chat-launch-status-card">
              <span className="chat-launch-status-label">Submitted prompt</span>
              <strong>{chatLaunchTransition.prompt}</strong>
              <span className="chat-launch-status-line">
                <span className="chat-launch-status-dot" />
                <span>{chatLaunchTransition.statusText}</span>
              </span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (page === 'chat') {
    return (
      <div className={`route-starter route-starter-${page}${embedded ? ' route-starter-embedded' : ''}`}>
        <section className="chat-starter-shell">
          <div className="chat-starter-head">
            <span className="launch-kicker">{definition.kicker}</span>
            <h1>{definition.title}</h1>
            <p>{definition.description}</p>
          </div>

          <section className="chat-starter-surface">
            <label className="chat-starter-editor">
              <span className="launch-control-label">{definition.promptLabel}</span>
              <textarea
                className="chat-starter-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    handleStartChat();
                  }
                }}
                placeholder={definition.placeholder}
                rows={7}
              />
            </label>

            <div className="chat-starter-rail">
              <div className="chat-starter-rail-group">
                <div className={`model-picker chat-starter-picker${presetPickerOpen ? ' open' : ''}`} ref={presetPickerRef}>
                  <button
                    type="button"
                    className="chat-starter-picker-trigger"
                    onClick={() => setPresetPickerOpen((current) => !current)}
                    aria-haspopup="listbox"
                    aria-expanded={presetPickerOpen}
                  >
                    <span className="chat-starter-picker-copy">
                      <span className="chat-starter-picker-label">Mode</span>
                      <span className="chat-starter-picker-value">
                        <strong>{selectedChatPresetMeta?.label ?? 'Chatbot'}</strong>
                      </span>
                    </span>
                    <span className="model-picker-trigger-icon chat-starter-picker-icon">
                      <IconChevronDown size={16} />
                    </span>
                  </button>

                  {presetPickerOpen && CHAT_START_PRESETS.length > 0 && (
                    <div className="model-picker-popover composer-picker-popover composer-picker-popover-upward chat-starter-picker-popover" role="listbox" aria-label="Chat presets">
                      <div className="model-picker-popover-head">
                        <span className="model-picker-popover-kicker">Preset</span>
                        <strong>Choose the response mode</strong>
                      </div>

                      <div className="model-picker-option-list">
                        {CHAT_START_PRESETS.map((preset) => {
                          const isSelected = preset.id === selectedChatPresetMeta?.id;
                          const description = describeChatPreset(preset.id);
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`model-picker-option${isSelected ? ' active' : ''}`}
                              onClick={() => {
                                setSelectedChatPreset(preset.id);
                                setPresetPickerOpen(false);
                              }}
                              role="option"
                              aria-selected={isSelected}
                            >
                              <span className="model-picker-option-copy">
                                <strong>{preset.label}</strong>
                                <span>{description}</span>
                              </span>
                              <span className="model-picker-option-mark">
                                {isSelected && <IconCheck size={14} />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className={`model-picker chat-starter-picker${modelPickerOpen ? ' open' : ''}`} ref={modelPickerRef}>
                  <button
                    type="button"
                    className="chat-starter-picker-trigger"
                    onClick={() => setModelPickerOpen((current) => !current)}
                    aria-haspopup="listbox"
                    aria-expanded={modelPickerOpen}
                    disabled={!models.length}
                  >
                    <span className="chat-starter-picker-copy">
                      <span className="chat-starter-picker-label">Model</span>
                      <span className="chat-starter-picker-value">
                        <strong>{selectedChatModelLabel}</strong>
                      </span>
                    </span>
                    <span className="model-picker-trigger-icon chat-starter-picker-icon">
                      <IconChevronDown size={16} />
                    </span>
                  </button>

                  {modelPickerOpen && models.length > 0 && (
                    <div className="model-picker-popover composer-picker-popover composer-picker-popover-upward chat-starter-picker-popover" role="listbox" aria-label="Hosted models">
                      <div className="model-picker-popover-head">
                        <span className="model-picker-popover-kicker">Model</span>
                        <strong>Choose the active model</strong>
                      </div>

                      <div className="model-picker-option-list">
                        {models.map((model) => {
                          const isSelected = model === resolvedChatModel;
                          return (
                            <button
                              key={model}
                              type="button"
                              className={`model-picker-option${isSelected ? ' active' : ''}`}
                              onClick={() => {
                                setSelectedChatModel(model);
                                setModelPickerOpen(false);
                              }}
                              role="option"
                              aria-selected={isSelected}
                            >
                              <span className="model-picker-option-copy">
                                <strong>{getModelDisplayName(model)}</strong>
                                <span>{isSelected ? `Selected for this chat launch / ${getModelProviderLabel(model)}` : `Available from ${getModelProviderLabel(model)}`}</span>
                              </span>
                              <span className="model-picker-option-mark">
                                {isSelected && <IconCheck size={14} />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="launch-action-btn primary chat-send-action chat-starter-send"
                disabled={!canLaunch}
                onClick={handleStartChat}
              >
                <span className="chat-send-action-icon-shell">
                  <span className="chat-send-action-icon-float">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      aria-hidden="true"
                    >
                      <path fill="none" d="M0 0h24v24H0z" />
                      <path
                        fill="currentColor"
                        d="M1.946 9.315c-.522-.174-.527-.455.01-.634l19.087-6.362c.529-.176.832.12.684.638l-5.454 19.086c-.15.529-.455.547-.679.045L12 14l6-8-8 6-8.054-2.685z"
                      />
                    </svg>
                  </span>
                </span>
                <span className="chat-send-action-label">{definition.launchLabel}</span>
              </button>
            </div>
          </section>
        </section>
      </div>
    );
  }

  if (false && page === 'chat') {
    return (
      <div className={`route-starter route-starter-${page}${embedded ? ' route-starter-embedded' : ''}`}>
        <section className="route-starter-chat-shell">
          <div className="route-starter-chat-intro">
            <div className="route-starter-chat-copy">
              <span className="launch-kicker">{definition.kicker}</span>
              <h1>{definition.title}</h1>
              <p>{definition.description}</p>
            </div>
          </div>

          <section className="route-starter-panel route-starter-panel-chat">
            <div className="route-starter-chat-composer">
              <label className="starter-prompt-field starter-prompt-field-chat">
                <span className="launch-control-label">{definition.promptLabel}</span>
                <textarea
                  className="launch-textarea launch-textarea-chat"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      handleStartChat();
                    }
                  }}
                  placeholder={definition.placeholder}
                  rows={7}
                />
              </label>

            <div className="route-starter-chat-dock">
              <div className="route-starter-chat-dock-group">
                <div className={`model-picker route-starter-chat-picker route-starter-chat-dock-picker${presetPickerOpen ? ' open' : ''}`} ref={presetPickerRef}>
                  <button
                    type="button"
                    className="model-picker-trigger route-starter-chat-dock-trigger"
                    onClick={() => setPresetPickerOpen((current) => !current)}
                    aria-haspopup="listbox"
                    aria-expanded={presetPickerOpen}
                  >
                    <span className="route-starter-chat-dock-copy">
                      <span className="route-starter-chat-dock-prefix">Mode</span>
                      <strong>{selectedChatPresetMeta?.label ?? 'Chatbot'}</strong>
                    </span>
                    <span className="model-picker-trigger-icon">
                      <IconChevronDown size={16} />
                    </span>
                  </button>

                  {presetPickerOpen && CHAT_START_PRESETS.length > 0 && (
                    <div className="model-picker-popover composer-picker-popover composer-picker-popover-upward route-starter-chat-dock-popover" role="listbox" aria-label="Chat presets">
                      <div className="model-picker-popover-head">
                        <span className="model-picker-popover-kicker">Preset</span>
                        <strong>Choose the response mode</strong>
                      </div>

                      <div className="model-picker-option-list">
                        {CHAT_START_PRESETS.map((preset) => {
                          const isSelected = preset.id === selectedChatPresetMeta?.id;
                          const description = describeChatPreset(preset.id);
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`model-picker-option${isSelected ? ' active' : ''}`}
                              onClick={() => {
                                setSelectedChatPreset(preset.id);
                                setPresetPickerOpen(false);
                              }}
                              role="option"
                              aria-selected={isSelected}
                            >
                              <span className="model-picker-option-copy">
                                <strong>{preset.label}</strong>
                                <span>{description}</span>
                              </span>
                              <span className="model-picker-option-mark">
                                {isSelected && <IconCheck size={14} />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className={`model-picker route-starter-chat-picker route-starter-chat-dock-picker${modelPickerOpen ? ' open' : ''}`} ref={modelPickerRef}>
                  <button
                    type="button"
                    className="model-picker-trigger route-starter-chat-dock-trigger"
                    onClick={() => setModelPickerOpen((current) => !current)}
                    aria-haspopup="listbox"
                    aria-expanded={modelPickerOpen}
                    disabled={!models.length}
                  >
                    <span className="route-starter-chat-dock-copy">
                      <span className="route-starter-chat-dock-prefix">Model</span>
                      <strong>{selectedChatModelLabel}</strong>
                    </span>
                    <span className="model-picker-trigger-icon">
                      <IconChevronDown size={16} />
                    </span>
                  </button>

                  {modelPickerOpen && models.length > 0 && (
                    <div className="model-picker-popover composer-picker-popover composer-picker-popover-upward route-starter-chat-dock-popover" role="listbox" aria-label="Hosted models">
                      <div className="model-picker-popover-head">
                        <span className="model-picker-popover-kicker">Model</span>
                        <strong>Choose the active model</strong>
                      </div>

                      <div className="model-picker-option-list">
                        {models.map((model) => {
                          const isSelected = model === resolvedChatModel;
                          return (
                            <button
                              key={model}
                              type="button"
                              className={`model-picker-option${isSelected ? ' active' : ''}`}
                              onClick={() => {
                                setSelectedChatModel(model);
                                setModelPickerOpen(false);
                              }}
                              role="option"
                              aria-selected={isSelected}
                            >
                              <span className="model-picker-option-copy">
                                <strong>{getModelDisplayName(model)}</strong>
                                <span>{isSelected ? `Selected for this chat launch · ${getModelProviderLabel(model)}` : `Available from ${getModelProviderLabel(model)}`}</span>
                              </span>
                              <span className="model-picker-option-mark">
                                {isSelected && <IconCheck size={14} />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="launch-action-btn primary chat-send-action route-starter-chat-dock-action"
                disabled={!canLaunch}
                onClick={handleStartChat}
              >
                <span className="chat-send-action-icon-shell">
                  <span className="chat-send-action-icon-float">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      aria-hidden="true"
                    >
                      <path fill="none" d="M0 0h24v24H0z" />
                      <path
                        fill="currentColor"
                        d="M1.946 9.315c-.522-.174-.527-.455.01-.634l19.087-6.362c.529-.176.832.12.684.638l-5.454 19.086c-.15.529-.455.547-.679.045L12 14l6-8-8 6-8.054-2.685z"
                      />
                    </svg>
                  </span>
                </span>
                <span className="chat-send-action-label">{definition.launchLabel}</span>
              </button>
            </div>
            </div>
          </section>
        </section>
      </div>
    );
  }

  return (
    <div className={`route-starter route-starter-${page}${embedded ? ' route-starter-embedded' : ''}`}>
      <section className="route-starter-hero">
        <div className="route-starter-copy">
          <span className="launch-kicker">{definition.kicker}</span>
          <h1>{definition.title}</h1>
          <p>{definition.description}</p>
        </div>
        {page !== 'chat' && (
          <div className="route-starter-meta">
            <span className="route-starter-meta-label">Default model</span>
            <strong>{selectedModelLabel}</strong>
          </div>
        )}
      </section>

      <section className="route-starter-panel">

        {definition.requiresWorkspace && (
          <div className="route-starter-section">
            <div className="route-starter-section-head">
              <span className="launch-control-label">{definition.workspaceLabel}</span>
              <p>{definition.workspaceHint}</p>
            </div>

            {workspaceOptions.length ? (
              <div className="route-starter-workspace-row">
                <select
                  className="starter-workspace-select"
                  value={selectedWorkspaceId}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                >
                  {workspaceOptions.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="launch-action-btn"
                  onClick={() => onOpenWorkspaceLauncher('create')}
                >
                  <IconFolderPlus size={15} />
                  <span>New workspace</span>
                </button>
                <button
                  type="button"
                  className="launch-action-btn"
                  onClick={() => onOpenWorkspaceLauncher('import')}
                >
                  <IconUpload size={15} />
                  <span>Import folder</span>
                </button>
              </div>
            ) : (
              <div className="route-starter-empty">
                <strong>{definition.emptyWorkspaceTitle}</strong>
                <p>{definition.emptyWorkspaceHint}</p>
                <div className="launch-inline-actions">
                  <button
                    type="button"
                    className="launch-action-btn"
                    onClick={() => onOpenWorkspaceLauncher('create')}
                  >
                    <IconFolderPlus size={15} />
                    <span>New workspace</span>
                  </button>
                  <button
                    type="button"
                    className="launch-action-btn"
                    onClick={() => onOpenWorkspaceLauncher('import')}
                  >
                    <IconUpload size={15} />
                    <span>Import folder</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <label className="starter-prompt-field">
          <span className="launch-control-label">{definition.promptLabel}</span>
          <textarea
            className="launch-textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                handleStartChat();
              }
            }}
            placeholder={definition.placeholder}
            rows={definition.requiresWorkspace ? 9 : 8}
          />
        </label>

        <div className="launch-controls">
          <div className={`launch-inline-actions${page === 'chat' ? ' chat-start-actions' : ''}`}>
            <button
              type="button"
              className={`launch-action-btn primary${page === 'chat' ? ' chat-send-action' : ''}`}
              disabled={!canLaunch}
              onClick={handleStartChat}
            >
              {page === 'chat' ? (
                <>
                  <span className="chat-send-action-icon-shell">
                    <span className="chat-send-action-icon-float">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        aria-hidden="true"
                      >
                        <path fill="none" d="M0 0h24v24H0z" />
                        <path
                          fill="currentColor"
                          d="M1.946 9.315c-.522-.174-.527-.455.01-.634l19.087-6.362c.529-.176.832.12.684.638l-5.454 19.086c-.15.529-.455.547-.679.045L12 14l6-8-8 6-8.054-2.685z"
                        />
                      </svg>
                    </span>
                  </span>
                  <span className="chat-send-action-label">{definition.launchLabel}</span>
                </>
              ) : (
                <>
                  <PageIcon size={15} />
                  <span>{definition.launchLabel}</span>
                </>
              )}
            </button>

            {page === 'chat' && (
              <div className={`model-picker${presetPickerOpen ? ' open' : ''}`} ref={presetPickerRef}>
                <button
                  type="button"
                  className="model-picker-trigger"
                  onClick={() => setPresetPickerOpen((current) => !current)}
                  aria-haspopup="listbox"
                  aria-expanded={presetPickerOpen}
                >
                  <span className="model-picker-trigger-copy">
                    <span className="model-picker-trigger-label">Chat preset</span>
                    <strong>{selectedChatPresetMeta?.label ?? 'Chatbot'}</strong>
                  </span>
                  <span className="model-picker-trigger-icon">
                    <IconChevronDown size={16} />
                  </span>
                </button>

                {presetPickerOpen && CHAT_START_PRESETS.length > 0 && (
                  <div className="model-picker-popover" role="listbox" aria-label="Chat presets">
                    <div className="model-picker-popover-head">
                      <span className="model-picker-popover-kicker">Preset</span>
                      <strong>Choose the response mode</strong>
                    </div>

                    <div className="model-picker-option-list">
                      {CHAT_START_PRESETS.map((preset) => {
                        const isSelected = preset.id === selectedChatPresetMeta?.id;
                        const description = preset.id === 'deep-research'
                          ? 'Broader live retrieval and longer, denser multi-paragraph answers.'
                          : preset.id === 'auto-chat'
                            ? 'Detects conversation, note-taking, or deep research automatically.'
                          : preset.id === 'note-taking'
                            ? 'Organizes content into structured notes, key points, and action items.'
                          : preset.id === 'creative'
                            ? 'Open-ended, more imaginative responses.'
                            : 'Balanced everyday chat responses.';
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={`model-picker-option${isSelected ? ' active' : ''}`}
                            onClick={() => {
                              setSelectedChatPreset(preset.id);
                              setPresetPickerOpen(false);
                            }}
                            role="option"
                            aria-selected={isSelected}
                          >
                            <span className="model-picker-option-copy">
                              <strong>{preset.label}</strong>
                              <span>{description}</span>
                            </span>
                            <span className="model-picker-option-mark">
                              {isSelected && <IconCheck size={14} />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {page === 'chat' && (
              <div className={`model-picker${modelPickerOpen ? ' open' : ''}`} ref={modelPickerRef}>
                <button
                  type="button"
                  className="model-picker-trigger"
                  onClick={() => setModelPickerOpen((current) => !current)}
                  aria-haspopup="listbox"
                  aria-expanded={modelPickerOpen}
                  disabled={!models.length}
                >
                  <span className="model-picker-trigger-copy">
                    <span className="model-picker-trigger-label">LLM Model</span>
                    <strong>{selectedChatModelLabel}</strong>
                  </span>
                  <span className="model-picker-trigger-icon">
                    <IconChevronDown size={16} />
                  </span>
                </button>

                {modelPickerOpen && models.length > 0 && (
                  <div className="model-picker-popover" role="listbox" aria-label="Hosted models">
                    <div className="model-picker-popover-head">
                      <span className="model-picker-popover-kicker">LLM Model</span>
                      <strong>What suits you best?</strong>
                    </div>

                    <div className="model-picker-option-list">
                      {models.map((model) => {
                        const isSelected = model === resolvedChatModel;
                        return (
                          <button
                            key={model}
                            type="button"
                            className={`model-picker-option${isSelected ? ' active' : ''}`}
                            onClick={() => {
                              setSelectedChatModel(model);
                              setModelPickerOpen(false);
                            }}
                            role="option"
                            aria-selected={isSelected}
                          >
                            <span className="model-picker-option-copy">
                              <strong>{getModelDisplayName(model)}</strong>
                              <span>{isSelected ? `Selected for this chat launch · ${getModelProviderLabel(model)}` : `Available from ${getModelProviderLabel(model)}`}</span>
                            </span>
                            <span className="model-picker-option-mark">
                              {isSelected && <IconCheck size={14} />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
