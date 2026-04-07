// FILE: src/components/MessageBubble.tsx
import { useState } from 'react';
import { parseContent, renderTextBlock, extractFilePath, stripFileComment } from '../lib/markdown';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { computeDiff } from '../lib/diffMetrics';
import { IconCheck, IconCopy, IconFileText, IconInfo, IconRefreshCw, IconThumbsDown, IconThumbsUp } from './Icon';
import { NoCodeWarning } from './NoCodeWarning';
import { ResponseTracePanel } from './ResponseTracePanel';
import { MessageSourcesPanel } from './MessageSourcesPanel';
import type { Message, ReplyFeedback } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  message: Message;
  withDownload?: boolean;
  prevRegistry?: FileRegistry;
  model?: string;
  showDeveloperTools?: boolean;
  feedbackValue?: ReplyFeedback | null;
  onFeedbackChange?: (next: ReplyFeedback | null) => void;
  hideCodeBlocks?: boolean;
  liveReplyLatencyMs?: number;
  /** When true, never show the NoCodeWarning even if the pattern fires.
   *  Used for Chatbot/Creative presets where a code-only response is normal. */
  suppressNoCodeWarning?: boolean;
}

function formatResponseDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;

  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;

  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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
  model,
  showDeveloperTools = false,
  feedbackValue = null,
  onFeedbackChange,
  hideCodeBlocks = false,
  liveReplyLatencyMs,
  suppressNoCodeWarning = false,
}: Props) {
  const isUser = message.role === 'user';
  const replyLatencyMs = !isUser
    ? liveReplyLatencyMs ?? message.responseFirstTokenMs ?? message.responseTimeMs
    : undefined;
  const replyLatencyLabel = replyLatencyMs != null ? formatResponseDuration(replyLatencyMs) : null;
  const totalTimingLabel = !isUser && message.responseTimeMs != null
    ? formatResponseDuration(message.responseTimeMs)
    : null;
  const timingTitle = !isUser && replyLatencyLabel
    ? [
        `First token ${replyLatencyLabel}`,
        totalTimingLabel ? `Total ${totalTimingLabel}` : null,
        message.responseStartedAt ? `Started ${new Date(message.responseStartedAt).toLocaleTimeString()}` : null,
        message.responseCompletedAt ? `Finished ${new Date(message.responseCompletedAt).toLocaleTimeString()}` : null,
      ].filter(Boolean).join(' • ')
    : undefined;

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
    !suppressNoCodeWarning &&
    withDownload &&
    detectFakeCompletion(cleanedFull, fileBlocks.length);
  const responseTrace = !isUser ? message.responseTrace : undefined;
  const developerToolsVisible = !isUser && showDeveloperTools;
  const [traceOpen, setTraceOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [replyCopied, setReplyCopied] = useState(false);
  const traceSources = !isUser
    ? (responseTrace?.sources ?? []).filter((source) => source.status === 'fetched' && source.url)
    : [];
  const messageSources = [...new Map(traceSources.map((source) => [source.url, source])).values()];
  const sourceButtonIcons = messageSources.slice(0, 3);
  const copyableReply = !isUser ? cleanedDisplay.trim() : '';

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

  const feedbackEnabled = !isUser && typeof onFeedbackChange === 'function';

  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-label">
        {isUser ? (
          <span>You</span>
        ) : (
          <>
            <strong className="msg-label-name">Larry</strong>
            {developerToolsVisible && replyLatencyLabel && (
              <span className="msg-label-response" title={timingTitle}>
                responded in {replyLatencyLabel}
              </span>
            )}
            {developerToolsVisible && responseTrace && (
              <button
                type="button"
                className="msg-trace-trigger"
                title="Inspect reply pipeline"
                aria-label="Inspect reply pipeline"
                onClick={() => setTraceOpen(true)}
              >
                <IconInfo size={13} />
              </button>
            )}
          </>
        )}
      </div>
      <div className="msg-bubble">
        <div className="msg-bubble-body">
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
      </div>

      {!isUser && (
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
                onClick={() => onFeedbackChange(feedbackValue === 'liked' ? null : 'liked')}
                aria-pressed={feedbackValue === 'liked'}
                aria-label={feedbackValue === 'liked' ? 'Remove valid or accurate rating' : 'Mark reply as valid or accurate'}
                title={feedbackValue === 'liked' ? 'Remove valid / accurate rating' : 'Mark as valid / accurate'}
              >
                <IconThumbsUp size={16} />
              </button>

              <button
                type="button"
                className={`msg-source-trigger msg-feedback-trigger dislike${feedbackValue === 'disliked' ? ' active' : ''}`}
                onClick={() => onFeedbackChange(feedbackValue === 'disliked' ? null : 'disliked')}
                aria-pressed={feedbackValue === 'disliked'}
                aria-label={feedbackValue === 'disliked' ? 'Remove invalid or inaccurate rating' : 'Mark reply as invalid or inaccurate'}
                title={feedbackValue === 'disliked' ? 'Remove invalid / inaccurate rating' : 'Mark as invalid / inaccurate'}
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

      {developerToolsVisible && responseTrace && (
        traceOpen ? (
          <ResponseTracePanel
            trace={responseTrace}
            firstTokenDurationMs={message.responseFirstTokenMs}
            totalDurationMs={message.responseTimeMs}
            onClose={() => setTraceOpen(false)}
          />
        ) : null
      )}

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
