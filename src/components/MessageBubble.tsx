import React from 'react';
import { parseContent, renderTextBlock } from '../lib/markdown';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { useToast } from '../hooks/useToast';
import type { Message } from '../types';

interface Props {
  message: Message;
  withDownload?: boolean;
}

function FileAttachment({ block }: { block: CodeBlockType }) {
  const { toast } = useToast();

  function handleDownload() {
    const name = block.suggestedFilename;
    const blob = new Blob([block.code], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Downloaded ${name}`);
  }

  const ext = block.ext.toUpperCase();

  return (
    <div className="file-attachment-card">
      <div className="file-attachment-icon-wrap">
        <svg className="file-attachment-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <div className="file-attachment-info">
        <span className="file-attachment-name">{block.suggestedFilename}</span>
        <span className="file-attachment-type">{ext}</span>
      </div>
      <button className="file-attachment-dl-btn" onClick={handleDownload} title={`Download ${block.suggestedFilename}`}>
        Download
      </button>
    </div>
  );
}

export function MessageBubble({ message, withDownload = false }: Props) {
  const isUser = message.role === 'user';
  const parsed = parseContent(message.content);

  // Collect all code blocks for the attachments strip
  const codeBlocks = parsed.parts
    .filter((p): p is { type: 'code'; block: CodeBlockType } => p.type === 'code');

  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-label">{isUser ? 'You' : 'Larry the Assistant'}</div>
      <div className="msg-bubble">
        {parsed.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <span
                key={i}
                dangerouslySetInnerHTML={{ __html: renderTextBlock(part.content) }}
              />
            );
          }
          return withDownload && !isUser
            ? <CodeBlock key={i} block={part.block} />
            : (
              <div key={i} className="code-block-wrapper">
                <div className="code-block-header">
                  <span className="code-lang-badge">{part.block.lang || 'text'}</span>
                </div>
                <pre className="code-pre">
                  <code className="block-code">{part.block.code}</code>
                </pre>
              </div>
            );
        })}
      </div>

      {/* File attachments strip — assistant only, when there are code blocks */}
      {!isUser && withDownload && codeBlocks.length > 0 && (
        <div className="file-attachments-strip">
          {codeBlocks.map((p) => (
            <FileAttachment key={p.block.id} block={p.block} />
          ))}
        </div>
      )}
    </div>
  );
}

