import type { ReplyPreferenceRecord, ThreadType } from '../types';

export const REPLY_PREFERENCES_STORAGE_KEY = 'larry_reply_preferences_v1';
export const REPLY_PREFERENCES_UPDATED_EVENT = 'larry-reply-preferences-updated';

const MAX_REPLY_PREFERENCES = 80;
const MAX_PROMPT_EXCERPT = 180;
const MAX_REPLY_EXCERPT = 260;

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxLength: number): string {
  const clean = normaliseWhitespace(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}...`;
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function parseReplyPreferences(value: string | null): ReplyPreferenceRecord[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as ReplyPreferenceRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.prompt === 'string' &&
      typeof entry.reply === 'string' &&
      (entry.feedback === 'liked' || entry.feedback === 'disliked'),
    );
  } catch {
    return [];
  }
}

function persistReplyPreferences(next: ReplyPreferenceRecord[]): ReplyPreferenceRecord[] {
  if (typeof window === 'undefined') return next;
  localStorage.setItem(REPLY_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(REPLY_PREFERENCES_UPDATED_EVENT));
  return next;
}

function tokenize(text: string): string[] {
  return normaliseWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

const STOPWORDS = new Set([
  'about', 'after', 'before', 'between', 'could', 'from', 'have', 'into', 'just', 'like',
  'more', 'that', 'than', 'then', 'they', 'this', 'what', 'when', 'where', 'which', 'while',
  'with', 'would', 'your', 'there', 'their', 'them', 'were', 'will', 'shall', 'should', 'been',
  'being', 'also', 'into', 'onto', 'over', 'under', 'very', 'some', 'such', 'only', 'need',
]);

export function cleanReplyPreferenceText(text: string): string {
  return text
    .replace(/<!--\s*step-break:[^>]*-->/g, '')
    .replace(/<!--\s*summary\s*-->/g, '')
    .replace(/#+\s*changes?\s*\n(\|.+\n)+/gi, '')
    .replace(/^\|[-:| ]+\|\s*$/gm, '')
    .trim();
}

export function buildReplyPreferenceId(input: {
  chatId: string;
  prompt: string;
  reply: string;
  responseCompletedAt?: number;
  index: number;
}): string {
  const signature = [
    input.chatId,
    input.index,
    input.responseCompletedAt ?? 'na',
    normaliseWhitespace(input.prompt),
    normaliseWhitespace(input.reply),
  ].join('::');

  return `replypref_${stableHash(signature)}`;
}

export function loadReplyPreferences(): ReplyPreferenceRecord[] {
  if (typeof window === 'undefined') return [];
  return parseReplyPreferences(localStorage.getItem(REPLY_PREFERENCES_STORAGE_KEY))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertReplyPreference(
  entry: Omit<ReplyPreferenceRecord, 'createdAt' | 'updatedAt'>,
): ReplyPreferenceRecord[] {
  const current = loadReplyPreferences();
  const existing = current.find((item) => item.id === entry.id);
  const now = Date.now();
  const nextEntry: ReplyPreferenceRecord = {
    ...entry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const next = [
    nextEntry,
    ...current.filter((item) => item.id !== entry.id),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_REPLY_PREFERENCES);

  return persistReplyPreferences(next);
}

export function removeReplyPreference(id: string): ReplyPreferenceRecord[] {
  const next = loadReplyPreferences().filter((entry) => entry.id !== id);
  return persistReplyPreferences(next);
}

export function clearReplyPreferences(): ReplyPreferenceRecord[] {
  if (typeof window === 'undefined') return [];
  localStorage.removeItem(REPLY_PREFERENCES_STORAGE_KEY);
  window.dispatchEvent(new Event(REPLY_PREFERENCES_UPDATED_EVENT));
  return [];
}

function scorePreference(
  preference: ReplyPreferenceRecord,
  currentPrompt: string,
  surface: ThreadType,
  preset?: string,
): number {
  let score = 0;
  if (preference.surface === surface) score += 5;
  if (preset && preference.preset === preset) score += 2;

  const currentTokens = new Set(tokenize(currentPrompt));
  const preferenceTokens = tokenize(preference.prompt);
  for (const token of preferenceTokens) {
    if (currentTokens.has(token)) score += 3;
  }

  const ageHours = Math.max(1, (Date.now() - preference.updatedAt) / (1000 * 60 * 60));
  score += Math.max(0, 3 - Math.log10(ageHours));
  return score;
}

export function buildReplyPreferenceInject(options: {
  preferences: ReplyPreferenceRecord[];
  prompt: string;
  surface: ThreadType;
  preset?: string;
}): { inject: string; matchedCount: number } {
  if (!options.preferences.length) {
    return { inject: '', matchedCount: 0 };
  }

  const ranked = [...options.preferences]
    .map((preference) => ({
      preference,
      score: scorePreference(preference, options.prompt, options.surface, options.preset),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const liked = ranked
    .filter((entry) => entry.preference.feedback === 'liked')
    .slice(0, 2)
    .map((entry) => entry.preference);
  const disliked = ranked
    .filter((entry) => entry.preference.feedback === 'disliked')
    .slice(0, 2)
    .map((entry) => entry.preference);

  if (!liked.length && !disliked.length) {
    return { inject: '', matchedCount: 0 };
  }

  const lines: string[] = [
    '',
    '---',
    '## Learned User Reply Preferences',
    'The user has previously rated similar replies for accuracy/validity. Use this memory only when relevant to the current prompt.',
    '- Treat liked examples as a quality bar for detail, evidence use, structure, and framing.',
    '- Treat disliked examples as patterns to avoid repeating.',
    '- Do not mention this preference memory unless the user asks about it.',
  ];

  if (liked.length) {
    lines.push('', 'Preferred examples:');
    for (const entry of liked) {
      lines.push(
        `- Prompt: "${truncate(entry.prompt, MAX_PROMPT_EXCERPT)}"`,
        `  Accepted reply excerpt: "${truncate(cleanReplyPreferenceText(entry.reply), MAX_REPLY_EXCERPT)}"`,
      );
    }
  }

  if (disliked.length) {
    lines.push('', 'Rejected examples:');
    for (const entry of disliked) {
      lines.push(
        `- Prompt: "${truncate(entry.prompt, MAX_PROMPT_EXCERPT)}"`,
        `  Rejected reply excerpt: "${truncate(cleanReplyPreferenceText(entry.reply), MAX_REPLY_EXCERPT)}"`,
      );
    }
  }

  lines.push('---');

  return {
    inject: lines.join('\n'),
    matchedCount: liked.length + disliked.length,
  };
}
