import { useEffect, useMemo, useState } from 'react';

type MenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

interface Props {
  workspaceLabel: string;
  activePath: string | null;
  terminalOpen: boolean;
  showIndentGuides: boolean;
  canSaveFile: boolean;
  canReloadFile: boolean;
  canRevertFile: boolean;
  canOpenActivePath: boolean;
  canRunValidation: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onSaveFile: () => void;
  onReloadFile: () => void;
  onRevertFile: () => void;
  onCopyActivePath: () => void;
  onOpenActivePath: () => void;
  onRefreshWorkspace: () => void;
  onToggleTerminal: () => void;
  onToggleIndentGuides: () => void;
  onRunValidation: () => void;
}

function WorkspaceIdeMenu({
  label,
  items,
  open,
  onToggle,
}: {
  label: string;
  items: MenuItem[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="workspace-ide-menu">
      <button
        type="button"
        className={`workspace-ide-menu-trigger${open ? ' active' : ''}`}
        onClick={onToggle}
      >
        {label}
      </button>

      {open && (
        <div className="workspace-ide-menu-popover" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="workspace-ide-menu-item"
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceIdeMenubar({
  workspaceLabel,
  activePath,
  terminalOpen,
  showIndentGuides,
  canSaveFile,
  canReloadFile,
  canRevertFile,
  canOpenActivePath,
  canRunValidation,
  onNewFile,
  onNewFolder,
  onSaveFile,
  onReloadFile,
  onRevertFile,
  onCopyActivePath,
  onOpenActivePath,
  onRefreshWorkspace,
  onToggleTerminal,
  onToggleIndentGuides,
  onRunValidation,
}: Props) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    const handlePointerDown = () => setOpenMenuId(null);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const fileMenu = useMemo<MenuItem[]>(() => [
    { id: 'new-file', label: 'New File', onSelect: onNewFile },
    { id: 'new-folder', label: 'New Folder', onSelect: onNewFolder },
    { id: 'save-file', label: 'Save Current File', disabled: !canSaveFile, onSelect: onSaveFile },
    { id: 'reload-file', label: 'Reload Current File', disabled: !canReloadFile, onSelect: onReloadFile },
  ], [canReloadFile, canSaveFile, onNewFile, onNewFolder, onReloadFile, onSaveFile]);

  const editMenu = useMemo<MenuItem[]>(() => [
    { id: 'revert-file', label: 'Revert Current File', disabled: !canRevertFile, onSelect: onRevertFile },
    { id: 'copy-path', label: activePath ? `Copy ${activePath}` : 'Copy Active Path', disabled: !activePath, onSelect: onCopyActivePath },
  ], [activePath, canRevertFile, onCopyActivePath, onRevertFile]);

  const selectionMenu = useMemo<MenuItem[]>(() => [
    { id: 'open-path', label: 'Open Active Path Outside Larry', disabled: !canOpenActivePath, onSelect: onOpenActivePath },
    { id: 'refresh-workspace', label: 'Refresh Workspace', onSelect: onRefreshWorkspace },
  ], [canOpenActivePath, onOpenActivePath, onRefreshWorkspace]);

  const viewMenu = useMemo<MenuItem[]>(() => [
    { id: 'toggle-terminal', label: terminalOpen ? 'Hide Terminal' : 'Show Terminal', onSelect: onToggleTerminal },
    { id: 'toggle-guides', label: showIndentGuides ? 'Hide Indent Guides' : 'Show Indent Guides', onSelect: onToggleIndentGuides },
  ], [onToggleIndentGuides, onToggleTerminal, showIndentGuides, terminalOpen]);

  const runMenu = useMemo<MenuItem[]>(() => [
    { id: 'run-validation', label: 'Run Workspace Validation', disabled: !canRunValidation, onSelect: onRunValidation },
  ], [canRunValidation, onRunValidation]);

  const menus = [
    { id: 'file', label: 'File', items: fileMenu },
    { id: 'edit', label: 'Edit', items: editMenu },
    { id: 'selection', label: 'Selection', items: selectionMenu },
    { id: 'view', label: 'View', items: viewMenu },
    { id: 'run', label: 'Run', items: runMenu },
  ];

  return (
    <div className="workspace-ide-menubar" onPointerDown={(event) => event.stopPropagation()}>
      <div className="workspace-ide-menubar-menus">
        {menus.map((menu) => (
          <WorkspaceIdeMenu
            key={menu.id}
            label={menu.label}
            items={menu.items.map((item) => ({
              ...item,
              onSelect: () => {
                setOpenMenuId(null);
                item.onSelect();
              },
            }))}
            open={openMenuId === menu.id}
            onToggle={() => setOpenMenuId((current) => current === menu.id ? null : menu.id)}
          />
        ))}
      </div>

      <div className="workspace-ide-menubar-status">
        <span>{workspaceLabel}</span>
        {activePath ? <code>{activePath}</code> : <span>No file selected</span>}
      </div>
    </div>
  );
}
