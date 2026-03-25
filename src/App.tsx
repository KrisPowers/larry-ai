import { useState, useCallback, useEffect } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';
import { useOllama } from './hooks/useOllama';
import { useDB } from './hooks/useDB';
import { useToast } from './hooks/useToast';
import { createRegistry, updateRegistry } from './lib/fileRegistry';
import { DEFAULT_PRESET_ID } from './lib/presets';
import { IconHexagon } from './components/Icon';
import type { Panel, ChatRecord, ProjectFolder } from './types';
import type { FileRegistry } from './lib/fileRegistry';

const FOLDERS_STORAGE_KEY = 'larry_project_folders_v1';

function normaliseProjectId(label: string): string {
  return `project:${label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-')}`;
}

function restoreRegistry(chatData?: Partial<ChatRecord>): FileRegistry {
  const reg = createRegistry();
  if (!chatData?.fileEntries?.length) return reg;
  return updateRegistry(reg, chatData.fileEntries, 0);
}

function newPanel(index: number, models: string[], chatData?: Partial<ChatRecord>): Panel {
  return {
    id: chatData?.id ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: chatData?.title ?? `Chat ${index + 1}`,
    model: chatData?.model ?? models[0] ?? '',
    preset: chatData?.preset ?? DEFAULT_PRESET_ID,
    projectId: chatData?.projectId,
    projectLabel: chatData?.projectLabel,
    messages: chatData?.messages ?? [],
    streaming: false,
    streamingContent: '',
    fileRegistry: restoreRegistry(chatData),
    prevRegistry: new Map(),
    streamingPhase: null,
  };
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

function parseChatLog(md: string, filename: string): ChatRecord | null {
  try {
    const lines = md.split('\n');
    const title = lines[0]?.replace(/^#\s*Chat Log\s*[—–-]\s*/, '').trim() || filename.replace(/\.md$/, '');

    const modelLine = lines.find(l => l.startsWith('**Model:**'));
    const presetLine = lines.find(l => l.startsWith('**Preset:**'));
    const projectLine = lines.find(l => l.startsWith('**Project:**'));
    const model = modelLine ? modelLine.replace(/\*\*Model:\*\*\s*/, '').trim() : '';
    const preset = presetLine ? presetLine.replace(/\*\*Preset:\*\*\s*/, '').trim() : DEFAULT_PRESET_ID;
    const projectLabel = projectLine ? projectLine.replace(/\*\*Project:\*\*\s*/, '').trim() : '';
    const projectId = projectLabel ? normaliseProjectId(projectLabel) : undefined;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const sections = md.split(/\n---\n/);
    for (const section of sections) {
      const s = section.trim();
      if (s.startsWith('### You')) {
        const content = s.replace(/^###\s+You\s*\n/, '').trim();
        if (content) messages.push({ role: 'user', content });
      } else if (s.startsWith('### Assistant')) {
        const content = s.replace(/^###\s+Assistant\s*\n/, '').trim();
        if (content) messages.push({ role: 'assistant', content });
      }
    }
    if (!messages.length) return null;

    return {
      id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      model,
      preset,
      projectId,
      projectLabel: projectLabel || undefined,
      messages,
      updatedAt: Date.now(),
      fileEntries: [],
    };
  } catch {
    return null;
  }
}

export default function App() {
  const { models, status } = useOllama();
  const { chats, save, remove, clearAll } = useDB();
  const { toast } = useToast();
  const [panels, setPanels] = useState<Panel[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setView] = useState<'chats' | 'settings'>('chats');
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOLDERS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ProjectFolder[];
      if (Array.isArray(parsed)) setProjectFolders(parsed);
    } catch {
      // ignore malformed local cache
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(projectFolders));
  }, [projectFolders]);

  const createPanel = useCallback((chatData?: Partial<ChatRecord>) => {
    setPanels(prev => {
      if (prev.length >= 3) {
        toast('Max 3 panels open at once.');
        return prev;
      }
      const nextPanel = newPanel(prev.length, models, chatData);
      setActivePanelId(nextPanel.id);
      return [...prev, nextPanel];
    });
  }, [models, toast]);

  const ensureProjectFolder = useCallback((id: string, label: string) => {
    setProjectFolders(prev => {
      if (prev.some(f => f.id === id)) return prev;
      return [...prev, { id, label, createdAt: Date.now() }];
    });
  }, []);

  const handleCreateFolder = useCallback(() => {
    const label = window.prompt('New project folder name');
    if (!label) return;
    const clean = label.trim();
    if (!clean) return;
    const id = normaliseProjectId(clean);
    ensureProjectFolder(id, clean);
    toast(`Created project folder "${clean}".`);
  }, [ensureProjectFolder, toast]);

  const handleCreateChatInFolder = useCallback((folder: { id: string; label: string }) => {
    ensureProjectFolder(folder.id, folder.label);
    createPanel({
      title: `${folder.label} Chat`,
      model: models[0] ?? '',
      preset: DEFAULT_PRESET_ID,
      projectId: folder.id,
      projectLabel: folder.label,
      messages: [],
      fileEntries: [],
      updatedAt: Date.now(),
    });
  }, [createPanel, ensureProjectFolder, models]);

  const closePanel = useCallback((id: string) => {
    setPanels(prev => {
      const next = prev.filter(p => p.id !== id);
      if (activePanelId === id) {
        setActivePanelId(next[0]?.id ?? null);
      }
      return next;
    });
  }, [activePanelId]);

  const activatePanel = useCallback((id: string) => {
    setActivePanelId(id);
  }, []);

  const updatePanel = useCallback((id: string, patch: Partial<Panel>) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  const savePanel = useCallback((panel: Panel) => {
    if (panel.projectId && panel.projectLabel) {
      ensureProjectFolder(panel.projectId, panel.projectLabel);
    }
    const fileEntries = [...panel.fileRegistry.values()];
    save({
      id: panel.id,
      title: panel.title,
      model: panel.model,
      preset: panel.preset,
      projectId: panel.projectId,
      projectLabel: panel.projectLabel,
      messages: panel.messages,
      updatedAt: Date.now(),
      fileEntries,
    });
  }, [save, ensureProjectFolder]);

  function handleOpenFromHistory(chat: ChatRecord) {
    const existing = panels.find(p => p.id === chat.id);
    if (!existing) {
      createPanel(chat);
    } else {
      setActivePanelId(existing.id);
    }
  }

  function handleImportChat(chat: ChatRecord) {
    if (chat.projectId && chat.projectLabel) {
      ensureProjectFolder(chat.projectId, chat.projectLabel);
    }
    save({
      id: chat.id,
      title: chat.title,
      model: chat.model,
      preset: chat.preset,
      projectId: chat.projectId,
      projectLabel: chat.projectLabel,
      messages: chat.messages,
      updatedAt: chat.updatedAt,
      fileEntries: chat.fileEntries ?? [],
    });
    handleOpenFromHistory(chat);
    toast(`Imported "${chat.title}"`);
  }

  async function handleImportLogs(files: File[]) {
    let imported = 0;
    for (const file of files) {
      const text = await file.text();
      const parsed = parseChatLog(text, file.name);
      if (!parsed) continue;
      handleImportChat(parsed);
      imported++;
    }
    if (!imported) {
      toast('No valid chat logs found in selected files.');
    }
  }

  async function handleImportDirectory(files: File[], targetFolder?: { id: string; label: string }) {
    let added = 0;
    let reg: FileRegistry = new Map();
    const active = panels.find(p => p.id === activePanelId);
    const folderPanel = targetFolder
      ? panels.find(p => p.projectId === targetFolder.id)
      : undefined;
    const targetPanel = targetFolder ? folderPanel : active;

    reg = new Map(targetPanel?.fileRegistry ?? new Map());
    let importedRoot = targetFolder?.label || targetPanel?.projectLabel || '';

    for (const file of files) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
      const parts = rel.split('/');
      if (!importedRoot && parts[0]) importedRoot = parts[0];
      const cleanPath = parts.length > 1 ? parts.slice(1).join('/') : rel;
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz|lock)$/.test(cleanPath)) continue;
      if (/node_modules|\.git|\.next|dist\/|build\//.test(cleanPath)) continue;
      const fileText = await file.text();
      if (fileText.includes('\0')) continue;
      reg = updateRegistry(reg, [{ path: cleanPath, content: fileText, lang: langFromPath(cleanPath) }], 0);
      added++;
    }

    if (!added) {
      toast('No importable source files found.');
      return;
    }

    const sysMsg = { role: 'assistant' as const, content: `_Imported ${added} file${added !== 1 ? 's' : ''} from directory into the project registry._` };
    const projectLabel = targetFolder?.label || importedRoot || targetPanel?.projectLabel || 'Project';
    const projectId = targetFolder?.id || normaliseProjectId(projectLabel);
    ensureProjectFolder(projectId, projectLabel);

    if (!targetPanel) {
      const chatData: ChatRecord = {
        id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: `${projectLabel} Workspace`,
        model: models[0] ?? '',
        preset: DEFAULT_PRESET_ID,
        projectId,
        projectLabel,
        messages: [sysMsg],
        updatedAt: Date.now(),
        fileEntries: [...reg.values()],
      };
      save(chatData);
      createPanel(chatData);
      toast(`Created project workspace for "${projectLabel}" with ${added} file${added !== 1 ? 's' : ''}.`);
      return;
    }

    setPanels(prev => prev.map(p => {
      if (p.id !== targetPanel.id) return p;
      const updated = {
        ...p,
        projectId,
        projectLabel,
        fileRegistry: reg,
        messages: [...p.messages, sysMsg],
      };
      savePanel(updated);
      return updated;
    }));
    toast(`Imported ${added} file${added !== 1 ? 's' : ''} into "${projectLabel}".`);
  }

  async function handleDeleteChat(id: string) {
    await remove(id);
    closePanel(id);
    toast('Chat deleted.');
  }

  async function handleClearAll() {
    if (!window.confirm('Delete all chat history? This cannot be undone.')) return;
    await clearAll();
    setPanels([]);
    setActivePanelId(null);
    toast('History cleared.');
  }

  const statusLabel =
    status === 'connecting' ? 'connecting...' :
    status === 'online' ? `ollama · ${models.length} model${models.length !== 1 ? 's' : ''}` :
    'ollama offline';

  return (
    <div id="app">
      <div id="app-shell">
        <Sidebar
          collapsed={sidebarCollapsed}
          view={view}
          folders={projectFolders}
          chats={chats}
          openPanelIds={panels.map(p => p.id)}
          status={status}
          statusLabel={statusLabel}
          onToggleCollapsed={() => setSidebarCollapsed(v => !v)}
          onChangeView={setView}
          onCreateFolder={handleCreateFolder}
          onCreateChatInFolder={handleCreateChatInFolder}
          onCreateChat={() => createPanel()}
          onOpenChat={handleOpenFromHistory}
          onDeleteChat={handleDeleteChat}
          onImportLogs={handleImportLogs}
          onImportDirectory={handleImportDirectory}
          onImportDirectoryToFolder={(folder, files) => {
            handleImportDirectory(files, folder);
          }}
        />

        <div id="main-content">
          {view === 'settings' ? (
            <div id="settings-view">
              <h2>Settings</h2>
              <p>This area is ready for presets, skills, and theme configuration.</p>
              <div className="settings-danger">
                <h3>Danger Zone</h3>
                <p>These actions are irreversible.</p>
                <button className="btn danger settings-danger-btn" onClick={handleClearAll}>
                  Clear All Conversation History
                </button>
              </div>
            </div>
          ) : (
            <div id="workspace">
              {panels.length === 0 ? (
                <div id="no-panels">
                  <div style={{ fontSize: 56, opacity: 0.12, color: 'var(--accent)' }}>
                    <IconHexagon size={72} />
                  </div>
                  <h2>No chats open</h2>
                  <p>Use <strong>New Chat</strong> from the sidebar to start a session.<br />Up to 3 panels side-by-side.</p>
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
                      selected={activePanelId === panel.id}
                      onActivate={activatePanel}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
