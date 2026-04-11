import { type ReactNode, useEffect, useState } from 'react';
import { IconCheck, IconChevronDown, IconX } from './Icon';
import type { ResponseTrace, ResponseTraceMetric, ResponseTracePhase, ResponseTraceSource, StreamingPhase } from '../types';

interface Props {
  trace?: ResponseTrace;
  streamingPhase?: StreamingPhase | null;
  isStreaming?: boolean;
  liveResponseMs?: number | null;
  hasStreamingContent?: boolean;
  defaultOpen?: boolean;
  onToggleOpenChange?: () => void;
  onOpenSources?: () => void;
  replyContent?: ReactNode;
}

interface ThinkingStep {
  heading: string;
  detail: string;
}

function decodeEntities(value: string): string {
  const basic = value
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  if (typeof document === 'undefined') return basic;

  const textarea = document.createElement('textarea');
  textarea.innerHTML = basic;
  return textarea.value;
}

function normalizeText(value?: string): string {
  return decodeEntities(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDuration(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds >= 3) return `${Math.round(seconds)}s`;
  return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
}

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function sourceFavicon(url: string): string | null {
  const hostname = sourceHostname(url);
  if (!hostname) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
}

function cleanSourceLabel(source: ResponseTraceSource): string {
  const title = normalizeText(source.title)
    .replace(/^Highlights:\s*/i, '')
    .replace(/^DuckDuckGo Search:\s*/i, '')
    .replace(/^DuckDuckGo Instant:\s*/i, '')
    .replace(/^Wikipedia:\s*/i, '')
    .trim();
  return title || sourceHostname(source.url) || source.url;
}

function metricValue(metrics: ResponseTraceMetric[] | undefined, label: string): number | null {
  const metric = metrics?.find((item) => item.label.toLowerCase() === label.toLowerCase());
  if (!metric) return null;
  const parsed = Number.parseInt(metric.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function credibilityRank(source: ResponseTraceSource): number {
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

function publishedTimestamp(source: ResponseTraceSource): number {
  if (!source.publishedAt) return 0;
  const value = new Date(source.publishedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function preferredSources(trace?: ResponseTrace): ResponseTraceSource[] {
  const unique = new Map<string, ResponseTraceSource>();
  for (const source of trace?.sources ?? []) {
    if (source.status !== 'fetched' || !source.url) continue;
    const key = source.url;
    if (!unique.has(key)) unique.set(key, source);
  }

  return [...unique.values()].sort((a, b) => {
    const rankDelta = credibilityRank(a) - credibilityRank(b);
    if (rankDelta !== 0) return rankDelta;
    const timeDelta = publishedTimestamp(b) - publishedTimestamp(a);
    if (timeDelta !== 0) return timeDelta;
    return cleanSourceLabel(a).localeCompare(cleanSourceLabel(b));
  });
}

function formatReferenceDate(trace?: ResponseTrace): string {
  const timestamp = trace?.completedAt ?? trace?.startedAt ?? Date.now();
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function findLatestPhase(
  trace: ResponseTrace | undefined,
  ids: string[],
  options: { requireDetail?: boolean; status?: ResponseTracePhase['status'] } = {},
): ResponseTracePhase | undefined {
  const phases = trace?.phases ?? [];
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (!ids.includes(phase.id)) continue;
    if (options.status && phase.status !== options.status) continue;
    if (options.requireDetail && !normalizeText(phase.detail)) continue;
    return phase;
  }
  return undefined;
}

function inferTopic(trace?: ResponseTrace): string | null {
  const prompt = normalizeText(trace?.prompt);
  const promptLower = prompt.toLowerCase();
  const sourceLabels = preferredSources(trace).map(cleanSourceLabel);
  const sourceText = sourceLabels.join(' ');

  if (/artemis\s*2\b/i.test(promptLower)) {
    return 'Artemis 2 launch';
  }

  if (/artemis\s*ii\b/i.test(promptLower) || /artemis\s*ii\b/i.test(sourceText)) {
    return 'Artemis II launch';
  }

  if (!prompt) return null;

  const cleaned = prompt
    .replace(/^(what(?:'s| is)|tell me|show me|give me|find|brief me on|update me on)\s+/i, '')
    .replace(/^(the\s+)?(latest|current|recent|new|status|update|news)\s+(with|on|about)\s+/i, '')
    .replace(/^(the\s+)?(latest|current|recent|new|status|update|news)\s+/i, '')
    .replace(/[?]+$/g, '')
    .trim();

  if (!cleaned) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildFirstThinkingStep(trace?: ResponseTrace): ThinkingStep {
  const topic = inferTopic(trace);
  const prompt = normalizeText(trace?.prompt);
  const latestLikePrompt = /\b(latest|current|recent|today|status|update|launch|news)\b/i.test(prompt);
  const reasoningSummary = normalizeText(trace?.reasoningSummary);
  const referenceDate = formatReferenceDate(trace);

  if (topic && latestLikePrompt) {
    return {
      heading: `Gathering ${topic} information`,
      detail: `It looks like the user wants the latest on ${topic}, so I need current information for ${referenceDate} from reliable live sources before answering. I should confirm the present status, check for any recent milestones or schedule changes, and avoid filling gaps with stale background knowledge.`,
    };
  }

  if (reasoningSummary) {
    return {
      heading: 'Understanding the request',
      detail: reasoningSummary,
    };
  }

  const firstPhase = (trace?.phases ?? []).find((phase) => Boolean(normalizeText(phase.detail)));
  return {
    heading: 'Understanding the request',
    detail: normalizeText(firstPhase?.detail)
      || normalizeText(trace?.orchestrationSummary)
      || 'Working through the request before drafting the reply.',
  };
}

function buildSecondThinkingStep(trace?: ResponseTrace, isStreaming = false): ThinkingStep {
  const topic = inferTopic(trace);
  const verifyPhase = findLatestPhase(trace, ['verify-live-sources']);
  const captured = metricValue(verifyPhase?.metrics, 'Captured');
  const required = metricValue(verifyPhase?.metrics, 'Required');
  const corroboratedSources = preferredSources(trace).length;
  const detailLabel = topic ? `Clarifying the ${topic} details` : 'Clarifying the final answer';
  const liveAssemblyPhase = isStreaming
    ? findLatestPhase(trace, ['context-assembly', 'verify-live-sources', 'extract-crew-roster'], { requireDetail: true })
    : undefined;

  if (liveAssemblyPhase?.detail) {
    return {
      heading: detailLabel,
      detail: normalizeText(liveAssemblyPhase.detail),
    };
  }

  if (captured != null && required != null && captured < required) {
    return {
      heading: detailLabel,
      detail: `The strongest retrieved sources give useful context, but this pass only validated ${captured} verified source${captured === 1 ? '' : 's'} and the configured floor is ${required}. The final answer should summarize only what those sources support and stay explicit that the current-status verification threshold was not met instead of presenting an unverified claim as settled fact.`,
    };
  }

  if (corroboratedSources > 0) {
    return {
      heading: detailLabel,
      detail: `The retrieved sources give enough context to answer, but I still need to anchor the reply to the overlap across the strongest sources, keep source-specific details attributed, and avoid overstating anything that only appears in a single result.`,
    };
  }

  const fallbackPhase = (trace?.phases ?? []).find((phase) =>
    !['live-context-fetch', 'prompt-url-fetch', 'resolve-packages'].includes(phase.id)
    && Boolean(normalizeText(phase.detail)),
  );

  return {
    heading: detailLabel,
    detail: normalizeText(fallbackPhase?.detail)
      || normalizeText(trace?.orchestrationSummary)
      || 'Finishing the reply from the gathered context.',
  };
}

function buildReadingDetail(trace?: ResponseTrace): string | null {
  const sources = preferredSources(trace);
  if (sources.length > 0) return null;

  const phases = trace?.phases ?? [];
  const phase = phases.find((item) =>
    ['live-context-fetch', 'prompt-url-fetch', 'resolve-packages'].includes(item.id)
    && Boolean(normalizeText(item.detail)),
  );

  return normalizeText(phase?.detail)
    || ((trace?.packages?.length ?? 0) > 0
      ? 'Checked the current package information before continuing.'
      : 'No external sources were needed for this response.');
}

function inferActiveStage(
  trace: ResponseTrace | undefined,
  isStreaming: boolean,
  streamingPhase: StreamingPhase | null | undefined,
  hasStreamingContent: boolean,
): 'thinking-1' | 'reading' | 'thinking-2' | 'answering' | null {
  if (!isStreaming) return null;

  const runningPhaseId = findLatestPhase(trace, [
    'classify-chat-mode',
    'reply-preferences',
    'prompt-url-fetch',
    'live-context-fetch',
    'resolve-packages',
    'extract-crew-roster',
    'context-assembly',
    'verify-live-sources',
    'reply-stream',
  ], { status: 'running' })?.id;

  if (hasStreamingContent || runningPhaseId === 'reply-stream') {
    return 'answering';
  }

  if (runningPhaseId && ['prompt-url-fetch', 'live-context-fetch', 'resolve-packages'].includes(runningPhaseId)) {
    return 'reading';
  }

  if (runningPhaseId && ['context-assembly', 'verify-live-sources', 'extract-crew-roster'].includes(runningPhaseId)) {
    return 'thinking-2';
  }

  if (runningPhaseId) {
    return 'thinking-1';
  }

  const phaseLabel = normalizeText(streamingPhase?.label).toLowerCase();
  if (/fetch|source|read|url|context|package/.test(phaseLabel)) {
    return 'reading';
  }

  if (hasStreamingContent || /stream|write|summary|reply|draft/.test(phaseLabel)) {
    return 'answering';
  }

  return 'thinking-1';
}

function ThoughtGlyph({ live = false }: { live?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`assistant-run-status-glyph${live ? ' is-live' : ''}`}
      aria-hidden="true"
    >
      <path d="M10 1.8 13.4 4.1 10.9 8 7.5 5.7Z" />
      <path d="M18.2 10 15.9 13.4 12 10.9 14.3 7.5Z" />
      <path d="M10 18.2 6.6 15.9 9.1 12 12.5 14.3Z" />
      <path d="M1.8 10 4.1 6.6 8 9.1 5.7 12.5Z" />
      <circle cx="10" cy="10" r="2.05" fill="var(--bg)" />
    </svg>
  );
}

export function AssistantRunStatus({
  trace,
  streamingPhase = null,
  isStreaming = false,
  liveResponseMs = null,
  hasStreamingContent = false,
  defaultOpen = false,
  onToggleOpenChange,
  onOpenSources,
  replyContent = null,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const firstThinking = buildFirstThinkingStep(trace);
  const secondThinking = buildSecondThinkingStep(trace, isStreaming);
  const readingDetail = buildReadingDetail(trace);
  const activeStage = inferActiveStage(trace, isStreaming, streamingPhase, hasStreamingContent);
  const durationLabel = formatDuration(liveResponseMs ?? trace?.totalDurationMs);
  const summaryLabel = isStreaming
    ? 'Thinking'
    : `Thought for ${durationLabel ?? '0s'}`;
  const sources = preferredSources(trace);
  const sourceIcons = sources.slice(0, 3);
  const showReplyOutput = replyContent != null || !isStreaming || activeStage === 'answering';
  const outputLabel = isStreaming
    ? (hasStreamingContent ? 'Answering' : 'Preparing reply')
    : 'Done';
  const outputBody = replyContent != null
    ? <div className="assistant-run-status-output-body">{replyContent}</div>
    : (
        <div className={`assistant-run-status-step-kicker assistant-run-status-step-kicker-done${isStreaming ? ' is-live' : ''}`}>
          {outputLabel}
        </div>
      );

  function renderOutputRow(mode: 'inline' | 'standalone') {
    if (!showReplyOutput) return null;

    return (
      <div className={`assistant-run-status-final assistant-run-status-final-${mode}${activeStage === 'answering' ? ' is-active' : ''}`}>
        <span className={`assistant-run-status-final-marker${isStreaming ? ' is-live' : ' is-done'}`} aria-hidden="true">
          {!isStreaming ? <IconCheck size={9} /> : null}
        </span>
        <div className="assistant-run-status-final-copy">
          {outputBody}
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-run-status">
      <div className={`assistant-run-status-shell${isStreaming ? ' is-live' : ''}`}>
        <div className="assistant-run-status-header">
          <div className="assistant-run-status-summary">
            <ThoughtGlyph live={isStreaming} />
            <span className={`assistant-run-status-label${isStreaming ? ' is-live' : ''}`}>
              {summaryLabel}
            </span>
          </div>

          <button
            type="button"
            className="assistant-run-status-toggle"
            onClick={() => {
              onToggleOpenChange?.();
              setOpen((value) => !value);
            }}
            aria-expanded={open}
            aria-label={open ? 'Hide steps' : 'Show steps'}
          >
            <span className="assistant-run-status-count">3 steps</span>
            {open ? <IconX size={12} /> : <IconChevronDown size={12} />}
          </button>
        </div>

        {open && (
          <div className="assistant-run-status-list">
            <div className={`assistant-run-status-step${activeStage === 'thinking-1' ? ' is-active' : ''}`}>
              <span className="assistant-run-status-step-marker" aria-hidden="true" />
              <div className="assistant-run-status-step-copy">
                <div className="assistant-run-status-step-kicker">Thinking</div>
                <div className="assistant-run-status-step-heading">{firstThinking.heading}</div>
                <p className="assistant-run-status-step-detail">{firstThinking.detail}</p>
              </div>
            </div>

            <div className={`assistant-run-status-step${activeStage === 'reading' ? ' is-active' : ''}`}>
              <span className="assistant-run-status-step-marker" aria-hidden="true" />
              <div className="assistant-run-status-step-copy">
                <div className="assistant-run-status-step-kicker">Reading</div>
                {sources.length > 0 && onOpenSources && (
                  <button
                    type="button"
                    className="assistant-run-status-source-trigger"
                    onClick={onOpenSources}
                    aria-label="Open sources"
                  >
                    <span className="assistant-run-status-source-icons" aria-hidden="true">
                      {sourceIcons.map((source) => {
                        const iconUrl = sourceFavicon(source.url);
                        return (
                          <span key={source.id} className="assistant-run-status-source-icon">
                            {iconUrl ? (
                              <img src={iconUrl} alt="" />
                            ) : (
                              <span className="assistant-run-status-source-icon-fallback" />
                            )}
                          </span>
                        );
                      })}
                    </span>
                    <span className="assistant-run-status-source-label">Sources</span>
                    <span className="assistant-run-status-source-count">{sources.length}</span>
                  </button>
                )}
                {readingDetail && <p className="assistant-run-status-step-detail">{readingDetail}</p>}
              </div>
            </div>

            <div className={`assistant-run-status-step${activeStage === 'thinking-2' ? ' is-active' : ''}`}>
              <span className="assistant-run-status-step-marker" aria-hidden="true" />
              <div className="assistant-run-status-step-copy">
                <div className="assistant-run-status-step-kicker">Thinking</div>
                <div className="assistant-run-status-step-heading">{secondThinking.heading}</div>
                <p className="assistant-run-status-step-detail">{secondThinking.detail}</p>
              </div>
            </div>

            {renderOutputRow('inline')}
          </div>
        )}

        {!open && renderOutputRow('standalone')}
      </div>
    </div>
  );
}
