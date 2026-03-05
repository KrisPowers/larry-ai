import React, { useState } from 'react';
import type { FileRegistry } from '../lib/fileRegistry';
import { downloadRegistryAsZip } from '../lib/zip';
import { useToast } from '../hooks/useToast';

interface Props {
  registry: FileRegistry;
  chatTitle: string;
}

// Build a simple tree structure from flat paths
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const path of paths.sort()) {
    const parts = path.split('/');
    let level = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isDir = i < parts.length - 1;
      let node = level.find(n => n.name === name);

      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join('/'), isDir, children: [] };
        level.push(node);
      }
      level = node.children;
    }
  }

  return root;
}

function TreeItem({ node, registry, depth }: { node: TreeNode; registry: FileRegistry; depth: number }) {
  const [open, setOpen] = useState(true);
  const entry = registry.get(node.path);

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    if (!entry) return;
    const blob = new Blob([entry.content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = node.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (node.isDir) {
    return (
      <div>
        <div
          className="registry-tree-dir"
          style={{ paddingLeft: depth * 12 + 6 }}
          onClick={() => setOpen(o => !o)}
        >
          <span className="registry-tree-arrow">{open ? '▾' : '▸'}</span>
          <span className="registry-tree-icon">📁</span>
          <span className="registry-tree-name">{node.name}</span>
        </div>
        {open && node.children.map(child => (
          <TreeItem key={child.path} node={child} registry={registry} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div className="registry-tree-file" style={{ paddingLeft: depth * 12 + 6 }}>
      <span className="registry-tree-icon">📄</span>
      <span className="registry-tree-name">{node.name}</span>
      <button className="registry-file-dl" onClick={handleDownload} title={`Download ${node.name}`}>↓</button>
    </div>
  );
}

export function FileRegistryPanel({ registry, chatTitle }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const paths = [...registry.keys()];
  const tree = buildTree(paths);

  function handleZipDownload() {
    if (registry.size === 0) return;
    const zipName = `${chatTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'project'}.zip`;
    downloadRegistryAsZip(registry, zipName);
    toast(`Downloading ${zipName} (${registry.size} file${registry.size !== 1 ? 's' : ''})`);
  }

  if (registry.size === 0) return null;

  return (
    <div className={`registry-panel${open ? ' open' : ''}`}>
      <div className="registry-header" onClick={() => setOpen(o => !o)}>
        <span className="registry-header-title">Project Files</span>
        <span className="registry-file-count">{registry.size} file{registry.size !== 1 ? 's' : ''}</span>
        <button
          className="registry-zip-btn"
          onClick={e => { e.stopPropagation(); handleZipDownload(); }}
          title="Download all as .zip"
        >
          ZIP
        </button>
        <span className="registry-chevron">{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div className="registry-tree">
          {tree.map(node => (
            <TreeItem key={node.path} node={node} registry={registry} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
