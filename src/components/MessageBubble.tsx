// FILE: src/components/MessageBubble.tsx
import { useState } from 'react';
import { parseContent, renderTextBlock, extractFilePath, hasFileComment } from '../lib/markdown';
import type { CodeBlock as CodeBlockType } from '../lib/markdown';
import { AssistantRunStatus } from './AssistantRunStatus';
import { CodeBlock } from './CodeBlock';
import { computeDiff, computeLineDiff } from '../lib/diffMetrics';
import { highlightWorkspaceFileContent } from '../lib/workspaceSyntax';
import { IconCheck, IconChevronDown, IconChevronUp, IconCopy, IconRotateCcw, IconThumbsDown, IconThumbsUp } from './Icon';
import { NoCodeWarning } from './NoCodeWarning';
import { MessageSourcesPanel } from './MessageSourcesPanel';
import type { Message, MessageWorkspaceChangeSet, ReplyFeedback, ResponseTraceSource, SearchDiscoveryEngine, StreamingPhase } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  message: Message;
  chatTitle?: string;
  withDownload?: boolean;
  prevRegistry?: FileRegistry;
  model?: string;
  feedbackValue?: ReplyFeedback | null;
  onFeedbackChange?: (next: ReplyFeedback | null) => void;
  hideCodeBlocks?: boolean;
  isStreaming?: boolean;
  streamingPhase?: StreamingPhase | null;
  liveResponseMs?: number | null;
  isMostRecentReply?: boolean;
  onAssistantRunStatusToggle?: () => void;
  onUndoWorkspaceChanges?: (changeSet: MessageWorkspaceChangeSet) => void | Promise<void>;
  // When true, never show the NoCodeWarning even if the pattern fires.
  suppressNoCodeWarning?: boolean;
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

function mergeDiscoveryEngines(
  left?: SearchDiscoveryEngine[],
  right?: SearchDiscoveryEngine[],
): SearchDiscoveryEngine[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (!merged.length) return undefined;
  return [...new Set(merged)];
}

function mergeTraceSources(sources: ResponseTraceSource[]): ResponseTraceSource[] {
  const merged = new Map<string, ResponseTraceSource>();

  for (const source of sources) {
    const existing = merged.get(source.url);
    if (!existing) {
      merged.set(source.url, {
        ...source,
        discoveryEngines: mergeDiscoveryEngines(source.discoveryEngines),
      });
      continue;
    }

    merged.set(source.url, {
      ...existing,
      preview: existing.preview || source.preview,
      error: existing.error || source.error,
      provider: existing.provider ?? source.provider,
      host: existing.host ?? source.host,
      path: existing.path ?? source.path,
      sourceType: existing.sourceType ?? source.sourceType,
      credibility: existing.credibility ?? source.credibility,
      publishedAt: existing.publishedAt ?? source.publishedAt,
      durationMs: existing.durationMs ?? source.durationMs,
      contextOrigin: existing.contextOrigin ?? source.contextOrigin,
      promptSelected: existing.promptSelected || source.promptSelected,
      discoveryEngines: mergeDiscoveryEngines(existing.discoveryEngines, source.discoveryEngines),
    });
  }

  return [...merged.values()];
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fallbackHighlightedLines(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => escapeHtml(line) || '<span class="workspace-file-editor-render-placeholder"> </span>');
}

function extractHighlightedLineHtmls(content: string, lang: string): string[] {
  const highlighted = highlightWorkspaceFileContent(content, lang || 'text');
  const linePrefix = '<span class="workspace-file-editor-render-line">';
  const segments = highlighted
    .split(linePrefix)
    .slice(1)
    .map((segment) => {
      const closingIndex = segment.lastIndexOf('</span>');
      return closingIndex >= 0
        ? segment.slice(0, closingIndex)
        : segment;
    });
  if (!segments.length) return fallbackHighlightedLines(content);
  return segments.map((segment) => segment || '<span class="workspace-file-editor-render-placeholder"> </span>');
}

function renderDiffLineHtml(
  line: ReturnType<typeof computeLineDiff>[number],
  oldHighlightedLines: string[],
  newHighlightedLines: string[],
): string {
  if (line.type === 'removed' && line.oldNumber != null) {
    return oldHighlightedLines[line.oldNumber - 1]
      ?? escapeHtml(line.content || '')
      ?? '<span class="workspace-file-editor-render-placeholder"> </span>';
  }

  if (line.newNumber != null) {
    return newHighlightedLines[line.newNumber - 1]
      ?? escapeHtml(line.content || '')
      ?? '<span class="workspace-file-editor-render-placeholder"> </span>';
  }

  if (line.oldNumber != null) {
    return oldHighlightedLines[line.oldNumber - 1]
      ?? escapeHtml(line.content || '')
      ?? '<span class="workspace-file-editor-render-placeholder"> </span>';
  }

  return '<span class="workspace-file-editor-render-placeholder"> </span>';
}

function ReplyWorkspaceChangePanel({
  changeSet,
  onUndo,
}: {
  changeSet: MessageWorkspaceChangeSet;
  onUndo?: (changeSet: MessageWorkspaceChangeSet) => void | Promise<void>;
}) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const files = changeSet.files.map((file) => ({
    ...file,
    metrics: computeDiff(file.previousContent ?? '', file.nextContent ?? ''),
  }));
  const totals = files.reduce(
    (acc, file) => ({
      added: acc.added + file.metrics.added,
      removed: acc.removed + file.metrics.removed,
    }),
    { added: 0, removed: 0 },
  );

  if (!files.length) return null;

  return (
    <div className="reply-change-summary">
      <div className="reply-change-summary-header">
        <div className="reply-change-summary-label">
          <span>{files.length} file{files.length === 1 ? '' : 's'} changed</span>
          <span className={`reply-change-summary-metric diff-added${totals.added === 0 ? ' is-zero' : ''}`}>+{totals.added}</span>
          <span className={`reply-change-summary-metric diff-removed${totals.removed === 0 ? ' is-zero' : ''}`}>-{totals.removed}</span>
        </div>

        {changeSet.backup && onUndo && (
          <button
            type="button"
            className="reply-change-undo"
            onClick={() => {
              void onUndo(changeSet);
            }}
          >
            <span>Undo</span>
            <IconRotateCcw size={14} />
          </button>
        )}
      </div>

      <div className="reply-change-file-list">
        {files.map((file) => {
          const isExpanded = expandedPath === file.path;
          const diffLines = isExpanded
            ? computeLineDiff(file.previousContent ?? '', file.nextContent ?? '', { contextLines: 3 })
            : [];
          const oldHighlightedLines = isExpanded
            ? extractHighlightedLineHtmls(file.previousContent ?? '', file.lang)
            : [];
          const newHighlightedLines = isExpanded
            ? extractHighlightedLineHtmls(file.nextContent ?? '', file.lang)
            : [];

          return (
            <div key={file.path} className={`reply-change-file${isExpanded ? ' is-expanded' : ''}`}>
              <button
                type="button"
                className="reply-change-file-row"
                onClick={() => setExpandedPath(isExpanded ? null : file.path)}
                aria-expanded={isExpanded}
                title={file.path}
              >
                <div className="reply-change-file-main">
                  <span className="reply-change-file-path">{file.path}</span>
                  <div className="reply-change-file-metrics">
                    <span className={`reply-change-summary-metric diff-added${file.metrics.added === 0 ? ' is-zero' : ''}`}>+{file.metrics.added}</span>
                    <span className={`reply-change-summary-metric diff-removed${file.metrics.removed === 0 ? ' is-zero' : ''}`}>-{file.metrics.removed}</span>
                  </div>
                </div>

                <span className="reply-change-file-toggle">
                  {isExpanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
                </span>
              </button>

              {isExpanded && (
                <div className="reply-change-diff-shell">
                  <div className="reply-change-diff-scroll">
                    {diffLines.map((line, index) => {
                      if (line.type === 'spacer') {
                        return (
                          <div key={`${file.path}-spacer-${index}`} className="reply-change-diff-spacer">
                            {line.hiddenLineCount ?? 0} unchanged line{line.hiddenLineCount === 1 ? '' : 's'}
                          </div>
                        );
                      }

                      return (
                        <div key={`${file.path}-${line.oldNumber ?? 'n'}-${line.newNumber ?? 'n'}-${index}`} className={`reply-change-diff-line is-${line.type}`}>
                          <span className="reply-change-diff-number">{line.oldNumber ?? ''}</span>
                          <span className="reply-change-diff-number">{line.newNumber ?? ''}</span>
                          <span className="reply-change-diff-marker" aria-hidden="true">
                            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                          </span>
                          <span
                            className="reply-change-diff-code"
                            dangerouslySetInnerHTML={{
                              __html: renderDiffLineHtml(line, oldHighlightedLines, newHighlightedLines),
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  chatTitle,
  withDownload = false,
  prevRegistry,
  model,
  feedbackValue = null,
  onFeedbackChange,
  hideCodeBlocks = false,
  isStreaming = false,
  streamingPhase = null,
  liveResponseMs = null,
  isMostRecentReply = false,
  onAssistantRunStatusToggle,
  onUndoWorkspaceChanges,
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
    .filter((part) => !part.block.isInline && hasFileComment(part.block.code));

  const seenPaths = new Map<string, typeof allFileBlocks[0]>();
  for (const part of allFileBlocks) {
    const path = extractFilePath(part.block.code, part.block.suggestedFilename);
    seenPaths.set(path, part);
  }
  const fileBlocks = [...seenPaths.values()];
  const workspaceChanges = !isUser ? message.workspaceChanges ?? null : null;

  const isFakeCompletion =
    !isUser &&
    !isStreaming &&
    !suppressNoCodeWarning &&
    message.responseTrace?.surface !== 'code' &&
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
  const messageSources = mergeTraceSources(traceSources);
  const copyableReply = !isUser ? cleanedDisplay.trim() : '';
  const feedbackEnabled = !isUser && typeof onFeedbackChange === 'function';

  const renderedReplyContent = (!isStreaming || hasVisibleContent)
    ? (
        <>
          {parsedDisplay.parts.map((part, index) => {
            if (part.type === 'text') {
              return (
                <span key={index} dangerouslySetInnerHTML={{ __html: renderTextBlock(part.content) }} />
              );
            }

            if (part.block.isInline) {
              return <InlineCodeBlock key={index} block={part.block} />;
            }

            if (hideCodeBlocks && !isUser && hasFileComment(part.block.code)) {
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
        </>
      )
    : null;
  const renderReplyInsideRunStatus = shouldShowAssistantRunStatus && !isUser;

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

  const assistantReplyActions = !isUser && !isStreaming ? (
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

      {!shouldShowAssistantRunStatus && messageSources.length > 0 && (
        <button
          type="button"
          className="msg-source-trigger msg-source-primary"
          onClick={() => setSourcesOpen(true)}
          aria-label="Open sources"
        >
          <span className="msg-source-trigger-label">Sources</span>
        </button>
      )}
    </div>
  ) : null;

  const assistantReplyBlock = (!isUser && (renderedReplyContent || assistantReplyActions)) ? (
    <div className="msg-reply-stack">
      {renderedReplyContent && (
        <div className="msg-bubble-body">
          {renderedReplyContent}
        </div>
      )}
      {assistantReplyActions}
    </div>
  ) : renderedReplyContent ? (
    <div className="msg-bubble-body">
      {renderedReplyContent}
    </div>
  ) : null;
  const isCodeRun = message.responseTrace?.surface === 'code';
  const runStatusDefaultOpen = isStreaming || (!isCodeRun && isMostRecentReply);

  return (
    <div className={`msg ${message.role}`}>

      {shouldShowAssistantRunStatus && (
        <AssistantRunStatus
          trace={responseTrace}
          chatTitle={chatTitle}
          streamingPhase={streamingPhase}
          isStreaming={isStreaming}
          liveResponseMs={isStreaming ? liveResponseMs : message.responseTimeMs ?? liveResponseMs}
          hasStreamingContent={hasVisibleContent}
          defaultOpen={runStatusDefaultOpen}
          onToggleOpenChange={onAssistantRunStatusToggle}
          onOpenSources={messageSources.length > 0 ? () => setSourcesOpen(true) : undefined}
          replyContent={renderReplyInsideRunStatus ? assistantReplyBlock : null}
        />
      )}

      {!renderReplyInsideRunStatus && assistantReplyBlock && (
        <div className="msg-bubble">
          {assistantReplyBlock}
        </div>
      )}

      {isFakeCompletion && <NoCodeWarning model={model ?? ''} />}

      {!isUser && messageSources.length > 0 && sourcesOpen && (
        <MessageSourcesPanel
          sources={messageSources}
          onClose={() => setSourcesOpen(false)}
        />
      )}

      {!isUser && workspaceChanges?.files.length ? (
        <ReplyWorkspaceChangePanel
          changeSet={workspaceChanges}
          onUndo={onUndoWorkspaceChanges}
        />
      ) : null}
    </div>
  );
}
