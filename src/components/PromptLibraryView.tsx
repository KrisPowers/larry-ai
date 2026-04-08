import { useEffect, useMemo, useRef, useState } from 'react';
import { buildWorkspaceGroups } from '../lib/workspaces';
import { getModelDisplayLabel, getModelDisplayName, getModelProviderLabel, resolveModelHandle } from '../lib/ollama';
import { PRESETS } from '../lib/presets';
import { attachmentsToStoredEntries, mergeImportableAttachments, readImportableAttachments, type ImportableAttachment } from '../lib/chatAttachments';
import type { ChatReasoningEffort, ChatRecord, ProjectFolder, ThreadType } from '../types';
import { ChatComposer, type ChatComposerOption } from './ChatComposer';
import {
  IconCheck,
  IconChevronDown,
  IconCode2,
  IconFolder,
  IconFolderPlus,
  IconMessageSquare,
  IconTrash2,
  IconUpload,
} from './Icon';

type PromptPage = 'landing' | 'chat' | 'code';

interface StartOptions {
  prompt: string;
  preset: string;
  title: string;
  threadType: ThreadType;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  workspace?: { id: string; label: string };
  fileEntries?: ChatRecord['fileEntries'];
}

interface Props {
  page: PromptPage;
  chats: ChatRecord[];
  folders: ProjectFolder[];
  defaultModel: string;
  defaultChatPreset: string;
  defaultReasoningEffort: ChatReasoningEffort;
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
    title: 'Start inside a workspace.',
    description: 'Each workspace now holds the project files plus the code chats that belong to that directory.',
    promptLabel: 'What should we build or inspect?',
    placeholder: 'Describe the feature, bug, repo area, constraints, files, or output you want help with...',
    launchLabel: 'Start workspace chat',
    preset: 'code',
    threadType: 'code',
    requiresWorkspace: true,
    workspaceLabel: 'Workspace',
    workspaceHint: 'Pick the project directory that should own this code chat.',
    emptyWorkspaceTitle: 'Create or import a workspace first.',
    emptyWorkspaceHint: 'A workspace acts as the project directory and groups the codebase with the chats that belong to it.',
    icon: IconCode2,
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
    description: 'Code generation, audits, and debugging in one IDE-style workspace.',
    icon: IconCode2,
  },
] as const;

const CHAT_START_PRESETS = PRESETS.filter((preset) => preset.id !== 'code');
const CODE_START_PRESET: ChatComposerOption = {
  value: 'code',
  label: 'Code Workspace',
  description: 'Generation, debugging, and auditing currently share the same code-focused preset.',
};
const CHAT_STARTER_PLACEHOLDER = "Ask anything... paste a URL and it'll be fetched automatically. Shift+Enter for newline.";
const REASONING_EFFORT_OPTIONS: Array<{ value: ChatReasoningEffort; label: string }> = [
  { value: 'light', label: 'Low' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High' },
  { value: 'extra-high', label: 'Extra High' },
];
const REASONING_EFFORT_CONFIG: Record<ChatReasoningEffort, { label: string; fetchDepth: 'standard' | 'deep'; maxSources: number; minLiveSources: number }> = {
  light: { label: 'Low', fetchDepth: 'standard', maxSources: 10, minLiveSources: 4 },
  balanced: { label: 'Balanced', fetchDepth: 'standard', maxSources: 12, minLiveSources: 5 },
  high: { label: 'High', fetchDepth: 'deep', maxSources: 14, minLiveSources: 6 },
  'extra-high': { label: 'Extra High', fetchDepth: 'deep', maxSources: 15, minLiveSources: 8 },
};

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
  defaultChatPreset,
  defaultReasoningEffort,
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
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [reasoningPickerOpen, setReasoningPickerOpen] = useState(false);
  const [selectedChatModel, setSelectedChatModel] = useState(defaultModel || models[0] || '');
  const [selectedChatPreset, setSelectedChatPreset] = useState(defaultChatPreset);
  const [selectedChatReasoningEffort, setSelectedChatReasoningEffort] = useState<ChatReasoningEffort>(defaultReasoningEffort);
  const [attachedChatFiles, setAttachedChatFiles] = useState<ImportableAttachment[]>([]);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const presetPickerRef = useRef<HTMLDivElement>(null);
  const reasoningPickerRef = useRef<HTMLDivElement>(null);

  const showLibrary = page === 'landing';
  const currentPage = page;
  const isCodeStarter = page === 'code';
  const usesAdvancedComposer = page === 'chat' || page === 'code';
  const definition = PAGE_DEFINITIONS[showLibrary ? 'chat' : page];
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

  useEffect(() => {
    setSelectedChatModel(defaultModel || models[0] || '');
  }, [defaultModel, models]);

  useEffect(() => {
    setSelectedChatPreset(defaultChatPreset);
  }, [defaultChatPreset]);

  useEffect(() => {
    setSelectedChatReasoningEffort(defaultReasoningEffort);
  }, [defaultReasoningEffort]);

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
  const composerReasoningOptions = REASONING_EFFORT_OPTIONS.map<ChatComposerOption>((option) => {
    const optionConfig = REASONING_EFFORT_CONFIG[option.value];
    return {
      value: option.value,
      label: option.label,
      description: `Targets ${optionConfig.maxSources} live sources with a ${optionConfig.fetchDepth === 'deep' ? 'deep' : 'standard'} comparison pass; requires at least ${optionConfig.minLiveSources} verified source${optionConfig.minLiveSources === 1 ? '' : 's'}.`,
    };
  });
  const composerPresetOptions = CHAT_START_PRESETS.map<ChatComposerOption>((preset) => ({
    value: preset.id,
    label: preset.label,
    description: describeChatPreset(preset.id),
  }));

  useEffect(() => {
    if (!usesAdvancedComposer) return;
    if (selectedChatModel && models.includes(selectedChatModel)) return;
    setSelectedChatModel(defaultModel || models[0] || '');
  }, [defaultModel, models, selectedChatModel, usesAdvancedComposer]);

  useEffect(() => {
    if (page !== 'chat') return;
    if (selectedChatPreset && CHAT_START_PRESETS.some((preset) => preset.id === selectedChatPreset)) return;
    setSelectedChatPreset(CHAT_START_PRESETS[0]?.id ?? 'auto-chat');
  }, [page, selectedChatPreset]);

  useEffect(() => {
    if (!modelPickerOpen && !presetPickerOpen && !reasoningPickerOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
      if (!presetPickerRef.current?.contains(event.target as Node)) {
        setPresetPickerOpen(false);
      }
      if (!reasoningPickerRef.current?.contains(event.target as Node)) {
        setReasoningPickerOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPickerOpen(false);
        setPresetPickerOpen(false);
        setReasoningPickerOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelPickerOpen, presetPickerOpen, reasoningPickerOpen]);

  async function handleChatUploads(files: File[]) {
    const imported = await readImportableAttachments(files);
    if (!imported.length) return;
    setAttachedChatFiles((current) => mergeImportableAttachments(current, imported));
  }

  const handleStartChat = () => {
    if (!definition) return;

    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    if (definition.requiresWorkspace && !selectedWorkspace) return;

    const title = definition.requiresWorkspace && selectedWorkspace
      ? `${selectedWorkspace.label} Chat`
      : isCodeStarter
        ? 'New Code Chat'
        : selectedChatPreset === 'deep-research'
        ? 'New Deep Research Chat'
        : 'New Chat';

    const started = onStartChat({
      prompt: cleanPrompt,
      preset: isCodeStarter ? 'code' : page === 'chat' ? selectedChatPreset : definition.preset,
      title,
      threadType: isCodeStarter ? 'code' : definition.threadType,
      model: usesAdvancedComposer ? resolvedChatModel : undefined,
      reasoningEffort: page === 'chat' ? selectedChatReasoningEffort : undefined,
      workspace: definition.requiresWorkspace ? selectedWorkspace : undefined,
      fileEntries: usesAdvancedComposer ? attachmentsToStoredEntries(attachedChatFiles) : undefined,
    });

    if (started) {
      setPrompt('');
      setAttachedChatFiles([]);
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
              Chat stays lightweight. Code now absorbs debugging and auditing so implementation work keeps one focused surface instead of splitting across routes.
            </p>
            <div className="landing-route-grid" role="navigation" aria-label="Start routes">
              {ROUTE_LAUNCHERS.map((route) => {
                const RouteIcon = route.icon;
                const handler = route.id === 'chat'
                  ? onGoToChat
                  : onGoToCode;
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
              <strong>`/chat`, `/code`</strong>
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
        <section className="thread-zero" aria-label="New conversation composer">
          <div className="thread-zero-spacer" />

          <div className="panel-input thread-zero-chatbar">
            <ChatComposer
              value={prompt}
              onValueChange={setPrompt}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  handleStartChat();
                }
              }}
              placeholder={CHAT_STARTER_PLACEHOLDER}
              ariaLabel={CHAT_STARTER_PLACEHOLDER}
              uploadTitle="Upload files or a zip before starting this chat"
              uploadActive={attachedChatFiles.length > 0}
              onUploadFiles={handleChatUploads}
              reasoningValue={selectedChatReasoningEffort}
              reasoningOptions={composerReasoningOptions}
              onReasoningChange={(value) => setSelectedChatReasoningEffort(value as ChatReasoningEffort)}
              presetValue={selectedChatPreset}
              presetOptions={composerPresetOptions}
              onPresetChange={setSelectedChatPreset}
              modelValue={resolvedChatModel}
              modelOptions={models}
              onModelChange={setSelectedChatModel}
              onSend={handleStartChat}
              sendDisabled={!prompt.trim()}
            />
          </div>
        </section>
      </div>
    );
  }

  if (page === 'code') {
    return (
      <div className={`route-starter route-starter-${page} route-starter-code-workbench${embedded ? ' route-starter-embedded' : ''}`}>
        <section className="code-workbench-starter">
          <div className="code-workbench-starter-head">
            <span className="launch-kicker">{definition.kicker}</span>
            <h1>{definition.title}</h1>
            <p>{definition.description}</p>
          </div>

          <div className="code-workbench-starter-grid">
            <article className="code-workbench-note code-workbench-note-primary">
              <span className="code-workbench-note-label">Workspace model</span>
              <strong>Files and chats stay together</strong>
              <p>Pick a workspace first, then keep every code chat tied to that project directory and file map.</p>
            </article>

            <article className="code-workbench-note">
              <span className="code-workbench-note-label">Good launch prompts</span>
              <ul className="code-workbench-note-list">
                <li>Name the file, feature, or bug first.</li>
                <li>Call out constraints, stack, and expected output.</li>
                <li>Upload a zip or files when local context will help.</li>
              </ul>
            </article>
          </div>

          {workspaceOptions.length ? (
            <section className="route-starter-section" aria-label="Workspace selection">
              <div className="route-starter-section-head">
                <strong>{definition.workspaceLabel}</strong>
                <p>{definition.workspaceHint}</p>
              </div>

              <div className="starter-workspace-block">
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

                  <button className="btn" type="button" onClick={() => onOpenWorkspaceLauncher('create')}>
                    <IconFolderPlus size={14} />
                    <span>New workspace</span>
                  </button>

                  <button className="btn settings-secondary-btn" type="button" onClick={() => onOpenWorkspaceLauncher('import')}>
                    <IconUpload size={14} />
                    <span>Import folder</span>
                  </button>
                </div>

                {selectedWorkspace ? (
                  <article className="code-workbench-note">
                    <span className="code-workbench-note-label">Selected workspace</span>
                    <strong>{selectedWorkspace.label}</strong>
                    <p>
                      {selectedWorkspace.fileCount} file{selectedWorkspace.fileCount === 1 ? '' : 's'} in the workspace
                      {' · '}
                      {selectedWorkspace.chats.length} saved code chat{selectedWorkspace.chats.length === 1 ? '' : 's'} already tied to it.
                    </p>
                  </article>
                ) : null}
              </div>
            </section>
          ) : (
            <div className="route-starter-empty">
              <strong>{definition.emptyWorkspaceTitle}</strong>
              <p>{definition.emptyWorkspaceHint}</p>
              <div className="route-starter-workspace-row">
                <button className="btn" type="button" onClick={() => onOpenWorkspaceLauncher('create')}>
                  <IconFolderPlus size={14} />
                  <span>New workspace</span>
                </button>
                <button className="btn settings-secondary-btn" type="button" onClick={() => onOpenWorkspaceLauncher('import')}>
                  <IconUpload size={14} />
                  <span>Import folder</span>
                </button>
              </div>
            </div>
          )}

          <div className="panel-input code-workbench-composer">
            <ChatComposer
              value={prompt}
              onValueChange={setPrompt}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  handleStartChat();
                }
              }}
              placeholder={definition.placeholder}
              ariaLabel={definition.promptLabel}
              uploadTitle="Upload files or a zip before starting this workspace chat"
              uploadActive={attachedChatFiles.length > 0}
              onUploadFiles={handleChatUploads}
              reasoningValue={selectedChatReasoningEffort}
              reasoningOptions={composerReasoningOptions}
              onReasoningChange={(value) => setSelectedChatReasoningEffort(value as ChatReasoningEffort)}
              reasoningDisabled={true}
              presetValue={CODE_START_PRESET.value}
              presetOptions={[CODE_START_PRESET]}
              onPresetChange={() => undefined}
              presetDisabled={true}
              modelValue={resolvedChatModel}
              modelOptions={models}
              onModelChange={setSelectedChatModel}
              onSend={handleStartChat}
              sendDisabled={!canLaunch}
            />
          </div>
        </section>
      </div>
    );
  }

  if (false && page === 'chat') {
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
        {currentPage !== 'chat' && (
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
          <div className={`launch-inline-actions${currentPage === 'chat' ? ' chat-start-actions' : ''}`}>
            <button
              type="button"
              className={`launch-action-btn primary${currentPage === 'chat' ? ' chat-send-action' : ''}`}
              disabled={!canLaunch}
              onClick={handleStartChat}
            >
              {currentPage === 'chat' ? (
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

            {currentPage === 'chat' && (
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

            {currentPage === 'chat' && (
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
