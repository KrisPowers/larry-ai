// FILE: src/components/ChatPanel.tsx
import { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { ChatComposer, type ChatComposerOption } from './ChatComposer';
import { MessageBubble } from './MessageBubble';
import { FileRegistryPanel } from './FileRegistryPanel';
import { ChecklistIndicator } from './ChecklistIndicator';
import { getModelProvider, resolveModelHandle, streamChat } from '../lib/ollama';
import { classifyRequest, resolvePackageVersions, planRequest, buildStepUserMessage, getStepExecutorSystem, buildSummaryUserMessage, getSummarySystem, packageVersionsToSystemInject } from '../lib/deepPlanner';
import type { DeepStep, PackageVersion } from '../lib/deepPlanner';
import { registryToSystemPrompt, updateRegistry } from '../lib/fileRegistry';
import { extractCodeBlocksForRegistry } from '../lib/markdown';
import { readImportableAttachments } from '../lib/chatAttachments';
import { extractUrlsFromText, fetchUrlsFromPrompt, fetchGlobalContext, getRequiredLiveSourceCount, shouldFetchGlobalContext, urlContextToSystemInject, globalContextToSystemInject, globalContextToConversationInject, extractCrewRosterFromContexts } from '../lib/fetcher';
import type { ExtractedCrewRosterMember, FetchContextDepth, FetchedContext } from '../lib/fetcher';
import { PRESETS, getPreset, DEFAULT_PRESET_ID, describePreset } from '../lib/presets';
import { classifyChatWorkflow } from '../lib/chatMode';
import { useReplyPreferences } from '../hooks/useReplyPreferences';
import { buildReplyPreferenceId, buildReplyPreferenceInject, cleanReplyPreferenceText } from '../lib/replyPreferences';
import {
  IconX,
  IconHexagon,
  IconDownload,
} from './Icon';
import type { ChatReasoningEffort, Panel, Message, ReplyFeedback, ReplyPreferenceRecord, ResponseTrace, ResponseTraceMetric, ResponseTracePhase, ResponseTracePlannerStep, ResponseTraceSource, ThreadType } from '../types';
import type { FileRegistry } from '../lib/fileRegistry';

interface Props {
  panel: Panel;
  models: string[];
  showDeveloperTools?: boolean;
  showAdvancedUse?: boolean;
  onUpdate: (id: string, patch: Partial<Panel>) => void;
  onClose: (id: string) => void;
  onSave: (panel: Panel) => void;
  selected?: boolean;
  backgroundMode?: boolean;
  onActivate?: (id: string) => void;
  onImportWorkspaceFiles?: (files: File[]) => void;
  launchPrompt?: string | null;
  onConsumeLaunchPrompt?: (panelId: string) => void;
}

const activeLaunchPromptRuns = new Set<string>();
const MESSAGE_OVERSCAN_PX = 640;
const MESSAGE_STACK_GAP_PX = 12;
const STICKY_SCROLL_THRESHOLD_PX = 96;
const MESSAGE_WHEEL_DAMPING = 0.72;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normaliseTitleComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanTitleSource(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[_*~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampTitle(text: string, maxLength = 48): string {
  const clean = text.trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;

  const shortened = clean.slice(0, maxLength - 1).trimEnd();
  const boundary = shortened.lastIndexOf(' ');
  const safeCut = boundary > 16 ? shortened.slice(0, boundary) : shortened;
  return `${safeCut.trim()}...`;
}

function sentenceCaseTitle(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trimPromptLead(text: string): string {
  const cleaned = cleanTitleSource(text)
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^help\s+me(?:\s+with|\s+to)?\s+/i, '')
    .replace(/^i\s+need\s+(?:help\s+with\s+)?/i, '')
    .replace(/^let'?s\s+/i, '')
    .trim();

  return cleaned || cleanTitleSource(text);
}

function isLikelyConnectivityError(message: string): boolean {
  return /(failed to fetch|fetch failed|networkerror|network error|timed out|timeout|econnrefused|unable to connect|connection refused)/i.test(message);
}

function buildModelErrorHelp(model: string, message: string): string {
  const provider = getModelProvider(model);

  if (provider === 'ollama') {
    if (/requires more system memory/i.test(message)) {
      return 'Ollama is reachable, but the selected model cannot load with the memory currently available. Free RAM, switch to a smaller quantization, or pick a smaller model before retrying.';
    }

    if (isLikelyConnectivityError(message)) {
      return [
        'Make sure Ollama is running and that the configured endpoint is correct:',
        '```bash',
        'OLLAMA_ORIGINS=* ollama serve',
        '```',
      ].join('\n');
    }

    return 'Ollama is reachable and returned the error above. Check the selected model and Ollama runtime resources before retrying.';
  }

  if (provider === 'openai') {
    return 'Check the saved OpenAI API key, model access, and any quota or permission limits for this request.';
  }

  if (provider === 'anthropic') {
    return 'Check the saved Anthropic API key, model access, and any quota or permission limits for this request.';
  }

  return '';
}

function trimReplyLead(text: string): string {
  const cleaned = cleanTitleSource(text)
    .replace(/^(?:hello|hi|hey)[,.!\s]+/i, '')
    .replace(/^(?:sure|absolutely|certainly|of\s+course|okay|ok)[,.!\s]+/i, '')
    .replace(/^i\s+can\s+(?:help|assist)(?:\s+you)?(?:\s+with|\s+by)?\s+/i, '')
    .replace(/^here'?s\s+/i, '')
    .trim();

  return cleaned || cleanTitleSource(text);
}

function titleFromText(text: string, maxWords = 7): string {
  const cleaned = cleanTitleSource(text);
  if (!cleaned) return '';

  const firstLine = cleaned.split(/\s*(?:\n|[.!?])\s+/)[0]?.trim() || cleaned;
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, maxWords);
  return clampTitle(sentenceCaseTitle(words.join(' ')));
}

function isLowSignalPrompt(text: string): boolean {
  const cleaned = cleanTitleSource(text).toLowerCase();
  if (!cleaned) return true;
  if (/^(?:hi|hello|hey|yo|sup|test|ok|okay|thanks|thank you|help)[.!?]*$/.test(cleaned)) {
    return true;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length <= 2 && cleaned.length < 20;
}

function isGenericAssistantReply(text: string): boolean {
  const cleaned = cleanTitleSource(text).toLowerCase();
  return (
    !cleaned ||
    /^(?:how can i help(?: you)?(?: today)?|how can i assist(?: you)?(?: today)?)/.test(cleaned) ||
    /^(?:what can i help you with|what do you need help with)/.test(cleaned)
  );
}

function canAutoManageTitle(currentTitle: string, projectLabel?: string, autoTitle?: string | null): boolean {
  const clean = currentTitle.trim();
  if (!clean) return true;

  if (autoTitle && normaliseTitleComparison(clean) === normaliseTitleComparison(autoTitle)) {
    return true;
  }

  if (/^(?:chat(?:\s+\d+)?|new chat|untitled)$/i.test(clean)) {
    return true;
  }

  if (projectLabel) {
    const workspaceTitlePattern = new RegExp(`^${escapeRegExp(projectLabel.trim())}\\s+chat$`, 'i');
    if (workspaceTitlePattern.test(clean)) return true;
  }

  return false;
}

function deriveAutoChatTitle({
  currentTitle,
  projectLabel,
  prompt,
  assistantReply,
  autoTitle,
}: {
  currentTitle: string;
  projectLabel?: string;
  prompt: string;
  assistantReply?: string;
  autoTitle?: string | null;
}): string | null {
  if (!canAutoManageTitle(currentTitle, projectLabel, autoTitle)) {
    return null;
  }

  const promptTitle = titleFromText(trimPromptLead(prompt));
  if (!assistantReply) {
    return promptTitle || null;
  }

  const replyTitle = titleFromText(trimReplyLead(assistantReply));
  if (isLowSignalPrompt(prompt) && replyTitle && !isGenericAssistantReply(assistantReply)) {
    return replyTitle;
  }

  return promptTitle || replyTitle || null;
}

function exportChatAsMarkdown(panel: Panel): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    `# Chat Log - ${panel.title}`, ``,
    `**Model:** ${panel.model || 'unknown'}  `,
    `**Preset:** ${panel.preset || 'code'}  `,
    ...(panel.projectLabel ? [`**Project:** ${panel.projectLabel}  `] : []),
    `**Exported:** ${date}  `,
    ``, `---`, ``,
  ];
  for (const msg of panel.messages) {
    lines.push(msg.role === 'user' ? '### You' : '### Assistant', '', msg.content, '', '---', '');
  }
  return lines.join('\n');
}

function formatTraceDuration(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getTraceSurface(panel: Panel): ThreadType {
  if (panel.threadType === 'chat' || panel.threadType === 'code' || panel.threadType === 'debug') {
    return panel.threadType;
  }
  return panel.projectId ? 'code' : 'chat';
}

function truncateTracePreview(text: string, maxLength = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatChatReferenceDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

const CORRECTION_PROMPT_RE = /\b(wrong|incorrect|inaccurate|not accurate|not right|still wrong|same info|same answer|same thing|check again|recheck|verify again|double[- ]check|that is false|that can't be right)\b/i;
const CREW_LOOKUP_PROMPT_RE = /\b(crew|crew members?|astronauts?|pilot|commander|mission specialists?|roster|who(?:'s| is| are)? the crew|what are their names|who are they|names?)\b/i;
const DIRECT_CREW_IDENTITY_PROMPT_RE = /\b(who(?:'s| is| are)?(?: the)?|what(?: are| is)?(?: their)? names?|name(?:s)? of|which(?: one)?(?: is| are)? the|pilot|commander|mission specialists?)\b/i;
const CREW_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};
const CREW_ROLE_PRIORITY: Record<string, number> = {
  Commander: 0,
  Pilot: 1,
  'Mission Specialist': 2,
  'Flight Engineer': 3,
  Specialist: 4,
};
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'balanced';
const REASONING_EFFORT_OPTIONS: Array<{ value: ChatReasoningEffort; label: string }> = [
  { value: 'light', label: 'Low' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High' },
  { value: 'extra-high', label: 'Extra High' },
];
const REASONING_EFFORT_CONFIG: Record<ChatReasoningEffort, {
  label: string;
  fetchDepth: FetchContextDepth;
  maxSources: number;
  minLiveSources: number;
  paragraphGuidance: string;
  citationGuidance: string;
  comparisonGuidance: string;
}> = {
  light: {
    label: 'Low',
    fetchDepth: 'standard',
    maxSources: 10,
    minLiveSources: 4,
    paragraphGuidance: 'Keep the answer compact: usually 1 to 2 tight paragraphs or a short list when that is clearer.',
    citationGuidance: 'Reference the strongest supporting source directly only when it materially helps the answer.',
    comparisonGuidance: 'Note major contradictions only when they materially change the conclusion.',
  },
  balanced: {
    label: 'Balanced',
    fetchDepth: 'standard',
    maxSources: 12,
    minLiveSources: 5,
    paragraphGuidance: 'Give a clear medium-depth answer: usually 2 to 3 compact paragraphs unless the user asked for more.',
    citationGuidance: 'Name the strongest supporting sources in the reply when the answer depends on fresh evidence.',
    comparisonGuidance: 'Call out important agreement or disagreement across sources without turning the answer into a report.',
  },
  high: {
    label: 'High',
    fetchDepth: 'deep',
    maxSources: 14,
    minLiveSources: 6,
    paragraphGuidance: 'Give a more complete answer: usually 3 to 5 information-dense paragraphs with concrete dates and implications.',
    citationGuidance: 'Reference the strongest sources directly in the reply and use corroborated details before making precise claims.',
    comparisonGuidance: 'Compare the retrieved sources before answering. Emphasize where the reporting aligns, then explain any material disagreement plainly.',
  },
  'extra-high': {
    label: 'Extra High',
    fetchDepth: 'deep',
    maxSources: 15,
    minLiveSources: 8,
    paragraphGuidance: 'Give a thorough answer: usually 4 to 6 full paragraphs unless the user explicitly wants a short reply.',
    citationGuidance: 'Directly attribute the main status claims to the strongest sources, and prefer facts repeated across multiple independent sources.',
    comparisonGuidance: 'Actively compare source overlap and source conflict. Surface similarities first, then explain opposing reporting and which version looks newest or best supported.',
  },
};

function isCorrectionPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return CORRECTION_PROMPT_RE.test(clean);
}

function isCrewLookupPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return CREW_LOOKUP_PROMPT_RE.test(clean);
}

function isDirectCrewIdentityPrompt(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return DIRECT_CREW_IDENTITY_PROMPT_RE.test(clean);
}

function buildReasoningEffortInject(options: {
  effort: ChatReasoningEffort;
  fetchLiveContext: boolean;
  requiredLiveSourceCount: number;
  targetLiveSourceCount: number;
}): string {
  const config = REASONING_EFFORT_CONFIG[options.effort];
  const lines = [
    '',
    '---',
    '## Reply Depth And Reasoning Effort',
    `Reasoning effort for this chat: ${config.label}.`,
    '- Treat this as the depth and evidence target for the current reply, unless the user explicitly asks for something shorter.',
    '- Higher effort means more corroboration, more careful comparison, and clearer confidence language, not filler.',
    `- ${config.paragraphGuidance}`,
    `- ${config.citationGuidance}`,
    `- ${config.comparisonGuidance}`,
  ];

  if (options.fetchLiveContext) {
    lines.push(
      `- Aim to compare roughly ${options.targetLiveSourceCount} live source${options.targetLiveSourceCount === 1 ? '' : 's'} for freshness-sensitive replies when retrieval can support it.`,
      `- When live research is active, do not rely on a single page or a single outlet. Use at least ${options.requiredLiveSourceCount} verified live source${options.requiredLiveSourceCount === 1 ? '' : 's'} before making current factual claims.`,
      '- Prefer the facts repeated across multiple independent sources, especially when official reporting and major news coverage align.',
      '- If sources materially disagree, say that directly and explain which version appears better supported by freshness, specificity, and corroboration.',
    );
  }

  lines.push('---');
  return lines.join('\n');
}

function extractRequestedCrewRole(text: string): string | null {
  if (/\bcommander\b/i.test(text)) return 'Commander';
  if (/\bpilot\b/i.test(text)) return 'Pilot';
  if (/\bmission specialist(?:s)?\b/i.test(text)) return 'Mission Specialist';
  if (/\bflight engineer\b/i.test(text)) return 'Flight Engineer';
  if (/\bspecialist\b/i.test(text)) return 'Specialist';
  return null;
}

function extractRequestedCrewCount(text: string): number | null {
  const numericMatch = text.match(/\b([1-9])\b(?=[^\n]{0,24}\b(?:crew|astronauts?|members?|people|names?)\b)/i)
    ?? text.match(/\b(?:crew|astronauts?|members?|people|names?)\b[^\n]{0,12}\b([1-9])\b/i);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const lower = text.toLowerCase();
  for (const [label, value] of Object.entries(CREW_COUNT_WORDS)) {
    if (new RegExp(`\\b${label}\\b(?=[^\\n]{0,24}\\b(?:crew|astronauts?|members?|people|names?)\\b)`, 'i').test(lower)
      || new RegExp(`\\b(?:crew|astronauts?|members?|people|names?)\\b[^\\n]{0,12}\\b${label}\\b`, 'i').test(lower)) {
      return value;
    }
  }

  return null;
}

function sortValidatedCrewRoster(roster: ExtractedCrewRosterMember[]): ExtractedCrewRosterMember[] {
  return [...roster].sort((left, right) => {
    const leftPriority = left.role ? (CREW_ROLE_PRIORITY[left.role] ?? 99) : 99;
    const rightPriority = right.role ? (CREW_ROLE_PRIORITY[right.role] ?? 99) : 99;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (right.sourceCount !== left.sourceCount) return right.sourceCount - left.sourceCount;
    if (right.supportScore !== left.supportScore) return right.supportScore - left.supportScore;
    return left.name.localeCompare(right.name);
  });
}

function buildValidatedCrewRosterInject(roster: ExtractedCrewRosterMember[]): string {
  if (!roster.length) return '';
  const lines = sortValidatedCrewRoster(roster).map((member) => (
    `- ${member.name}${member.role ? ` - ${member.role}` : ''} (${member.sourceCount} source${member.sourceCount === 1 ? '' : 's'})`
  ));
  return [
    '',
    '---',
    '## Validated Crew Roster',
    'The following names were derived directly from the fetched live sources and validated before answer generation.',
    'When answering crew or flight-role questions, use only this validated roster and do not add any other names.',
    '',
    ...lines,
    '---',
  ].join('\n');
}

function buildCrewLookupReply(
  roster: ExtractedCrewRosterMember[],
  prompt: string,
  referenceDateLabel: string,
): string {
  const orderedRoster = sortValidatedCrewRoster(roster);
  const requestedRole = extractRequestedCrewRole(prompt);
  const requestedCount = extractRequestedCrewCount(prompt);

  if (!orderedRoster.length) {
    return [
      `As of ${referenceDateLabel}, I could not verify the crew roster from the fetched live sources in this run, so I am not going to guess.`,
      '',
      'Please retry once the live source pass returns enough roster evidence.',
    ].join('\n');
  }

  if (requestedRole) {
    const matchingRoster = orderedRoster.filter((member) => member.role === requestedRole || (requestedRole === 'Mission Specialist' && member.role === 'Specialist'));
    if (!matchingRoster.length) {
      return [
        `As of ${referenceDateLabel}, I could not verify the ${requestedRole.toLowerCase()} from the fetched live sources in this run.`,
        '',
        `Verified crew names from this run: ${orderedRoster.map((member) => member.name).join(', ')}.`,
      ].join('\n');
    }

    if (matchingRoster.length === 1) {
      return `As of ${referenceDateLabel}, the fetched live sources identify ${matchingRoster[0].name} as the ${requestedRole.toLowerCase()}.`;
    }

    return [
      `As of ${referenceDateLabel}, the fetched live sources identify these ${requestedRole.toLowerCase()}s:`,
      '',
      ...matchingRoster.map((member) => `- ${member.name}`),
    ].join('\n');
  }

  const limitedRoster = requestedCount && requestedCount > 0
    ? orderedRoster.slice(0, requestedCount)
    : orderedRoster;

  const lines = [
    `As of ${referenceDateLabel}, the fetched live sources identify these crew members:`,
    '',
    ...limitedRoster.map((member) => `- ${member.name}`),
  ];

  if (requestedCount && orderedRoster.length < requestedCount) {
    lines.push(
      '',
      `I could only verify ${orderedRoster.length} name${orderedRoster.length === 1 ? '' : 's'} from the fetched live sources in this run, so I am not guessing the rest.`,
    );
  }

  return lines.join('\n');
}

function buildCorrectionInject(): string {
  return [
    '',
    '---',
    '## Correction Mode',
    'The user says a previous assistant answer in this conversation was wrong.',
    'Do not repeat, preserve, summarize, or defend earlier assistant claims just because they appeared earlier in the thread.',
    'Re-evaluate the question from the fetched evidence and current user turns only.',
    'If earlier assistant claims conflict with the retrieved evidence, explicitly correct the record and give the corrected answer directly.',
    'For name, crew, roster, or role questions, list only the names and roles explicitly shown in the retrieved sources.',
    'Keep the correction concise and factual instead of repeating a long apology.',
    '---',
  ].join('\n');
}

function buildCrewLookupInject(): string {
  return [
    '',
    '---',
    '## Crew Lookup Mode',
    'The user is asking for crew members, names, or flight roles.',
    'Do not reuse names from earlier assistant replies or from general memory.',
    'Use fetched evidence and current user turns only.',
    'Prefer official roster or crew pages over general mission overview pages.',
    'If the retrieved sources do not explicitly show the names and roles, say they could not be confirmed in this pass instead of inventing them.',
    'Do not include people from another mission, another program, or historical Moon flights.',
    '---',
  ].join('\n');
}

function buildConversationHistoryForReply(messages: Message[], currentUserText: string): Message[] {
  const priorHistory = messages.slice(0, -1);
  if (!isCorrectionPrompt(currentUserText) && !isCrewLookupPrompt(currentUserText)) {
    return priorHistory;
  }

  const userOnlyHistory = priorHistory.filter((message) => message.role === 'user');
  return userOnlyHistory.length ? userOnlyHistory : priorHistory;
}

function findPreviousUserMessage(messages: Message[], assistantIndex: number): Message | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index];
    }
  }
  return null;
}

function buildReplyPreferenceContext(messages: Message[], assistantIndex: number): string {
  const start = Math.max(0, assistantIndex - 4);
  return messages
    .slice(start, assistantIndex)
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncateTracePreview(cleanReplyPreferenceText(message.content), 220)}`;
    })
    .join('\n');
}

function buildReplyPreferenceEntry(options: {
  chatId: string;
  chatTitle: string;
  assistantMessage: Message;
  assistantIndex: number;
  messages: Message[];
  panel: Panel;
  feedback: ReplyFeedback;
}): Omit<ReplyPreferenceRecord, 'createdAt' | 'updatedAt'> | null {
  const promptMessage = findPreviousUserMessage(options.messages, options.assistantIndex);
  if (!promptMessage) return null;

  const cleanedReply = cleanReplyPreferenceText(options.assistantMessage.content);
  if (!cleanedReply.trim()) return null;

  return {
    id: buildReplyPreferenceId({
      chatId: options.chatId,
      prompt: promptMessage.content,
      reply: cleanedReply,
      responseCompletedAt: options.assistantMessage.responseCompletedAt,
      index: options.assistantIndex,
    }),
    chatId: options.chatId,
    chatTitle: options.chatTitle,
    prompt: promptMessage.content,
    reply: cleanedReply,
    conversationContext: buildReplyPreferenceContext(options.messages, options.assistantIndex),
    feedback: options.feedback,
    surface: getTraceSurface(options.panel),
    preset: options.panel.preset ?? DEFAULT_PRESET_ID,
    model: options.panel.model,
    traceSummary: options.assistantMessage.responseTrace?.orchestrationSummary,
    sourceUrls: (options.assistantMessage.responseTrace?.sources ?? [])
      .filter((source) => source.status === 'fetched' && source.url)
      .map((source) => source.url),
  };
}

function buildChatWorkflowInject(options: {
  mode: string;
  summary: string;
  minParagraphs: number;
  minSentencesPerParagraph: number;
  referenceDateLabel: string;
  forceFetch: boolean;
}): string {
  const lines = [
    '',
    '---',
    '## Detected Chat Workflow',
    `Mode: ${options.mode}`,
    options.summary,
    `Reference date for timeline wording: ${options.referenceDateLabel}.`,
  ];

  if (options.mode === 'deep-research') {
    lines.push(
      '',
      'Response contract:',
      `- Write at least ${options.minParagraphs} full-length paragraphs.`,
      `- Each paragraph must contain at least ${options.minSentencesPerParagraph} complete sentences.`,
      '- Do this in the first answer. Do not save key details for a later rewrite.',
      '- Once the reply is being streamed to the user, treat that visible reply as final content rather than rewriting it from scratch.',
      '- Keep the answer dense with concrete dates, source-grounded facts, and implications.',
      '- For time-sensitive answers, separate three things clearly: what is true now, what already happened, and what comes next.',
      '- Keep past milestones in the answer when they are relevant, but describe them in past tense as completed or prior events.',
      '- Do not erase or dismiss relevant past milestones just because they already happened.',
      '- If the user asks after a launch, decision, or announcement date, say it happened on that date and then explain the current status after it.',
      '- For every exact date you mention, compare it to the reference date before writing the sentence.',
      '- Dates before the reference date must be described only in past tense: happened, launched, occurred, completed, was announced, was tested.',
      '- Dates on the reference date may be described as happening today or having happened today.',
      '- Dates after the reference date may be described as upcoming, scheduled, expected, planned, or will happen.',
      '- Before finishing the answer, do a final tense check on every dated milestone and rewrite any sentence that mismatches past, present, or future.',
      '- If you present a timeline, split it into what already happened, the current status, and what comes next instead of mixing old and upcoming items together.',
    );
  } else if (options.mode === 'note-taking') {
    lines.push(
      '',
      'Response contract:',
      '- Organize the answer as clean notes, key points, and follow-ups when useful.',
      '- Optimize for clarity and structure over conversational padding.',
    );
  } else {
    lines.push(
      '',
      'Time-sensitive response contract:',
      ...(options.forceFetch
        ? [
            '- Start with a direct answer to the user\'s actual question in the first sentence.',
            '- Keep the reply concise unless the user explicitly asks for a deep or exhaustive answer.',
            '- For time-sensitive factual answers, prefer a clean structure: `Current status`, `What already happened`, and `What comes next`.',
            '- Each section should be a short paragraph, not a wall of text or a muddled timeline dump.',
            '- Attribute the main status claim to the strongest fetched source or sources in the first or second sentence.',
            '- Only state precise dates, crew details, launch windows, landing plans, return dates, or outcomes when the fetched evidence clearly supports them.',
            '- For numbered missions or flights, do not transfer crew names, landing goals, launch outcomes, or milestone dates from a different mission number or from a different historical program.',
            '- If the user did not ask for crew members or names, do not volunteer a crew roster unless the retrieved evidence makes crew identity central to the question being answered.',
            '- If the fetched evidence does not clearly confirm a specific detail, say that detail remains unclear, inconsistently reported, or unverified in the retrieved sources.',
            '- Resolve the timeline into one coherent story instead of listing conflicting dated claims side by side.',
            '- If newer evidence conflicts with an older schedule article, describe the older item as earlier reporting or an earlier plan, not as the current status.',
            '- If a source says an event was delayed, rescheduled, or scheduled to a date or month that has already arrived by the reference date, treat that source as earlier planning coverage unless it also states what happened after that date.',
            '- Never describe the same mission or event as both already underway/completed and still scheduled for a later future date.',
            '- If evidence conflicts, write the contradiction plainly as: "Earlier reporting said X, but newer reporting indicates Y."',
          ]
        : []),
      '- For every exact date you mention, compare it to the reference date before writing the sentence.',
      '- Dates before the reference date must be described in past tense.',
      '- Dates on the reference date may be described as happening today or having happened today.',
      '- Dates after the reference date may be described as upcoming, scheduled, expected, planned, or will happen.',
      '- Keep relevant past milestones in the answer when they help explain the current status.',
      '- Separate what already happened, what is true now, and what comes next.',
    );
  }

  lines.push('---');
  return lines.join('\n');
}

function buildRuntimeDateInject(referenceDateLabel: string): string {
  return [
    '',
    '---',
    '## Runtime Date And Freshness Guard',
    `Today in this runtime is ${referenceDateLabel}.`,
    '- You must treat that as the current date for relative and time-sensitive wording.',
    '- Never say "as of my last update", "my knowledge cutoff", or anything that sounds like a training-data timestamp.',
    '- If live retrieval did not verify a current fact, say that current fact remains unverified in this run.',
    '- Do not substitute stale background knowledge for a verified current status.',
    '- If you mention a year, schedule, or timeline older than the runtime date, describe it as prior background or earlier reporting rather than current status.',
    '---',
  ].join('\n');
}

function buildInsufficientLiveContextReply(referenceDateLabel: string, fetchedCount: number, requiredCount: number): string {
  const sourceLabel = fetchedCount === 1 ? 'source' : 'sources';
  const requiredLabel = requiredCount === 1 ? 'source' : 'sources';
  return [
    `As of ${referenceDateLabel}, I could not verify this request with enough live sources to answer it reliably.`,
    '',
    `This run captured ${fetchedCount} verified live ${sourceLabel}, but at least ${requiredCount} verified live ${requiredLabel} are required before I answer a research or current-status prompt like this.`,
    '',
    'I am withholding a factual answer instead of guessing or filling in stale background knowledge.',
  ].join('\n');
}

function buildLiveTransportUnavailableReply(referenceDateLabel: string, detail?: string): string {
  return [
    `As of ${referenceDateLabel}, live source retrieval is unavailable in this app session, so I am withholding a factual answer instead of guessing.`,
    '',
    'The local fetch transport did not return valid proxied source responses for this run.',
    detail ? `Detail: ${detail}` : '',
    '',
    'Reload the active dev app tab and retry the prompt so the current /__fetch transport is used.',
  ].filter(Boolean).join('\n');
}

function createResponseTrace({
  prompt,
  panel,
  model,
  presetId,
  reasoningEffort,
  pipeline,
  startedAt,
}: {
  prompt: string;
  panel: Panel;
  model: string;
  presetId: string;
  reasoningEffort: ChatReasoningEffort;
  pipeline: ResponseTrace['pipeline'];
  startedAt: number;
}): ResponseTrace {
  return {
    version: 1,
    prompt,
    surface: getTraceSurface(panel),
    preset: presetId,
    reasoningEffort,
    model,
    pipeline,
    startedAt,
    orchestrationSummary: pipeline === 'deep-plan'
      ? 'Deep planning flow started: classify the request, build a file plan, execute steps, then write a summary.'
      : 'Single-pass reply started with optional live context fetching before the model stream.',
    phases: [],
    sources: [],
    packages: [],
    plannerSteps: [],
  };
}

function startTracePhase(trace: ResponseTrace, id: string, label: string, detail?: string): ResponseTracePhase {
  const phase: ResponseTracePhase = {
    id,
    label,
    detail,
    status: 'running',
    startedAt: Date.now(),
  };
  trace.phases.push(phase);
  return phase;
}

function finishTracePhase(
  phase: ResponseTracePhase | undefined,
  options: {
    status?: ResponseTracePhase['status'];
    detail?: string;
    metrics?: ResponseTraceMetric[];
  } = {},
) {
  if (!phase) return;
  phase.status = options.status ?? 'completed';
  phase.completedAt = Date.now();
  if (options.detail !== undefined) phase.detail = options.detail;
  if (options.metrics !== undefined) phase.metrics = options.metrics;
}

function appendTraceSources(
  trace: ResponseTrace,
  contexts: FetchedContext[],
  kind: ResponseTraceSource['kind'],
) {
  if (!contexts.length) return;
  trace.sources = [
    ...(trace.sources ?? []),
    ...contexts.map((context, index) => ({
      id: `${kind}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      title: context.title || context.url,
      url: context.url,
      status: context.error ? 'error' as const : 'fetched' as const,
      durationMs: context.durationMs,
      preview: context.text ? truncateTracePreview(context.text) : undefined,
      error: context.error,
      provider: context.provider,
      sourceType: context.sourceType,
      credibility: context.credibility,
      publishedAt: context.publishedAt,
    })),
  ];
}

function snapshotTrace(trace: ResponseTrace, completedAt?: number): ResponseTrace {
  return {
    ...trace,
    completedAt: completedAt ?? trace.completedAt,
    phases: trace.phases.map((phase) => ({
      ...phase,
      status: phase.status === 'running' ? 'completed' : phase.status,
      metrics: phase.metrics?.map((metric) => ({ ...metric })),
    })),
    sources: trace.sources?.map((source) => ({ ...source })),
    packages: trace.packages?.map((pkg) => ({ ...pkg })),
    plannerSteps: trace.plannerSteps?.map((step) => ({ ...step })),
  };
}

function estimateMessageHeight(
  message: Message,
  hideCodeBlocks: boolean,
  trailingGapPx: number,
): number {
  if (message.role === 'assistant' && hideCodeBlocks) {
    return 248 + trailingGapPx;
  }

  const newlineCount = (message.content.match(/\n/g)?.length ?? 0) + 1;
  const codeFenceCount = Math.floor((message.content.match(/```/g)?.length ?? 0) / 2);
  const sampledLength = Math.min(message.content.length, 4_000);
  const baseHeight = message.role === 'assistant' ? 132 : 88;
  const lengthHeight = Math.ceil(sampledLength / 110) * (message.role === 'assistant' ? 16 : 11);
  const lineHeight = Math.min(newlineCount, 42) * 4;
  const codeHeight = Math.min(180, codeFenceCount * 64);
  const minimumHeight = message.role === 'assistant' ? 172 : 104;
  const estimatedHeight = baseHeight + lengthHeight + lineHeight + codeHeight;

  return Math.max(minimumHeight + trailingGapPx, Math.min(760, estimatedHeight + trailingGapPx));
}

function normalizeWheelDelta(event: WheelEvent, viewport: HTMLDivElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(viewport).lineHeight);
    const lineHeight = Number.isFinite(computedLineHeight) ? computedLineHeight : 16;
    return event.deltaY * lineHeight;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewport.clientHeight;
  }

  return event.deltaY;
}

export function ChatPanel({
  panel,
  models,
  showDeveloperTools = false,
  onUpdate,
  onClose,
  onSave,
  selected,
  backgroundMode,
  onActivate,
  launchPrompt,
  onConsumeLaunchPrompt,
}: Props) {
  const { replyPreferences, saveReplyPreference, removeReplyPreference } = useReplyPreferences();
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestTitleRef = useRef(panel.title);
  const autoTitleRef = useRef<string | null>(null);
  const responseTimingRef = useRef<{
    startedAt: number;
    startedPerf: number;
    firstTokenAt?: number;
    firstTokenPerf?: number;
  } | null>(null);
  const visibleReplyContentRef = useRef('');
  const rowElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const rowSeenRef = useRef<Set<number>>(new Set());
  const rowHeightsRef = useRef<Map<number, number>>(new Map());
  const rowResizeObserversRef = useRef<Map<number, ResizeObserver>>(new Map());
  const visibilityObserverRef = useRef<IntersectionObserver | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollTopRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const scrollDirectionRef = useRef<'up' | 'down'>('down');
  const [inputValue, setInputValue] = useState('');
  const [liveResponseMs, setLiveResponseMs] = useState<number | null>(null);
  const [liveReplyLatencyMs, setLiveReplyLatencyMs] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measurementVersion, setMeasurementVersion] = useState(0);

  const [checklistSteps,       setChecklistSteps]       = useState<DeepStep[]>([]);
  const [checklistCurrentStep, setChecklistCurrentStep] = useState(0);
  const [checklistPlanning,    setChecklistPlanning]     = useState(false);
  const [checklistClassifying, setChecklistClassifying] = useState(false);
  const [checklistMode,        setChecklistMode]        = useState<import('../lib/deepPlanner').RequestMode | undefined>();
  const hasMessages = panel.messages.length > 0;

  function disconnectResizeObservers() {
    for (const observer of rowResizeObserversRef.current.values()) {
      observer.disconnect();
    }
    rowResizeObserversRef.current.clear();
  }

  function disconnectVisibilityObserver() {
    visibilityObserverRef.current?.disconnect();
    visibilityObserverRef.current = null;
  }

  function disconnectVirtualObservers() {
    disconnectResizeObservers();
    disconnectVisibilityObserver();
    rowElementsRef.current.clear();
  }

  function scrollMessagesToEnd(behavior: ScrollBehavior = 'auto') {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    stickToBottomRef.current = true;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }

  function syncViewportMetrics() {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const nextScrollTop = viewport.scrollTop;
    const previousScrollTop = scrollTopRef.current;

    if (nextScrollTop < previousScrollTop) {
      scrollDirectionRef.current = 'up';
    } else if (nextScrollTop > previousScrollTop) {
      scrollDirectionRef.current = 'down';
    }

    scrollTopRef.current = nextScrollTop;
    stickToBottomRef.current =
      viewport.scrollHeight - (nextScrollTop + viewport.clientHeight) <= STICKY_SCROLL_THRESHOLD_PX;
    setScrollTop(nextScrollTop);
    setViewportHeight(viewport.clientHeight);
  }

  function handleVirtualRowRef(index: number, node: HTMLDivElement | null) {
    const previousNode = rowElementsRef.current.get(index);
    if (previousNode && previousNode !== node) {
      visibilityObserverRef.current?.unobserve(previousNode);
    }

    const resizeObservers = rowResizeObserversRef.current;
    resizeObservers.get(index)?.disconnect();
    resizeObservers.delete(index);
    rowElementsRef.current.delete(index);

    if (!node) return;

    rowElementsRef.current.set(index, node);
    node.dataset.rowIndex = String(index);
    node.dataset.enter = scrollDirectionRef.current;
    if (rowSeenRef.current.has(index)) {
      node.classList.add('is-visible');
    } else {
      node.classList.remove('is-visible');
    }

    const measure = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      const previousHeight = rowHeightsRef.current.get(index);

      if (!nextHeight || previousHeight === nextHeight) return;

      rowHeightsRef.current.set(index, nextHeight);
      setMeasurementVersion((version) => version + 1);
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        measure();
      });
      resizeObserver.observe(node);
      resizeObservers.set(index, resizeObserver);
    }

    if (typeof IntersectionObserver === 'undefined') {
      node.classList.add('is-visible');
      rowSeenRef.current.add(index);
      return;
    }

    if (!rowSeenRef.current.has(index)) {
      visibilityObserverRef.current?.observe(node);
    }
  }

  useEffect(() => {
    latestTitleRef.current = panel.title;
  }, [panel.title]);

  useEffect(() => {
    autoTitleRef.current = null;
  }, [panel.id]);

  useEffect(() => {
    rowHeightsRef.current.clear();
    rowSeenRef.current.clear();
    disconnectVirtualObservers();
    scrollTopRef.current = 0;
    stickToBottomRef.current = true;
    scrollDirectionRef.current = 'down';
    setScrollTop(0);
    setViewportHeight(messagesViewportRef.current?.clientHeight ?? 0);
    setMeasurementVersion(0);
  }, [panel.id]);

  useEffect(() => {
    const resizeObservers = rowResizeObserversRef.current;
    const heights = rowHeightsRef.current;

    for (const index of [...resizeObservers.keys()]) {
      if (index < panel.messages.length) continue;
      resizeObservers.get(index)?.disconnect();
      resizeObservers.delete(index);
    }

    for (const index of [...rowElementsRef.current.keys()]) {
      if (index < panel.messages.length) continue;
      const node = rowElementsRef.current.get(index);
      if (node) {
        visibilityObserverRef.current?.unobserve(node);
      }
      rowElementsRef.current.delete(index);
    }

    for (const index of [...heights.keys()]) {
      if (index < panel.messages.length) continue;
      heights.delete(index);
    }

    for (const index of [...rowSeenRef.current.values()]) {
      if (index < panel.messages.length) continue;
      rowSeenRef.current.delete(index);
    }
  }, [panel.messages.length]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return undefined;

    const queueSync = () => {
      if (scrollFrameRef.current != null) return;

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncViewportMetrics();
      });
    };

    syncViewportMetrics();

    const handleScroll = () => {
      queueSync();
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return;

      const normalizedDelta = normalizeWheelDelta(event, viewport);
      if (normalizedDelta === 0) return;

      event.preventDefault();
      viewport.scrollTop += normalizedDelta * MESSAGE_WHEEL_DAMPING;
      queueSync();
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    viewport.addEventListener('wheel', handleWheel, { passive: false });

    if (typeof IntersectionObserver !== 'undefined') {
      visibilityObserverRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLDivElement;

          if (entry.isIntersecting) {
            target.dataset.enter = scrollDirectionRef.current;
            target.classList.add('is-visible');
            const rowIndex = Number(target.dataset.rowIndex);
            if (Number.isFinite(rowIndex)) {
              rowSeenRef.current.add(rowIndex);
            }
            visibilityObserverRef.current?.unobserve(target);
          }
        }
      }, {
        root: viewport,
        threshold: 0,
      });

      for (const node of rowElementsRef.current.values()) {
        visibilityObserverRef.current.observe(node);
      }
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        queueSync();
      });
      resizeObserver.observe(viewport);
    }

    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('wheel', handleWheel);
      disconnectVisibilityObserver();
      resizeObserver?.disconnect();
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [panel.id]);

  useEffect(() => {
    return () => {
      disconnectVirtualObservers();
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hasMessages && !panel.streaming) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, panel.id, panel.streaming]);

  useEffect(() => {
    if (!stickToBottomRef.current || !hasMessages) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('smooth');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, panel.messages.length]);

  useEffect(() => {
    if (!stickToBottomRef.current || !panel.streamingContent) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [panel.streamingContent]);

  useEffect(() => {
    if (!stickToBottomRef.current || (!hasMessages && !panel.streaming)) return;

    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToEnd('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasMessages, measurementVersion, panel.streaming]);

  useEffect(() => {
    if (!panel.streaming) {
      if (!backgroundMode) {
        inputRef.current?.focus();
      }
      setChecklistSteps([]);
      setChecklistCurrentStep(0);
      setChecklistPlanning(false);
      setChecklistClassifying(false);
      setChecklistMode(undefined);
      setLiveResponseMs(null);
      setLiveReplyLatencyMs(null);
    }
  }, [backgroundMode, panel.streaming]);

  useEffect(() => {
    if (!panel.streaming || !responseTimingRef.current) return undefined;

    const tick = () => {
      if (!responseTimingRef.current) return;
      setLiveResponseMs(Math.max(0, performance.now() - responseTimingRef.current.startedPerf));
    };

    tick();
    const interval = window.setInterval(tick, 100);
    return () => window.clearInterval(interval);
  }, [panel.streaming]);

  const replyPreferenceFeedbackById = new Map(
    replyPreferences.map((entry) => [entry.id, entry.feedback]),
  );

  const handleReplyFeedbackChange = useCallback((assistantMessage: Message, assistantIndex: number, next: ReplyFeedback | null) => {
    const draft = buildReplyPreferenceEntry({
      chatId: panel.id,
      chatTitle: panel.title,
      assistantMessage,
      assistantIndex,
      messages: panel.messages,
      panel,
      feedback: next ?? 'liked',
    });

    if (!draft) return;

    if (next == null) {
      removeReplyPreference(draft.id);
      return;
    }

    saveReplyPreference({
      ...draft,
      feedback: next,
    });
  }, [panel, removeReplyPreference, saveReplyPreference]);

  function handleExportLog() {
    const blob = new Blob([exportChatAsMarkdown(panel)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${panel.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'chat'}_log.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const sendPrompt = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || panel.streaming) return;
    setInputValue('');

    const userMsg: Message               = { role: 'user', content: text };
    const updatedMessages                = [...panel.messages, userMsg];
    const snapshotRegistry: FileRegistry = new Map(panel.fileRegistry);
    const presetId                       = panel.preset ?? DEFAULT_PRESET_ID;
    const isCodePreset                   = presetId === 'code';
    const reasoningEffort                = panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const reasoningConfig                = REASONING_EFFORT_CONFIG[reasoningEffort];
    const chatWorkflow                   = !isCodePreset
      ? classifyChatWorkflow(text, panel.messages, presetId)
      : null;
    const effectivePresetId              = chatWorkflow?.effectivePresetId ?? presetId;
    const fetchDepth: FetchContextDepth  = !isCodePreset && (chatWorkflow?.fetchDepth === 'deep' || reasoningConfig.fetchDepth === 'deep')
      ? 'deep'
      : chatWorkflow?.fetchDepth ?? 'standard';
    const modelName                      = resolveModelHandle(panel.model, models, { preserveUnavailable: true });
    const correctionTurn                 = !isCodePreset && isCorrectionPrompt(text);
    const crewLookupTurn                 = !isCodePreset && isCrewLookupPrompt(text);
    const hasPromptUrls                  = extractUrlsFromText(text).length > 0;
    const fetchLiveContext               = !isCodePreset && shouldFetchGlobalContext(text, panel.messages, {
      forceFetch: correctionTurn || crewLookupTurn || chatWorkflow?.forceFetch,
    });
    const isFirstAssistantReply          = !panel.messages.some((message) => message.role === 'assistant');
    const provisionalTitle               = isFirstAssistantReply
      ? deriveAutoChatTitle({
          currentTitle: latestTitleRef.current,
          projectLabel: panel.projectLabel,
          prompt: text,
          autoTitle: autoTitleRef.current,
        })
      : null;
    const runStartedAt = Date.now();
    const trace = createResponseTrace({
      prompt: text,
      panel,
      model: modelName,
      presetId: effectivePresetId,
      reasoningEffort,
      pipeline: isCodePreset ? 'deep-plan' : 'single-pass',
      startedAt: runStartedAt,
    });
    if (chatWorkflow) {
      trace.chatMode = chatWorkflow.mode;
      trace.chatModeConfidence = chatWorkflow.confidence;
      trace.reasoningSummary = chatWorkflow.summary;
    }
    let terminalTracePhase: ResponseTracePhase | undefined;
    responseTimingRef.current = { startedAt: runStartedAt, startedPerf: performance.now() };
    visibleReplyContentRef.current = '';
    setLiveResponseMs(0);
    setLiveReplyLatencyMs(null);

    if (provisionalTitle) {
      autoTitleRef.current = provisionalTitle;
    }

    onUpdate(panel.id, {
      ...(provisionalTitle ? { title: provisionalTitle } : {}),
      messages: updatedMessages,
      streaming: true,
      streamingContent: '',
      prevRegistry: snapshotRegistry,
      streamingPhase: {
        label: hasPromptUrls || fetchLiveContext ? 'Fetching context...' : 'Starting reply...',
        stepIndex: 0,
        totalSteps: 0,
      },
    });

    const abort = new AbortController();
    abortRef.current = abort;

    // Auto-fetch: URLs in the prompt + global knowledge sources
    // Pass the full conversation history so follow-up questions ("what is the
    // US involvement?") can inherit topics from prior messages ("Iran").
    // Global context is injected BOTH into the system prompt AND as a synthetic
    // assistant prefill turn in the conversation, so even small models that
    // deprioritise system prompts will see and use the live data.
    let urlInject    = '';
    let globalInject = '';
    let replyPreferenceInject = '';
    let contextTurns: Message[] = [];
    let promptContexts: FetchedContext[] = [];
    let globalContexts: FetchedContext[] = [];
    let contextFetchErrorMessage: string | null = null;
    const replyPreferenceSummary = buildReplyPreferenceInject({
      preferences: replyPreferences,
      prompt: text,
      surface: getTraceSurface(panel),
      preset: effectivePresetId,
    });
    const promptContextPhase = hasPromptUrls
      ? startTracePhase(trace, 'prompt-url-fetch', 'Fetch linked URLs', 'Scrape any URLs the user pasted into the prompt before generation.')
      : undefined;
    const chatModePhase = chatWorkflow
      ? startTracePhase(trace, 'classify-chat-mode', 'Detect chat mode', 'Classify the prompt as conversation, note-taking, creative, or deep research before retrieval.')
      : undefined;
    const liveContextPhase = fetchLiveContext
      ? startTracePhase(trace, 'live-context-fetch', 'Fetch live context', 'Query public sources for up-to-date context before the reply stream begins.')
      : undefined;
    const replyPreferencePhase = startTracePhase(
      trace,
      'reply-preferences',
      'Load reply preferences',
      'Apply previously rated valid and invalid replies as guidance when they are relevant to the current prompt.',
    );
    try {
      if (chatModePhase && chatWorkflow) {
        finishTracePhase(chatModePhase, {
          detail: chatWorkflow.summary,
          metrics: [
            { label: 'Mode', value: chatWorkflow.mode },
            { label: 'Preset', value: effectivePresetId },
            { label: 'Confidence', value: chatWorkflow.confidence },
            { label: 'Fetch depth', value: fetchDepth },
          ],
        });
      }

      replyPreferenceInject = replyPreferenceSummary.inject;
      finishTracePhase(replyPreferencePhase, {
        detail: replyPreferenceSummary.matchedCount > 0
          ? `Matched ${replyPreferenceSummary.matchedCount} previously rated reply preference${replyPreferenceSummary.matchedCount === 1 ? '' : 's'} for this prompt.`
          : 'No prior reply preferences were relevant enough to inject into this prompt.',
        metrics: [
          { label: 'Stored', value: String(replyPreferences.length) },
          { label: 'Matched', value: String(replyPreferenceSummary.matchedCount) },
        ],
      });

      const [loadedPromptContexts, loadedGlobalContexts] = await Promise.all([
        fetchUrlsFromPrompt(text),
        fetchLiveContext
          ? fetchGlobalContext(text, panel.messages, {
              depth: fetchDepth,
              forceFetch: chatWorkflow?.forceFetch,
              maxSources: reasoningConfig.maxSources,
            })
          : Promise.resolve([]),
      ]);
      promptContexts = loadedPromptContexts;
      globalContexts = loadedGlobalContexts;
      appendTraceSources(trace, promptContexts, 'prompt-url');
      appendTraceSources(trace, globalContexts, 'live-context');

      if (promptContextPhase) {
        const fetchedPromptCount = promptContexts.filter((context) => !context.error && context.text.trim()).length;
        const promptErrorCount = promptContexts.filter((context) => context.error).length;
        finishTracePhase(promptContextPhase, {
          detail: fetchedPromptCount > 0
            ? `Fetched ${fetchedPromptCount} linked source${fetchedPromptCount === 1 ? '' : 's'} before reply generation.`
            : 'No linked pages returned usable content.',
          metrics: [
            { label: 'URLs', value: String(promptContexts.length) },
            { label: 'Fetched', value: String(fetchedPromptCount) },
            ...(promptErrorCount > 0 ? [{ label: 'Errors', value: String(promptErrorCount) }] : []),
          ],
        });
      }

      if (liveContextPhase) {
        const fetchedLiveCount = globalContexts.filter((context) => !context.error && context.text.trim()).length;
        const liveErrorCount = globalContexts.filter((context) => context.error).length;
        const officialCount = globalContexts.filter((context) => context.credibility === 'official').length;
        const majorNewsCount = globalContexts.filter((context) => context.credibility === 'major-news').length;
        const communityCount = globalContexts.filter((context) => context.credibility === 'community').length;
        finishTracePhase(liveContextPhase, {
          detail: fetchedLiveCount > 0
            ? `Collected ${fetchedLiveCount} ranked live source${fetchedLiveCount === 1 ? '' : 's'} after filtering for freshness, credibility, and relevance.`
            : 'No live context sources returned usable text.',
          metrics: [
            { label: 'Sources', value: String(globalContexts.length) },
            { label: 'Fetched', value: String(fetchedLiveCount) },
            ...(officialCount > 0 ? [{ label: 'Official', value: String(officialCount) }] : []),
            ...(majorNewsCount > 0 ? [{ label: 'Major News', value: String(majorNewsCount) }] : []),
            ...(communityCount > 0 ? [{ label: 'Community', value: String(communityCount) }] : []),
            ...(liveErrorCount > 0 ? [{ label: 'Errors', value: String(liveErrorCount) }] : []),
          ],
        });
      }

      urlInject    = urlContextToSystemInject(promptContexts);
      globalInject = globalContextToSystemInject(globalContexts, { depth: fetchDepth });
      contextTurns = globalContextToConversationInject(globalContexts, text, { depth: fetchDepth });
    } catch (error) {
      contextFetchErrorMessage = error instanceof Error ? error.message : String(error);
      if (replyPreferencePhase.status === 'running') {
        finishTracePhase(replyPreferencePhase, {
          status: 'error',
          detail: 'Reply preference memory could not be applied before reply generation.',
        });
      }
      if (chatModePhase?.status === 'running') {
        finishTracePhase(chatModePhase, {
          status: 'error',
          detail: 'Prompt classification failed before reply generation.',
        });
      }
      finishTracePhase(promptContextPhase, {
        status: 'error',
        detail: contextFetchErrorMessage || 'Linked page fetching failed before reply generation.',
      });
      finishTracePhase(liveContextPhase, {
        status: 'error',
        detail: contextFetchErrorMessage || 'Live context fetching failed before reply generation.',
      });
    }

    // Non-code presets - single pass
    if (!isCodePreset) {
      const preset = getPreset(effectivePresetId);
      const referenceDateLabel = formatChatReferenceDate(new Date());
      const baseRequiredLiveSourceCount = fetchLiveContext
        ? getRequiredLiveSourceCount(text, panel.messages, {
            depth: fetchDepth,
            forceFetch: correctionTurn || crewLookupTurn || chatWorkflow?.forceFetch,
          })
        : 0;
      const requiredLiveSourceCount = fetchLiveContext
        ? Math.max(baseRequiredLiveSourceCount, reasoningConfig.minLiveSources)
        : 0;
      const runtimeDateInject = buildRuntimeDateInject(referenceDateLabel);
      const chatWorkflowInject = chatWorkflow
        ? buildChatWorkflowInject({
            mode: chatWorkflow.mode,
            summary: chatWorkflow.summary,
            minParagraphs: chatWorkflow.minParagraphs,
            minSentencesPerParagraph: chatWorkflow.minSentencesPerParagraph,
            referenceDateLabel,
            forceFetch: chatWorkflow.forceFetch,
          })
        : '';
      const reasoningEffortInject = buildReasoningEffortInject({
        effort: reasoningEffort,
        fetchLiveContext,
        requiredLiveSourceCount,
        targetLiveSourceCount: reasoningConfig.maxSources,
      });
      const liveResearchFallbackInject = fetchLiveContext && globalContexts.length === 0
        ? [
            '',
            '---',
            '## Live Research Retrieval Status',
            contextFetchErrorMessage?.includes('Local fetch proxy unavailable')
              ? 'A live research pass was attempted, but this app session is not connected to a valid local fetch proxy.'
              : 'A live research pass was attempted for this prompt, but no usable external excerpts were captured.',
            'You must still help the user instead of refusing, but you must not invent or guess current facts.',
            '',
            'Rules:',
            '- Give the most useful stable background insight you can from general knowledge.',
            '- Clearly separate stable background context from any current-status claim you could not verify live.',
            '- Do not state exact current timelines, launch dates, crew lists, locations, counts, schedules, or status milestones unless they were verified by fetched live sources.',
            '- If a fresh fact could not be verified, say that exact point remains unverified instead of turning it into a confident claim.',
            '- Do not use phrases like "as of my last update", and do not answer a current-events question with stale training-era dates as if they were current.',
            '- Say that live retrieval did not return usable excerpts in this pass if needed, not that you lack real-time access.',
            '- Never answer with "I do not have access to real-time information", "my training data does not include this", or a deflection to search elsewhere.',
            '---',
          ].join('\n')
        : '';
      const correctionInject = correctionTurn ? buildCorrectionInject() : '';
      const crewLookupInject = crewLookupTurn ? buildCrewLookupInject() : '';
      const crewRosterPhase = crewLookupTurn
        ? startTracePhase(
            trace,
            'extract-crew-roster',
            'Validate crew roster',
            'Derive a validated crew roster from the fetched live sources before answer generation.',
          )
        : undefined;
      let validatedCrewRoster: ExtractedCrewRosterMember[] = [];
      if (crewLookupTurn) {
        validatedCrewRoster = extractCrewRosterFromContexts(globalContexts, text, panel.messages);
        if (crewRosterPhase) {
          finishTracePhase(crewRosterPhase, {
            detail: validatedCrewRoster.length > 0
              ? `Validated ${validatedCrewRoster.length} crew roster entr${validatedCrewRoster.length === 1 ? 'y' : 'ies'} from the fetched live sources.`
              : globalContexts.length > 0
                ? 'Live sources were fetched, but no validated crew roster could be derived from them.'
                : 'No live sources were available to derive a validated crew roster.',
            metrics: [
              { label: 'Live sources', value: String(globalContexts.length) },
              { label: 'Validated names', value: String(validatedCrewRoster.length) },
            ],
          });
        }
      }
      const validatedCrewInject = validatedCrewRoster.length > 0
        ? buildValidatedCrewRosterInject(validatedCrewRoster)
        : '';
      const contextAssemblyPhase = startTracePhase(
        trace,
        'context-assembly',
        'Assemble model context',
        'Combine preset instructions, file context, fetched sources, and conversation history into the final prompt.',
      );
      const hasSufficientLiveContext = !fetchLiveContext
        || requiredLiveSourceCount <= 0
        || globalContexts.length >= requiredLiveSourceCount;
      const systemPrompt = runtimeDateInject
        + preset.systemPrompt
        + replyPreferenceInject
        + registryToSystemPrompt(panel.fileRegistry)
        + urlInject
        + globalInject
        + chatWorkflowInject
        + reasoningEffortInject
        + correctionInject
        + crewLookupInject
        + validatedCrewInject
        + liveResearchFallbackInject;
      finishTracePhase(contextAssemblyPhase, {
        detail: contextTurns.length > 0
          ? 'Injected fetched live context into both the system prompt and the conversation history.'
          : 'Built the final prompt from the preset, registry, and conversation history.',
        metrics: [
          { label: 'Reasoning', value: reasoningConfig.label },
          { label: 'Preference matches', value: String(replyPreferenceSummary.matchedCount) },
          { label: 'Prompt URLs', value: String(promptContexts.length) },
          { label: 'Live sources', value: String(globalContexts.length) },
          ...(requiredLiveSourceCount > 0 ? [{ label: 'Required live', value: String(requiredLiveSourceCount) }] : []),
          { label: 'Injected turns', value: String(contextTurns.length) },
        ],
      });

      const enrichmentLabels: string[] = [];
      if (promptContexts.length) {
        enrichmentLabels.push(`${promptContexts.length} linked source${promptContexts.length === 1 ? '' : 's'}`);
      }
      if (globalContexts.length) {
        enrichmentLabels.push(`${globalContexts.length} live source${globalContexts.length === 1 ? '' : 's'}`);
      }
      const modeLabel = chatWorkflow?.mode ? `${chatWorkflow.mode.replace(/-/g, ' ')} ` : '';
      trace.orchestrationSummary = enrichmentLabels.length > 0
        ? `Single-pass ${modeLabel}reply enriched with ${enrichmentLabels.join(' and ')} before streaming from ${modelName}.`
        : `Single-pass ${modeLabel}reply streamed directly from ${modelName} with no extra fetched context.`;

      if (!hasSufficientLiveContext) {
        if (contextFetchErrorMessage?.includes('Local fetch proxy unavailable')) {
          const verificationPhase = startTracePhase(
            trace,
            'verify-live-sources',
            'Verify live source floor',
            'Ensure the prompt has enough verified live sources before answer generation.',
          );
          finishTracePhase(verificationPhase, {
            status: 'error',
            detail: contextFetchErrorMessage,
            metrics: [
              { label: 'Captured', value: String(globalContexts.length) },
              { label: 'Required', value: String(requiredLiveSourceCount) },
            ],
          });
          trace.orchestrationSummary = 'Live retrieval could not run because the local fetch proxy was unavailable in this app session.';
          await finaliseResponse(
            buildLiveTransportUnavailableReply(referenceDateLabel, contextFetchErrorMessage),
            updatedMessages,
            snapshotRegistry,
            panel.fileRegistry,
          );
          return;
        }

        const verificationPhase = startTracePhase(
          trace,
          'verify-live-sources',
          'Verify live source floor',
          'Ensure the prompt has enough verified live sources before answer generation.',
        );
        finishTracePhase(verificationPhase, {
          status: 'error',
          detail: `Captured ${globalContexts.length} verified live source${globalContexts.length === 1 ? '' : 's'}, below the required ${requiredLiveSourceCount} for this prompt. The reply was withheld rather than guessed.`,
          metrics: [
            { label: 'Captured', value: String(globalContexts.length) },
            { label: 'Required', value: String(requiredLiveSourceCount) },
          ],
        });
        trace.orchestrationSummary = `Live retrieval captured ${globalContexts.length} verified source${globalContexts.length === 1 ? '' : 's'}, below the required ${requiredLiveSourceCount}; the reply was withheld instead of guessing.`;
        await finaliseResponse(
          buildInsufficientLiveContextReply(referenceDateLabel, globalContexts.length, requiredLiveSourceCount),
          updatedMessages,
          snapshotRegistry,
          panel.fileRegistry,
        );
        return;
      }

      if (crewLookupTurn && isDirectCrewIdentityPrompt(text)) {
        trace.orchestrationSummary = validatedCrewRoster.length > 0
          ? `Direct crew lookup answered from ${validatedCrewRoster.length} validated roster entr${validatedCrewRoster.length === 1 ? 'y' : 'ies'} extracted from live sources.`
          : 'Direct crew lookup could not derive a validated roster from the live sources, so the reply was withheld instead of guessed.';
        await finaliseResponse(
          buildCrewLookupReply(validatedCrewRoster, text, referenceDateLabel),
          updatedMessages,
          snapshotRegistry,
          panel.fileRegistry,
        );
        return;
      }

      // Build the message array: history + [assistant context prefill] + user message.
      // The context prefill makes the model "own" the research and answer from it
      // rather than ignoring it. It's positioned as the last assistant turn so the
      // model continues naturally from "Based on the above, I will now answer..."
      const priorHistory = buildConversationHistoryForReply(updatedMessages, text);
      const messagesWithContext = [
        ...priorHistory,
        ...contextTurns,   // synthetic assistant turn with live research
        userMsg,           // the user's actual question
      ];

      let accumulated = '';
      terminalTracePhase = startTracePhase(
        trace,
        'reply-stream',
        'Stream reply',
        'Open the assistant stream and accumulate tokens until the reply is complete.',
      );
      try {
        const gen = streamChat(modelName, messagesWithContext, systemPrompt, abort.signal);
        for await (const chunk of gen) {
          markFirstToken();
          accumulated += chunk;
          visibleReplyContentRef.current = accumulated;
          onUpdate(panel.id, { streamingContent: accumulated, streamingPhase: null });
        }
        await finaliseResponse(accumulated, updatedMessages, snapshotRegistry, panel.fileRegistry);
      } catch (err) {
        handleError(err, updatedMessages);
      }
      return;
    }

    // Code preset: plan -> execute each step independently
    try {
      setChecklistClassifying(true);
      setChecklistPlanning(false);
      setChecklistSteps([]);
      setChecklistCurrentStep(0);
      onUpdate(panel.id, { streamingPhase: { label: 'Analysing request...', stepIndex: 0, totalSteps: 0 } });
      const classificationPhase = startTracePhase(
        trace,
        'classify-request',
        'Classify request',
        'Decide whether the coding task is a build, feature, refactor, docs, or debug flow.',
      );
      terminalTracePhase = classificationPhase;
      const classification = await classifyRequest(text, panel.messages, modelName, abort.signal);
      finishTracePhase(classificationPhase, {
        detail: `Classified as ${classification.mode.replace(/_/g, ' ')}.`,
        metrics: [
          { label: 'Mode', value: classification.mode.replace(/_/g, ' ') },
          { label: 'Confidence', value: classification.confidence },
          { label: 'Packages', value: String(classification.mentionedPackages.length) },
        ],
      });
      terminalTracePhase = undefined;
      trace.plannerMode = classification.mode;
      trace.plannerConfidence = classification.confidence;
      trace.reasoningSummary = classification.reasoning || undefined;

      let resolvedPackages: PackageVersion[] = [];
      if (classification.mentionedPackages.length > 0) {
        onUpdate(panel.id, { streamingPhase: { label: 'Resolving package versions...', stepIndex: 0, totalSteps: 0 } });
        const packagePhase = startTracePhase(
          trace,
          'resolve-packages',
          'Resolve package versions',
          'Fetch current package versions from public registries before file generation begins.',
        );
        terminalTracePhase = packagePhase;
        resolvedPackages = await resolvePackageVersions(classification.mentionedPackages);
        trace.packages = resolvedPackages.map((pkg) => ({ ...pkg }));
        finishTracePhase(packagePhase, {
          detail: resolvedPackages.length > 0
            ? `Resolved ${resolvedPackages.length} package version${resolvedPackages.length === 1 ? '' : 's'} for the planner.`
            : 'No package versions could be resolved from the detected package list.',
          metrics: [
            { label: 'Mentioned', value: String(classification.mentionedPackages.length) },
            { label: 'Resolved', value: String(resolvedPackages.length) },
          ],
        });
        terminalTracePhase = undefined;
      }

      setChecklistClassifying(false);
      setChecklistPlanning(true);
      onUpdate(panel.id, { streamingPhase: { label: 'Building execution plan...', stepIndex: 0, totalSteps: 0 } });
      const planningPhase = startTracePhase(
        trace,
        'plan-request',
        'Build execution plan',
        'Turn the classified request into a file-by-file implementation plan.',
      );
      terminalTracePhase = planningPhase;
      const planningResult = await planRequest(
        text,
        panel.messages,
        classification,
        modelName,
        abort.signal,
      );
      finishTracePhase(planningPhase, {
        detail: `Planned ${planningResult.steps.length} implementation step${planningResult.steps.length === 1 ? '' : 's'}.`,
        metrics: [
          { label: 'Mode', value: classification.mode.replace(/_/g, ' ') },
          { label: 'Steps', value: String(planningResult.steps.length) },
        ],
      });
      terminalTracePhase = undefined;

      const plan = {
        projectSummary: planningResult.projectSummary,
        mode: classification.mode,
        classification,
        resolvedPackages,
        steps: planningResult.steps,
      };
      trace.plannerSummary = plan.projectSummary;
      trace.plannerSteps = plan.steps.map<ResponseTracePlannerStep>((step) => ({
        stepNumber: step.stepNumber,
        label: step.label,
        filePath: step.filePath,
        purpose: step.purpose,
        status: 'planned',
      }));
      trace.orchestrationSummary = `Deep planning classified this request as ${classification.mode.replace(/_/g, ' ')}, built a ${plan.steps.length}-step file plan, executed the steps sequentially, and then wrote a final summary.`;

      setChecklistClassifying(false);
      setChecklistPlanning(false);
      setChecklistMode(plan.mode);
      setChecklistSteps(plan.steps);
      setChecklistCurrentStep(1);

      const pkgVersionInject = packageVersionsToSystemInject(plan.resolvedPackages ?? []);
      const executorSystem = getStepExecutorSystem()
        + replyPreferenceInject
        + registryToSystemPrompt(panel.fileRegistry)
        + urlInject
        + pkgVersionInject;

      let combinedContent = '';
      let currentRegistry = panel.fileRegistry;
      const alreadyWritten: Array<{ path: string; exports: string[] }> = [];

      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        setChecklistCurrentStep(si + 1);

        onUpdate(panel.id, {
          streamingPhase: {
            label:      `Step ${si + 1} of ${plan.steps.length} - ${step.filePath}`,
            stepIndex:  si + 1,
            totalSteps: plan.steps.length,
          },
        });

        const stepPhase = startTracePhase(
          trace,
          `execute-step-${si + 1}`,
          `Execute step ${si + 1}`,
          `${step.filePath} — ${step.purpose}`,
        );
        terminalTracePhase = stepPhase;

        const stepUserMsg = buildStepUserMessage(plan, step, alreadyWritten);
        const stepMessages: Message[] = [
          { role: 'user', content: text },
          { role: 'assistant', content: `Understood. I will implement the project step by step. Starting step ${si + 1}: ${step.filePath}` },
          { role: 'user', content: stepUserMsg },
        ];

        let stepContent = '';
        const gen = streamChat(modelName, stepMessages, executorSystem, abort.signal);
        for await (const token of gen) {
          markFirstToken();
          stepContent += token;
          onUpdate(panel.id, { streamingContent: combinedContent + stepContent });
        }

        const newBlocks = extractCodeBlocksForRegistry(stepContent);
        currentRegistry = updateRegistry(currentRegistry, newBlocks, updatedMessages.length);
        for (const b of newBlocks) {
          const planned = plan.steps.find(s => s.filePath === b.path);
          alreadyWritten.push({ path: b.path, exports: planned?.exports ?? [] });
        }

        const separator = si < plan.steps.length - 1
          ? `\n\n<!-- step-break: ${si + 1}/${plan.steps.length} -->\n\n`
          : '';
        combinedContent += stepContent + separator;
        finishTracePhase(stepPhase, {
          detail: `Completed ${step.filePath}.`,
          metrics: [
            { label: 'File', value: step.filePath },
            { label: 'Exports', value: String(step.exports.length) },
          ],
        });
        terminalTracePhase = undefined;
        trace.plannerSteps = trace.plannerSteps?.map((plannedStep) =>
          plannedStep.stepNumber === step.stepNumber && plannedStep.filePath === step.filePath
            ? { ...plannedStep, status: 'executed' }
            : plannedStep,
        );
      }

      setChecklistCurrentStep(plan.steps.length + 1);

      const filesWritten = [...currentRegistry.values()].map(e => ({ path: e.path }));

      onUpdate(panel.id, {
        streamingPhase: {
          label: 'Writing summary...',
          stepIndex: plan.steps.length + 1,
          totalSteps: plan.steps.length + 1,
        },
        streamingContent: combinedContent,
      });

      const summaryUserMsg = buildSummaryUserMessage(text, plan.projectSummary, filesWritten);
      const summaryMessages: Message[] = [
        { role: 'user', content: summaryUserMsg },
      ];

      let summaryContent = '';
      const summaryPhase = startTracePhase(
        trace,
        'write-summary',
        'Write summary',
        'Generate the final prose summary after code generation completes.',
      );
      terminalTracePhase = summaryPhase;
      const summaryGen = streamChat(modelName, summaryMessages, getSummarySystem() + replyPreferenceInject, abort.signal);
      for await (const token of summaryGen) {
        markFirstToken();
        summaryContent += token;
        onUpdate(panel.id, { streamingContent: combinedContent + '\n\n<!-- summary -->\n\n' + summaryContent });
      }
      finishTracePhase(summaryPhase, {
        detail: 'Generated the final developer-facing summary.',
        metrics: [
          { label: 'Files', value: String(filesWritten.length) },
          { label: 'Steps', value: String(plan.steps.length) },
        ],
      });
      terminalTracePhase = undefined;

      const fullContent = combinedContent + '\n\n<!-- summary -->\n\n' + summaryContent;
      await finaliseResponse(fullContent, updatedMessages, snapshotRegistry, currentRegistry);

    } catch (err) {
      handleError(err, updatedMessages);
    }

    async function finaliseResponse(
      content: string,
      msgs: Message[],
      snapReg: FileRegistry,
      baseReg: FileRegistry,
    ) {
      const finalContent = !isCodePreset && visibleReplyContentRef.current
        ? visibleReplyContentRef.current
        : content;
      const timing = responseTimingRef.current;
      const completedAt = Date.now();
      const responseFirstTokenMs = timing
        ? Math.max(0, Math.round((timing.firstTokenPerf ?? performance.now()) - timing.startedPerf))
        : undefined;
      const responseTimeMs = timing
        ? Math.max(0, Math.round(performance.now() - timing.startedPerf))
        : undefined;
      const timingMetrics: ResponseTraceMetric[] = [
        ...(responseFirstTokenMs != null ? [{ label: 'First token', value: formatTraceDuration(responseFirstTokenMs) }] : []),
        ...(responseTimeMs != null ? [{ label: 'Total', value: formatTraceDuration(responseTimeMs) }] : []),
      ];
      if (terminalTracePhase?.status === 'running') {
        finishTracePhase(terminalTracePhase, {
          detail: 'Completed the final reply stream.',
          metrics: timingMetrics,
        });
        terminalTracePhase = undefined;
      }
      trace.firstTokenAt = timing?.firstTokenAt ?? trace.firstTokenAt;
      trace.completedAt = completedAt;
      trace.firstTokenDurationMs = responseFirstTokenMs;
      trace.totalDurationMs = responseTimeMs;
      const assistantMsg: Message = {
        role: 'assistant',
        content: finalContent,
        responseTimeMs,
        responseFirstTokenMs,
        responseStartedAt: timing?.startedAt,
        responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
        responseCompletedAt: timing ? completedAt : undefined,
        responseTrace: snapshotTrace(trace, completedAt),
      };
      const finalMessages         = [...msgs, assistantMsg];
      const newBlocks             = extractCodeBlocksForRegistry(finalContent);
      const updatedReg            = updateRegistry(baseReg, newBlocks, finalMessages.length - 1);
      const nextTitle             = !msgs.some((message) => message.role === 'assistant')
        ? deriveAutoChatTitle({
            currentTitle: latestTitleRef.current,
            projectLabel: panel.projectLabel,
            prompt: text,
            assistantReply: finalContent,
            autoTitle: autoTitleRef.current,
          }) ?? latestTitleRef.current
        : latestTitleRef.current;
      autoTitleRef.current = nextTitle;
      responseTimingRef.current = null;
      visibleReplyContentRef.current = '';
      setLiveResponseMs(null);
      setLiveReplyLatencyMs(null);

      onUpdate(panel.id, {
        title: nextTitle,
        messages: finalMessages,
        streaming: false,
        streamingContent: '',
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
      });
      onSave({
        ...panel,
        title: nextTitle,
        messages: finalMessages,
        fileRegistry: updatedReg,
        prevRegistry: snapReg,
        streamingPhase: null,
      });
    }

    function handleError(err: unknown, msgs: Message[]) {
      const timing = responseTimingRef.current;
      const completedAt = Date.now();
      const responseFirstTokenMs = timing
        ? Math.max(0, Math.round((timing.firstTokenPerf ?? performance.now()) - timing.startedPerf))
        : undefined;
      const responseTimeMs = timing
        ? Math.max(0, Math.round(performance.now() - timing.startedPerf))
        : undefined;
      const timingMetrics: ResponseTraceMetric[] = [
        ...(responseFirstTokenMs != null ? [{ label: 'First token', value: formatTraceDuration(responseFirstTokenMs) }] : []),
        ...(responseTimeMs != null ? [{ label: 'Elapsed', value: formatTraceDuration(responseTimeMs) }] : []),
      ];
      if (terminalTracePhase?.status === 'running') {
        finishTracePhase(terminalTracePhase, {
          status: (err as Error)?.name === 'AbortError' ? 'skipped' : 'error',
          detail: (err as Error)?.name === 'AbortError'
            ? 'Generation was stopped before the phase finished.'
            : `The phase ended with an error: ${(err as Error).message}`,
          metrics: timingMetrics,
        });
        terminalTracePhase = undefined;
      }
      trace.firstTokenAt = timing?.firstTokenAt ?? trace.firstTokenAt;
      trace.completedAt = completedAt;
      trace.firstTokenDurationMs = responseFirstTokenMs;
      trace.totalDurationMs = responseTimeMs;
      if ((err as Error)?.name === 'AbortError') {
        const content = visibleReplyContentRef.current || panel.streamingContent;
        if (content) {
          const assistantMsg: Message = {
            role: 'assistant',
            content: content + '\n\n_[stopped]_',
            responseTimeMs,
            responseFirstTokenMs,
            responseStartedAt: timing?.startedAt,
            responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
            responseCompletedAt: timing ? completedAt : undefined,
            responseTrace: snapshotTrace(trace, completedAt),
          };
          const finalMessages         = [...msgs, assistantMsg];
          const newBlocks             = extractCodeBlocksForRegistry(content);
          const updatedReg            = updateRegistry(panel.fileRegistry, newBlocks, finalMessages.length - 1);
          const nextTitle             = !msgs.some((message) => message.role === 'assistant')
            ? deriveAutoChatTitle({
                currentTitle: latestTitleRef.current,
                projectLabel: panel.projectLabel,
                prompt: text,
                assistantReply: content,
                autoTitle: autoTitleRef.current,
              }) ?? latestTitleRef.current
            : latestTitleRef.current;
          autoTitleRef.current = nextTitle;
          responseTimingRef.current = null;
          setLiveResponseMs(null);
          setLiveReplyLatencyMs(null);
          onUpdate(panel.id, {
            title: nextTitle,
            messages: finalMessages,
            streaming: false,
            streamingContent: '',
            fileRegistry: updatedReg,
            streamingPhase: null,
          });
          onSave({
            ...panel,
            title: nextTitle,
            messages: finalMessages,
            fileRegistry: updatedReg,
            streamingPhase: null,
          });
        } else {
          responseTimingRef.current = null;
          visibleReplyContentRef.current = '';
          setLiveResponseMs(null);
          setLiveReplyLatencyMs(null);
          onUpdate(panel.id, { streaming: false, streamingContent: '', streamingPhase: null });
        }
      } else {
        trace.orchestrationSummary = `The reply pipeline failed before completion while using ${modelName}.`;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorHelp = buildModelErrorHelp(modelName, errorMessage);
        const errMsg: Message = {
          role: 'assistant',
          content: errorHelp
            ? `Error: ${errorMessage}\n\n${errorHelp}`
            : `Error: ${errorMessage}`,
          responseTimeMs,
          responseFirstTokenMs,
          responseStartedAt: timing?.startedAt,
          responseFirstTokenAt: timing?.firstTokenAt ?? completedAt,
          responseCompletedAt: timing ? completedAt : undefined,
          responseTrace: snapshotTrace(trace, completedAt),
        };
        responseTimingRef.current = null;
        visibleReplyContentRef.current = '';
        setLiveResponseMs(null);
        setLiveReplyLatencyMs(null);
        onUpdate(panel.id, { messages: [...msgs, errMsg], streaming: false, streamingContent: '', streamingPhase: null });
      }
    }

    function markFirstToken() {
      const timing = responseTimingRef.current;
      if (!timing || timing.firstTokenPerf != null) return;

      const firstTokenAt = Date.now();
      const firstTokenPerf = performance.now();
      responseTimingRef.current = {
        ...timing,
        firstTokenAt,
        firstTokenPerf,
      };
      trace.firstTokenAt = firstTokenAt;
      setLiveReplyLatencyMs(Math.max(0, Math.round(firstTokenPerf - timing.startedPerf)));
    }

  }, [models, onSave, onUpdate, panel, replyPreferences]);

  function handleSend() {
    void sendPrompt(inputValue);
  }

  useEffect(() => {
    if (!launchPrompt?.trim() || panel.streaming || panel.messages.length > 0) return;
    const launchKey = `${panel.id}::${launchPrompt.trim()}`;
    if (activeLaunchPromptRuns.has(launchKey)) return;
    activeLaunchPromptRuns.add(launchKey);
    onConsumeLaunchPrompt?.(panel.id);
    void (async () => {
      try {
        await sendPrompt(launchPrompt);
      } finally {
        activeLaunchPromptRuns.delete(launchKey);
      }
    })();
  }, [
    launchPrompt,
    onConsumeLaunchPrompt,
    panel.id,
    panel.messages.length,
    panel.streaming,
    sendPrompt,
  ]);

  function handleStop()  { abortRef.current?.abort(); }
  function handleModelChange(model: string) {
    onUpdate(panel.id, { model });
    onSave({ ...panel, model });
  }
  function handlePresetChange(id: string) {
    onUpdate(panel.id, { preset: id });
    onSave({ ...panel, preset: id });
  }
  function handleReasoningEffortChange(reasoningEffort: ChatReasoningEffort) {
    onUpdate(panel.id, { reasoningEffort });
    onSave({ ...panel, reasoningEffort });
  }
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleUploadFiles(files: File[]) {
    const imported = await readImportableAttachments(files);
    if (!imported.length) return;
    const updatedRegistry = updateRegistry(panel.fileRegistry, imported, panel.messages.length);
    onUpdate(panel.id, { fileRegistry: updatedRegistry });
    onSave({ ...panel, fileRegistry: updatedRegistry });
  }

  const currentPreset  = panel.preset ?? DEFAULT_PRESET_ID;
  const currentReasoningEffort = panel.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const currentModel = resolveModelHandle(panel.model, models, { preserveUnavailable: true });
  const isCodeThread = panel.threadType === 'code' || panel.threadType === 'debug';
  const presetCandidates = isCodeThread
    ? PRESETS.filter((preset) => preset.id === 'code')
    : PRESETS.filter((preset) => preset.id !== 'code');
  const presetPickerOptions = (
    presetCandidates.some((preset) => preset.id === currentPreset)
      ? presetCandidates
      : [getPreset(currentPreset), ...presetCandidates.filter((preset) => preset.id !== currentPreset)]
  ).map<ChatComposerOption>((preset) => ({
    value: preset.id,
    label: preset.label,
    description: describePreset(preset.id),
  }));
  const reasoningOptions = REASONING_EFFORT_OPTIONS.map<ChatComposerOption>((option) => {
    const optionConfig = REASONING_EFFORT_CONFIG[option.value];
    return {
      value: option.value,
      label: option.label,
      description: `Targets ${optionConfig.maxSources} live sources with a ${optionConfig.fetchDepth === 'deep' ? 'deep' : 'standard'} comparison pass; requires at least ${optionConfig.minLiveSources} verified source${optionConfig.minLiveSources === 1 ? '' : 's'}.`,
    };
  });
  const isCodeStreaming = panel.streaming && currentPreset === 'code';
  const inputPlaceholder =
    "Ask anything... paste a URL and it'll be fetched automatically. Shift+Enter for newline.";
  const messageOffsets = new Array<number>(panel.messages.length);
  const messageHeights = new Array<number>(panel.messages.length);
  let totalVirtualHeight = 0;

  for (let index = 0; index < panel.messages.length; index += 1) {
    const message = panel.messages[index];
    const trailingGapPx = index === panel.messages.length - 1 ? 0 : MESSAGE_STACK_GAP_PX;
    const hideCodeBlocks = message.role === 'assistant' && currentPreset === 'code';
    const measuredHeight = rowHeightsRef.current.get(index);
    const nextHeight = measuredHeight ?? estimateMessageHeight(message, hideCodeBlocks, trailingGapPx);

    messageOffsets[index] = totalVirtualHeight;
    messageHeights[index] = nextHeight;
    totalVirtualHeight += nextHeight;
  }

  let virtualStartIndex = 0;
  let virtualEndIndex = -1;

  if (hasMessages) {
    const renderTop = Math.max(0, scrollTop - MESSAGE_OVERSCAN_PX);
    const renderBottom = scrollTop + Math.max(viewportHeight, 1) + MESSAGE_OVERSCAN_PX;

    while (
      virtualStartIndex < panel.messages.length
      && messageOffsets[virtualStartIndex] + messageHeights[virtualStartIndex] < renderTop
    ) {
      virtualStartIndex += 1;
    }

    let endCursor = virtualStartIndex;
    while (endCursor < panel.messages.length && messageOffsets[endCursor] < renderBottom) {
      endCursor += 1;
    }

    virtualEndIndex = Math.min(
      panel.messages.length - 1,
      Math.max(endCursor - 1, virtualStartIndex + 5),
    );
  }

  return (
    <div
      className={`chat-panel${selected ? ' active' : ''}${backgroundMode ? ' background-mode' : ''}`}
      onMouseDown={() => onActivate?.(panel.id)}
    >
      <div className="panel-header">
        <input
          className="panel-title"
          value={panel.title}
          placeholder="Chat name..."
          onChange={e => onUpdate(panel.id, { title: e.target.value })}
          onBlur={() => onSave(panel)}
        />
        {hasMessages && (
          <button className="panel-btn" onClick={handleExportLog} title="Export chat log as Markdown">
            <IconDownload size={13} />
          </button>
        )}
        <button
          className="panel-btn close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(panel.id);
          }}
          title="Close panel"
        >
          <IconX size={13} />
        </button>
      </div>

      <div className="messages" ref={messagesViewportRef}>
        {!hasMessages && !panel.streaming ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconHexagon size={52} /></div>
            <h3>Ready</h3>
            <p>Ask me to write code, generate docs, or debug anything.</p>
          </div>
        ) : (
          <div className="messages-stack">
            {hasMessages && (
              <div className="messages-virtual-stage" style={{ height: `${totalVirtualHeight}px` }}>
                {panel.messages.slice(virtualStartIndex, virtualEndIndex + 1).map((msg, localIndex) => {
                  const actualIndex = virtualStartIndex + localIndex;
                  const isCodeAssistant = msg.role === 'assistant' && currentPreset === 'code';
                  const replyPreferenceDraft = msg.role === 'assistant'
                    ? buildReplyPreferenceEntry({
                        chatId: panel.id,
                        chatTitle: panel.title,
                        assistantMessage: msg,
                        assistantIndex: actualIndex,
                        messages: panel.messages,
                        panel,
                        feedback: 'liked',
                      })
                    : null;
                  return (
                    <div
                      key={actualIndex}
                      className="message-virtual-row"
                      style={{ top: `${messageOffsets[actualIndex]}px` }}
                    >
                      <div
                        ref={(node) => handleVirtualRowRef(actualIndex, node)}
                        className={`message-virtual-row-shell${actualIndex === panel.messages.length - 1 ? ' is-last' : ''}`}
                      >
                        <MessageBubble
                          message={msg}
                          withDownload={true}
                          prevRegistry={panel.prevRegistry}
                          model={panel.model}
                          showDeveloperTools={showDeveloperTools}
                          feedbackValue={replyPreferenceDraft ? replyPreferenceFeedbackById.get(replyPreferenceDraft.id) ?? null : null}
                          onFeedbackChange={replyPreferenceDraft ? (next) => handleReplyFeedbackChange(msg, actualIndex, next) : undefined}
                          hideCodeBlocks={isCodeAssistant}
                          suppressNoCodeWarning={currentPreset !== 'code'}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {panel.streaming && (
              <>
                {isCodeStreaming && (
                  <div className="checklist-wrap">
                    <ChecklistIndicator
                      steps={checklistSteps}
                      currentStep={checklistCurrentStep}
                      isPlanning={checklistPlanning}
                      isClassifying={checklistClassifying}
                      mode={checklistMode}
                    />
                  </div>
                )}

                {panel.streamingContent ? (
                  <div className="streaming-wrap">
                    {(() => {
                      const summaryMarker = '\n\n<!-- summary -->\n\n';
                      const hasSummary = isCodeStreaming &&
                        panel.streamingContent.includes(summaryMarker);
                      if (isCodeStreaming && !hasSummary) return null;
                      return (
                        <MessageBubble
                          message={{ role: 'assistant', content: panel.streamingContent }}
                          withDownload={false}
                          prevRegistry={panel.prevRegistry}
                          model={panel.model}
                          showDeveloperTools={showDeveloperTools}
                          hideCodeBlocks={isCodeStreaming}
                          liveReplyLatencyMs={liveReplyLatencyMs ?? undefined}
                          suppressNoCodeWarning={true}
                        />
                      );
                    })()}
                  </div>
                ) : !isCodeStreaming ? (
                  <div className="thinking">
                    <div className="thinking-dots"><span /><span /><span /></div>
                    <span>
                      thinking...
                      {liveResponseMs != null ? ` ${Math.max(0.1, liveResponseMs / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>

      <FileRegistryPanel registry={panel.fileRegistry} chatTitle={panel.title} />

      <div className="panel-input">
        <ChatComposer
          value={inputValue}
          onValueChange={setInputValue}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          ariaLabel={inputPlaceholder}
          textareaRef={inputRef}
          disabled={panel.streaming}
          uploadTitle="Upload files or a zip into this chat"
          uploadActive={panel.fileRegistry.size > 0}
          onUploadFiles={handleUploadFiles}
          reasoningValue={currentReasoningEffort}
          reasoningOptions={reasoningOptions}
          onReasoningChange={(value) => handleReasoningEffortChange(value as ChatReasoningEffort)}
          reasoningDisabled={currentPreset === 'code'}
          presetValue={currentPreset}
          presetOptions={presetPickerOptions}
          onPresetChange={handlePresetChange}
          presetDisabled={presetPickerOptions.length < 2}
          modelValue={currentModel}
          modelOptions={models}
          onModelChange={handleModelChange}
          onSend={handleSend}
          sendDisabled={!inputValue.trim()}
          isStreaming={panel.streaming}
          onStop={handleStop}
        />
      </div>
    </div>
  );
}
