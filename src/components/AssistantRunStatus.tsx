import { type ReactNode, useEffect, useState } from 'react';
import { IconCheck, IconChevronDown, IconChevronUp } from './Icon';
import type { ResponseTrace, ResponseTraceMetric, ResponseTracePhase, ResponseTraceSource, StreamingPhase } from '../types';

interface Props {
  trace?: ResponseTrace;
  chatTitle?: string;
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

interface CodePhaseStep {
  id: string;
  heading: string;
  detail: string;
  status: ResponseTracePhase['status'];
  metrics?: ResponseTraceMetric[];
}

interface CodeRunActionEntry {
  id: string;
  kind: 'file' | 'command';
  label: string;
  status: ResponseTracePhase['status'];
  added?: number;
  removed?: number;
}

type CodeRunFeedItem =
  | {
      id: string;
      type: 'insight';
      detail: string;
      status: ResponseTracePhase['status'];
    }
  | {
      id: string;
      type: 'action';
      entry: CodeRunActionEntry;
      status: ResponseTracePhase['status'];
    }
  | {
      id: string;
      type: 'group';
      summary: string;
      items: CodeRunActionEntry[];
      status: ResponseTracePhase['status'];
    };

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

function metricText(metrics: ResponseTraceMetric[] | undefined, label: string): string | null {
  const metric = metrics?.find((item) => item.label.toLowerCase() === label.toLowerCase());
  const value = normalizeText(metric?.value);
  return value || null;
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
    'read-technical-docs',
    'resolve-packages',
    'extract-crew-roster',
    'context-assembly',
    'verify-live-sources',
    'reply-stream',
  ], { status: 'running' })?.id;

  if (hasStreamingContent || runningPhaseId === 'reply-stream') {
    return 'answering';
  }

  if (runningPhaseId && ['prompt-url-fetch', 'live-context-fetch', 'read-technical-docs', 'resolve-packages'].includes(runningPhaseId)) {
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

function buildPhaseMetricSummary(metrics?: ResponseTraceMetric[]): string {
  if (!metrics?.length) return '';
  return metrics
    .map((metric) => `${metric.label}: ${metric.value}`)
    .join(' · ');
}

function buildCodePhaseSteps(
  trace: ResponseTrace | undefined,
  streamingPhase: StreamingPhase | null | undefined,
  isStreaming: boolean,
): CodePhaseStep[] {
  const phases = (trace?.phases ?? [])
    .filter((phase) => normalizeText(phase.label))
    .map((phase) => ({
      id: phase.id,
      heading: normalizeText(phase.label),
      detail: normalizeText(phase.detail) || buildPhaseMetricSummary(phase.metrics),
      status: phase.status,
      metrics: phase.metrics,
    }));

  if (!phases.length && streamingPhase?.label) {
      return [{
      id: 'workspace-run',
      heading: normalizeText(streamingPhase.label),
      detail: '',
      status: isStreaming ? 'running' : 'completed',
      metrics: undefined,
    }];
  }

  return phases;
}

function mergeCodePhaseStatus(
  current: ResponseTracePhase['status'],
  next: ResponseTracePhase['status'],
): ResponseTracePhase['status'] {
  if (current === 'error' || next === 'error') return 'error';
  if (current === 'running' || next === 'running') return 'running';
  if (current === 'completed' || next === 'completed') return 'completed';
  if (current === 'skipped') return next;
  return current;
}

function extractCodeRunStepPath(step: CodePhaseStep): string {
  const metricPath = metricText(step.metrics, 'File') ?? metricText(step.metrics, 'Path');
  if (metricPath) return metricPath;

  const normalizedHeading = normalizeText(step.heading);
  const headingMatch = normalizedHeading.match(/(?:reading|writing|syncing|repairing)\s+(.+)$/i);
  if (headingMatch?.[1]) return headingMatch[1];

  const detailMatch = normalizeText(step.detail).match(/\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/);
  if (detailMatch?.[1]) return detailMatch[1];

  return normalizedHeading;
}

function extractCodeRunCommandLabel(step: CodePhaseStep): string {
  const metricCommand = metricText(step.metrics, 'Command');
  if (metricCommand) return metricCommand;

  const idCommand = step.id.match(/^(?:install|test):(.+)$/)?.[1];
  if (idCommand) return normalizeText(idCommand);

  const normalizedHeading = normalizeText(step.heading);
  const installHeading = normalizedHeading.match(/^Installing dependencies with\s+(.+)$/i)?.[1];
  if (installHeading) return normalizeText(installHeading);

  const testingHeading = normalizedHeading.match(/^Testing\s+(.+)$/i)?.[1];
  if (testingHeading) return normalizeText(testingHeading);

  const previewHeading = normalizedHeading.match(/^Previewing\s+(.+)$/i)?.[1];
  if (previewHeading) return normalizeText(previewHeading);

  const normalizedDetail = normalizeText(step.detail);
  const backtickMatch = normalizedDetail.match(/`([^`]+)`/);
  if (backtickMatch?.[1]) return backtickMatch[1];

  const commandMatch = normalizedDetail.match(/\b(?:npm|pnpm|yarn|bun|go|cargo|python|pytest|vite|node)\b[^\n.;]*/i);
  if (commandMatch?.[0]) return commandMatch[0].trim();

  return normalizedHeading;
}

function phaseIdHasSegment(id: string, segment: string): boolean {
  const escapedSegment = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|-)${escapedSegment}-\\d+(?:$|-)`).test(id);
}

function isCodeRunFileStep(step: CodePhaseStep): boolean {
  return phaseIdHasSegment(step.id, 'sync-step');
}

function isCodeRunCommandStep(step: CodePhaseStep): boolean {
  return /^(install:|test:|preview-web-app)$/.test(step.id) || /^(install:|test:)/.test(step.id);
}

function summarizeCodeInsight(step: CodePhaseStep): string | null {
  if (isCodeRunFileStep(step) || isCodeRunCommandStep(step)) return null;
  const detail = normalizeText(step.detail);
  if (!detail) return null;
  const stepPath = extractCodeRunStepPath(step);

  if (/^(loaded the live workspace context|wrote .* into the live workspace|.+ is now saved in the live workspace|phase completed|completed the latest workspace operation)/i.test(detail)) {
    return null;
  }

  if (/^Matched \d+ previously rated reply preference/i.test(detail)) {
    return 'I matched earlier response preferences for this kind of request and folded them into the run.';
  }

  if (/^Saved a workspace restore point/i.test(detail)) {
    return 'I saved a restore point before making changes so this run can be rolled back cleanly if needed.';
  }

  if (/^No readable workspace files were found/i.test(detail)) {
    return 'I didn’t find reusable workspace files, so I’m treating this as a fresh build and planning from the request.';
  }

  if (/^Classified as /i.test(detail)) {
    const classifiedAs = detail.replace(/^Classified as\s+/i, '').replace(/\.$/, '');
    return `I classified this request as ${classifiedAs} so the workspace can follow the right path.`;
  }

  if (/^Planned \d+ implementation steps?\./i.test(detail)) {
    const stepCount = detail.match(/^Planned (\d+) implementation step/i)?.[1];
    return `I mapped the request into ${stepCount ?? 'a set of'} concrete implementation steps so I can work through the files in order.`;
  }

  if (/^Resolved \d+ package versions?/i.test(detail)) {
    return 'I checked the current package versions before writing dependencies and config.';
  }

  if (/^Technical doc lookup exceeded/i.test(detail)) {
    return 'Live docs were too slow on this pass, so I kept moving from the workspace context and targeted repair checks instead.';
  }

  if (/^Fetched \d+ repair reference source/i.test(detail)) {
    return 'I pulled targeted repair references around the failing validation before planning the fix.';
  }

  if (/^No additional repair docs were fetched/i.test(detail)) {
    return 'I did not get useful repair references back, so the fix is continuing from the workspace state and the failing output itself.';
  }

  if (/^Repair doc lookup failed/i.test(detail)) {
    return 'Issue found: repair documentation lookup failed, so the fix is continuing from the workspace alone.';
  }

  if (/^Planned \d+ repair steps?/i.test(detail)) {
    return detail.replace(/^Planned /i, 'I planned ');
  }

  if (/^No concrete repair steps were planned/i.test(detail)) {
    return 'Issue found: the repair planner did not produce a usable fix, so another repair pass is needed.';
  }

  if (/^Repaired the step output so /i.test(detail)) {
    return `I repaired the generated output for ${stepPath} so it could be written cleanly.`;
  }

  if (/^The repaired output still did not produce a usable file block for /i.test(detail)) {
    return `Issue found: I still couldn’t turn ${stepPath} into a valid file, so it needs another repair pass.`;
  }

  if (/^Regenerated the plan with defined file extensions/i.test(detail)) {
    return 'I corrected the file plan so every generated file has a defined type before execution starts.';
  }

  if (/^The planner still proposed invalid file paths:/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (/^Reply preference memory could not be applied/i.test(detail)) {
    return 'I could not apply saved response preferences before continuing, so this run is proceeding without them.';
  }

  if (/^(Prompt classification failed|Linked page fetching failed|Live context fetching failed)/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (/^Generated the chat title |^Updated the final developer-facing summary\.|^Completed the final reply stream\./i.test(detail)) {
    return null;
  }

  if (/^The live workspace commit failed/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (/^(execute-step-|repair-step-)/.test(step.id)) {
    const parts = detail.split(/\s+[—-]\s+/);
    if (parts.length >= 2) {
      const purpose = parts.slice(1).join(' - ').replace(/\.$/, '');
      return `I’m working on ${parts[0]} to ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}.`;
    }
  }

  if (/^Generated an internal draft of /i.test(detail)) {
    return null;
  }

  return detail;
}

function normalizeInsightSentence(value: string, status: ResponseTracePhase['status']): string {
  const detail = decodeEntities(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!detail) return '';
  const withPrefix = status === 'error' && !/^issue found[:,-]?/i.test(detail)
    ? `Issue found: ${detail}`
    : detail;
  return /[.!?]$/.test(withPrefix) || /\n\d+\.\s/.test(withPrefix) ? withPrefix : `${withPrefix}.`;
}

function summarizeCodeInsightForFeed(step: CodePhaseStep): string | null {
  void summarizeCodeInsight(step);
  if (isCodeRunFileStep(step) || isCodeRunCommandStep(step)) return null;
  const detail = normalizeText(step.detail);
  if (!detail) return null;
  const stepPath = extractCodeRunStepPath(step);

  if (/^(loaded the live workspace context|wrote .* into the live workspace|.+ is now saved in the live workspace|phase completed|completed the latest workspace operation)/i.test(detail)) {
    return null;
  }

  if (/^Matched \d+ previously rated reply preference/i.test(detail)) {
    return 'I matched earlier response preferences for this kind of request and folded them into the run.';
  }

  if (/^Saved a workspace restore point/i.test(detail)) {
    return 'I saved a restore point before making changes so this run can be rolled back cleanly if needed.';
  }

  if (/^No readable workspace files were found/i.test(detail)) {
    return 'I did not find reusable workspace files, so I am treating this as a fresh build and planning from the request.';
  }

  if (/^Classified as /i.test(detail)) {
    const classifiedAs = detail.replace(/^Classified as\s+/i, '').replace(/\.$/, '');
    return `I classified this request as ${classifiedAs} so the workspace can follow the right path.`;
  }

  if (/^Planned \d+ implementation steps?\./i.test(detail)) {
    const stepCount = detail.match(/^Planned (\d+) implementation step/i)?.[1];
    return `I mapped the request into ${stepCount ?? 'a set of'} concrete implementation steps so I can work through the files in order.`;
  }

  if (/^Resolved \d+ package versions?/i.test(detail)) {
    return 'I checked the current package versions before writing dependencies and config.';
  }

  if (/^Technical doc lookup exceeded/i.test(detail)) {
    return 'Live docs were too slow on this pass, so I kept moving from the workspace context and targeted repair checks instead.';
  }

  if (/^Fetched \d+ repair reference source/i.test(detail)) {
    return 'I pulled targeted repair references around the failing validation before planning the fix.';
  }

  if (/^No additional repair docs were fetched/i.test(detail)) {
    return 'I did not get useful repair references back, so the fix is continuing from the workspace state and the failing output itself.';
  }

  if (/^Repair doc lookup failed/i.test(detail)) {
    return 'Issue found: repair documentation lookup failed, so the fix is continuing from the workspace alone.';
  }

  if (/^Planned \d+ repair steps?/i.test(detail)) {
    return detail.replace(/^Planned /i, 'I planned ');
  }

  if (/^No concrete repair steps were planned/i.test(detail)) {
    return 'Issue found: the repair planner did not produce a usable fix, so another repair pass is needed.';
  }

  if (/^Repaired the step output so /i.test(detail)) {
    return `I repaired the generated output for ${stepPath} so it could be written cleanly.`;
  }

  if (/^The repaired output still did not produce a usable file block for /i.test(detail)) {
    return `Issue found: I still could not turn ${stepPath} into a valid file, so it needs another repair pass.`;
  }

  if (/^Regenerated the plan with defined file extensions/i.test(detail)) {
    return 'I corrected the file plan so every generated file has a defined type before execution starts.';
  }

  if (/^The planner still proposed invalid file paths:/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (/^Reply preference memory could not be applied/i.test(detail)) {
    return 'I could not apply saved response preferences before continuing, so this run is proceeding without them.';
  }

  if (/^(Prompt classification failed|Linked page fetching failed|Live context fetching failed)/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (/^Generated the chat title |^Updated the final developer-facing summary\.|^Completed the final reply stream\./i.test(detail)) {
    return null;
  }

  if (/^The live workspace commit failed/i.test(detail)) {
    return `Issue found: ${detail}`;
  }

  if (phaseIdHasSegment(step.id, 'execute-step') || phaseIdHasSegment(step.id, 'repair-step')) {
    const parts = detail.split(/\s+-\s+/);
    if (parts.length >= 2) {
      const purpose = parts.slice(1).join(' - ').replace(/\.$/, '');
      return `I am working on ${parts[0]} to ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}.`;
    }
  }

  if (/^Generated an internal draft of /i.test(detail)) {
    return null;
  }

  return detail;
}

function lowercaseLeadingCharacter(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function parseCodeWorkDescriptor(step: CodePhaseStep): { path: string; purpose: string } | null {
  const detail = normalizeText(step.detail);
  const match = detail.match(/^(.+?)\s+(?:-|—|â€”)\s+(.+)$/);
  if (!match) return null;
  return {
    path: match[1].trim(),
    purpose: match[2].trim().replace(/\.$/, ''),
  };
}

function findAdjacentCodeWorkStep(
  steps: CodePhaseStep[],
  startIndex: number,
  direction: 1 | -1,
): CodePhaseStep | null {
  for (let index = startIndex + direction; index >= 0 && index < steps.length; index += direction) {
    const candidate = steps[index];
    if (phaseIdHasSegment(candidate.id, 'execute-step') || phaseIdHasSegment(candidate.id, 'repair-step')) {
      return candidate;
    }
  }
  return null;
}

function buildPlanOutline(steps: CodePhaseStep[], startIndex: number, limit = 4): string[] {
  const lines: string[] = [];
  const seenPaths = new Set<string>();

  for (let index = startIndex + 1; index < steps.length && lines.length < limit; index += 1) {
    const candidate = steps[index];
    const work = parseCodeWorkDescriptor(candidate);
    if (!work || seenPaths.has(work.path)) continue;

    seenPaths.add(work.path);
    const actionVerb = phaseIdHasSegment(candidate.id, 'repair-step') ? 'Patch' : 'Update';
    lines.push(`${lines.length + 1}. ${actionVerb} ${work.path} so ${lowercaseLeadingCharacter(work.purpose)}.`);
  }

  return lines;
}

function buildFocusedFileList(detail: string): string[] {
  const focusMatch = detail.match(/Focused files:\s*(.+?)(?:\.|$)/i)?.[1];
  if (!focusMatch) return [];

  return focusMatch
    .split(',')
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

function buildNarrativeParagraph(
  sentences: Array<string | null | undefined>,
  options: { planLines?: string[] } = {},
): string {
  const paragraph = sentences
    .map((sentence) => normalizeText(sentence ?? ''))
    .filter(Boolean)
    .join(' ');

  if (!options.planLines?.length) {
    return paragraph;
  }

  return `${paragraph}\n\nPlan from here:\n${options.planLines.join('\n')}`;
}

function isSilentNarrativeCodeStep(step: CodePhaseStep): boolean {
  const detail = normalizeText(step.detail);
  if (!detail) return true;
  if (isCodeRunFileStep(step) || isCodeRunCommandStep(step)) return true;

  if (
    phaseIdHasSegment(step.id, 'read-step')
    || phaseIdHasSegment(step.id, 'sync-step')
    || /^(reply-preferences|backup-workspace|read-workspace-files|classify-request|read-technical-docs|resolve-packages|repair-docs-\d+|title-generation|review-reply|rewrite-reply|final-review-reply|reply-stream)$/.test(step.id)
  ) {
    return true;
  }

  return /^(Matched \d+ previously rated reply preference|Saved a workspace restore point|No workspace backup was created|Read \d+ readable workspace file|No readable workspace files were found|Classified as |Resolved \d+ package versions?|Package metadata lookup exceeded|No package versions could be resolved|Technical doc lookup exceeded|Fetched \d+ technical reference source|No technical reference pages returned usable content|Fetched \d+ repair reference source|No additional repair docs were fetched|Reply preference memory could not be applied|Loaded the live workspace context|Completed .*\.|Edited .*\.|Generated the chat title |Updated the final developer-facing summary\.|Completed the final reply stream\.)/i.test(detail);
}

function buildCodeInsightParagraph(steps: CodePhaseStep[], index: number): string | null {
  const step = steps[index];
  void summarizeCodeInsightForFeed(step);
  if (isSilentNarrativeCodeStep(step)) return null;

  const detail = normalizeText(step.detail);
  const work = parseCodeWorkDescriptor(step);
  const nextWorkStep = findAdjacentCodeWorkStep(steps, index, 1);
  const nextWork = nextWorkStep ? parseCodeWorkDescriptor(nextWorkStep) : null;

  if (step.id === 'understand-request') {
    return detail;
  }

  if (step.id === 'plan-request') {
    const stepCount = detail.match(/^Planned (\d+) implementation step/i)?.[1] ?? 'a set of';
    const planLines = buildPlanOutline(steps, index);
    return buildNarrativeParagraph([
      `I've broken the request into ${stepCount} concrete implementation steps so the run has a stable order instead of improvising file by file.`,
      nextWork
        ? `I'm starting with ${nextWork.path} because it needs to ${lowercaseLeadingCharacter(nextWork.purpose)} before the surrounding files can connect to something real.`
        : 'I\'m finalizing the first execution pass now so the opening writes land in the right sequence.',
      'That lets me build against the actual workspace state as it changes, rather than planning the whole run against assumptions that go stale after the first edit.',
      'Once this first piece lands, I\'ll keep moving through the adjacent files in order so each new step inherits from code that already exists.',
    ], { planLines });
  }

  if (step.id === 'inspect-runtime') {
    return buildNarrativeParagraph([
      'I\'m reviewing the package and config layer first so the validation pass uses the real install, build, test, and preview commands for this project.',
      'That keeps the run anchored to what this workspace actually is, instead of falling back to generic framework guesses.',
      'I\'m also checking the entrypoints and runtime wiring here, because a project can build cleanly and still fail to boot if the app starts from the wrong file.',
    ]);
  }

  if (step.id === 'normalize-web-entry-files') {
    return buildNarrativeParagraph([
      'I found overlapping React or Vite entry files in the workspace, which is exactly the kind of thing that causes blank screens and misleading build results.',
      'I\'m stripping the stale variants now so the app keeps one canonical entry path instead of two competing boot files.',
      'Once that is clean, the next validation pass can tell us whether the real app works instead of whichever duplicate file happened to win the import path.',
    ]);
  }

  if (step.id === 'refresh-dependencies') {
    return buildNarrativeParagraph([
      'I\'m refreshing the dependency tree now so the next validation run uses a clean install instead of stale local modules.',
      'This is where version mismatches, broken lockfile state, and bad peer dependencies usually surface, so I want that noise out of the way before I trust any build result.',
      'If a package version is wrong, this pass gives me the exact failure text I need for the repair loop instead of a vague downstream error.',
    ]);
  }

  if (step.id === 'audit-workspace') {
    return buildNarrativeParagraph([
      'Before I trust the runtime checks, I\'m auditing the generated files and their references from the workspace itself.',
      'I\'m looking for missing entrypoints, duplicate boot files, broken relative imports, and files that were created under the wrong names or extensions.',
      'Catching that here is faster than waiting for a later build or preview to fail in a less specific way.',
    ]);
  }

  if (step.id === 'setup-guide') {
    return buildNarrativeParagraph([
      'The code changes are in place, and I\'m updating setup.md so the workspace documents how this version actually installs, runs, and validates.',
      'I want that guide tied to the current project state instead of a generic scaffold explanation that drifts away from the real files.',
      'That way the next run, or the next person opening this workspace, gets instructions that match the commands and paths that really exist right now.',
    ]);
  }

  if (step.id === 'repair-plan-file-types') {
    return buildNarrativeParagraph([
      'The first plan still had ambiguous file paths, so I\'m correcting the file names and extensions before I write anything else.',
      'If I let that stand, the run can create duplicate files or put valid code under the wrong path, which makes every later step harder to trust.',
      'I\'m cleaning the plan now so the next writes land in real, typed files the editor and validation pipeline can understand.',
    ]);
  }

  if (/^repair-plan-\d+$/.test(step.id)) {
    const focusedFiles = buildFocusedFileList(detail);
    const planLines = buildPlanOutline(steps, index);
    return buildNarrativeParagraph([
      focusedFiles.length > 0
        ? `I narrowed the repair path to ${focusedFiles.join(', ')} and I\'m using that failure output to shape the next fix.`
        : 'A validation problem surfaced, so I\'m turning the failing output into a targeted repair plan before the next retry.',
      'I do not want a blind second pass here, because that usually just changes nearby files without removing the actual blocker.',
      'This repair plan is being built from the command failure, the focused files, and the current workspace state so the next retry has a real chance to clear the issue.',
      'Once the repair steps are locked, I\'ll patch those files and send the workspace straight back through validation.',
    ], { planLines });
  }

  if (phaseIdHasSegment(step.id, 'repair-step') && work) {
    return buildNarrativeParagraph([
      `The previous draft for ${work.path} still was not usable in the workspace, so I\'m rewriting that file cleanly now.`,
      `I\'m keeping the repair focused on ${lowercaseLeadingCharacter(work.purpose)} so I fix the actual blocker without destabilizing the surrounding files.`,
      nextWork && nextWork.path !== work.path
        ? `When this version is stable, I\'ll move back into ${nextWork.path} so the repaired flow connects cleanly across the next file.`
        : 'As soon as this lands, I\'ll push it back through sync and validation so the next pass tests the repaired file instead of the broken draft.',
    ]);
  }

  if (phaseIdHasSegment(step.id, 'execute-step') && work) {
    return buildNarrativeParagraph([
      `I\'m in ${work.path} right now because this file needs to ${lowercaseLeadingCharacter(work.purpose)}.`,
      'I want this piece solid before I move on, because the surrounding files are going to inherit their imports, config, or structure from what lands here.',
      nextWork && nextWork.path !== work.path
        ? `When this write is finished, I\'ll move into ${nextWork.path} so the next file is built against the version that actually exists in the workspace.`
        : 'After this write lands, I\'ll keep the next step tied to the current workspace state instead of planning ahead in a vacuum.',
    ]);
  }

  if (/^Repaired the step output so /i.test(detail)) {
    return buildNarrativeParagraph([
      `The generated draft for ${extractCodeRunStepPath(step)} came back messy enough that it could not be synced safely into the workspace.`,
      'I\'m normalizing that file now so the content matches the target path cleanly and the next step has a stable base to build on.',
      'Once that cleanup is done, the run can keep moving without carrying a malformed file block forward.',
    ]);
  }

  if (/^The repaired output still did not produce a usable file block for /i.test(detail)) {
    return buildNarrativeParagraph([
      'I hit a concrete blocker in this step and the repaired output still did not resolve into a usable workspace file.',
      detail,
      'I\'m treating that failure text as the next repair target instead of pretending the run is still healthy.',
    ]);
  }

  if (/^No concrete repair steps were planned/i.test(detail)) {
    return buildNarrativeParagraph([
      'The repair planner did not produce a concrete fix on this pass, which means I do not have a trustworthy file-level change set yet.',
      'I am not treating that as success, because a vague repair step usually just burns time and misses the actual blocker.',
      'The next pass needs tighter failure localization so the repair loop can come back with specific file edits instead of broad cleanup language.',
    ]);
  }

  if (/^The planner still proposed invalid file paths:/i.test(detail) || /^The live workspace commit failed/i.test(detail)) {
    return buildNarrativeParagraph([
      'I hit a concrete blocker in the workspace pipeline and the run cannot safely keep pretending it is on the happy path.',
      detail,
      'I\'m using that exact failure as the next correction target so the following pass fixes the real break instead of narrating around it.',
    ]);
  }

  if (step.status === 'error' && detail) {
    return buildNarrativeParagraph([
      'This phase hit a real blocker and I\'m treating it like a repair input, not a cosmetic status update.',
      detail,
      'The next move from here is to localize that failure to the exact file, command, or config edge that caused it.',
    ]);
  }

  return null;
}

function buildCodeRunActionEntry(step: CodePhaseStep): CodeRunActionEntry {
  return {
    id: step.id,
    kind: isCodeRunFileStep(step) ? 'file' : 'command',
    label: isCodeRunFileStep(step) ? extractCodeRunStepPath(step) : extractCodeRunCommandLabel(step),
    status: step.status,
    added: isCodeRunFileStep(step) ? metricValue(step.metrics, 'Added') ?? 0 : undefined,
    removed: isCodeRunFileStep(step) ? metricValue(step.metrics, 'Removed') ?? 0 : undefined,
  };
}

function buildActionGroupSummary(items: CodeRunActionEntry[]): string {
  const fileCount = items.filter((entry) => entry.kind === 'file').length;
  const commandCount = items.filter((entry) => entry.kind === 'command').length;

  if (fileCount > 0 && commandCount > 0) {
    return `Edited ${fileCount} file${fileCount === 1 ? '' : 's'}, ran ${commandCount} command${commandCount === 1 ? '' : 's'}`;
  }

  if (fileCount > 0) {
    return `Edited ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  }

  return `Ran ${commandCount} command${commandCount === 1 ? '' : 's'}`;
}

function buildDeferredCodeRunFeed(
  steps: CodePhaseStep[],
  options: { compactTrailingActions?: boolean } = {},
): CodeRunFeedItem[] {
  const feed: CodeRunFeedItem[] = [];
  let pendingActions: {
    items: CodeRunActionEntry[];
    status: ResponseTracePhase['status'];
  } | null = null;

  const flushPendingActions = (mode: 'group' | 'individual') => {
    if (!pendingActions || pendingActions.items.length === 0) {
      pendingActions = null;
      return;
    }

    if (mode === 'group' && pendingActions.items.length > 1) {
      feed.push({
        id: `group-${pendingActions.items[0].id}`,
        type: 'group',
        summary: buildActionGroupSummary(pendingActions.items),
        items: [...pendingActions.items],
        status: pendingActions.status,
      });
    } else {
      for (const entry of pendingActions.items) {
        feed.push({
          id: `${entry.kind}-${entry.id}`,
          type: 'action',
          entry,
          status: entry.status,
        });
      }
    }

    pendingActions = null;
  };

  for (const [stepIndex, step] of steps.entries()) {
    const actionKind = isCodeRunFileStep(step)
      ? 'file'
      : isCodeRunCommandStep(step)
        ? 'command'
        : null;

    if (actionKind) {
      const entry = buildCodeRunActionEntry(step);
      if (!pendingActions) {
        pendingActions = { items: [entry], status: step.status };
      } else {
        pendingActions.items.push(entry);
        pendingActions.status = mergeCodePhaseStatus(pendingActions.status, step.status);
      }
      continue;
    }

    flushPendingActions('group');
    const summary = buildCodeInsightParagraph(steps, stepIndex);
    if (!summary) continue;
    feed.push({
      id: `insight-${step.id}`,
      type: 'insight',
      detail: normalizeInsightSentence(summary, step.status),
      status: step.status,
    });
  }

  flushPendingActions(options.compactTrailingActions ? 'group' : 'individual');
  return feed;
}

function getNextTypingLength(target: string, currentLength: number): number {
  if (currentLength >= target.length) return target.length;

  let nextLength = currentLength;
  while (nextLength < target.length && /\s/.test(target.charAt(nextLength))) {
    nextLength += 1;
  }
  while (nextLength < target.length && !/\s/.test(target.charAt(nextLength))) {
    nextLength += 1;
  }
  while (nextLength < target.length && /\s/.test(target.charAt(nextLength))) {
    nextLength += 1;
  }

  return Math.max(currentLength + 1, nextLength);
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(query.matches);
    const handleChange = () => setPrefersReducedMotion(query.matches);

    query.addEventListener?.('change', handleChange);
    return () => query.removeEventListener?.('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

function TypingText({
  text,
  active,
  className,
  as = 'span',
}: {
  text: string;
  active: boolean;
  className?: string;
  as?: 'p' | 'span' | 'div';
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = active && !prefersReducedMotion && text.length > 0;
  const [visibleText, setVisibleText] = useState(() => (shouldAnimate ? '' : text));

  useEffect(() => {
    if (!shouldAnimate) {
      setVisibleText(text);
      return;
    }

    setVisibleText((current) => (text.startsWith(current) ? current : ''));
  }, [shouldAnimate, text]);

  useEffect(() => {
    if (!shouldAnimate || visibleText.length >= text.length) return undefined;

    const delay = /[.!?]\s*$/.test(visibleText) ? 95 : 34;
    const timeout = window.setTimeout(() => {
      setVisibleText((current) => text.slice(0, getNextTypingLength(text, current.length)));
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [shouldAnimate, text, visibleText]);

  const content = (
    <>
      {visibleText}
      {shouldAnimate && visibleText.length < text.length && (
        <span className="assistant-run-status-typing-caret" aria-hidden="true" />
      )}
    </>
  );

  if (as === 'p') {
    return <p className={className} aria-label={text}>{content}</p>;
  }

  if (as === 'div') {
    return <div className={className} aria-label={text}>{content}</div>;
  }

  return <span className={className} aria-label={text}>{content}</span>;
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
  chatTitle,
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
  const [expandedFeedGroups, setExpandedFeedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const firstThinking = buildFirstThinkingStep(trace);
  const secondThinking = buildSecondThinkingStep(trace, isStreaming);
  const readingDetail = buildReadingDetail(trace);
  const activeStage = inferActiveStage(trace, isStreaming, streamingPhase, hasStreamingContent);
  const durationLabel = formatDuration(liveResponseMs ?? trace?.totalDurationMs);
  const codePhaseSteps = trace?.surface === 'code'
    ? buildCodePhaseSteps(trace, streamingPhase, isStreaming)
    : [];
  const codeRunFeed = trace?.surface === 'code'
    ? buildDeferredCodeRunFeed(codePhaseSteps, { compactTrailingActions: !isStreaming })
    : [];
  const codeSummaryLabel = isStreaming
    ? `Working for ${durationLabel ?? '0s'}`
    : `Worked for ${durationLabel ?? '0s'}`;
  const summaryLabel = trace?.surface === 'code'
    ? codeSummaryLabel
    : isStreaming
      ? 'Thinking'
      : `Thought for ${durationLabel ?? '0s'}`;
  const sources = preferredSources(trace);
  const sourceIcons = sources.slice(0, 3);
  const showReplyOutput = replyContent != null || !isStreaming || activeStage === 'answering';
  const outputLabel = isStreaming
    ? (hasStreamingContent ? 'Answering' : 'Preparing reply')
    : 'Done';
  const stepsCountLabel = trace?.surface === 'code'
    ? `${codeRunFeed.length || 1} update${(codeRunFeed.length || 1) === 1 ? '' : 's'}`
    : '3 steps';
  const replyTitle = normalizeText(chatTitle) || 'Untitled conversation';
  const outputBody = replyContent != null
    ? <div className="assistant-run-status-output-body">{replyContent}</div>
    : (
        <div className={`assistant-run-status-step-kicker assistant-run-status-step-kicker-done${isStreaming ? ' is-live' : ''}`}>
          {outputLabel}
        </div>
      );

  function renderCodeRunEntry(entry: CodeRunActionEntry, options: { key?: string; nested?: boolean } = {}) {
    return (
      <div
        key={options.key ?? entry.id}
        className={`assistant-run-status-feed-action-line is-${entry.kind}${entry.status === 'error' ? ' is-error' : ''}${options.nested ? ' is-nested' : ''}`}
      >
        <span className="assistant-run-status-feed-action-prefix">
          {entry.kind === 'file' ? 'Edited' : 'Ran'}
        </span>
        <span className="assistant-run-status-feed-action-label">{entry.label}</span>
        {entry.kind === 'file' && (
          <div className="assistant-run-status-feed-action-metrics">
            <span className={`assistant-run-status-feed-action-metric is-added${(entry.added ?? 0) === 0 ? ' is-zero' : ''}`}>
              +{entry.added ?? 0}
            </span>
            <span className={`assistant-run-status-feed-action-metric is-removed${(entry.removed ?? 0) === 0 ? ' is-zero' : ''}`}>
              -{entry.removed ?? 0}
            </span>
          </div>
        )}
      </div>
    );
  }

  function renderOutputRow(mode: 'inline' | 'standalone') {
    if (!showReplyOutput) return null;

    return (
      <div className={`assistant-run-status-final assistant-run-status-final-${mode}${activeStage === 'answering' ? ' is-active' : ''}`}>
        <span className={`assistant-run-status-final-marker${isStreaming ? ' is-live' : ' is-done'}`} aria-hidden="true">
          {!isStreaming ? <IconCheck size={9} /> : null}
        </span>
        <div className="assistant-run-status-final-copy">
          <div className="assistant-run-status-step-kicker">Replied</div>
          <div className="assistant-run-status-step-heading">{replyTitle}</div>
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
            <span className="assistant-run-status-count">{stepsCountLabel}</span>
            {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </button>
        </div>

        {open && trace?.surface === 'code' && (
          <div className="assistant-run-status-code-feed">
            {codeRunFeed.map((item) => {
              if (item.type === 'insight') {
                return (
                  <div
                    key={item.id}
                    className={`assistant-run-status-feed-item is-insight${item.status === 'running' ? ' is-active' : ''}${item.status === 'error' ? ' is-error' : ''}`}
                  >
                    <TypingText
                      as="p"
                      className="assistant-run-status-feed-item-detail"
                      text={item.detail}
                      active={isStreaming}
                    />
                  </div>
                );
              }

              if (item.type === 'action') {
                return (
                  <div
                    key={item.id}
                    className={`assistant-run-status-feed-item is-action${item.status === 'running' ? ' is-active' : ''}${item.status === 'error' ? ' is-error' : ''}`}
                  >
                    {renderCodeRunEntry(item.entry)}
                  </div>
                );
              }

              const isExpanded = expandedFeedGroups[item.id] ?? false;
              return (
                <div
                  key={item.id}
                  className={`assistant-run-status-feed-item is-group${item.status === 'running' ? ' is-active' : ''}${item.status === 'error' ? ' is-error' : ''}`}
                >
                  <button
                    type="button"
                    className="assistant-run-status-feed-group-toggle"
                    onClick={() => {
                      setExpandedFeedGroups((current) => ({
                        ...current,
                        [item.id]: !isExpanded,
                      }));
                    }}
                    aria-expanded={isExpanded}
                  >
                    <span className="assistant-run-status-feed-group-summary">{item.summary}</span>
                    <span className="assistant-run-status-feed-group-icon">
                      {isExpanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="assistant-run-status-feed-group-list">
                      {item.items.map((entry) => renderCodeRunEntry(entry, { key: entry.id, nested: true }))}
                    </div>
                  )}
                </div>
              );
            })}

            {isStreaming && !hasStreamingContent && (
              <div className="assistant-run-status-feed-footer">
                Thinking
              </div>
            )}

            {!isStreaming && renderOutputRow('standalone')}
          </div>
        )}

        {open && trace?.surface !== 'code' && (
          <div className="assistant-run-status-list">
            <div className={`assistant-run-status-step${activeStage === 'thinking-1' ? ' is-active' : ''}`}>
              <span className="assistant-run-status-step-marker" aria-hidden="true" />
              <div className="assistant-run-status-step-copy">
                <div className="assistant-run-status-step-kicker">Thinking</div>
                <div className="assistant-run-status-step-heading">{firstThinking.heading}</div>
                <TypingText
                  as="p"
                  className="assistant-run-status-step-detail"
                  text={firstThinking.detail}
                  active={isStreaming}
                />
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
                {readingDetail && (
                  <TypingText
                    as="p"
                    className="assistant-run-status-step-detail"
                    text={readingDetail}
                    active={isStreaming}
                  />
                )}
              </div>
            </div>

            <div className={`assistant-run-status-step${activeStage === 'thinking-2' ? ' is-active' : ''}`}>
              <span className="assistant-run-status-step-marker" aria-hidden="true" />
              <div className="assistant-run-status-step-copy">
                <div className="assistant-run-status-step-kicker">Thinking</div>
                <div className="assistant-run-status-step-heading">{secondThinking.heading}</div>
                <TypingText
                  as="p"
                  className="assistant-run-status-step-detail"
                  text={secondThinking.detail}
                  active={isStreaming}
                />
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
