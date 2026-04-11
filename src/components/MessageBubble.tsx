// FILE: src/components/MessageBubble.tsx
import { useState } from 'react';
import { parseContent, renderTextBlock, extractFilePath, stripFileComment } from '../lib/markdown';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { AssistantRunStatus } from './AssistantRunStatus';
import { CodeBlock } from './CodeBlock';
import { computeDiff } from '../lib/diffMetrics';
import { IconCheck, IconCopy, IconFileText, IconRefreshCw, IconThumbsDown, IconThumbsUp } from './Icon';
import { NoCodeWarning } from './NoCodeWarning';
import { MessageSourcesPanel } from './MessageSourcesPanel';
import type { Message, ReplyFeedback, ResponseTraceSource, StreamingPhase } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  message: Message;
  withDownload?: boolean;
  prevRegistry?: FileRegistry;
  model?: string;
  feedbackValue?: ReplyFeedback | null;
  onFeedbackChange?: (next: ReplyFeedback | null) => void;
  hideCodeBlocks?: boolean;
  isStreaming?: boolean;
  streamingPhase?: StreamingPhase | null;
  liveResponseMs?: number | null;
  onAssistantRunStatusToggle?: () => void;
  // When true, never show the NoCodeWarning even if the pattern fires.
  suppressNoCodeWarning?: boolean;
}

function getSourceHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function getSourceFaviconUrl(url: string): string | null {
  const hostname = getSourceHostname(url);
  if (!hostname) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
}

function sourceCredibilityRank(source: ResponseTraceSource): number {
  switch (source.credibility) {
    case 'official':
      return 0;
    case 'reference':
      return 1;
    case 'major-news':
      return 2;
    case 'search':
      return 3;
    case 'community':
      return 4;
    default:
      return 5;
  }
}

function sourcePublishedAt(source: ResponseTraceSource): number {
  if (!source.publishedAt) return 0;
  const value = new Date(source.publishedAt).getTime();
  return Number.isFinite(value) ? value : 0;
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

function stripChangelog(text: string): string {
  return text
    .replace(/<!--\s*step-break:[^>]*-->/g, '')
    .replace(/<!--\s*summary\s*-->/g, '')
    .replace(/#+\s*changes?\s*\n(\|.+\n)+/gi, '')
    .replace(/^\|[-:| ]+\|\s*$/gm, '')
    .trim();
}

function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Clipboard unavailable.'));
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      const copied = document.execCommand('copy');
      if (!copied) {
        reject(new Error('Copy command failed.'));
        return;
      }
      resolve();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Copy command failed.'));
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

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
            {metrics.removed > 0 && <span className="diff-removed">-{metrics.removed}</span>}
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
  model,
  feedbackValue = null,
  onFeedbackChange,
  hideCodeBlocks = false,
  isStreaming = false,
  streamingPhase = null,
  liveResponseMs = null,
  onAssistantRunStatusToggle,
  suppressNoCodeWarning = false,
}: Props) {
  const isUser = message.role === 'user';
  const summaryMarker = '\n\n<!-- summary -->\n\n';
  const summaryIdx = (!isUser && hideCodeBlocks)
    ? message.content.indexOf(summaryMarker)
    : -1;
  const displayContent = summaryIdx >= 0
    ? message.content.slice(summaryIdx + summaryMarker.length)
    : message.content;

  const cleanedFull = isUser ? message.content : stripChangelog(message.content);
  const cleanedDisplay = isUser ? message.content : stripChangelog(displayContent);
  const parsed = parseContent(cleanedFull);
  const parsedDisplay = parseContent(cleanedDisplay);

  const allFileBlocks = parsed.parts
    .filter((part): part is { type: 'code'; block: CodeBlockType } => part.type === 'code')
    .filter((part) => !part.block.isInline);

  const seenPaths = new Map<string, typeof allFileBlocks[0]>();
  for (const part of allFileBlocks) {
    const path = extractFilePath(part.block.code, part.block.suggestedFilename);
    seenPaths.set(path, part);
  }
  const fileBlocks = [...seenPaths.values()];

  const isFakeCompletion =
    !isUser &&
    !isStreaming &&
    !suppressNoCodeWarning &&
    withDownload &&
    detectFakeCompletion(cleanedFull, fileBlocks.length);
  const responseTrace = !isUser ? message.responseTrace : undefined;
  const shouldShowAssistantRunStatus = !isUser && (isStreaming || message.responseTimeMs != null || Boolean(responseTrace));
  const hasVisibleContent = cleanedDisplay.trim().length > 0;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [replyCopied, setReplyCopied] = useState(false);
  const traceSources = !isUser
    ? (responseTrace?.sources ?? [])
      .filter((source) => source.status === 'fetched' && source.url)
      .sort((a, b) => {
        const rankDelta = sourceCredibilityRank(a) - sourceCredibilityRank(b);
        if (rankDelta !== 0) return rankDelta;
        return sourcePublishedAt(b) - sourcePublishedAt(a);
      })
    : [];
  const messageSources = [...new Map(traceSources.map((source) => [source.url, source])).values()];
  const sourceButtonIcons = messageSources.slice(0, 3);
  const copyableReply = !isUser ? cleanedDisplay.trim() : '';
  const feedbackEnabled = !isUser && typeof onFeedbackChange === 'function';

  function handleCopyReply() {
    if (!copyableReply) return;

    copyTextToClipboard(copyableReply)
      .then(() => {
        setReplyCopied(true);
        window.setTimeout(() => setReplyCopied(false), 1600);
      })
      .catch(() => {
        setReplyCopied(false);
      });
  }

  return (
    <div className={`msg ${message.role}`}>

      {shouldShowAssistantRunStatus && (
        <AssistantRunStatus
          trace={responseTrace}
          streamingPhase={streamingPhase}
          isStreaming={isStreaming}
          liveResponseMs={isStreaming ? liveResponseMs : message.responseTimeMs ?? liveResponseMs}
          hasStreamingContent={hasVisibleContent}
          onToggleOpenChange={onAssistantRunStatusToggle}
        />
      )}

      {(!isStreaming || hasVisibleContent) && (
        <div className="msg-bubble">
          <div className="msg-bubble-body">
            {parsedDisplay.parts.map((part, index) => {
              if (part.type === 'text') {
                return (
                  <span key={index} dangerouslySetInnerHTML={{ __html: renderTextBlock(part.content) }} />
                );
              }

              if (part.block.isInline) {
                return <InlineCodeBlock key={index} block={part.block} />;
              }

              if (hideCodeBlocks && !isUser) {
                return null;
              }

              if (!withDownload || isUser) {
                return (
                  <div key={index} className="code-block-wrapper">
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
              return <CodeBlock key={index} block={part.block} prevContent={prevContent} />;
            })}
          </div>
        </div>
      )}

      {!isUser && !isStreaming && (
        <div className="msg-source-actions">
          <button
            type="button"
            className={`msg-source-trigger msg-copy-trigger${replyCopied ? ' copied' : ''}`}
            onClick={handleCopyReply}
            aria-label={replyCopied ? 'Reply copied' : 'Copy reply'}
            title={replyCopied ? 'Copied' : 'Copy reply'}
            disabled={!copyableReply}
          >
            {replyCopied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </button>

          {feedbackEnabled && (
            <>
              <button
                type="button"
                className={`msg-source-trigger msg-feedback-trigger like${feedbackValue === 'liked' ? ' active' : ''}`}
                onClick={() => onFeedbackChange?.(feedbackValue === 'liked' ? null : 'liked')}
                aria-pressed={feedbackValue === 'liked'}
                aria-label={feedbackValue === 'liked' ? 'Remove valid or accurate rating' : 'Mark reply as valid or accurate'}
                title={feedbackValue === 'liked' ? 'Remove valid or accurate rating' : 'Mark reply as valid or accurate'}
              >
                <IconThumbsUp size={16} />
              </button>

              <button
                type="button"
                className={`msg-source-trigger msg-feedback-trigger dislike${feedbackValue === 'disliked' ? ' active' : ''}`}
                onClick={() => onFeedbackChange?.(feedbackValue === 'disliked' ? null : 'disliked')}
                aria-pressed={feedbackValue === 'disliked'}
                aria-label={feedbackValue === 'disliked' ? 'Remove invalid or inaccurate rating' : 'Mark reply as invalid or inaccurate'}
                title={feedbackValue === 'disliked' ? 'Remove invalid or inaccurate rating' : 'Mark reply as invalid or inaccurate'}
              >
                <IconThumbsDown size={16} />
              </button>
            </>
          )}

          {messageSources.length > 0 && (
            <button
              type="button"
              className="msg-source-trigger msg-source-primary"
              onClick={() => setSourcesOpen(true)}
              aria-label="Open sources"
            >
              <span className="msg-source-trigger-icons" aria-hidden="true">
                {sourceButtonIcons.map((source) => (
                  <span key={source.id} className="msg-source-trigger-icon">
                    {getSourceFaviconUrl(source.url) ? (
                      <img
                        src={getSourceFaviconUrl(source.url) ?? undefined}
                        alt=""
                      />
                    ) : (
                      <span className="msg-source-trigger-icon-fallback" />
                    )}
                  </span>
                ))}
              </span>
              <span className="msg-source-trigger-label">Sources</span>
            </button>
          )}
        </div>
      )}

      {isFakeCompletion && <NoCodeWarning model={model ?? ''} />}

      {!isUser && messageSources.length > 0 && sourcesOpen && (
        <MessageSourcesPanel
          sources={messageSources}
          onClose={() => setSourcesOpen(false)}
        />
      )}

      {!isUser && withDownload && fileBlocks.length > 0 && (
        <div className="change-summary">
          <div className="change-summary-label">
            <IconRefreshCw size={11} style={{ color: 'var(--accent)' }} />
            {fileBlocks.length} file{fileBlocks.length !== 1 ? 's' : ''} changed
          </div>
          <div className="change-pills">
            {fileBlocks.map((part) => (
              <FileChangePill
                key={part.block.id}
                block={part.block}
                prevContent={prevRegistry?.get(
                  extractFilePath(part.block.code, part.block.suggestedFilename)
                )?.content}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
