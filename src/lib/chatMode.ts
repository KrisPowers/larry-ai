import type { FetchContextDepth } from './fetcher';

export type ChatWorkflowMode = 'conversation' | 'note-taking' | 'deep-research' | 'creative';

export interface ChatWorkflowDecision {
  mode: ChatWorkflowMode;
  confidence: 'low' | 'medium' | 'high';
  effectivePresetId: string;
  fetchDepth: FetchContextDepth;
  forceFetch: boolean;
  minParagraphs: number;
  minSentencesPerParagraph: number;
  summary: string;
}

const NOTE_TAKING_RE = /\b(note\s*taking|notetaking|notes?|meeting minutes|minutes|action items?|takeaways|outline|study notes|lecture notes|organize these notes|turn this into notes|bullet points?)\b/i;
const RESEARCH_RE = /\b(latest|current|recent|today|now|timeline|plan|roadmap|status|announced|reported|reporting|sources?|what's going on|what is going on|investigate|research|verify|confirm|accurate|evidence|brief me)\b/i;
const FACTUAL_DOMAIN_RE = /\b(nasa|moon|space|mission|government|election|economy|policy|ceo|company|market|war|conflict|science|study|launch|agency|official)\b/i;
const CREATIVE_RE = /\b(write a story|poem|lyrics|fiction|roleplay|brainstorm names|tagline|copy ideas|creative)\b/i;
const EXPLICIT_DEEP_RESEARCH_RE = /\b(deep research|deep dive|investigate|investigation|exhaustive|comprehensive|thorough|full context|full report|detailed breakdown|detailed analysis|cross-check|source disagreement|verify carefully|evidence-backed breakdown)\b/i;
const CASUAL_RE = /^(hi|hello|hey|yo|thanks|thank you|cool|nice|ok|okay|help)\W*$/i;

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  return matches?.length ?? 0;
}

export function classifyChatWorkflow(
  prompt: string,
  history: Array<{ role: string; content: string }> = [],
  basePresetId = 'auto-chat',
): ChatWorkflowDecision {
  const recentHistory = history
    .filter((message) => message.role === 'user')
    .slice(-4)
    .map((message) => message.content)
    .join(' ');
  const combined = normalise(`${recentHistory} ${prompt}`);
  const cleanPrompt = normalise(prompt);
  const questionCount = (cleanPrompt.match(/\?/g) ?? []).length;
  const currentResearchCueCount = countMatches(cleanPrompt, RESEARCH_RE);
  const explicitDeepResearch = EXPLICIT_DEEP_RESEARCH_RE.test(cleanPrompt);
  const noteScore =
    (NOTE_TAKING_RE.test(combined) ? 4 : 0) +
    (/\b(summarize|summarise|organize|capture|convert)\b/i.test(combined) ? 2 : 0);
  const researchScore =
    (RESEARCH_RE.test(combined) ? 4 : 0) +
    (FACTUAL_DOMAIN_RE.test(combined) ? 2 : 0) +
    (questionCount >= 2 ? 2 : questionCount === 1 ? 1 : 0) +
    (cleanPrompt.length >= 120 ? 1 : 0);

  if (basePresetId === 'creative') {
    return {
      mode: 'creative',
      confidence: 'high',
      effectivePresetId: 'creative',
      fetchDepth: 'standard',
      forceFetch: false,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Manual creative mode selected.',
    };
  }

  if (basePresetId === 'deep-research') {
    return {
      mode: 'deep-research',
      confidence: 'high',
      effectivePresetId: 'deep-research',
      fetchDepth: 'deep',
      forceFetch: true,
      minParagraphs: 5,
      minSentencesPerParagraph: 3,
      summary: 'Manual deep research mode selected.',
    };
  }

  if (basePresetId === 'note-taking') {
    return {
      mode: 'note-taking',
      confidence: 'high',
      effectivePresetId: 'note-taking',
      fetchDepth: 'standard',
      forceFetch: false,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Manual note-taking mode selected.',
    };
  }

  if (!cleanPrompt || CASUAL_RE.test(cleanPrompt)) {
    return {
      mode: 'conversation',
      confidence: 'high',
      effectivePresetId: 'chatbot',
      fetchDepth: 'standard',
      forceFetch: false,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Detected a lightweight conversational request.',
    };
  }

  if (noteScore >= 4 && noteScore >= researchScore) {
    return {
      mode: 'note-taking',
      confidence: noteScore >= 6 ? 'high' : 'medium',
      effectivePresetId: 'note-taking',
      fetchDepth: 'standard',
      forceFetch: false,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Detected a note-taking or organization request.',
    };
  }

  if (CREATIVE_RE.test(combined)) {
    return {
      mode: 'creative',
      confidence: 'medium',
      effectivePresetId: 'creative',
      fetchDepth: 'standard',
      forceFetch: false,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Detected a creative or open-ended ideation request.',
    };
  }

  if (explicitDeepResearch || (researchScore >= 8 && cleanPrompt.length >= 160 && questionCount >= 2)) {
    return {
      mode: 'deep-research',
      confidence: researchScore >= 7 ? 'high' : 'medium',
      effectivePresetId: 'deep-research',
      fetchDepth: 'deep',
      forceFetch: true,
      minParagraphs: 5,
      minSentencesPerParagraph: 3,
      summary: 'Detected a factual, time-sensitive research request that needs broader context and a longer-form answer.',
    };
  }

  if (
    currentResearchCueCount > 0 ||
    (FACTUAL_DOMAIN_RE.test(cleanPrompt) && questionCount >= 1) ||
    /\b(who|what|when|where|which|timeline|status|plan|crew|astronaut|names?)\b/i.test(cleanPrompt)
  ) {
    return {
      mode: 'conversation',
      confidence: researchScore >= 6 ? 'high' : 'medium',
      effectivePresetId: 'chatbot',
      fetchDepth: 'standard',
      forceFetch: true,
      minParagraphs: 0,
      minSentencesPerParagraph: 0,
      summary: 'Detected a current factual lookup that should use live retrieval but stay concise and clear.',
    };
  }

  return {
    mode: 'conversation',
    confidence: 'medium',
    effectivePresetId: 'chatbot',
    fetchDepth: 'standard',
    forceFetch: false,
    minParagraphs: 0,
    minSentencesPerParagraph: 0,
    summary: 'Detected a general conversational request.',
  };
}
