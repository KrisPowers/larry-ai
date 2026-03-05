import React, { useState, useRef } from 'react';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { useToast } from '../hooks/useToast';

interface Props {
  block: CodeBlockType;
}

const LANG_COLORS: Record<string, string> = {
  js: 'lang-js', javascript: 'lang-js',
  ts: 'lang-js', typescript: 'lang-js',
  jsx: 'lang-js', tsx: 'lang-js',
  md: 'lang-md', markdown: 'lang-md',
  html: 'lang-html', css: 'lang-html', scss: 'lang-html',
  py: 'lang-py', python: 'lang-py',
  json: 'lang-json',
  sh: 'lang-sh', bash: 'lang-sh', shell: 'lang-sh',
};

const DEFAULT_HEIGHT = 260; // px
const MIN_HEIGHT = 60;

export function CodeBlock({ block }: Props) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [filename, setFilename] = useState(block.suggestedFilename);
  const dragStartY = useRef<number | null>(null);
  const dragStartH = useRef<number>(DEFAULT_HEIGHT);

  const langClass = LANG_COLORS[block.lang] ?? '';

  function handleCopy() {
    navigator.clipboard.writeText(block.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleDownload() {
    let name = filename.trim() || block.suggestedFilename;
    if (!name.includes('.')) name += `.${block.ext}`;
    const blob = new Blob([block.code], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Downloaded ${name}`);
  }

  // ── resize drag ─────────────────────────────────────────────────────────
  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartH.current = height;

    function onMove(ev: MouseEvent) {
      if (dragStartY.current === null) return;
      const delta = ev.clientY - dragStartY.current;
      setHeight(Math.max(MIN_HEIGHT, dragStartH.current + delta));
    }
    function onUp() {
      dragStartY.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const lineCount = block.code.split('\n').length;

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className={`code-lang-badge ${langClass}`}>{block.lang || 'text'}</span>
        {/* Collapse toggle */}
        <button
          className="code-action-btn collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? 'Show' : 'Hide'}
          <span className="line-count">{lineCount} lines</span>
        </button>
        <div className="code-block-actions">
          <input
            className="code-filename-input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            spellCheck={false}
            title="Filename for download"
          />
          <button className="code-action-btn download" onClick={handleDownload}>Download</button>
          <button
            className={`code-action-btn${copied ? ' copied' : ''}`}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <pre
            className="code-pre"
            style={{ height, minHeight: MIN_HEIGHT, overflow: 'auto' }}
          >
            <code className="block-code">{block.code}</code>
          </pre>
          {/* Resize handle */}
          <div
            className="code-resize-handle"
            onMouseDown={onResizeMouseDown}
            title="Drag to resize"
          >
            <span>⠿</span>
          </div>
        </>
      )}
    </div>
  );
}

