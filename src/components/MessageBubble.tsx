// FILE: src/components/MessageBubble.tsx
import React from 'react';
import { parseContent, renderTextBlock, extractFilePath, stripFileComment } from '../lib/markdown';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { computeDiff } from '../lib/diffMetrics';
import { IconFileText, IconRefreshCw } from './Icon';
import { NoCodeWarning } from './NoCodeWarning';
import type { Message } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  message: Message;
  withDownload?: boolean;
  prevRegistry?: FileRegistry;
  currentRegistry?: FileRegistry;
  model?: string;
  hideCodeBlocks?: boolean;
}

function detectFakeCompletion(content: string, fileBlockCount: number): boolean {
  if (fileBlockCount > 0) return false;
  return (
    /files to (be )?creat/i.test(content) ||
    /\|\s*file\s*\|/i.test(content) ||
    /\*\*overview:\*\*/i.test(content) ||
    /src\/[a-z].*\.ts/i.test(content)
  );
}

/**
 * Strips inline changelog tables (### Changes | File | … rows) and
 * step-break HTML comments from rendered text so they don't appear in the UI.
 * Changes are tracked in the change-pill strip below each message instead.
 */
function stripChangelog(text: string): string {
  return text
    // Remove <!-- step-break: N/M --> and <!-- summary --> markers
    .replace(/<!--\s*step-break:[^>]*-->/g, '')
    .replace(/<!--\s*summary\s*-->/g, '')
    // Remove ### Changes heading + the table that follows it
    .replace(/#+\s*changes?\s*\n(\|.+\n)+/gi, '')
    // Remove any orphan separator rows left over
    .replace(/^\|[-:| ]+\|\s*$/gm, '')
    .trim();
}

/** Plain inline code block — used for shell/text/plain langs. */
function InlineCodeBlock({ block }: { block: CodeBlockType }) {
  return (
    <div className="inline-code-block">
      {block.lang && <span className="inline-code-lang">{block.lang}</span>}
      <pre className="inline-code-pre"><code>{block.code}</code></pre>
    </div>
  );
}

function FileChangePill({
  block,
  prevContent,
}: {
  block: CodeBlockType;
  prevContent?: string;
}) {
  const resolvedPath = extractFilePath(block.code, block.suggestedFilename);
  const cleanCode = stripFileComment(block.code);
  const metrics = computeDiff(prevContent ?? '', cleanCode);
  const isNew = !prevContent;
  const name = resolvedPath.split('/').pop() ?? resolvedPath;
  const dir = resolvedPath.includes('/')
    ? resolvedPath.slice(0, resolvedPath.lastIndexOf('/'))
    : '';

  return (
    <div className="change-pill">
      <IconFileText size={12} className="change-pill-icon" />
      <div className="change-pill-info">
        {dir && <span className="change-pill-dir">{dir}/</span>}
        <span className="change-pill-name">{name}</span>
      </div>
      <div className="change-pill-metrics">
        {isNew ? (
          <span className="diff-added change-pill-new">new</span>
        ) : (
          <>
            {metrics.added > 0 && <span className="diff-added">+{metrics.added}</span>}
            {metrics.removed > 0 && <span className="diff-removed">−{metrics.removed}</span>}
          </>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  withDownload = false,
  prevRegistry,
  currentRegistry,
  model,
  hideCodeBlocks = false,
}: Props) {
  const isUser = message.role === 'user';

  // For code preset messages the full content (with all code blocks) is stored
  // in the message, but we only want to display the summary portion as prose.
  // We split here so that:
  //   - `parsed`      — full content, used to build fileBlocks / change pills
  //   - `displayContent` — only the post-summary text, rendered in the bubble
  const SUMMARY_MARKER = '\n\n<!-- summary -->\n\n';
  const summaryIdx = (!isUser && hideCodeBlocks)
    ? message.content.indexOf(SUMMARY_MARKER)
    : -1;
  const displayContent = summaryIdx >= 0
    ? message.content.slice(summaryIdx + SUMMARY_MARKER.length)
    : message.content;

  // Strip changelog tables and step-break markers before parsing/rendering
  const cleanedFull    = isUser ? message.content : stripChangelog(message.content);
  const cleanedDisplay = isUser ? message.content : stripChangelog(displayContent);

  // Parse the FULL content so fileBlocks / change pills include every file
  const parsed        = parseContent(cleanedFull);
  // Parse only the display portion for rendering in the bubble
  const parsedDisplay = parseContent(cleanedDisplay);

  // Deduplicate by resolved file path — multi-step responses concatenate all
  // step outputs into one message, so the same file can appear multiple times
  // if a step re-mentions a file. Keep only the last occurrence (most recent).
  const allFileBlocks = parsed.parts
    .filter((p): p is { type: 'code'; block: CodeBlockType } => p.type === 'code')
    .filter(p => !p.block.isInline);

  const seenPaths = new Map<string, typeof allFileBlocks[0]>();
  for (const p of allFileBlocks) {
    const path = extractFilePath(p.block.code, p.block.suggestedFilename);
    seenPaths.set(path, p);
  }
  const fileBlocks = [...seenPaths.values()];

  const isFakeCompletion =
    !isUser &&
    withDownload &&
    detectFakeCompletion(cleanedFull, fileBlocks.length);

  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-label">{isUser ? 'You' : 'Larry the Assistant'}</div>
      <div className="msg-bubble">
        {parsedDisplay.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <span key={i} dangerouslySetInnerHTML={{ __html: renderTextBlock(part.content) }} />
            );
          }

          if (part.block.isInline) {
            return <InlineCodeBlock key={i} block={part.block} />;
          }

          // Code preset: hide file code blocks entirely — they are silently
          // parsed into the file registry; only plain text renders in the bubble.
          if (hideCodeBlocks && !isUser) {
            return null;
          }

          if (!withDownload || isUser) {
            return (
              <div key={i} className="code-block-wrapper">
                <div className="code-block-header">
                  <span className="code-lang-badge">{part.block.lang || 'text'}</span>
                </div>
                <pre className="code-pre">
                  <code className="block-code">{part.block.code}</code>
                </pre>
              </div>
            );
          }

          const resolvedPath = extractFilePath(part.block.code, part.block.suggestedFilename);
          const prevContent = prevRegistry?.get(resolvedPath)?.content;
          return <CodeBlock key={i} block={part.block} prevContent={prevContent} />;
        })}
      </div>

      {isFakeCompletion && <NoCodeWarning model={model ?? ''} />}

      {!isUser && withDownload && fileBlocks.length > 0 && (
        <div className="change-summary">
          <div className="change-summary-label">
            <IconRefreshCw size={11} style={{ color: 'var(--accent)' }} />
            {fileBlocks.length} file{fileBlocks.length !== 1 ? 's' : ''} changed
          </div>
          <div className="change-pills">
            {fileBlocks.map(p => (
              <FileChangePill
                key={p.block.id}
                block={p.block}
                prevContent={prevRegistry?.get(
                  extractFilePath(p.block.code, p.block.suggestedFilename)
                )?.content}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
