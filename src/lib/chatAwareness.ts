import type { ChatExchangeMemory } from '../types';

export interface ChatAwarenessConversationEntry {
  role: string;
  content: string;
  exchangeMemory?: ChatExchangeMemory;
}

export interface ChatAwarenessSignals {
  memories: ChatExchangeMemory[];
  activeMemory: ChatExchangeMemory | null;
  topics: string[];
  keyTerms: string[];
  keyPhrases: string[];
  keyFacts: string[];
  searchText: string;
}

const MEMORY_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'around', 'because', 'been', 'before', 'being', 'between',
  'both', 'could', 'does', 'doing', 'during', 'each', 'from', 'have', 'having', 'into', 'just', 'more', 'most',
  'much', 'need', 'only', 'other', 'over', 'please', 'really', 'should', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'what', 'when', 'where', 'which',
  'while', 'who', 'with', 'would', 'your', 'were', 'was', 'have', 'has', 'had', 'will', 'can', 'could', 'into',
  'from', 'explain', 'explained', 'summary', 'answer', 'reply', 'chat',
]);

const FACT_SIGNAL_RE = /\b(is|was|were|are|included|established|created|resulted|began|ended|tried|charged|convicted|sentenced|prosecuted|held|became|helped|led|founded|defined)\b/i;
const CONTEXT_DEPENDENT_RE = /\b(who|what|which|when|where|why|how|those|these|they|them|their|he|him|his|she|her|hers|it|its|that|this|individuals|people|figures|trial|trials|defendants|leaders)\b/i;
const CORRECTION_FOLLOW_UP_RE = /\b(wrong|incorrect|inaccurate|not accurate|not right|still wrong|same answer|same thing|check again|recheck|verify again|double[- ]check|that is false|that'?s false|that can'?t be right|actually|instead|rather|wasn'?t|weren'?t|isn'?t|aren'?t|didn'?t|doesn'?t|never)\b/i;
const CORRECTION_OUTCOME_RE = /\b(suicide|cyanide|capsule|pill|hung|hanged|hanging|executed|execution|died|death|killed|before execution|before hanging|right before)\b/i;
const SUBJECT_WORD_RE = /\b(trial|trials|defendant|defendants|court|courts|crime|crimes|criminal|justice|history|law|laws|case|cases|mission|program|launch|flight|crew|policy|government|president|company|product|service|platform|model|framework|library|language|api|election|campaign|event)\b/i;

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function cleanMemoryText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[_*~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemoryComparisonText(text: string): string {
  return cleanMemoryText(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractReplySummarySource(text: string): string {
  const summaryMatch = text.match(/<!--\s*summary\s*-->\s*([\s\S]*)$/i);
  return cleanMemoryText(summaryMatch?.[1] || text);
}

function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function stripPromptLead(text: string): string {
  const cleaned = cleanMemoryText(text)
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^help\s+me(?:\s+with|\s+to)?\s+/i, '')
    .replace(/^i\s+need\s+(?:help\s+with\s+)?/i, '')
    .replace(/^let'?s\s+/i, '')
    .replace(/^(?:tell\s+me(?:\s+about)?|explain(?:\s+to\s+me)?|describe|summarize|outline|walk\s+me\s+through)\s+/i, '')
    .replace(/^(?:what|who|which|when|where|why|how)(?:\s+(?:is|are|was|were|did|do|does))?\s+/i, '')
    .replace(/^(?:give\s+me|show\s+me)\s+/i, '')
    .replace(/\?+$/, '')
    .trim();

  return cleaned || cleanMemoryText(text);
}

function clampWords(text: string, maxWords = 14, maxLength = 140): string {
  const cleaned = cleanMemoryText(text);
  if (!cleaned) return '';
  const words = cleaned.split(/\s+/).filter(Boolean);
  const compact = words.slice(0, maxWords).join(' ');
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function splitSentences(text: string): string[] {
  return cleanMemoryText(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function extractKeyTerms(text: string, maxTerms = 10): string[] {
  return uniqueStrings(
    normalizeMemoryComparisonText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !MEMORY_STOPWORDS.has(token)),
  ).slice(0, maxTerms);
}

function extractCapitalizedPhrases(text: string): string[] {
  const matches = text.match(/\b(?:[A-Z\u00C0-\u00D6\u00D8-\u00DE][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF'-]+(?:\s+[A-Z\u00C0-\u00D6\u00D8-\u00DE][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF'-]+){0,4}|[A-Z]{2,}(?:\s+[A-Z]{2,})*)\b/g) ?? [];
  return uniqueStrings(
    matches
      .map((phrase) => cleanMemoryText(phrase))
      .filter((phrase) => phrase.length >= 6),
  );
}

function extractWindowedPhrases(text: string, maxPhrases = 8): string[] {
  const tokens = cleanMemoryText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const phrases: string[] = [];
  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const window = tokens.slice(index, index + size);
      if (MEMORY_STOPWORDS.has(window[0]) || MEMORY_STOPWORDS.has(window[window.length - 1])) continue;
      const significantCount = window.filter((token) => token.length >= 4 && !MEMORY_STOPWORDS.has(token)).length;
      if (significantCount < 2) continue;

      const phrase = window.join(' ');
      if (phrase.length < 8 || phrase.length > 48) continue;
      phrases.push(phrase);
      if (phrases.length >= maxPhrases * 2) break;
    }
    if (phrases.length >= maxPhrases * 2) break;
  }

  return uniqueStrings(phrases).slice(0, maxPhrases);
}

function extractPromptSubject(prompt: string): string {
  const cleaned = stripPromptLead(prompt);
  const firstClause = cleaned.split(/[.?!]/).map((part) => part.trim()).find(Boolean) || cleaned;
  const normalized = firstClause
    .replace(/^about\s+/i, '')
    .replace(/^(?:to\s+me\s+)?/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\b(?:was|were|is|are|did|does)\s+(?:he|she|they|it)\b.*$/i, '')
    .trim();
  return clampWords(normalized || firstClause, 8, 72);
}

function extractPromptEntities(prompt: string, maxEntities = 4): string[] {
  const cleaned = stripPromptLead(prompt)
    .replace(/^about\s+/i, '')
    .replace(/\b(?:was|were|is|are|did|does)\s+(?:he|she|they|it)\b.*$/i, '')
    .trim();
  return extractCapitalizedPhrases(cleaned).slice(0, maxEntities);
}

function extractKeyFacts(reply: string, maxFacts = 4): string[] {
  return uniqueStrings(
    splitSentences(extractReplySummarySource(reply))
      .filter((sentence) => {
        const wordCount = sentence.split(/\s+/).filter(Boolean).length;
        if (wordCount < 6 || wordCount > 30) return false;
        return /\b\d{4}\b/.test(sentence)
          || /\b\d+\b/.test(sentence)
          || FACT_SIGNAL_RE.test(sentence)
          || extractCapitalizedPhrases(sentence).length > 0;
      })
      .map((sentence) => clampWords(sentence, 24, 180)),
  ).slice(0, maxFacts);
}

function buildTopic(prompt: string, reply: string, keyPhrases: string[]): string {
  const promptSubject = extractPromptSubject(prompt);
  const promptEntities = extractPromptEntities(prompt, 4);
  const promptTerms = extractKeyTerms(promptSubject, 4);
  const replySource = extractReplySummarySource(reply);
  const replyCandidates = uniqueStrings([
    ...extractCapitalizedPhrases(replySource),
    ...extractWindowedPhrases(replySource, 10),
  ]);
  const candidates = uniqueStrings([
    ...promptEntities,
    ...replyCandidates,
    ...keyPhrases,
    promptSubject,
    clampWords(replySource, 7, 56),
  ]);

  let bestCandidate = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const cleaned = sentenceCase(candidate.replace(/[.?!:;,]+$/, '').trim());
    if (!cleaned) continue;

    const lower = normalizeMemoryComparisonText(cleaned).toLowerCase();
    let score = 0;
    if (promptEntities.some((entity) => normalizeMemoryComparisonText(entity).toLowerCase() === lower)) score += 12;
    if (promptEntities.some((entity) => {
      const normalizedEntity = normalizeMemoryComparisonText(entity).toLowerCase();
      return normalizedEntity.includes(lower) || lower.includes(normalizedEntity);
    })) score += 6;
    if (cleaned === promptSubject) score += 4;
    if (cleaned.includes(' ')) score += 6;
    if (SUBJECT_WORD_RE.test(cleaned)) score += 4;
    if (normalizeMemoryComparisonText(replySource).toLowerCase().includes(lower)) score += 6;
    if (promptTerms.length > 0) {
      score += promptTerms.filter((term) => lower.includes(term)).length * 5;
      if (promptTerms.some((term) => lower.endsWith(term))) score += 2;
    }
    if (cleaned.split(/\s+/).length > 6) score -= 3;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = cleaned;
    }
  }

  return bestCandidate || sentenceCase(promptSubject || clampWords(replySource, 7, 56));
}

function findPreviousUserIndex(history: ChatAwarenessConversationEntry[], assistantIndex: number): number {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') return index;
  }
  return -1;
}

export function buildExchangeMemory(prompt: string, reply: string): ChatExchangeMemory {
  const promptSummary = clampWords(prompt, 14, 120);
  const replySummary = clampWords(extractReplySummarySource(reply), 24, 220);
  const keyPhrases = uniqueStrings([
    ...extractCapitalizedPhrases(`${prompt}\n${reply}`),
    ...extractWindowedPhrases(`${prompt}\n${extractReplySummarySource(reply)}`),
  ]).slice(0, 6);
  const keyTerms = uniqueStrings([
    ...extractKeyTerms(prompt, 6),
    ...extractKeyTerms(extractReplySummarySource(reply), 8),
    ...extractKeyTerms(keyPhrases.join(' '), 4),
  ]).slice(0, 10);
  const keyFacts = extractKeyFacts(reply, 4);

  return {
    topic: buildTopic(promptSummary, replySummary, keyPhrases),
    promptSummary,
    replySummary,
    keyTerms,
    keyPhrases,
    keyFacts,
  };
}

export function collectRecentExchangeMemories(
  history: ChatAwarenessConversationEntry[],
  maxExchanges = 3,
): ChatExchangeMemory[] {
  const memories: ChatExchangeMemory[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'assistant') continue;

    const memory = message.exchangeMemory || (() => {
      const previousUserIndex = findPreviousUserIndex(history, index);
      if (previousUserIndex < 0) return null;
      return buildExchangeMemory(history[previousUserIndex].content, message.content);
    })();

    if (!memory) continue;
    memories.unshift(memory);
    if (memories.length >= maxExchanges) break;
  }

  return memories;
}

export function collectChatAwarenessSignals(
  history: ChatAwarenessConversationEntry[],
  maxExchanges = 3,
): ChatAwarenessSignals {
  const memories = collectRecentExchangeMemories(history, maxExchanges);
  const prioritizedMemories = [...memories].reverse();
  const activeMemory = prioritizedMemories[0] ?? null;
  const topics = uniqueStrings(prioritizedMemories.map((memory) => memory.topic)).slice(0, maxExchanges);
  const keyTerms = uniqueStrings(prioritizedMemories.flatMap((memory) => memory.keyTerms)).slice(0, 12);
  const keyPhrases = uniqueStrings(prioritizedMemories.flatMap((memory) => memory.keyPhrases)).slice(0, 8);
  const keyFacts = uniqueStrings(prioritizedMemories.flatMap((memory) => memory.keyFacts)).slice(0, 6);

  return {
    memories,
    activeMemory,
    topics,
    keyTerms,
    keyPhrases,
    keyFacts,
    searchText: uniqueStrings([
      ...topics,
      ...keyPhrases,
      ...keyTerms,
    ]).join(' '),
  };
}

export function isLikelyCorrectionFollowUp(text: string): boolean {
  const cleaned = cleanMemoryText(text).toLowerCase();
  if (!cleaned) return false;
  return CORRECTION_FOLLOW_UP_RE.test(cleaned)
    || (/\bright before\b/i.test(cleaned) && CORRECTION_OUTCOME_RE.test(cleaned))
    || (/\bmeant to be\b/i.test(cleaned) && CORRECTION_OUTCOME_RE.test(cleaned));
}

export function isContextDependentFollowUp(currentUserText: string, history: ChatAwarenessConversationEntry[]): boolean {
  const cleaned = cleanMemoryText(currentUserText).toLowerCase();
  const currentTerms = extractKeyTerms(cleaned, 8);
  return collectRecentExchangeMemories(history, 1).length > 0
    && (currentTerms.length <= 5 || CONTEXT_DEPENDENT_RE.test(cleaned) || isLikelyCorrectionFollowUp(cleaned));
}

export function buildChatAwarenessTurnContent(
  history: ChatAwarenessConversationEntry[],
  currentUserText: string,
  maxExchanges = 3,
): string {
  if (!isContextDependentFollowUp(currentUserText, history)) return '';

  const signals = collectChatAwarenessSignals(history, maxExchanges);
  if (!signals.memories.length) return '';

  const activeMemory = signals.activeMemory ?? signals.memories[signals.memories.length - 1];
  const lines: string[] = [
    '## Chat Awareness',
    `Active subject: ${activeMemory.topic || activeMemory.promptSummary}`,
    'Treat the current prompt as a follow-up on that subject unless the user clearly introduces a new one.',
    'Resolve generic references like "individuals", "people", "leaders", "defendants", "they", or "those tried" against the active subject.',
    'If the user is correcting a prior answer with pronouns like "he", "she", or "they", anchor that correction to the latest named entity from the most recent exchange.',
    '',
  ];

  signals.memories.forEach((memory, index) => {
    lines.push(`### Exchange ${index + 1}: ${memory.topic || memory.promptSummary}`);
    lines.push(`Prompt: ${memory.promptSummary}`);
    lines.push(`Reply: ${memory.replySummary}`);
    if (memory.keyPhrases.length) {
      lines.push(`Phrases: ${memory.keyPhrases.slice(0, 3).join('; ')}`);
    }
    if (memory.keyFacts.length) {
      lines.push('Facts:');
      memory.keyFacts.slice(0, 2).forEach((fact) => {
        lines.push(`- ${fact}`);
      });
    }
    lines.push('');
  });

  return lines.join('\n').trim();
}
