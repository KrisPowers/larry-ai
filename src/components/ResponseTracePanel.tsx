import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResponseTrace, ResponseTracePhase } from '../types';
import { IconListChecks, IconX } from './Icon';

interface Props {
  trace: ResponseTrace;
  firstTokenDurationMs?: number;
  totalDurationMs?: number;
  onClose: () => void;
}

interface RunSummaryItem {
  id: string;
  label: string;
  phaseId?: string;
  durationLabel?: string;
  detail?: string;
  status: 'completed' | 'error' | 'skipped' | 'running';
  meta?: string[];
}

function formatDuration(ms?: number): string | null {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function parseDurationLabel(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const minuteMatch = trimmed.match(/(\d+)\s*m/);
  const secondMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*s/);
  const millisecondMatch = trimmed.match(/(\d+)\s*ms/);

  if (minuteMatch || secondMatch || millisecondMatch) {
    const minutes = minuteMatch ? Number(minuteMatch[1]) * 60_000 : 0;
    const seconds = secondMatch ? Math.round(Number(secondMatch[1]) * 1000) : 0;
    const milliseconds = millisecondMatch ? Number(millisecondMatch[1]) : 0;
    return minutes + seconds + milliseconds;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function getPhase(trace: ResponseTrace, id: string): ResponseTracePhase | undefined {
  return trace.phases.find((phase) => phase.id === id);
}

function getSourceHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function getPhaseMetricDuration(phase: ResponseTracePhase | undefined, label: string): number | null {
  const value = phase?.metrics?.find((metric) => metric.label === label)?.value;
  return parseDurationLabel(value);
}

function getPhaseDurationMs(phase: ResponseTracePhase | undefined): number | null {
  if (!phase?.startedAt || !phase.completedAt) return null;
  return Math.max(0, phase.completedAt - phase.startedAt);
}

function getPhaseDurationLabel(phase: ResponseTracePhase | undefined): string | undefined {
  const duration = getPhaseDurationMs(phase);
  return duration != null ? formatDuration(duration) ?? undefined : undefined;
}

function buildPhaseMeta(phase: ResponseTracePhase): string[] {
  return (phase.metrics ?? [])
    .slice(0, 4)
    .map((metric) => `${metric.value} ${metric.label.toLowerCase()}`);
}

function buildRunSummaryItems(
  trace: ResponseTrace,
  totalDurationLabel: string | null,
  firstTokenLabel: string | null,
): RunSummaryItem[] {
  const items = trace.phases
    .filter((phase) => phase.label.trim())
    .map<RunSummaryItem>((phase) => {
      const meta = buildPhaseMeta(phase);
      if (phase.id === 'reply-stream' && firstTokenLabel) {
        meta.unshift(`first token ${firstTokenLabel}`);
      }

      return {
        id: phase.id,
        phaseId: phase.id,
        label: phase.label,
        durationLabel: getPhaseDurationLabel(phase) ?? undefined,
        detail: phase.detail,
        status: phase.status,
        meta,
      };
    });

  if (totalDurationLabel) {
    items.push({
      id: 'assistant-reply',
      label: 'Assistant reply',
      durationLabel: totalDurationLabel,
      detail: trace.orchestrationSummary,
      status: 'completed',
    });
  }

  return items;
}

function formatStatusLabel(status: RunSummaryItem['status']): string {
  if (status === 'running') return 'Running';
  if (status === 'error') return 'Error';
  if (status === 'skipped') return 'Skipped';
  return 'Complete';
}

function buildSourceIdentity(source: NonNullable<ResponseTrace['sources']>[number]): string {
  return source.provider || getSourceHostname(source.url) || source.url;
}

export function ResponseTracePanel({
  trace,
  firstTokenDurationMs,
  totalDurationMs,
  onClose,
}: Props) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const replyStreamPhase = getPhase(trace, 'reply-stream');
  const totalDuration =
    totalDurationMs
    ?? trace.totalDurationMs
    ?? getPhaseMetricDuration(replyStreamPhase, 'Total')
    ?? getPhaseMetricDuration(replyStreamPhase, 'Elapsed')
    ?? (trace.completedAt != null ? trace.completedAt - trace.startedAt : undefined);
  const firstTokenDuration =
    firstTokenDurationMs
    ?? trace.firstTokenDurationMs
    ?? getPhaseMetricDuration(replyStreamPhase, 'First token')
    ?? (trace.firstTokenAt != null ? trace.firstTokenAt - trace.startedAt : undefined);

  const visiblePhases = trace.phases.filter((phase) => phase.label.trim());
  const totalDurationLabel = formatDuration(totalDuration);
  const firstTokenLabel = formatDuration(firstTokenDuration);
  const runSummaryItems = buildRunSummaryItems(trace, totalDurationLabel, firstTokenLabel);
  const showReasoningSummary = Boolean(trace.reasoningSummary || trace.plannerSummary || trace.plannerMode);
  const liveContextSources = (trace.sources ?? []).filter((source) => source.kind === 'live-context');

  function toggleSection(sectionId: string) {
    setExpandedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }

  const modal = (
    <div className="response-trace-modal-layer" role="presentation">
      <button
        type="button"
        className="response-trace-backdrop"
        aria-label="Close reply process inspector"
        onClick={onClose}
      />

      <div
        className="response-trace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="response-trace-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="response-trace-modal-header">
          <div className="response-trace-modal-copy">
            <div className="response-trace-kicker">Reply inspector</div>
            <h2 id="response-trace-title">Pipeline from prompt to full reply</h2>
            <p>{trace.orchestrationSummary}</p>
          </div>

          <div className="response-trace-modal-actions">
            <div className="response-trace-badges">
              <span className="response-trace-badge">{trace.pipeline === 'deep-plan' ? 'Deep plan' : 'Single pass'}</span>
              <span className="response-trace-badge">{trace.model}</span>
              <span className="response-trace-badge">{visiblePhases.length} phase{visiblePhases.length === 1 ? '' : 's'}</span>
              {firstTokenDuration != null && (
                <span className="response-trace-badge">First token {formatDuration(firstTokenDuration)}</span>
              )}
              {totalDuration != null && (
                <span className="response-trace-badge">Total {formatDuration(totalDuration)}</span>
              )}
            </div>

            <button
              type="button"
              className="response-trace-close"
              onClick={onClose}
              aria-label="Close reply process inspector"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>

        <div className="response-trace-modal-body">
          <section className="response-trace-section response-trace-run-summary">
            <div className="response-trace-section-head">
              <IconListChecks size={13} />
              <span>Run summary</span>
            </div>

            <div className="response-trace-reasoning">
              {trace.plannerMode && (
                <div className="response-trace-inline-meta">
                  <span>{trace.plannerMode.replace(/_/g, ' ')}</span>
                  {trace.plannerConfidence && <span>{trace.plannerConfidence} confidence</span>}
                </div>
              )}
              {trace.reasoningSummary && <p>{trace.reasoningSummary}</p>}
              {trace.plannerSummary && <p>{trace.plannerSummary}</p>}
              {!showReasoningSummary && <p>{trace.orchestrationSummary}</p>}
            </div>

            {runSummaryItems.length > 0 && (
              <div className="response-trace-run-list">
                {runSummaryItems.map((item, index) => (
                  <div key={item.id} className={`response-trace-run-item ${item.status}`}>
                    <div className="response-trace-run-item-top">
                      <div className="response-trace-run-item-line">
                        <span className="response-trace-run-item-order">{index + 1}.</span>
                        {item.durationLabel && (
                          <span className="response-trace-run-item-duration">{item.durationLabel}</span>
                        )}
                        <strong>{item.label}</strong>
                      </div>
                      <div className="response-trace-run-item-actions">
                        {item.phaseId === 'live-context-fetch' && liveContextSources.length > 0 && (
                          <button
                            type="button"
                            className={`response-trace-run-item-toggle${expandedSections[item.id] ? ' expanded' : ''}`}
                            onClick={() => toggleSection(item.id)}
                            aria-expanded={expandedSections[item.id] ? 'true' : 'false'}
                            aria-controls={`${item.id}-sources`}
                          >
                            {expandedSections[item.id] ? 'Hide sources' : 'Show sources'}
                          </button>
                        )}
                        <span className="response-trace-run-item-status">{formatStatusLabel(item.status)}</span>
                      </div>
                    </div>
                    {item.detail && <p>{item.detail}</p>}
                    {item.meta && item.meta.length > 0 && (
                      <div className="response-trace-run-item-meta">
                        {item.meta.map((entry) => (
                          <span key={`${item.id}-${entry}`}>{entry}</span>
                        ))}
                      </div>
                    )}
                    {item.phaseId === 'live-context-fetch' && liveContextSources.length > 0 && expandedSections[item.id] && (
                      <div id={`${item.id}-sources`} className="response-trace-source-dropdown">
                        {liveContextSources.map((source) => (
                          <a
                            key={source.id}
                            className={`response-trace-source-dropdown-item ${source.status}`}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <div className="response-trace-source-dropdown-top">
                              <div className="response-trace-source-dropdown-line">
                                <span className="response-trace-source-dropdown-duration">
                                  {formatDuration(source.durationMs) ?? 'n/a'}
                                </span>
                                <strong>{buildSourceIdentity(source)}</strong>
                              </div>
                              <span className="response-trace-source-dropdown-kind">
                                {source.sourceType ?? source.kind}
                              </span>
                            </div>
                            <span className="response-trace-source-dropdown-title">
                              {source.title}
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {trace.packages && trace.packages.length > 0 && (
            <section className="response-trace-section">
              <div className="response-trace-section-head">
                <IconListChecks size={13} />
                <span>Resolved packages</span>
              </div>
              <div className="response-trace-package-list">
                {trace.packages.map((pkg) => (
                  <div key={`${pkg.ecosystem}-${pkg.name}`} className="response-trace-package">
                    <strong>{pkg.name}</strong>
                    <span>{pkg.version}</span>
                    <span>{pkg.ecosystem}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {trace.plannerSteps && trace.plannerSteps.length > 0 && (
            <section className="response-trace-section">
              <div className="response-trace-section-head">
                <IconListChecks size={13} />
                <span>Planned files</span>
              </div>
              <div className="response-trace-step-list">
                {trace.plannerSteps.map((step) => (
                  <div key={`${step.stepNumber}-${step.filePath}`} className={`response-trace-step ${step.status}`}>
                    <div className="response-trace-step-top">
                      <strong>{step.filePath}</strong>
                      <span>{step.status}</span>
                    </div>
                    <p>{step.purpose}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
