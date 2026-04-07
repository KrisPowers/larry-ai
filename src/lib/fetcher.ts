export type FetchedSourceType = 'search' | 'news' | 'official' | 'reference' | 'community';
export type FetchedCredibility = 'official' | 'major-news' | 'reference' | 'search' | 'community';
export type FetchContextDepth = 'standard' | 'deep';

export interface FetchedContext {
  url: string;
  title: string;
  text: string;
  error?: string;
  durationMs?: number;
  provider?: string;
  sourceType?: FetchedSourceType;
  credibility?: FetchedCredibility;
  publishedAt?: string;
}

export interface ExtractedCrewRosterMember {
  name: string;
  role?: string;
  supportScore: number;
  sourceCount: number;
}

type QueryMode = 'conversation' | 'question' | 'research';
type TemporalFocus = 'timeless' | 'recent' | 'current' | 'future' | 'historic';
type SourceProfile = 'general' | 'government' | 'science' | 'technical';

interface QueryAnalysis {
  currentYear: number;
  years: number[];
  queryMode: QueryMode;
  temporalFocus: TemporalFocus;
  sourceProfile: SourceProfile;
  primaryTerm: string;
  contextTerm: string;
  countries: string[];
  prefersOfficialSources: boolean;
  prefersNewsSources: boolean;
  prefersCommunitySources: boolean;
  shouldFetch: boolean;
  maxSources: number;
  terms: string[];
  missionKeys: string[];
}

interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
  publishedAt?: string;
}

interface FetchPageOptions {
  provider: string;
  sourceType: FetchedSourceType;
  credibility: FetchedCredibility;
  title?: string;
  publishedAt?: string;
  timeoutMs?: number;
  minTextLength?: number;
}

interface FetchGlobalContextOptions {
  depth?: FetchContextDepth;
  forceFetch?: boolean;
  maxSources?: number;
}

interface ContextFormattingOptions {
  depth?: FetchContextDepth;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const YEAR_RE = /\b(19\d{2}|20\d{2}|21\d{2})\b/g;
const QUESTION_RE = /[?]|^(who|what|when|where|why|how|is|are|can|could|would|will|do|does|did|has|have|was|were|tell me|explain)\b/i;
const LOOKUP_RE = /\b(search|look up|lookup|find|research|check|browse|verify|confirm|update me|timeline|plan|schedule|status|latest|current|recent|compare)\b/i;
const FUTURE_RE = /\b(next|upcoming|future|planned|roadmap|timeline|schedule|scheduled|expected|forecast|target|tomorrow|next year|later this year|coming|next steps)\b/i;
const RELATIVE_TIME_RE = /\b(today|yesterday|tonight|this week|last week|this month|this year|right now|currently|current|latest|recent|now|live|breaking)\b/i;
const NEWS_EVENT_RE = /\b(news|headline|headlines|report|reports|reported|reporting|issue|issues|problem|problems|outage|outages|glitch|glitches|disruption|disruptions|controversy|incident|incidents|coverage)\b/i;
const FOLLOW_UP_ENTITY_RE = /\b(it|its|they|them|their|that|this|those|these|mission|program|launch|flight|crew)\b/i;
const STATUS_UPDATE_RE = /\b(status|timeline|latest|current|today|now|update|updates|what'?s going on|what is going on|happening|what happened|plan|next steps)\b/i;
const SPACE_RE = /\b(nasa|moon|mars|esa|space|launch|rocket|mission|orbiter|crew|astronaut|lunar|spacex|iss|jaxa|isro|csa)\b/i;
const GOVERNMENT_RE = /\b(government|official|agency|department|ministry|policy|president|prime minister|parliament|congress|senate|white house|state department|embassy|statement|announced|sanctions|treaty)\b/i;
const US_FEDERAL_RE = /\b(u\.?s\.?|united states|america(?:n)?|federal|white house|congress|senate|house|pentagon|homeland security|justice department|state department|treasury|nasa|cia|fbi|nsa|cdc|nih|fda|epa|irs|noaa|usda|faa|dhs|doj|dod|va|cisa|secret service)\b/i;
const TECHNICAL_RE = /\b(code|programming|typescript|javascript|python|react|node|api|framework|library|package|bug|debug|error|forum|reddit|hacker news|discussion)\b/i;
const COMMUNITY_RE = /\b(reddit|forum|hacker news|community|discussion|opinion|what are people saying|social media|sentiment)\b/i;
const CASUAL_QUERY_RE = /^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening)|thanks|thank you|thx|ok|okay|cool|nice|who are you|what can you do|how are you|help|help me|test)\W*$/i;
const COUNTRY_RE = /\b(iran|ukraine|russia|china|israel|gaza|taiwan|north korea|south korea|syria|sudan|myanmar|venezuela|belarus|cuba|turkey|egypt|saudi arabia|iraq|libya|nigeria|ethiopia|haiti|somalia|mali|niger|pakistan|india|bangladesh|sri lanka|afghanistan|yemen|lebanon|jordan|canada|united states|usa|uk|united kingdom|japan|australia|france|germany|european union|eu|un|nato|g7|g20)\b/gi;
const RECENT_YEAR_FLOOR = 2022;
const MAX_TEXT = 5000;
const MAX_SEARCH_ITEMS_PER_SOURCE = 20;
const MAX_SYSTEM_CONTEXTS_STANDARD = 8;
const MAX_SYSTEM_CONTEXTS_DEEP = 12;
const MAX_SYSTEM_CONTEXT_EXCERPT_STANDARD = 640;
const MAX_SYSTEM_CONTEXT_EXCERPT_DEEP = 920;
const MAX_CONVERSATION_CONTEXT_EXCERPT_STANDARD = 180;
const MAX_CONVERSATION_CONTEXT_EXCERPT_DEEP = 280;
const FETCH_PROMPT_URL_TIMEOUT_MS = 6_000;
const FETCH_SEARCH_TIMEOUT_MS = 4_500;
const FETCH_SEARCH_SCRAPE_TIMEOUT_MS = 2_400;
const FETCH_DIRECT_JSON_TIMEOUT_MS = 4_500;
const GLOBAL_CONTEXT_BUDGET_STANDARD_MS = 15_000;
const GLOBAL_CONTEXT_BUDGET_DEEP_MS = 24_000;
const RECOVERY_CONTEXT_BUDGET_STANDARD_MS = 7_500;
const RECOVERY_CONTEXT_BUDGET_DEEP_MS = 12_000;
const LOCAL_FETCH_PROXY_PATH = '/__fetch?url=';
const READER_PROXY = 'https://r.jina.ai/http://';

const WORLD_NEWS_DOMAINS = [
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'aljazeera.com',
  'dw.com',
  'theguardian.com',
  'france24.com',
  'cbc.ca',
  'cnn.com',
  'abcnews.go.com',
  'cbsnews.com',
  'nbcnews.com',
  'npr.org',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'politico.com',
  'axios.com',
  'thehill.com',
  'news.sky.com',
];
const SCIENCE_NEWS_DOMAINS = [
  'space.com',
  'spaceflightnow.com',
  'spacenews.com',
  'arstechnica.com',
  'scientificamerican.com',
];
const GOVERNMENT_DOMAINS = ['gov.uk', 'europa.eu', 'un.org', 'canada.ca', 'state.gov', 'usa.gov', 'gov.in', 'go.jp', 'gov.au', 'gouv.fr', 'bund.de', 'nato.int'];
const SPACE_AGENCY_DOMAINS = ['nasa.gov', 'esa.int', 'jaxa.jp', 'isro.gov.in', 'asc-csa.gc.ca'];
// Broad U.S. federal agency roster used to prioritize official-source retrieval.
const US_FEDERAL_AGENCY_DOMAINS = [
  'whitehouse.gov',
  'usa.gov',
  'state.gov',
  'defense.gov',
  'army.mil',
  'navy.mil',
  'af.mil',
  'spaceforce.mil',
  'marines.mil',
  'coastguard.mil',
  'justice.gov',
  'fbi.gov',
  'cia.gov',
  'nsa.gov',
  'dni.gov',
  'nro.gov',
  'nga.mil',
  'dia.mil',
  'dhs.gov',
  'cisa.gov',
  'fema.gov',
  'cbp.gov',
  'ice.gov',
  'secretservice.gov',
  'tsa.gov',
  'uscis.gov',
  'atf.gov',
  'dea.gov',
  'usmarshals.gov',
  'treasury.gov',
  'irs.gov',
  'fincen.gov',
  'occ.treas.gov',
  'commerce.gov',
  'census.gov',
  'noaa.gov',
  'weather.gov',
  'nist.gov',
  'bis.doc.gov',
  'uspto.gov',
  'trade.gov',
  'ustr.gov',
  'energy.gov',
  'nnsa.energy.gov',
  'transportation.gov',
  'faa.gov',
  'fhwa.dot.gov',
  'fra.dot.gov',
  'hhs.gov',
  'cdc.gov',
  'fda.gov',
  'nih.gov',
  'cms.gov',
  'samhsa.gov',
  'ahrq.gov',
  'ed.gov',
  'education.gov',
  'dol.gov',
  'nlrb.gov',
  'eeoc.gov',
  'interior.gov',
  'nps.gov',
  'usgs.gov',
  'blm.gov',
  'fws.gov',
  'epa.gov',
  'usda.gov',
  'fs.usda.gov',
  'ars.usda.gov',
  'ers.usda.gov',
  'nifa.usda.gov',
  'nasa.gov',
  'nsf.gov',
  'va.gov',
  'ssa.gov',
  'sba.gov',
  'opm.gov',
  'gsa.gov',
  'gao.gov',
  'archives.gov',
  'loc.gov',
  'smithsonian.gov',
  'consumerfinance.gov',
  'sec.gov',
  'ftc.gov',
  'cftc.gov',
  'fdic.gov',
  'federalreserve.gov',
  'ncua.gov',
  'exim.gov',
  'usitc.gov',
  'peacecorps.gov',
  'usaid.gov',
  'mcc.gov',
  'neh.gov',
  'arts.gov',
  'imls.gov',
  'uscourts.gov',
  'supremecourt.gov',
  'congress.gov',
  'house.gov',
  'senate.gov',
];
const SEARCH_STOPWORDS = new Set(['about', 'after', 'again', 'against', 'all', 'also', 'amid', 'among', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'doing', 'for', 'from', 'have', 'having', 'heard', 'hearing', 'hello', 'help', 'here', 'into', 'just', 'latest', 'more', 'most', 'need', 'news', 'please', 'recent', 'really', 'should', 'tell', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'today', 'update', 'updates', 'want', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'with', 'would', 'yesterday', 'your']);
const NUMBERED_ENTITY_TOKEN_BLOCKLIST = new Set([
  ...SEARCH_STOPWORDS,
  'agency',
  'article',
  'chapter',
  'current',
  'day',
  'days',
  'episode',
  'flight',
  'issue',
  'item',
  'latest',
  'mission',
  'model',
  'month',
  'months',
  'news',
  'part',
  'phase',
  'plan',
  'report',
  'section',
  'session',
  'space',
  'stage',
  'status',
  'step',
  'test',
  'tests',
  'timeline',
  'version',
  'week',
  'weeks',
  'year',
  'years',
  'january',
  'jan',
  'february',
  'feb',
  'march',
  'mar',
  'april',
  'apr',
  'may',
  'june',
  'jun',
  'july',
  'jul',
  'august',
  'aug',
  'september',
  'sept',
  'sep',
  'october',
  'oct',
  'november',
  'nov',
  'december',
  'dec',
]);
const NUMBERED_ENTITY_RE = /\b([a-z][a-z0-9-]{2,30})\s*(\d+|[ivxlcdm]+)\b/gi;

const uniqueStrings = (values: string[]) => [...new Set(values.filter(Boolean))];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
const stripPromptUrls = (text: string) => text.replace(URL_RE, ' ');
const extractYears = (text: string) => uniqueStrings([...text.matchAll(YEAR_RE)].map((m) => m[0])).map((y) => Number(y)).filter(Number.isFinite);
const extractHostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; } };
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
const MONTH_DAY_YEAR_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i;
const ISO_DATE_RE = /\b20\d{2}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?\b/i;
const RELATIVE_PUBLISHED_RE = /\b(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago\b/i;
const MONTH_DAY_YEAR_CAPTURE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),\s+(20\d{2})\b/gi;
const MONTH_YEAR_CAPTURE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b(?!\s*,)/gi;
const SCHEDULE_LANGUAGE_RE = /\b(schedule[ds]?|reschedule[ds]?|delay(?:ed|s)?|postpone[ds]?|push(?:ed|es)?\s+back|target(?:ed|s)?|expect(?:ed|s)?|plan(?:ned|s)?|slated|set for|launch window|launch in|launch no earlier than|net)\b/i;
const POST_EVENT_LANGUAGE_RE = /\b(launched|launch occurred|lifted off|liftoff|took place|occurred|happened|completed|is in orbit|currently in orbit|orbiting|flew|returned|returning|splashed down|splashdown|crew(?:ed)?\s+mission launched)\b/i;
const ACTIVE_STATUS_LANGUAGE_RE = /\b(currently|underway|in transit|on track|is expected to|expected to reach|scheduled to return|will return|will reach|is heading|en route)\b/i;
const CREW_NAME_RE = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,3})\b/g;
const CREW_ROLE_WINDOW = 48;
const CREW_SEGMENT_HINT_RE = /\b(crew|astronaut|pilot|commander|mission specialist|flight engineer|roster|mission crew|flight crew|spacecraft|capsule|orbiter|aboard|crew member)\b/i;
const CREW_NAME_BLOCKLIST = new Set([
  'Kennedy Space Center',
  'Canadian Space Agency',
  'European Space Agency',
  'International Space Station',
  'Johnson Space Center',
  'Launch Complex',
  'Mission Control',
  'Moon Mission',
  'Moon Orbit',
  'Orion Spacecraft',
  'Space Center',
  'Space Station',
  'United States',
]);
const CREW_NAME_WORD_BLOCKLIST = new Set([
  'agency',
  'april',
  'astronaut',
  'astronauts',
  'august',
  'base',
  'canadian',
  'capsule',
  'center',
  'centre',
  'commander',
  'crew',
  'december',
  'earth',
  'engineer',
  'european',
  'february',
  'flight',
  'florida',
  'friday',
  'hello',
  'january',
  'july',
  'june',
  'launch',
  'march',
  'may',
  'mission',
  'monday',
  'moon',
  'nasa',
  'november',
  'october',
  'official',
  'orbit',
  'orion',
  'pilot',
  'program',
  'role',
  'roster',
  'saturday',
  'scientist',
  'september',
  'shuttle',
  'space',
  'specialist',
  'station',
  'sunday',
  'thursday',
  'timeline',
  'today',
  'tuesday',
  'update',
  'wednesday',
]);
const CREW_ROLE_PATTERNS: Array<{ role: string; pattern: RegExp }> = [
  { role: 'Commander', pattern: /\bcommander\b/i },
  { role: 'Pilot', pattern: /\bpilot\b/i },
  { role: 'Mission Specialist', pattern: /\bmission specialist(?:s)?\b/i },
  { role: 'Flight Engineer', pattern: /\bflight engineer\b/i },
  { role: 'Specialist', pattern: /\bspecialist\b/i },
];

const MONTH_INDEX_BY_NAME: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function toIsoIfValid(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function parseRelativePublishedAt(value: string): string | undefined {
  const match = value.match(RELATIVE_PUBLISHED_RE);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].toLowerCase();
  const now = new Date();
  const next = new Date(now);
  if (unit.startsWith('minute')) next.setMinutes(next.getMinutes() - amount);
  else if (unit.startsWith('hour')) next.setHours(next.getHours() - amount);
  else if (unit.startsWith('day')) next.setDate(next.getDate() - amount);
  else if (unit.startsWith('week')) next.setDate(next.getDate() - (amount * 7));
  else return undefined;
  return next.toISOString();
}

function extractPublishedAtFromSnippet(snippet: string): string | undefined {
  const compact = normalizeWhitespace(snippet);
  if (!compact) return undefined;

  const relative = parseRelativePublishedAt(compact);
  if (relative) return relative;

  const isoMatch = compact.match(ISO_DATE_RE)?.[0];
  if (isoMatch) return toIsoIfValid(isoMatch);

  const monthMatch = compact.match(MONTH_DAY_YEAR_RE)?.[0];
  if (monthMatch) return toIsoIfValid(monthMatch);

  return undefined;
}

function trimContextText(text: string, maxLength: number): string {
  const compact = normalizeWhitespace(text);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

async function fetchWithBudget(url: string, init: RequestInit = {}, timeoutMs = FETCH_SEARCH_TIMEOUT_MS, parentSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('Timed out')), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', abortFromParent);
    }
  }
}

function buildLocalProxyUrl(url: string, timeoutMs: number): string {
  return `${LOCAL_FETCH_PROXY_PATH}${encodeURIComponent(url)}&timeoutMs=${Math.max(500, Math.round(timeoutMs))}`;
}

function assertLocalProxyResponse(response: Response, requestedUrl: string): void {
  const proxyMarker = response.headers.get('x-codex-fetch-proxy')?.trim().toLowerCase();
  if (proxyMarker === 'vite') return;

  throw new Error(`Local fetch proxy unavailable for ${requestedUrl}. Reload the active dev app so /__fetch is served by the current Vite server.`);
}

async function fetchThroughLocalProxy(url: string, timeoutMs: number, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const response = await fetchWithBudget(
    buildLocalProxyUrl(url, timeoutMs),
    init,
    timeoutMs,
    signal,
  );
  assertLocalProxyResponse(response, url);
  return response;
}

function buildSearchTerms(text: string): string[] {
  return uniqueStrings(
    stripPromptUrls(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token)),
  ).slice(0, 12);
}

function romanToInt(value: string): number | null {
  const roman = value.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(roman)) return null;

  const numerals: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };

  let total = 0;
  let previous = 0;
  for (let index = roman.length - 1; index >= 0; index -= 1) {
    const current = numerals[roman[index]];
    if (!current) return null;
    if (current < previous) total -= current;
    else {
      total += current;
      previous = current;
    }
  }

  return total > 0 ? total : null;
}

function normalizeMissionNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  return romanToInt(value);
}

function intToRoman(value: number): string {
  const numerals: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let remaining = Math.max(1, Math.floor(value));
  let result = '';
  for (const [amount, glyph] of numerals) {
    while (remaining >= amount) {
      result += glyph;
      remaining -= amount;
    }
  }
  return result;
}

function extractMissionKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(NUMBERED_ENTITY_RE)) {
    const program = (match[1] ?? '').toLowerCase();
    const missionNumber = normalizeMissionNumber(match[2] ?? '');
    if (!program || missionNumber == null) continue;
    if (NUMBERED_ENTITY_TOKEN_BLOCKLIST.has(program)) continue;
    keys.push(`${program}-${missionNumber}`);
  }
  return uniqueStrings(keys);
}

function missionKeyToVariants(key: string): string[] {
  const [program, numericPart] = key.split('-');
  const missionNumber = Number(numericPart);
  if (!program || !Number.isFinite(missionNumber) || missionNumber <= 0) return [];
  const programLabel = program.charAt(0).toUpperCase() + program.slice(1);
  return uniqueStrings([
    `${programLabel} ${missionNumber}`,
    `${programLabel} ${intToRoman(missionNumber)}`,
  ]);
}

function getRequestedProgramTokens(analysis: QueryAnalysis): string[] {
  if (!analysis.missionKeys.length) return [];
  return uniqueStrings(
    analysis.missionKeys
      .map((key) => key.split('-')[0]?.toLowerCase().trim())
      .filter(Boolean),
  );
}

function contextMentionsRequestedProgram(contextText: string, analysis: QueryAnalysis): boolean {
  const lower = contextText.toLowerCase();
  return getRequestedProgramTokens(analysis).some((program) => lower.includes(program));
}

function stripSearchFiller(text: string): string {
  const cleaned = normalizeWhitespace(
    stripPromptUrls(text)
      .replace(/^(hi|hello|hey|yo)[,!.\s-]*/i, '')
      .replace(/^(can you|could you|would you|please|tell me|explain|help me understand|i want to know|do you know|give me|show me)\b/gi, '')
      .replace(/\?+$/, ''),
  );
  return cleaned || normalizeWhitespace(stripPromptUrls(text));
}

function analyzeQuery(currentMessage: string, conversationHistory: Array<{ role: string; content: string }> = []): QueryAnalysis {
  const recentHistory = conversationHistory
    .filter((message) => message.role === 'user')
    .slice(-4)
    .map((message) => message.content)
    .join(' ');
  const combinedText = normalizeWhitespace(`${recentHistory} ${currentMessage}`);
  const currentYear = new Date().getFullYear();
  const years = extractYears(combinedText);
  const countries = uniqueStrings([...combinedText.matchAll(COUNTRY_RE)].map((match) => match[0].toLowerCase()));
  const cleanedCurrent = stripSearchFiller(currentMessage).slice(0, 160);
  const historyTerms = buildSearchTerms(recentHistory);
  const currentTerms = buildSearchTerms(cleanedCurrent);
  const historyEntityHint = historyTerms.slice(0, 3).join(' ');
  const contextHint = countries.slice(0, 2).join(' ') || historyEntityHint;
  const missionKeys = extractMissionKeys(`${currentMessage} ${recentHistory}`);
  const isCrewLookup = /\b(crew|astronaut|pilot|commander|mission specialist|specialist|roster|who is|who are|names?)\b/i.test(cleanedCurrent);
  const missionLead = missionKeys.flatMap((key) => missionKeyToVariants(key)).find(Boolean) ?? '';
  const hasNewsCue = NEWS_EVENT_RE.test(cleanedCurrent) || NEWS_EVENT_RE.test(currentMessage);
  const followUpNeedsHistoryContext = Boolean(
    contextHint && (
      currentTerms.length <= 3
      || FOLLOW_UP_ENTITY_RE.test(currentMessage)
      || hasNewsCue
    ),
  );
  const baseContextTerm = normalizeWhitespace(followUpNeedsHistoryContext ? `${contextHint} ${cleanedCurrent}` : cleanedCurrent).slice(0, 180);
  const basePrimaryTerm = normalizeWhitespace(followUpNeedsHistoryContext && historyEntityHint ? `${historyEntityHint} ${cleanedCurrent}` : cleanedCurrent).slice(0, 180) || baseContextTerm;
  const missionAnchoredLookup = isCrewLookup && missionLead
    ? normalizeWhitespace(`${missionLead} ${cleanedCurrent}`.replace(/\b(?:that|this|those|these|it|they|them|their)\b/gi, ' '))
    : '';
  const contextTerm = (missionAnchoredLookup || baseContextTerm).slice(0, 180);
  const primaryTerm = (missionAnchoredLookup || basePrimaryTerm || contextTerm).slice(0, 180) || contextTerm;
  const terms = buildSearchTerms(`${cleanedCurrent} ${contextTerm} ${recentHistory}`);
  const queryMode: QueryMode = LOOKUP_RE.test(currentMessage) || LOOKUP_RE.test(combinedText) || terms.length >= 6 ? 'research' : QUESTION_RE.test(currentMessage) ? 'question' : 'conversation';
  const temporalFocus: TemporalFocus =
    FUTURE_RE.test(combinedText) ? 'future'
      : RELATIVE_TIME_RE.test(combinedText) ? 'current'
        : years.length ? (Math.max(...years) > currentYear ? 'future' : Math.max(...years) >= currentYear - 1 ? 'current' : Math.max(...years) >= RECENT_YEAR_FLOOR ? 'recent' : 'historic')
          : LOOKUP_RE.test(combinedText) && /\b(plan|timeline|status|schedule|announced|statement|roadmap)\b/i.test(combinedText) ? 'recent'
            : 'timeless';
  const sourceProfile: SourceProfile = GOVERNMENT_RE.test(combinedText) ? 'government' : TECHNICAL_RE.test(combinedText) ? 'technical' : SPACE_RE.test(combinedText) ? 'science' : 'general';
  const prefersOfficialSources = sourceProfile === 'government' || sourceProfile === 'science' || temporalFocus === 'recent' || temporalFocus === 'current' || temporalFocus === 'future' || years.some((year) => year >= RECENT_YEAR_FLOOR);
  const scienceStatusNeedsNews = sourceProfile === 'science' && (temporalFocus === 'recent' || temporalFocus === 'current' || temporalFocus === 'future') && STATUS_UPDATE_RE.test(combinedText);
  const prefersNewsSources = hasNewsCue || scienceStatusNeedsNews || ((sourceProfile === 'science' || sourceProfile === 'government') && /\b(issue|issues|problem|problems|outage|outages|glitch|glitches|incident|incidents|reported|reporting|coverage)\b/i.test(combinedText));
  const prefersCommunitySources = COMMUNITY_RE.test(combinedText) || (sourceProfile === 'technical' && /\b(opinion|discussion|compare|tradeoff|what are people saying)\b/i.test(combinedText));
  const needsFreshness = temporalFocus === 'recent' || temporalFocus === 'current' || temporalFocus === 'future' || years.some((year) => year >= RECENT_YEAR_FLOOR);
  const objectiveTopic = queryMode !== 'conversation' || countries.length > 0 || sourceProfile !== 'general' || terms.length >= 3;
  const shouldFetch = !!currentMessage.trim() && !(CASUAL_QUERY_RE.test(currentMessage.trim()) && currentMessage.trim().length <= 80) && (needsFreshness || objectiveTopic);
  let maxSources = queryMode === 'research' ? 5 : queryMode === 'question' ? 4 : 3;
  if ((temporalFocus === 'current' || temporalFocus === 'future') && prefersOfficialSources) {
    maxSources += 1;
  }
  if (prefersNewsSources) maxSources += 1;
  if (prefersCommunitySources) maxSources += 1;

  return {
    currentYear,
    years,
    queryMode,
    temporalFocus,
    sourceProfile,
    primaryTerm,
    contextTerm: contextTerm || cleanedCurrent,
    countries,
    prefersOfficialSources,
    prefersNewsSources,
    prefersCommunitySources,
    shouldFetch,
    maxSources: Math.max(3, Math.min(maxSources, 5)),
    terms,
    missionKeys,
  };
}

function buildCompactQuery(analysis: QueryAnalysis): string {
  if (isCrewLookupAnalysis(analysis) && analysis.missionKeys.length > 0) {
    const missionLead = analysis.missionKeys.flatMap((key) => missionKeyToVariants(key)).find(Boolean);
    if (missionLead) {
      return normalizeWhitespace(`${missionLead} crew official roster`);
    }
  }

  const preferredTerms = analysis.terms.filter((term) => !['going', 'date', 'dates', 'thing', 'things', 'current'].includes(term));
  const intentTerms: string[] = [];
  const promptText = `${analysis.primaryTerm} ${analysis.contextTerm}`.toLowerCase();

  if (/\btimeline|schedule|scheduled|target\b/i.test(promptText)) intentTerms.push('timeline');
  if (/\bplan|roadmap|next steps\b/i.test(promptText)) intentTerms.push('plan');
  if (/\bstatus|latest|current|recent|today|now\b/i.test(promptText)) intentTerms.push('latest');
  if (analysis.prefersNewsSources) intentTerms.push('news');
  if (/\b(issue|issues|problem|problems|outage|outages|glitch|glitches|incident|incidents)\b/i.test(promptText)) {
    intentTerms.push('issues');
  }

  const compactTerms = uniqueStrings([
    ...preferredTerms.slice(0, 6),
    ...intentTerms,
    ...analysis.years.slice(-1).map(String),
  ]);

  return compactTerms.join(' ').slice(0, 140) || analysis.contextTerm || analysis.primaryTerm;
}

function buildExactSearchQueries(currentMessage: string): string[] {
  const raw = normalizeWhitespace(stripPromptUrls(currentMessage)).trim();
  if (!raw || CASUAL_QUERY_RE.test(raw) || buildSearchTerms(raw).length < 2) {
    return [];
  }

  const exact = raw.slice(0, 220);
  const cleanedExact = stripSearchFiller(exact).slice(0, 220);
  const quotedExact = exact.replace(/"/g, '').trim();

  return uniqueStrings([
    exact,
    cleanedExact && cleanedExact !== exact ? cleanedExact : '',
    quotedExact.split(/\s+/).length >= 4 ? `"${quotedExact}"` : '',
  ]).filter(Boolean);
}

function buildQueryVariants(analysis: QueryAnalysis): string[] {
  const base = uniqueStrings([
    buildCompactQuery(analysis),
    analysis.contextTerm,
    analysis.primaryTerm,
  ]).filter(Boolean);
  const variants = new Set<string>(base);

  if (analysis.prefersNewsSources) {
    variants.add(normalizeWhitespace(`${analysis.contextTerm} latest news`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} reported issues`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} latest update`));
  }

  if (analysis.temporalFocus === 'current' || analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'future') {
    variants.add(normalizeWhitespace(`${analysis.contextTerm} ${analysis.currentYear}`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} ${analysis.currentYear} latest update`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} ${analysis.currentYear} current status`));
  }

  if (isCrewLookupAnalysis(analysis)) {
    variants.add(normalizeWhitespace(`${analysis.contextTerm} crew official`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} roster official`));
    variants.add(normalizeWhitespace(`${analysis.contextTerm} crew members official`));
  }

  for (const missionKey of analysis.missionKeys) {
    for (const missionVariant of missionKeyToVariants(missionKey)) {
      variants.add(normalizeWhitespace(`${missionVariant} latest update`));
      variants.add(normalizeWhitespace(`${missionVariant} current status`));
      variants.add(normalizeWhitespace(`${missionVariant} official update`));
      if (isCrewLookupAnalysis(analysis)) {
        variants.add(normalizeWhitespace(`${missionVariant} crew official`));
        variants.add(normalizeWhitespace(`${missionVariant} roster official`));
        variants.add(normalizeWhitespace(`${missionVariant} meet the crew`));
        variants.add(normalizeWhitespace(`${missionVariant} pilot commander mission specialist`));
      }
    }
  }

  return [...variants].filter(Boolean).slice(0, isCrewLookupAnalysis(analysis) ? 6 : 4);
}

function resolveDesiredSourceCount(
  analysis: QueryAnalysis,
  options: FetchGlobalContextOptions = {},
): number {
  if (options.maxSources) return options.maxSources;

  const breadthBoost = analysis.prefersNewsSources || analysis.prefersOfficialSources ? 2 : 0;
  const base = analysis.maxSources + (options.depth === 'deep' ? 5 : 3) + breadthBoost;
  return Math.max(6, Math.min(base, options.depth === 'deep' ? 14 : 10));
}

function resolveSystemContextLimit(options: ContextFormattingOptions = {}): number {
  return options.depth === 'deep' ? MAX_SYSTEM_CONTEXTS_DEEP : MAX_SYSTEM_CONTEXTS_STANDARD;
}

function resolveSystemExcerptLimit(options: ContextFormattingOptions = {}): number {
  return options.depth === 'deep' ? MAX_SYSTEM_CONTEXT_EXCERPT_DEEP : MAX_SYSTEM_CONTEXT_EXCERPT_STANDARD;
}

function resolveConversationExcerptLimit(options: ContextFormattingOptions = {}): number {
  return options.depth === 'deep' ? MAX_CONVERSATION_CONTEXT_EXCERPT_DEEP : MAX_CONVERSATION_CONTEXT_EXCERPT_STANDARD;
}

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  return uniqueStrings(matches.map((value) => value.replace(/[.,;:!?)>\]]+$/, '')));
}

export function shouldFetchGlobalContext(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
  options: Pick<FetchGlobalContextOptions, 'forceFetch'> = {},
): boolean {
  const analysis = analyzeQuery(userMessage, conversationHistory);
  return options.forceFetch ? Boolean(userMessage.trim()) : analysis.shouldFetch;
}

export function getRequiredLiveSourceCount(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
  options: FetchGlobalContextOptions = {},
): number {
  const analysis = analyzeQuery(userMessage, conversationHistory);
  return minimumRequiredSourceCount(analysis, options);
}

export async function fetchUrlsFromPrompt(promptText: string): Promise<FetchedContext[]> {
  const urls = extractUrlsFromText(promptText);
  if (!urls.length) return [];
  return Promise.all(urls.map((url) => fetchUrl(url)));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|article|section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : '';
}

function extractPublishedAtFromHtml(html: string): string | undefined {
  const candidates = [
    ...html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|article:modified_time|og:published_time|og:updated_time|datePublished|dateModified|pubdate|publish-date)["'][^>]+content=["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/gi),
  ];

  for (const match of candidates) {
    const value = normalizeWhitespace(match[1] ?? '');
    const exact = toIsoIfValid(value);
    if (exact) return exact;
  }

  return undefined;
}

function extractReaderTitle(text: string): string {
  const titleMatch = text.match(/^Title:\s*(.+)$/mi);
  return titleMatch ? normalizeWhitespace(titleMatch[1]).slice(0, 120) : '';
}

function extractReaderPublishedAt(text: string): string | undefined {
  const publishedLine = text.match(/^Published Time:\s*(.+)$/mi)?.[1]
    ?? text.match(/^Date:\s*(.+)$/mi)?.[1];
  if (!publishedLine) return undefined;
  return toIsoIfValid(normalizeWhitespace(publishedLine));
}

function readerToText(text: string): string {
  return text
    .replace(/^Title:\s*.+$/gim, ' ')
    .replace(/^URL Source:\s*.+$/gim, ' ')
    .replace(/^Markdown Content:\s*$/gim, ' ')
    .replace(/^Description:\s*.+$/gim, ' ')
    .replace(/^Published Time:\s*.+$/gim, ' ')
    .replace(/^Author:\s*.+$/gim, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]*\)/g, ' ')
    .replace(/[`#>*_-]{1,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

function getFinalProxiedUrl(response: Response, fallbackUrl: string): string {
  const finalUrl = response.headers.get('x-final-url')?.trim();
  if (finalUrl && /^https?:\/\//i.test(finalUrl)) {
    return finalUrl;
  }
  return fallbackUrl;
}

async function fetchPageViaAllOrigins(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ url: string; body: string; title: string; text: string; publishedAt?: string; }> {
  const response = await fetchThroughLocalProxy(url, timeoutMs, signal);
  if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
  const body = await response.text();
  if (!body) throw new Error('Empty proxy response');
  const resolvedUrl = getFinalProxiedUrl(response, url);
  const text = body.trimStart().startsWith('{') || body.trimStart().startsWith('[')
    ? (() => {
        try {
          return JSON.stringify(JSON.parse(body), null, 2).slice(0, MAX_TEXT);
        } catch {
          return htmlToText(body);
        }
      })()
    : htmlToText(body);
  return {
    url: resolvedUrl,
    body,
    title: extractTitle(body),
    text,
    publishedAt: extractPublishedAtFromHtml(body),
  };
}

async function fetchPageViaReader(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ url: string; body: string; title: string; text: string; publishedAt?: string; }> {
  const response = await fetchThroughLocalProxy(`${READER_PROXY}${url}`, timeoutMs, signal);
  if (!response.ok) throw new Error(`Reader HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('Empty reader response');
  return {
    url,
    body,
    title: extractReaderTitle(body),
    text: readerToText(body),
    publishedAt: extractReaderPublishedAt(body),
  };
}

async function fetchSearchSnapshot(options: {
  url: string;
  title: string;
  provider: string;
  sourceType: FetchedSourceType;
  credibility: FetchedCredibility;
  minTextLength?: number;
}, signal?: AbortSignal): Promise<FetchedContext> {
  return fetchReadablePage(options.url, {
    provider: options.provider,
    sourceType: options.sourceType,
    credibility: options.credibility,
    title: options.title,
    timeoutMs: FETCH_SEARCH_TIMEOUT_MS,
    minTextLength: options.minTextLength ?? 80,
  }, signal);
}

async function fetchReadablePage(rawUrl: string, options: FetchPageOptions, signal?: AbortSignal): Promise<FetchedContext> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const startedAt = nowMs();
  try {
    const minTextLength = options.minTextLength ?? 0;
    const timeoutMs = options.timeoutMs ?? FETCH_PROMPT_URL_TIMEOUT_MS;
    const attemptErrors: string[] = [];
    const attempts = [fetchPageViaAllOrigins, fetchPageViaReader];
    let resolvedText = '';
    let resolvedTitle = options.title || url;
    let resolvedPublishedAt = options.publishedAt;
    let resolvedUrl = url;

    for (const attempt of attempts) {
      try {
        const result = await attempt(url, timeoutMs, signal);
        if (result.url) {
          resolvedUrl = result.url;
        }
        if (result.title) {
          resolvedTitle = result.title;
        }
        if (!resolvedPublishedAt && result.publishedAt) {
          resolvedPublishedAt = result.publishedAt;
        }
        if (result.text.trim().length >= minTextLength) {
          resolvedText = result.text;
          break;
        }
        attemptErrors.push('Insufficient page text');
      } catch (error) {
        attemptErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (minTextLength > 0 && resolvedText.trim().length < minTextLength) {
      throw new Error(attemptErrors.filter(Boolean).join(' | ') || 'Insufficient page text');
    }

    return {
      url: resolvedUrl,
      title: resolvedTitle,
      text: resolvedText,
      durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
      provider: options.provider,
      sourceType: options.sourceType,
      credibility: options.credibility,
      publishedAt: resolvedPublishedAt,
    };
  } catch (error) {
    return {
      url,
      title: options.title || url,
      text: '',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
      provider: options.provider,
      sourceType: options.sourceType,
      credibility: options.credibility,
      publishedAt: options.publishedAt,
    };
  }
}

export async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<FetchedContext> {
  return fetchReadablePage(rawUrl, {
    provider: 'Prompt URL',
    sourceType: 'reference',
    credibility: 'reference',
  }, signal);
}

export async function fetchJsonDirect<T>(url: string, timeoutMs = FETCH_DIRECT_JSON_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  const response = await fetchThroughLocalProxy(
    url,
    timeoutMs,
    signal,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function decodeDuckDuckGoResultUrl(rawHref: string): string {
  const href = rawHref.replace(/&amp;/g, '&');
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return href.startsWith('//') ? `https:${href}` : href;
  }
}

function decodeGoogleResultUrl(rawHref: string): string {
  const href = rawHref.replace(/&amp;/g, '&');
  try {
    const parsed = new URL(href, 'https://www.google.com');
    const redirected = parsed.searchParams.get('q');
    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return href;
  }
}

function buildGenericSearchSnippet(html: string, anchorIndex: number): string {
  const start = Math.max(0, anchorIndex - 180);
  const end = Math.min(html.length, anchorIndex + 520);
  return normalizeWhitespace(htmlToText(html.slice(start, end))).slice(0, 240);
}

function mergeSearchResultItems(items: SearchResultItem[], limit: number): SearchResultItem[] {
  const merged = new Map<string, SearchResultItem>();

  for (const item of items) {
    if (!item.title || !item.url) continue;
    const hostname = extractHostname(item.url);
    if (!hostname || isSearchEngineHost(hostname)) continue;

    const existing = merged.get(item.url);
    if (!existing) {
      merged.set(item.url, item);
      continue;
    }

    const betterTitle = item.title.length > existing.title.length ? item.title : existing.title;
    const betterSnippet = item.snippet.length > existing.snippet.length ? item.snippet : existing.snippet;
    merged.set(item.url, {
      title: betterTitle,
      snippet: betterSnippet,
      url: item.url,
      publishedAt: existing.publishedAt ?? item.publishedAt,
    });
  }

  return [...merged.values()].slice(0, limit);
}

async function fetchSearchResultPages(
  fetchPage: (
    query: string,
    limit?: number,
    signal?: AbortSignal,
    offset?: number,
  ) => Promise<SearchResultItem[]>,
  query: string,
  options: {
    pageSize?: number;
    pageCount?: number;
  } = {},
  signal?: AbortSignal,
): Promise<SearchResultItem[]> {
  const pageSize = Math.max(6, options.pageSize ?? MAX_SEARCH_ITEMS_PER_SOURCE);
  const pageCount = Math.max(1, options.pageCount ?? 1);
  const pageResults = await Promise.allSettled(
    Array.from({ length: pageCount }, (_unused, pageIndex) =>
      fetchPage(query, pageSize, signal, pageIndex * pageSize),
    ),
  );

  const items = pageResults.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  const merged = mergeSearchResultItems(items, pageSize * pageCount);
  if (!merged.length) throw new Error('No results parsed');
  return merged;
}

function parseGenericSearchItems(
  html: string,
  options: {
    decodeUrl: (rawHref: string) => string;
    limit?: number;
  },
): SearchResultItem[] {
  const limit = Math.max(options.limit ?? 8, 1);
  const matches = [...html.matchAll(/<a\b[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const items: SearchResultItem[] = [];

  for (const match of matches) {
    const rawHref = match[1] ?? '';
    const resolvedUrl = options.decodeUrl(rawHref);
    if (!resolvedUrl.startsWith('http')) continue;

    const hostname = extractHostname(resolvedUrl);
    if (!hostname || isSearchEngineHost(hostname)) continue;

    const title = normalizeWhitespace(htmlToText(match[2] ?? ''));
    if (title.length < 12) continue;

    const snippet = buildGenericSearchSnippet(html, match.index ?? 0);
    items.push({
      title,
      snippet,
      url: resolvedUrl,
      publishedAt: extractPublishedAtFromSnippet(snippet),
    });
  }

  return mergeSearchResultItems(items, limit);
}

function parseDuckDuckGoSearchItems(html: string, limit = 8): SearchResultItem[] {
  const titles = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi)];
  const structuredItems = titles
    .map((match, index) => {
      const snippet = normalizeWhitespace(htmlToText(snippets[index]?.[1] ?? ''));
      return {
        title: normalizeWhitespace(htmlToText(match[2])),
        snippet,
        url: decodeDuckDuckGoResultUrl(match[1]),
        publishedAt: extractPublishedAtFromSnippet(snippet),
      };
    })
    .filter((item) => item.title && item.url)
    .filter((item) => {
      const hostname = extractHostname(item.url);
      return hostname && !isSearchEngineHost(hostname);
    })
    .filter((item, index, array) => array.findIndex((entry) => entry.url === item.url) === index)
    .slice(0, limit);

  const genericItems = parseGenericSearchItems(html, {
    decodeUrl: decodeDuckDuckGoResultUrl,
    limit: limit * 2,
  });

  return mergeSearchResultItems([...structuredItems, ...genericItems], limit);
}

function parseGoogleSearchItems(html: string, limit = 8): SearchResultItem[] {
  const matches = [...html.matchAll(/<a[^>]+href="([^"]*\/url\?q=[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/gi)];
  const snippets = [...html.matchAll(/<div[^>]+class="[^"]*(?:VwiC3b|yXK7lf|MUxGbd)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];

  const structuredItems = matches
    .map((match, index) => {
      const snippet = normalizeWhitespace(htmlToText(snippets[index]?.[1] ?? ''));
      return {
        title: normalizeWhitespace(htmlToText(match[2])),
        snippet,
        url: decodeGoogleResultUrl(match[1]),
        publishedAt: extractPublishedAtFromSnippet(snippet),
      };
    })
    .filter((item) => item.title && item.url.startsWith('http'))
    .filter((item) => {
      const hostname = extractHostname(item.url);
      return hostname && !isSearchEngineHost(hostname);
    })
    .filter((item, index, array) => array.findIndex((entry) => entry.url === item.url) === index)
    .slice(0, limit);

  const genericItems = parseGenericSearchItems(html, {
    decodeUrl: decodeGoogleResultUrl,
    limit: limit * 2,
  });

  return mergeSearchResultItems([...structuredItems, ...genericItems], limit);
}

function parseBingSearchItems(html: string, limit = 8): SearchResultItem[] {
  const results = [...html.matchAll(/<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?(?:<p>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/gi)]
    .map((match) => {
      const snippet = normalizeWhitespace(htmlToText(match[3] ?? ''));
      return {
        title: normalizeWhitespace(htmlToText(match[2] ?? '')),
        snippet,
        url: normalizeWhitespace(match[1] ?? ''),
        publishedAt: extractPublishedAtFromSnippet(snippet),
      };
    })
    .filter((item) => item.title && item.url.startsWith('http'))
    .filter((item) => {
      const hostname = extractHostname(item.url);
      return hostname && !isSearchEngineHost(hostname);
    })
    .filter((item, index, array) => array.findIndex((entry) => entry.url === item.url) === index)
    .slice(0, limit);

  if (results.length) return results;

  return [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      title: normalizeWhitespace(htmlToText(match[2] ?? '')),
      snippet: '',
      url: normalizeWhitespace(match[1] ?? ''),
    }))
    .filter((item) => item.title && item.url.startsWith('http'))
    .filter((item) => {
      const hostname = extractHostname(item.url);
      return hostname && !isSearchEngineHost(hostname) && item.title.length >= 12;
    })
    .filter((item, index, array) => array.findIndex((entry) => entry.url === item.url) === index)
    .slice(0, limit);
}

function buildReaderSearchSnippet(text: string, anchorIndex: number): string {
  const start = Math.max(0, anchorIndex - 220);
  const end = Math.min(text.length, anchorIndex + 420);
  return normalizeWhitespace(text.slice(start, end)).slice(0, 240);
}

function parseReaderSearchItems(
  readerText: string,
  options: {
    decodeUrl: (rawHref: string) => string;
    limit?: number;
  },
): SearchResultItem[] {
  const limit = Math.max(options.limit ?? 8, 1);
  const matches = [...readerText.matchAll(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g)];
  const items: SearchResultItem[] = [];

  for (const match of matches) {
    const title = normalizeWhitespace(match[1] ?? '');
    const resolvedUrl = options.decodeUrl(match[2] ?? '');
    if (title.length < 12 || /^image\b/i.test(title)) continue;
    if (!resolvedUrl.startsWith('http')) continue;

    const hostname = extractHostname(resolvedUrl);
    if (!hostname || isSearchEngineHost(hostname)) continue;

    const snippet = buildReaderSearchSnippet(readerText, match.index ?? 0);
    items.push({
      title,
      snippet,
      url: resolvedUrl,
      publishedAt: extractPublishedAtFromSnippet(snippet),
    });
  }

  return mergeSearchResultItems(items, limit);
}

function isBlockedGoogleSearchContent(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('our systems have detected unusual traffic')
    || lower.includes('please enable javascript on your web browser')
    || lower.includes('this page checks to see if it\'s really you');
}

function formatSearchItems(items: SearchResultItem[]): string {
  return items
    .slice(0, MAX_SEARCH_ITEMS_PER_SOURCE)
    .map((item) => {
      const metadata = [item.publishedAt ? `Date: ${item.publishedAt}` : '', extractHostname(item.url) ? `Host: ${extractHostname(item.url)}` : ''].filter(Boolean).join(' | ');
      return [
        `- ${trimContextText(item.title, 140)}`,
        metadata ? `  ${metadata}` : '',
        item.snippet ? `  ${trimContextText(item.snippet, 180)}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n')
    .slice(0, 2200);
}

function buildContextFromItems(options: {
  url: string;
  title: string;
  provider: string;
  sourceType: FetchedSourceType;
  credibility: FetchedCredibility;
  items: SearchResultItem[];
  error?: string;
  durationMs?: number;
}): FetchedContext {
  return {
    url: options.url,
    title: options.title,
    text: options.items.length ? formatSearchItems(options.items) : '',
    error: options.error,
    durationMs: options.durationMs,
    provider: options.provider,
    sourceType: options.sourceType,
    credibility: options.credibility,
    publishedAt: options.items.find((item) => item.publishedAt)?.publishedAt,
  };
}

function classifySourceFromUrl(
  url: string,
  fallbackType: FetchedSourceType,
  fallbackCredibility: FetchedCredibility,
): { sourceType: FetchedSourceType; credibility: FetchedCredibility } {
  const hostname = extractHostname(url);
  if (!hostname) {
    return {
      sourceType: fallbackType,
      credibility: fallbackCredibility,
    };
  }

  if (
    hostname.endsWith('.gov')
    || hostname.endsWith('.mil')
    || GOVERNMENT_DOMAINS.includes(hostname)
    || SPACE_AGENCY_DOMAINS.includes(hostname)
    || US_FEDERAL_AGENCY_DOMAINS.includes(hostname)
  ) {
    return { sourceType: 'official', credibility: 'official' };
  }

  if (WORLD_NEWS_DOMAINS.includes(hostname)) {
    return { sourceType: 'news', credibility: 'major-news' };
  }

  if (hostname === 'wikipedia.org' || hostname.endsWith('.wikipedia.org')) {
    return { sourceType: 'reference', credibility: 'reference' };
  }

  if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com') || hostname.includes('news.ycombinator.com')) {
    return { sourceType: 'community', credibility: 'community' };
  }

  return {
    sourceType: fallbackType,
    credibility: fallbackCredibility,
  };
}

function buildContextsFromSearchItems(
  items: SearchResultItem[],
  options: {
    provider: string;
    sourceType: FetchedSourceType;
    credibility: FetchedCredibility;
    maxItems?: number;
  },
): FetchedContext[] {
  return items
    .filter((item) => item.url && item.title)
    .slice(0, options.maxItems ?? MAX_SEARCH_ITEMS_PER_SOURCE)
    .map((item) => {
      const classified = classifySourceFromUrl(item.url, options.sourceType, options.credibility);
      const hostname = extractHostname(item.url);
      const lines = [
        hostname ? `Host: ${hostname}` : '',
        item.publishedAt ? `Published: ${item.publishedAt}` : '',
        `Result title: ${trimContextText(item.title, 180)}`,
        item.snippet ? trimContextText(item.snippet, 320) : '',
        `Observed via ${options.provider} results.`,
      ].filter(Boolean);

      return {
        url: item.url,
        title: item.title,
        text: lines.join('\n'),
        durationMs: undefined,
        provider: hostname || options.provider,
        sourceType: classified.sourceType,
        credibility: classified.credibility,
        publishedAt: item.publishedAt,
      } satisfies FetchedContext;
    })
    .filter((context) => context.text.trim().length >= 24);
}

function mergeContextsByUrl(
  primary: FetchedContext[],
  secondary: FetchedContext[],
): FetchedContext[] {
  const merged = new Map<string, FetchedContext>();

  for (const context of [...primary, ...secondary]) {
    const key = context.url.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, context);
      continue;
    }

    const existingLength = existing.text.trim().length;
    const nextLength = context.text.trim().length;
    merged.set(key, nextLength > existingLength ? { ...existing, ...context } : { ...context, ...existing });
  }

  return [...merged.values()];
}

function isScrapableSearchResult(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const hostname = parsed.hostname.replace(/^www\./i, '');
    return ![
      'google.com',
      'duckduckgo.com',
      'news.google.com',
    ].includes(hostname);
  } catch {
    return false;
  }
}

async function scrapeSearchResultItems(
  items: SearchResultItem[],
  options: {
    provider: string;
    sourceType: FetchedSourceType;
    credibility: FetchedCredibility;
    maxPages?: number;
    minTextLength?: number;
  },
  signal?: AbortSignal,
): Promise<FetchedContext[]> {
  const selectedItems = items
    .filter((item) => isScrapableSearchResult(item.url))
    .slice(0, options.maxPages ?? 2);

  if (!selectedItems.length) return [];

  const results = await Promise.all(
    selectedItems.map((item) => fetchReadablePage(item.url, {
      provider: extractHostname(item.url) || options.provider,
      sourceType: options.sourceType,
      credibility: options.credibility,
      title: item.title,
      publishedAt: item.publishedAt,
      timeoutMs: FETCH_SEARCH_SCRAPE_TIMEOUT_MS,
      minTextLength: options.minTextLength ?? 120,
    }, signal)),
  );

  return results.filter((context) => !context.error && context.text.trim().length >= (options.minTextLength ?? 120));
}

async function collectDestinationContextsFromItems(
  items: SearchResultItem[],
  options: {
    provider: string;
    sourceType: FetchedSourceType;
    credibility: FetchedCredibility;
    maxItems?: number;
    maxPages?: number;
    minTextLength?: number;
  },
  signal?: AbortSignal,
): Promise<FetchedContext[]> {
  if (!items.length) return [];

  const itemContexts = buildContextsFromSearchItems(items, {
    provider: options.provider,
    sourceType: options.sourceType,
    credibility: options.credibility,
    maxItems: options.maxItems ?? items.length,
  });

  const scraped = await scrapeSearchResultItems(items, {
    provider: options.provider,
    sourceType: options.sourceType,
    credibility: options.credibility,
    maxPages: options.maxPages,
    minTextLength: options.minTextLength,
  }, signal).catch(() => []);

  const merged = mergeContextsByUrl(scraped, itemContexts);
  const destinationContexts = (merged.length ? merged : itemContexts)
    .filter((context) => {
      const hostname = extractHostname(context.url);
      return hostname ? !isSearchEngineHost(hostname) : false;
    });
  return destinationContexts;
}

async function collectSearchContexts(options: {
  items: SearchResultItem[];
  summaryUrl: string;
  summaryTitle: string;
  summaryProvider: string;
  summarySourceType: FetchedSourceType;
  summaryCredibility: FetchedCredibility;
  scrapeProvider?: string;
  scrapeSourceType?: FetchedSourceType;
  scrapeCredibility?: FetchedCredibility;
  maxPages?: number;
  minTextLength?: number;
}, signal?: AbortSignal): Promise<FetchedContext[]> {
  if (!options.items.length) return [];
  const itemContexts = buildContextsFromSearchItems(options.items, {
    provider: options.summaryProvider,
    sourceType: options.scrapeSourceType ?? options.summarySourceType,
    credibility: options.scrapeCredibility ?? options.summaryCredibility,
    maxItems: options.items.length,
  });

  const scrapeController = new AbortController();
  const abortFromParent = () => scrapeController.abort(signal?.reason);
  const timeoutHandle = setTimeout(
    () => scrapeController.abort('Search scrape budget exceeded'),
    FETCH_SEARCH_SCRAPE_TIMEOUT_MS,
  );

  if (signal) {
    if (signal.aborted) {
      scrapeController.abort(signal.reason);
    } else {
      signal.addEventListener('abort', abortFromParent, { once: true });
    }
  }

  try {
    const scraped = await scrapeSearchResultItems(options.items, {
      provider: options.scrapeProvider ?? options.summaryProvider,
      sourceType: options.scrapeSourceType ?? options.summarySourceType,
      credibility: options.scrapeCredibility ?? options.summaryCredibility,
      maxPages: options.maxPages,
      minTextLength: options.minTextLength,
    }, scrapeController.signal).catch(() => []);

    const mergedResultContexts = mergeContextsByUrl(scraped, itemContexts);
    if (mergedResultContexts.length) {
      return mergedResultContexts;
    }

    return itemContexts;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) {
      signal.removeEventListener('abort', abortFromParent);
    }
  }
}

async function fetchDuckDuckGoSearchResults(
  query: string,
  limit = MAX_SEARCH_ITEMS_PER_SOURCE,
  signal?: AbortSignal,
  offset = 0,
): Promise<SearchResultItem[]> {
  const normalizedOffset = Math.max(0, offset);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${normalizedOffset}&dc=${normalizedOffset + 1}`;
  try {
    const response = await fetchThroughLocalProxy(searchUrl, FETCH_SEARCH_TIMEOUT_MS, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!html) throw new Error('Empty');
    const items = parseDuckDuckGoSearchItems(html, limit);
    if (!items.length) throw new Error('No results parsed');
    return items;
  } catch {
    const readerUrl = `${READER_PROXY}https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetchThroughLocalProxy(readerUrl, FETCH_SEARCH_TIMEOUT_MS, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error('Empty');
    const items = parseReaderSearchItems(text, {
      decodeUrl: decodeDuckDuckGoResultUrl,
      limit,
    });
    if (!items.length) throw new Error('No results parsed');
    return items;
  }
}

async function fetchGoogleSearchResults(
  query: string,
  limit = MAX_SEARCH_ITEMS_PER_SOURCE,
  signal?: AbortSignal,
  offset = 0,
): Promise<SearchResultItem[]> {
  const normalizedOffset = Math.max(0, offset);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=${Math.max(limit, 10)}&start=${normalizedOffset}`;
  try {
    const response = await fetchThroughLocalProxy(searchUrl, FETCH_SEARCH_TIMEOUT_MS, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!html) throw new Error('Empty');
    const items = parseGoogleSearchItems(html, limit);
    if (!items.length) throw new Error('No results parsed');
    return items;
  } catch {
    const readerUrl = `${READER_PROXY}https://www.google.com/search?gbv=1&q=${encodeURIComponent(query)}&hl=en&num=${Math.max(limit, 10)}&start=${normalizedOffset}`;
    const response = await fetchThroughLocalProxy(readerUrl, FETCH_SEARCH_TIMEOUT_MS, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim() || isBlockedGoogleSearchContent(text)) throw new Error('Google search blocked');
    const items = parseReaderSearchItems(text, {
      decodeUrl: decodeGoogleResultUrl,
      limit,
    });
    if (!items.length) throw new Error('No results parsed');
    return items;
  }
}

async function fetchBingSearchResults(
  query: string,
  limit = MAX_SEARCH_ITEMS_PER_SOURCE,
  signal?: AbortSignal,
  offset = 0,
): Promise<SearchResultItem[]> {
  const normalizedOffset = Math.max(0, offset);
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US&count=${Math.max(limit, 10)}&first=${normalizedOffset + 1}`;
  const response = await fetchThroughLocalProxy(searchUrl, FETCH_SEARCH_TIMEOUT_MS, signal);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (!html) throw new Error('Empty');
  const items = parseBingSearchItems(html, limit);
  if (!items.length) throw new Error('No results parsed');
  return items;
}

async function duckduckgoSearch(query: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  const startedAt = nowMs();
  try {
    const items = await fetchDuckDuckGoSearchResults(query, MAX_SEARCH_ITEMS_PER_SOURCE, signal);
    return buildContextFromItems({ url, title: `DuckDuckGo Search: ${query}`, provider: 'DuckDuckGo', sourceType: 'search', credibility: 'search', items, durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  } catch (error) {
    return buildContextFromItems({ url, title: `DuckDuckGo Search: ${query}`, provider: 'DuckDuckGo', sourceType: 'search', credibility: 'search', items: [], error: String(error), durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  }
}

async function duckduckgoInstant(query: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const startedAt = nowMs();
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url, FETCH_DIRECT_JSON_TIMEOUT_MS, signal);
    const parts: string[] = [];
    const abstract = String(data.AbstractText ?? '').trim();
    if (abstract) parts.push(abstract);
    const answer = String(data.Answer ?? '').trim();
    if (answer) parts.push(`Answer: ${answer}`);
    const definition = String(data.Definition ?? '').trim();
    if (definition) parts.push(`Definition: ${definition}`);
    if (Array.isArray(data.RelatedTopics)) {
      const topics = (data.RelatedTopics as Array<{ Text?: string; Topics?: Array<{ Text?: string }> }>)
        .flatMap((topic) => (topic.Topics ? topic.Topics : [topic]))
        .slice(0, 8)
        .map((topic) => topic.Text?.trim())
        .filter(Boolean);
      if (topics.length) parts.push(`Related:\n${topics.join('\n')}`);
    }
    return { url, title: `DuckDuckGo Instant: ${query}`, text: parts.join('\n\n').slice(0, MAX_TEXT), durationMs: Math.max(0, Math.round(nowMs() - startedAt)), provider: 'DuckDuckGo', sourceType: 'search', credibility: 'search' };
  } catch (error) {
    return { url, title: `DuckDuckGo Instant: ${query}`, text: '', error: String(error), durationMs: Math.max(0, Math.round(nowMs() - startedAt)), provider: 'DuckDuckGo', sourceType: 'search', credibility: 'search' };
  }
}

async function wikipediaSummary(title: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const startedAt = nowMs();
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url, FETCH_DIRECT_JSON_TIMEOUT_MS, signal);
    const text = String(data.extract ?? '').slice(0, MAX_TEXT);
    const pageTitle = String(data.title ?? title);
    if (!text) throw new Error('No extract');
    return { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`, title: `Wikipedia: ${pageTitle}`, text, durationMs: Math.max(0, Math.round(nowMs() - startedAt)), provider: 'Wikipedia', sourceType: 'reference', credibility: 'reference' };
  } catch (error) {
    return { url, title: `Wikipedia: ${title}`, text: '', error: String(error), durationMs: Math.max(0, Math.round(nowMs() - startedAt)), provider: 'Wikipedia', sourceType: 'reference', credibility: 'reference' };
  }
}

async function wikipediaSearch(query: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url, FETCH_DIRECT_JSON_TIMEOUT_MS, signal);
    const results = (data.query as Record<string, unknown> | undefined)?.search as Array<{ title: string }> | undefined;
    if (!results?.length) throw new Error('No results');
    for (const result of results.slice(0, 2)) {
      const summary = await wikipediaSummary(result.title, signal);
      if (!summary.error && summary.text.length > 100) return summary;
    }
    throw new Error('No usable results');
  } catch (error) {
    return { url, title: `Wikipedia: ${query}`, text: '', error: String(error), provider: 'Wikipedia', sourceType: 'reference', credibility: 'reference' };
  }
}

async function redditSearch(query: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&t=week&limit=8&type=link`;
  const startedAt = nowMs();
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url, FETCH_DIRECT_JSON_TIMEOUT_MS, signal);
    const posts = (data.data as Record<string, unknown> | undefined)?.children as Array<{ data: { title: string; selftext?: string; subreddit?: string; url?: string } }> | undefined;
    if (!posts?.length) throw new Error('No posts');
    const items = posts.map((post) => ({ title: `${post.data.title}${post.data.subreddit ? ` (r/${post.data.subreddit})` : ''}`, snippet: normalizeWhitespace(post.data.selftext?.slice(0, 220) ?? ''), url: post.data.url ?? url })).slice(0, 6);
    return buildContextFromItems({ url, title: `Reddit: ${query}`, provider: 'Reddit', sourceType: 'community', credibility: 'community', items, durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  } catch (error) {
    return buildContextFromItems({ url, title: `Reddit: ${query}`, provider: 'Reddit', sourceType: 'community', credibility: 'community', items: [], error: String(error), durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  }
}

async function hackerNewsSearch(query: string, signal?: AbortSignal): Promise<FetchedContext> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`;
  const startedAt = nowMs();
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url, FETCH_DIRECT_JSON_TIMEOUT_MS, signal);
    const hits = data.hits as Array<{ title?: string; story_text?: string; url?: string }> | undefined;
    if (!hits?.length) throw new Error('No hits');
    const items = hits.filter((hit) => hit.title).map((hit) => ({ title: hit.title ?? 'Untitled', snippet: normalizeWhitespace(hit.story_text?.slice(0, 220) ?? ''), url: hit.url ?? url })).slice(0, 6);
    return buildContextFromItems({ url, title: `Hacker News: ${query}`, provider: 'Hacker News', sourceType: 'community', credibility: 'community', items, durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  } catch (error) {
    return buildContextFromItems({ url, title: `Hacker News: ${query}`, provider: 'Hacker News', sourceType: 'community', credibility: 'community', items: [], error: String(error), durationMs: Math.max(0, Math.round(nowMs() - startedAt)) });
  }
}

function credibilityScore(credibility: FetchedCredibility | undefined): number {
  switch (credibility) {
    case 'official': return 72;
    case 'major-news': return 62;
    case 'reference': return 48;
    case 'search': return 36;
    case 'community': return 10;
    default: return 20;
  }
}

function countTermMatches(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term.toLowerCase()) ? (term.length >= 6 ? 4 : 2) : 0), 0);
}

function getPublishedTimestamp(context: FetchedContext): number | null {
  if (!context.publishedAt) return null;
  const publishedAt = new Date(context.publishedAt).getTime();
  return Number.isFinite(publishedAt) ? publishedAt : null;
}

function parseExplicitMonthDayYearTargets(text: string): Array<{ timestamp: number; granularity: 'day' }> {
  const targets: Array<{ timestamp: number; granularity: 'day' }> = [];
  for (const match of text.matchAll(MONTH_DAY_YEAR_CAPTURE_RE)) {
    const monthToken = (match[1] ?? '').toLowerCase();
    const monthIndex = MONTH_INDEX_BY_NAME[monthToken];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!Number.isInteger(monthIndex) || !Number.isFinite(day) || !Number.isFinite(year)) continue;
    const timestamp = Date.UTC(year, monthIndex, day);
    if (Number.isFinite(timestamp)) {
      targets.push({ timestamp, granularity: 'day' });
    }
  }
  return targets;
}

function parseExplicitMonthYearTargets(text: string): Array<{ timestamp: number; granularity: 'month' }> {
  const targets: Array<{ timestamp: number; granularity: 'month' }> = [];
  for (const match of text.matchAll(MONTH_YEAR_CAPTURE_RE)) {
    const monthToken = (match[1] ?? '').toLowerCase();
    const monthIndex = MONTH_INDEX_BY_NAME[monthToken];
    const year = Number(match[2]);
    if (!Number.isInteger(monthIndex) || !Number.isFinite(year)) continue;
    const timestamp = Date.UTC(year, monthIndex, 1);
    if (Number.isFinite(timestamp)) {
      targets.push({ timestamp, granularity: 'month' });
    }
  }
  return targets;
}

function extractScheduledTargets(context: FetchedContext): Array<{ timestamp: number; granularity: 'day' | 'month' }> {
  const combined = `${context.title}\n${context.text}`;
  if (!SCHEDULE_LANGUAGE_RE.test(combined)) return [];
  return [
    ...parseExplicitMonthDayYearTargets(combined),
    ...parseExplicitMonthYearTargets(combined),
  ];
}

function isStaleScheduleContext(context: FetchedContext, analysis: QueryAnalysis): boolean {
  const timelyFocus = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  if (!timelyFocus) return false;
  if (POST_EVENT_LANGUAGE_RE.test(`${context.title}\n${context.text}`)) return false;

  const scheduledTargets = extractScheduledTargets(context);
  if (!scheduledTargets.length) return false;

  const now = new Date();
  const currentMonthKey = (now.getUTCFullYear() * 12) + now.getUTCMonth();
  const nowDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return scheduledTargets.some((target) => {
    if (target.granularity === 'day') {
      return target.timestamp <= nowDayStart;
    }
    const targetDate = new Date(target.timestamp);
    const targetMonthKey = (targetDate.getUTCFullYear() * 12) + targetDate.getUTCMonth();
    return targetMonthKey <= currentMonthKey;
  });
}

function hasCurrentStatusLanguage(context: FetchedContext): boolean {
  return POST_EVENT_LANGUAGE_RE.test(`${context.title}\n${context.text}`);
}

function getNewestSignalYear(context: FetchedContext): number | undefined {
  const publishedYear = context.publishedAt ? new Date(context.publishedAt).getFullYear() : undefined;
  const years = [...(publishedYear && Number.isFinite(publishedYear) ? [publishedYear] : []), ...extractYears(`${context.title} ${context.text}`)];
  return years.length ? Math.max(...years) : undefined;
}

function getNewestSignalTimestamp(context: FetchedContext): number | null {
  const publishedAt = getPublishedTimestamp(context);
  if (publishedAt != null) return publishedAt;

  const newestYear = getNewestSignalYear(context);
  if (!newestYear) return null;
  return Date.UTC(newestYear, 0, 1);
}

function formatReferenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function isCrewLookupAnalysis(analysis: QueryAnalysis): boolean {
  const text = `${analysis.primaryTerm} ${analysis.contextTerm}`.toLowerCase();
  return /\b(crew|astronaut|pilot|commander|mission specialist|specialist|roster|who is|who are|names?)\b/.test(text);
}

function isRosterStyleContext(context: FetchedContext): boolean {
  const text = `${context.title}\n${context.text}`.toLowerCase();
  return /\b(crew|astronaut)\b/.test(text)
    && /\b(commander|pilot|mission specialist)\b/.test(text);
}

function isCrewEvidenceContext(context: FetchedContext): boolean {
  const text = `${context.title}\n${context.text}\n${context.url}`.toLowerCase();
  return isRosterStyleContext(context)
    || /\b(crew members|meet the crew|official crew|crew profile|crew roster|astronaut biographies?|flight crew|mission crew)\b/.test(text);
}

function normalizeCrewCandidateName(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\b(?:Dr|Mr|Mrs|Ms|Capt|Captain|Cmdr|Commander|Lt|Col|Colonel|Major|Gen|General|Pilot)\.?\s+/gi, '')
      .replace(/[.,;:()\[\]{}]+/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function isLikelyCrewPersonName(value: string): boolean {
  const normalized = normalizeCrewCandidateName(value);
  if (!normalized) return false;
  if (CREW_NAME_BLOCKLIST.has(normalized)) return false;
  if (/^(?:The|A|An)\b/.test(normalized)) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  const loweredWords = words.map((word) => word.toLowerCase());
  if (loweredWords.some((word) => CREW_NAME_WORD_BLOCKLIST.has(word))) return false;
  if (loweredWords.some((word) => MONTH_INDEX_BY_NAME[word] != null)) return false;
  if (/\b(?:mission|crew|astronaut|pilot|commander|specialist|space|launch|update|news)\b/i.test(normalized)) return false;
  return true;
}

function splitCrewEvidenceSegments(value: string): string[] {
  return uniqueStrings(
    value
      .replace(/[•·]/g, '\n')
      .replace(/\s+\|\s+/g, '\n')
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((line) => normalizeWhitespace(line))
      .filter((line) => line.length >= 18 && line.length <= 320),
  );
}

function detectCrewRoleNearName(name: string, segment: string): string | undefined {
  const escapedName = escapeRegExp(name);
  for (const { role, pattern } of CREW_ROLE_PATTERNS) {
    const beforePattern = new RegExp(`${escapedName}\\s*(?:,|:|\\-|–|—|\\()\\s*(?:NASA astronaut(?: and)?\\s+|CSA astronaut(?: and)?\\s+|ESA astronaut(?: and)?\\s+|JAXA astronaut(?: and)?\\s+|ISRO astronaut(?: and)?\\s+)?${pattern.source}`, 'i');
    const afterPattern = new RegExp(`${pattern.source}\\s+(?:NASA astronaut\\s+|CSA astronaut\\s+|ESA astronaut\\s+|JAXA astronaut\\s+|ISRO astronaut\\s+)?${escapedName}`, 'i');
    if (beforePattern.test(segment) || afterPattern.test(segment)) {
      return role;
    }
  }
  return undefined;
}

export function extractCrewRosterFromContexts(
  contexts: FetchedContext[],
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
): ExtractedCrewRosterMember[] {
  const analysis = analyzeQuery(userMessage, conversationHistory);
  if (!isCrewLookupAnalysis(analysis)) return [];

  const candidateContexts = contexts.filter((context) => {
    if (context.error || context.text.trim().length < 40) return false;
    if (isSearchSummaryContext(context) || isDirectoryStyleContext(context)) return false;
    if (getMissionAlignmentScore(context, analysis) < 0) return false;
    return isCrewEvidenceContext(context) || isPrimaryEvidenceContext(context);
  });

  const candidates = new Map<string, {
    name: string;
    supportScore: number;
    sourceUrls: Set<string>;
    officialHits: number;
    roleVotes: Map<string, number>;
  }>();

  for (const context of candidateContexts) {
    const contextScoreBase = (context.sourceType === 'official' ? 7 : context.sourceType === 'news' ? 4 : 2)
      + (isRosterStyleContext(context) ? 4 : 0)
      + (isCrewEvidenceContext(context) ? 2 : 0)
      + (getMissionAlignmentScore(context, analysis) > 0 ? 4 : 0);
    const segments = splitCrewEvidenceSegments(`${context.title}\n${context.text}`);
    const seenNamesForContext = new Set<string>();

    for (const segment of segments) {
      if (!isRosterStyleContext(context) && !CREW_SEGMENT_HINT_RE.test(segment)) {
        continue;
      }

      const names = uniqueStrings(
        [...segment.matchAll(CREW_NAME_RE)]
          .map((match) => normalizeCrewCandidateName(match[1] ?? ''))
          .filter(isLikelyCrewPersonName),
      );

      for (const name of names) {
        const key = name.toLowerCase();
        const candidate = candidates.get(key) ?? {
          name,
          supportScore: 0,
          sourceUrls: new Set<string>(),
          officialHits: 0,
          roleVotes: new Map<string, number>(),
        };

        if (!seenNamesForContext.has(key)) {
          let localScore = contextScoreBase;
          if (segment.toLowerCase().includes(name.toLowerCase())) localScore += 2;
          if (CREW_SEGMENT_HINT_RE.test(segment)) localScore += 2;
          if (context.title.toLowerCase().includes(name.toLowerCase())) localScore += 2;
          candidate.supportScore += localScore;
          candidate.sourceUrls.add(context.url.toLowerCase());
          if (context.sourceType === 'official') {
            candidate.officialHits += 1;
          }
          seenNamesForContext.add(key);
        }

        const role = detectCrewRoleNearName(name, segment);
        if (role) {
          candidate.roleVotes.set(role, (candidate.roleVotes.get(role) ?? 0) + contextScoreBase + 2);
        }

        candidates.set(key, candidate);
      }
    }
  }

  return [...candidates.values()]
    .filter((candidate) => {
      if (candidate.officialHits > 0) return candidate.supportScore >= 10;
      return candidate.sourceUrls.size >= 2 && candidate.supportScore >= 12;
    })
    .map<ExtractedCrewRosterMember>((candidate) => {
      const roleVote = [...candidate.roleVotes.entries()].sort((left, right) => right[1] - left[1])[0];
      return {
        name: candidate.name,
        role: roleVote && roleVote[1] >= 8 ? roleVote[0] : undefined,
        supportScore: candidate.supportScore,
        sourceCount: candidate.sourceUrls.size,
      };
    })
    .sort((left, right) => {
      if ((right.sourceCount ?? 0) !== (left.sourceCount ?? 0)) {
        return (right.sourceCount ?? 0) - (left.sourceCount ?? 0);
      }
      if ((right.supportScore ?? 0) !== (left.supportScore ?? 0)) {
        return (right.supportScore ?? 0) - (left.supportScore ?? 0);
      }
      return left.name.localeCompare(right.name);
    });
}

function isDirectoryStyleContext(context: FetchedContext): boolean {
  const combined = `${context.title}\n${context.url}\n${context.text}`.toLowerCase();
  return /\b(agency directory|agencies index|directory|agency list|browse agencies|department directory|site index|a-z index|topic index)\b/.test(combined)
    || /\/(?:agencies|agency|directory|directories|site-index|sitemap|topics|browse)(?:\/|$)/.test(context.url.toLowerCase());
}

function needsAgencyDirectoryContext(analysis: QueryAnalysis): boolean {
  const text = `${analysis.primaryTerm} ${analysis.contextTerm}`.toLowerCase();
  return /\b(agency|agencies|department|departments|ministry|ministries|directory|directories|who handles|which agency|what agency|federal agencies)\b/.test(text);
}

function isHistoricalLiveStatusContext(context: FetchedContext, analysis: QueryAnalysis): boolean {
  const timelyFocus = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  if (!timelyFocus) return false;

  const text = `${context.title}\n${context.text}`;
  if (!ACTIVE_STATUS_LANGUAGE_RE.test(text)) return false;

  const publishedAt = getPublishedTimestamp(context);
  if (publishedAt != null) {
    const ageDays = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
    return ageDays > 120;
  }

  const newestYear = getNewestSignalYear(context);
  if (!newestYear) return false;
  return newestYear < analysis.currentYear;
}

function getMissionAlignmentScore(context: FetchedContext, analysis: QueryAnalysis): number {
  if (!analysis.missionKeys.length) return 0;

  const contextMissionKeys = extractMissionKeys(`${context.title}\n${context.text}\n${context.url}`);
  if (contextMissionKeys.some((key) => analysis.missionKeys.includes(key))) {
    return 30;
  }

  const requestedPrograms = uniqueStrings(analysis.missionKeys.map((key) => key.split('-')[0]).filter(Boolean));
  const contextPrograms = uniqueStrings(contextMissionKeys.map((key) => key.split('-')[0]).filter(Boolean));

  if (contextMissionKeys.length && contextPrograms.some((program) => requestedPrograms.includes(program))) {
    return -34;
  }

  if (contextMissionKeys.length && requestedPrograms.length > 0 && !contextPrograms.some((program) => requestedPrograms.includes(program))) {
    return -42;
  }

  const contextText = `${context.title}\n${context.text}\n${context.url}`.toLowerCase();
  if (!contextMentionsRequestedProgram(contextText, analysis) && !contextMissionKeys.length) {
    return analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future' || analysis.temporalFocus === 'recent'
      ? -32
      : -18;
  }
  if (requestedPrograms.some((program) => contextText.includes(program)) && !contextMissionKeys.length) {
    return analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future' || analysis.temporalFocus === 'recent'
      ? -10
      : -4;
  }

  return 0;
}

function isSearchEngineHost(hostname: string): boolean {
  return hostname === 'google.com'
    || hostname.endsWith('.google.com')
    || hostname === 'bing.com'
    || hostname.endsWith('.bing.com')
    || hostname === 'duckduckgo.com'
    || hostname.endsWith('.duckduckgo.com');
}

function isSearchSummaryContext(context: FetchedContext): boolean {
  const hostname = extractHostname(context.url);
  const normalizedTitle = context.title.toLowerCase();
  return isSearchEngineHost(hostname)
    || normalizedTitle.includes('search:')
    || normalizedTitle.includes('snapshot:')
    || normalizedTitle.includes('probe:');
}

function isPrimaryEvidenceContext(context: FetchedContext): boolean {
  if (context.error) return false;
  if (isSearchSummaryContext(context)) return false;
  if (isDirectoryStyleContext(context)) return false;
  const sourceType = context.sourceType ?? 'search';
  if (sourceType !== 'official' && sourceType !== 'news') return false;
  const textLength = context.text.trim().length;
  return textLength >= 220 || Boolean(context.publishedAt && textLength >= 140);
}

function isDirectSourceEvidenceContext(context: FetchedContext, analysis: QueryAnalysis): boolean {
  if (context.error) return false;
  if (isSearchSummaryContext(context)) return false;
  if (isDirectoryStyleContext(context)) return false;
  const hostname = extractHostname(context.url);
  if (!hostname || isSearchEngineHost(hostname)) return false;

  const sourceType = context.sourceType ?? 'search';
  if (analysis.temporalFocus === 'current' || analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'future') {
    return sourceType === 'official' || sourceType === 'news';
  }

  return sourceType === 'official' || sourceType === 'news' || sourceType === 'reference';
}

function isOfficialReportContext(context: FetchedContext): boolean {
  if (context.sourceType !== 'official') return false;
  const combined = `${context.title} ${context.url}`.toLowerCase();
  return /(?:breaking news|blog|blogs|update|updates|statement|report|reports|news release|press release|mission update|media advisory)/i.test(combined)
    || /\/(?:news|blogs|blog|updates|update|press-release|pressrelease|missions?\/updates)\//i.test(combined);
}

function sortContextsForPrompt(contexts: FetchedContext[]): FetchedContext[] {
  return contexts
    .map((context, index) => ({ context, index }))
    .sort((left, right) => {
      const searchSummaryDelta = Number(isSearchSummaryContext(left.context)) - Number(isSearchSummaryContext(right.context));
      if (searchSummaryDelta !== 0) return searchSummaryDelta;

      const evidenceDelta = Number(isPrimaryEvidenceContext(right.context)) - Number(isPrimaryEvidenceContext(left.context));
      if (evidenceDelta !== 0) return evidenceDelta;

      return left.index - right.index;
    })
    .map(({ context }) => context);
}

function sourceTypeBoost(sourceType: FetchedSourceType | undefined, analysis: QueryAnalysis): number {
  switch (sourceType) {
    case 'official': return analysis.prefersOfficialSources ? (analysis.prefersNewsSources && analysis.sourceProfile !== 'government' ? 20 : 28) : 18;
    case 'news': return analysis.prefersNewsSources ? 32 : analysis.temporalFocus === 'timeless' ? 6 : 22;
    case 'reference': return analysis.temporalFocus === 'timeless' || analysis.temporalFocus === 'historic' ? 18 : 6;
    case 'search': return 10;
    case 'community': return analysis.prefersCommunitySources ? 8 : -26;
    default: return 0;
  }
}

function temporalScore(context: FetchedContext, analysis: QueryAnalysis): number {
  if (analysis.temporalFocus === 'timeless') return 0;
  const publishedAt = getPublishedTimestamp(context);
  if (publishedAt != null) {
    const ageDays = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
    if (analysis.temporalFocus === 'future' || analysis.temporalFocus === 'current') {
      if (ageDays <= 2) return 34;
      if (ageDays <= 7) return 26;
      if (ageDays <= 21) return 18;
      if (ageDays <= 45) return 8;
      if (ageDays <= 90) return -2;
      if (ageDays <= 180) return -14;
      return -28;
    }
    if (analysis.temporalFocus === 'recent') {
      if (ageDays <= 7) return 24;
      if (ageDays <= 30) return 16;
      if (ageDays <= 90) return 6;
      if (ageDays <= 180) return -6;
      return -18;
    }
    if (analysis.temporalFocus === 'historic') {
      return ageDays >= 365 ? 10 : 2;
    }
  }

  const newestYear = getNewestSignalYear(context);
  if (!newestYear) return analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future' ? -12 : 0;
  if (analysis.temporalFocus === 'future') return newestYear > analysis.currentYear ? 8 : newestYear === analysis.currentYear ? 2 : -24;
  if (analysis.temporalFocus === 'current') return newestYear >= analysis.currentYear ? 4 : newestYear >= analysis.currentYear - 1 ? -2 : -20;
  if (analysis.temporalFocus === 'recent') return newestYear >= RECENT_YEAR_FLOOR ? 4 : -12;
  if (analysis.temporalFocus === 'historic') return newestYear < RECENT_YEAR_FLOOR ? 8 : 2;
  return 0;
}

function scoreContext(context: FetchedContext, analysis: QueryAnalysis): number {
  let score = credibilityScore(context.credibility);
  score += sourceTypeBoost(context.sourceType, analysis);
  score += temporalScore(context, analysis);
  score += countTermMatches(`${context.title}\n${context.text}`, analysis.terms);
  score += getMissionAlignmentScore(context, analysis);
  const hostname = extractHostname(context.url);
  const timelyFocus = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  const searchSummary = isSearchSummaryContext(context);
  const primaryEvidence = isPrimaryEvidenceContext(context);
  const publishedAt = getPublishedTimestamp(context);
  const ageDays = publishedAt != null ? Math.max(0, (Date.now() - publishedAt) / 86_400_000) : null;
  const staleScheduleContext = isStaleScheduleContext(context, analysis);
  const currentStatusLanguage = hasCurrentStatusLanguage(context);
  const directoryStyleContext = isDirectoryStyleContext(context);
  const historicalLiveStatusContext = isHistoricalLiveStatusContext(context, analysis);
  if (isSearchEngineHost(hostname)) {
    score -= 28;
  }
  if (!needsAgencyDirectoryContext(analysis) && directoryStyleContext) {
    score -= 56;
  }
  if (analysis.prefersNewsSources && context.sourceType === 'news') score += 12;
  if (timelyFocus && searchSummary) score -= 26;
  if (timelyFocus && context.sourceType === 'search') score -= 12;
  if (isDirectSourceEvidenceContext(context, analysis)) {
    score += timelyFocus ? 12 : 6;
  }
  if (timelyFocus && primaryEvidence) {
    score += context.sourceType === 'official' ? 18 : 14;
  }
  if (timelyFocus && context.sourceType === 'official' && isOfficialReportContext(context)) {
    score += ageDays != null && ageDays <= 30 ? 16 : 8;
  }
  if (isCrewLookupAnalysis(analysis) && isRosterStyleContext(context)) {
    score += context.sourceType === 'official' ? 24 : 10;
  }
  if (isCrewLookupAnalysis(analysis) && isCrewEvidenceContext(context)) {
    score += context.sourceType === 'official' ? 20 : 8;
  }
  if (timelyFocus && context.sourceType === 'official' && !isOfficialReportContext(context) && !isCrewLookupAnalysis(analysis)) {
    score -= context.publishedAt ? 6 : 18;
  }
  if (timelyFocus && currentStatusLanguage) {
    score += context.sourceType === 'official' ? 18 : 14;
  }
  if (timelyFocus && staleScheduleContext) {
    score -= context.sourceType === 'official' ? 34 : 42;
  }
  if (historicalLiveStatusContext) {
    score -= 46;
  }
  if (timelyFocus && !primaryEvidence && !context.publishedAt) score -= 8;
  if (timelyFocus && ageDays != null && ageDays > 30) score -= 10;
  if (timelyFocus && ageDays != null && ageDays > 90) score -= 16;
  if (timelyFocus && context.text.trim().length < 180) score -= 10;
  if (context.error) score -= 100;
  if (!context.text.trim()) score -= 40;
  if (context.sourceType === 'community' && !analysis.prefersCommunitySources) score -= 20;
  if (context.sourceType === 'reference' && (analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future')) score -= 8;
  return score;
}

function buildContextSupportTerms(context: FetchedContext, analysis: QueryAnalysis): Set<string> {
  const combined = `${context.title} ${context.text}`;
  const contextTerms = buildSearchTerms(combined).slice(0, 18);
  const relevantTerms = contextTerms.filter((term) =>
    analysis.terms.includes(term)
    || getRequestedProgramTokens(analysis).includes(term)
    || /\b(?:crew|pilot|commander|specialist|launch|moon|timeline|status|orbit|return|capsule|orion)\b/i.test(term),
  );
  return new Set(relevantTerms);
}

function computeContextConsensusBoost(
  target: FetchedContext,
  peers: FetchedContext[],
  analysis: QueryAnalysis,
): number {
  const targetHost = extractHostname(target.url);
  if (!targetHost) return 0;

  const targetTerms = buildContextSupportTerms(target, analysis);
  if (!targetTerms.size) return 0;

  let corroboratingHosts = 0;
  for (const peer of peers) {
    if (peer.url.toLowerCase() === target.url.toLowerCase()) continue;
    const peerHost = extractHostname(peer.url);
    if (!peerHost || peerHost === targetHost) continue;
    if (isSearchSummaryContext(peer) || isDirectoryStyleContext(peer)) continue;
    if (getMissionAlignmentScore(peer, analysis) < 0) continue;

    const peerTerms = buildContextSupportTerms(peer, analysis);
    let overlap = 0;
    for (const term of targetTerms) {
      if (peerTerms.has(term)) overlap += 1;
    }
    if (overlap >= 2) corroboratingHosts += 1;
  }

  return Math.min(18, corroboratingHosts * 6);
}

function resolveHostCapForContext(context: FetchedContext, analysis: QueryAnalysis, isDeep: boolean): number {
  const sourceType = context.sourceType ?? 'search';
  if (sourceType === 'official') {
    return isDeep ? 2 : 1;
  }
  if (sourceType === 'news') {
    return analysis.prefersNewsSources && isDeep ? 2 : 1;
  }
  return 1;
}

function selectBestContexts(
  contexts: FetchedContext[],
  analysis: QueryAnalysis,
  options: FetchGlobalContextOptions = {},
): FetchedContext[] {
  const desiredSourceCount = resolveDesiredSourceCount(analysis, options);
  const isDeep = options.depth === 'deep';
  const timelyFocus = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  const rawDeduped = contexts
    .filter((context) => !context.error && context.text.trim().length >= 24)
    .filter((context, index, array) => array.findIndex((entry) => `${(entry.provider ?? '').toLowerCase()}|${entry.url.toLowerCase()}|${entry.title.toLowerCase()}` === `${(context.provider ?? '').toLowerCase()}|${context.url.toLowerCase()}|${context.title.toLowerCase()}`) === index)
    .map((context) => ({ context, score: scoreContext(context, analysis) }));
  const deduped = rawDeduped
    .map(({ context, score }) => ({
      context,
      score: score + computeContextConsensusBoost(context, rawDeduped.map((entry) => entry.context), analysis),
    }))
    .sort((left, right) => right.score - left.score);
  const directEvidenceCandidates = deduped.filter(({ context }) => isDirectSourceEvidenceContext(context, analysis));
  const directEvidenceHostCount = new Set(directEvidenceCandidates.map(({ context }) => extractHostname(context.url)).filter(Boolean)).size;

  const strongEvidenceCount = deduped.filter(({ context, score }) =>
    score >= (isDeep ? 22 : 26) && isPrimaryEvidenceContext(context),
  ).length;
  const hasFreshTimelyEvidence = timelyFocus && deduped.some(({ context, score }) => {
    const publishedAt = getPublishedTimestamp(context);
    if (publishedAt == null) return false;
    const ageDays = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
    return score >= (isDeep ? 22 : 26) && ageDays <= 14;
  });
  const hasFreshCurrentStatusEvidence = timelyFocus && deduped.some(({ context, score }) => {
    const publishedAt = getPublishedTimestamp(context);
    if (publishedAt == null) return false;
    const ageDays = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
    return score >= (isDeep ? 22 : 26) && ageDays <= 14 && hasCurrentStatusLanguage(context);
  });
  const hasStrongCrewEvidence = isCrewLookupAnalysis(analysis) && deduped.some(({ context, score }) =>
    score >= (isDeep ? 18 : 22) && isCrewEvidenceContext(context) && getMissionAlignmentScore(context, analysis) >= 0,
  );
  const hasMissionMatchedEvidence = analysis.missionKeys.length > 0 && deduped.some(({ context, score }) =>
    score >= (isDeep ? 22 : 26) && getMissionAlignmentScore(context, analysis) > 0,
  );
  const shouldLockSearchSummariesOut = timelyFocus && (strongEvidenceCount >= 2 || directEvidenceHostCount >= 2);

  const maxByType: Record<FetchedSourceType, number> = {
    official: isDeep ? 4 : analysis.prefersOfficialSources ? 3 : 2,
    news: isDeep ? 6 : timelyFocus || analysis.prefersNewsSources ? 4 : 3,
    reference: isDeep ? 2 : 1,
    search: shouldLockSearchSummariesOut ? 0 : isDeep ? 3 : 2,
    community: analysis.prefersCommunitySources ? 1 : 0,
  };
  const providerCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();
  const typeCounts = new Map<FetchedSourceType, number>();
  const selected: FetchedContext[] = [];
  const minimumScore = isDeep ? 18 : 22;

  for (const { context, score } of deduped) {
    if (selected.length >= desiredSourceCount) break;
    if (score < minimumScore) continue;
    if (shouldLockSearchSummariesOut && isSearchSummaryContext(context)) continue;
    if (!needsAgencyDirectoryContext(analysis) && isDirectoryStyleContext(context)) continue;
    if (isHistoricalLiveStatusContext(context, analysis)) continue;
    if (hasStrongCrewEvidence && !isCrewEvidenceContext(context)) continue;
    if (hasMissionMatchedEvidence && getMissionAlignmentScore(context, analysis) < 0) continue;
    if (hasFreshCurrentStatusEvidence && isStaleScheduleContext(context, analysis)) continue;
    if (hasFreshTimelyEvidence) {
      const publishedAt = getPublishedTimestamp(context);
      const ageDays = publishedAt != null ? Math.max(0, (Date.now() - publishedAt) / 86_400_000) : null;
      if (ageDays != null && ageDays > 60) continue;
      if (ageDays == null && timelyFocus && context.sourceType === 'official' && !isOfficialReportContext(context) && !isCrewLookupAnalysis(analysis)) continue;
    }
    const providerKey = (context.provider ?? context.title).toLowerCase();
    const hostKey = extractHostname(context.url) || providerKey;
    const sourceType = context.sourceType ?? 'search';
    const hostCap = resolveHostCapForContext(context, analysis, isDeep);
    if ((hostCounts.get(hostKey) ?? 0) >= hostCap) continue;
    if ((providerCounts.get(providerKey) ?? 0) >= (isDeep && sourceType === 'news' ? 2 : 1) && sourceType !== 'news') continue;
    if ((typeCounts.get(sourceType) ?? 0) >= maxByType[sourceType]) continue;
    selected.push(context);
    hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
    providerCounts.set(providerKey, (providerCounts.get(providerKey) ?? 0) + 1);
    typeCounts.set(sourceType, (typeCounts.get(sourceType) ?? 0) + 1);
  }

  const currentDirectEvidenceCount = selected.filter((context) => isDirectSourceEvidenceContext(context, analysis)).length;
  const desiredDirectEvidenceCount = timelyFocus
    ? Math.min(Math.max(minimumRequiredSourceCount(analysis, options) + 2, 4), desiredSourceCount, directEvidenceHostCount)
    : 0;
  if (timelyFocus && currentDirectEvidenceCount < desiredDirectEvidenceCount) {
    for (const { context, score } of directEvidenceCandidates) {
      if (selected.length >= desiredSourceCount) break;
      if (score < Math.max(12, minimumScore - 10)) continue;
      if (selected.some((entry) => entry.url.toLowerCase() === context.url.toLowerCase())) continue;
      if (isHistoricalLiveStatusContext(context, analysis)) continue;
      if (hasMissionMatchedEvidence && getMissionAlignmentScore(context, analysis) < 0) continue;
      if (hasFreshCurrentStatusEvidence && isStaleScheduleContext(context, analysis)) continue;

      const providerKey = (context.provider ?? context.title).toLowerCase();
      const hostKey = extractHostname(context.url) || providerKey;
      const sourceType = context.sourceType ?? 'search';
      const hostCap = resolveHostCapForContext(context, analysis, isDeep);
      if ((hostCounts.get(hostKey) ?? 0) >= hostCap) continue;
      if ((providerCounts.get(providerKey) ?? 0) >= (isDeep && sourceType === 'news' ? 2 : 1) && sourceType !== 'news') continue;
      if ((typeCounts.get(sourceType) ?? 0) >= maxByType[sourceType]) continue;

      selected.push(context);
      hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
      providerCounts.set(providerKey, (providerCounts.get(providerKey) ?? 0) + 1);
      typeCounts.set(sourceType, (typeCounts.get(sourceType) ?? 0) + 1);

      if (selected.filter((entry) => isDirectSourceEvidenceContext(entry, analysis)).length >= desiredDirectEvidenceCount) {
        break;
      }
    }
  }

  if (selected.length < desiredSourceCount) {
    const supplementalMinimumScore = isDeep ? 12 : timelyFocus ? 14 : 16;
    const supplementalPool = (directEvidenceCandidates.length ? directEvidenceCandidates : deduped)
      .filter(({ context }) => !isSearchSummaryContext(context) && !isDirectoryStyleContext(context));

    for (const { context, score } of supplementalPool) {
      if (selected.length >= desiredSourceCount) break;
      if (score < supplementalMinimumScore) continue;
      if (selected.some((entry) => entry.url.toLowerCase() === context.url.toLowerCase())) continue;
      if (isHistoricalLiveStatusContext(context, analysis)) continue;
      if (hasMissionMatchedEvidence && getMissionAlignmentScore(context, analysis) < 0) continue;
      if (hasFreshCurrentStatusEvidence && isStaleScheduleContext(context, analysis)) continue;

      const providerKey = (context.provider ?? context.title).toLowerCase();
      const hostKey = extractHostname(context.url) || providerKey;
      const sourceType = context.sourceType ?? 'search';
      const hostCap = resolveHostCapForContext(context, analysis, isDeep);
      const supplementalTypeCap = sourceType === 'news'
        ? (isDeep ? 6 : 5)
        : sourceType === 'official'
          ? (isDeep ? 4 : 3)
          : maxByType[sourceType];

      if ((hostCounts.get(hostKey) ?? 0) >= hostCap) continue;
      if ((providerCounts.get(providerKey) ?? 0) >= (isDeep && sourceType === 'news' ? 2 : 1) && sourceType !== 'news') continue;
      if ((typeCounts.get(sourceType) ?? 0) >= supplementalTypeCap) continue;

      selected.push(context);
      hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
      providerCounts.set(providerKey, (providerCounts.get(providerKey) ?? 0) + 1);
      typeCounts.set(sourceType, (typeCounts.get(sourceType) ?? 0) + 1);
    }
  }

  if (selected.length) {
    return selected;
  }

  const fallbackPool = directEvidenceCandidates.length
    ? directEvidenceCandidates
    : deduped.filter(({ context }) => !isSearchSummaryContext(context));

  return fallbackPool
    .slice(0, Math.max(2, Math.min(desiredSourceCount, isDeep ? 8 : 5)))
    .map((entry) => entry.context);
}

function minimumRequiredSourceCount(
  analysis: QueryAnalysis,
  options: FetchGlobalContextOptions = {},
): number {
  const timelyFocus = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  if (options.depth === 'deep') return 3;
  if (analysis.queryMode === 'research') return 3;
  if (timelyFocus && (analysis.prefersOfficialSources || analysis.prefersNewsSources)) {
    return 3;
  }
  return 0;
}

function buildNonSearchSourcePool(
  contexts: FetchedContext[],
  analysis: QueryAnalysis,
): FetchedContext[] {
  return contexts
    .filter((context) => !context.error && context.text.trim().length >= 24)
    .filter((context) => !isSearchSummaryContext(context))
    .filter((context) => !isDirectoryStyleContext(context))
    .filter((context) => {
      const hostname = extractHostname(context.url);
      return hostname && !isSearchEngineHost(hostname);
    })
    .filter((context, index, array) => array.findIndex((entry) => entry.url.toLowerCase() === context.url.toLowerCase()) === index)
    .map((context) => ({ context, score: scoreContext(context, analysis) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.context);
}

function ensureMinimumSourceCount(
  selected: FetchedContext[],
  contexts: FetchedContext[],
  analysis: QueryAnalysis,
  options: FetchGlobalContextOptions = {},
): FetchedContext[] {
  const minimumRequired = minimumRequiredSourceCount(analysis, options);
  if (minimumRequired <= 0 || selected.length >= minimumRequired) {
    return selected;
  }

  const desiredSourceCount = resolveDesiredSourceCount(analysis, options);
  const supplemented = [...selected];
  const seenUrls = new Set(supplemented.map((context) => context.url.toLowerCase()));

  for (const context of buildNonSearchSourcePool(contexts, analysis)) {
    if (supplemented.length >= Math.max(minimumRequired, Math.min(desiredSourceCount, minimumRequired + 2))) {
      break;
    }
    const key = context.url.toLowerCase();
    if (seenUrls.has(key)) continue;
    supplemented.push(context);
    seenUrls.add(key);
    if (supplemented.length >= minimumRequired) {
      break;
    }
  }

  return supplemented;
}

async function recoverMinimumContexts(
  analysis: QueryAnalysis,
  queryVariants: string[],
  exactQueries: string[],
  options: FetchGlobalContextOptions,
): Promise<FetchedContext[]> {
  const minimumRequired = minimumRequiredSourceCount(analysis, options);
  if (minimumRequired <= 0) return [];

  const isDeep = options.depth === 'deep';
  const searchFallbackSourceType: FetchedSourceType = analysis.prefersNewsSources ? 'news' : analysis.prefersOfficialSources ? 'official' : 'search';
  const searchFallbackCredibility: FetchedCredibility = analysis.prefersNewsSources ? 'major-news' : analysis.prefersOfficialSources ? 'official' : 'search';
  const variantLimit = isDeep ? Math.min(queryVariants.length, 3) : Math.min(queryVariants.length, 2);
  const variants = uniqueStrings([
    ...exactQueries,
    ...queryVariants,
  ]).slice(0, Math.max(1, variantLimit + exactQueries.length));
  const recoveryBudget = isDeep ? RECOVERY_CONTEXT_BUDGET_DEEP_MS : RECOVERY_CONTEXT_BUDGET_STANDARD_MS;
  const recoverySearchPageCount = isDeep ? 2 : 1;
  const recoveryDestinationPageLimit = isDeep ? 4 : 3;
  const recoverySearchItemLimit = isDeep ? 16 : 12;

  const taskFactories: Array<(signal: AbortSignal) => Promise<FetchedContext | FetchedContext[] | null>> = [];

  for (const variant of variants) {
    taskFactories.push(async (signal) => {
      const items = await fetchSearchResultPages(fetchGoogleSearchResults, variant, {
        pageSize: recoverySearchItemLimit,
        pageCount: recoverySearchPageCount,
      }, signal).catch(() => []);
      return collectSearchContexts({
        items,
        summaryUrl: `https://www.google.com/search?q=${encodeURIComponent(variant)}`,
        summaryTitle: `Recovery Google Search: ${variant}`,
        summaryProvider: 'Google Search',
        summarySourceType: searchFallbackSourceType,
        summaryCredibility: searchFallbackCredibility,
        scrapeProvider: 'Recovery Google Search',
        scrapeSourceType: searchFallbackSourceType,
        scrapeCredibility: searchFallbackCredibility,
        maxPages: recoveryDestinationPageLimit,
      }, signal);
    });
    taskFactories.push(async (signal) => {
      const items = await fetchSearchResultPages(fetchDuckDuckGoSearchResults, variant, {
        pageSize: recoverySearchItemLimit,
        pageCount: recoverySearchPageCount,
      }, signal).catch(() => []);
      return collectSearchContexts({
        items,
        summaryUrl: `https://duckduckgo.com/?q=${encodeURIComponent(variant)}`,
        summaryTitle: `Recovery DuckDuckGo Search: ${variant}`,
        summaryProvider: 'DuckDuckGo',
        summarySourceType: searchFallbackSourceType,
        summaryCredibility: searchFallbackCredibility,
        scrapeProvider: 'Recovery DuckDuckGo Search',
        scrapeSourceType: searchFallbackSourceType,
        scrapeCredibility: searchFallbackCredibility,
        maxPages: recoveryDestinationPageLimit,
      }, signal);
    });
  }

  const results = await collectContextsWithinBudget(taskFactories, recoveryBudget);
  return buildNonSearchSourcePool(results, analysis).slice(0, isDeep ? 10 : 6);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function collectContextsWithinBudget(
  taskFactories: Array<(signal: AbortSignal) => Promise<FetchedContext | FetchedContext[] | null>>,
  budgetMs: number,
): Promise<FetchedContext[]> {
  const controller = new AbortController();
  const results: FetchedContext[] = [];

  const tasks = taskFactories.map(async (factory) => {
    try {
      const result = await factory(controller.signal);
      if (result) {
        if (Array.isArray(result)) {
          results.push(...result);
        } else {
          results.push(result);
        }
      }
      return result;
    } catch {
      return null;
    }
  });

  const raceResult = await Promise.race([
    Promise.allSettled(tasks).then(() => 'settled' as const),
    wait(budgetMs).then(() => 'timeout' as const),
  ]);

  if (raceResult === 'timeout') {
    controller.abort('Global context budget exceeded');
    await Promise.allSettled(tasks);
  }

  return results;
}

export async function fetchGlobalContext(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
  options: FetchGlobalContextOptions = {},
): Promise<FetchedContext[]> {
  const analysis = analyzeQuery(userMessage, conversationHistory);
  if ((!analysis.shouldFetch && !options.forceFetch) || (!analysis.primaryTerm && !analysis.contextTerm)) return [];

  const compactQuery = buildCompactQuery(analysis);
  const exactSearchQueries = buildExactSearchQueries(userMessage);
  const queryVariants = buildQueryVariants(analysis);
  const primarySearchQuery = queryVariants[0] ?? compactQuery;
  const desiredSourceCount = resolveDesiredSourceCount(analysis, options);
  const minimumRequired = minimumRequiredSourceCount(analysis, options);
  const needsTimelySources = analysis.temporalFocus === 'recent' || analysis.temporalFocus === 'current' || analysis.temporalFocus === 'future';
  const searchFallbackSourceType: FetchedSourceType = analysis.prefersNewsSources ? 'news' : analysis.prefersOfficialSources ? 'official' : 'search';
  const searchFallbackCredibility: FetchedCredibility = analysis.prefersNewsSources ? 'major-news' : analysis.prefersOfficialSources ? 'official' : 'search';
  const isDeep = options.depth === 'deep';
  const searchItemLimit = isDeep ? 16 : 12;
  const primaryResultPageCount = isDeep ? 2 : 1;
  const secondaryResultPageCount = isDeep ? 1 : 1;
  const primarySearchPageLimit = isDeep ? 4 : 3;
  const secondarySearchPageLimit = isDeep ? 3 : 2;
  const searchVariantLimit = isDeep ? Math.min(queryVariants.length, 5) : Math.min(queryVariants.length, 3);
  const globalBudgetMs = isDeep ? GLOBAL_CONTEXT_BUDGET_DEEP_MS : GLOBAL_CONTEXT_BUDGET_STANDARD_MS;
  const timelyQuery = needsTimelySources && !/\blatest|current|status|timeline|today\b/i.test(compactQuery)
    ? `${compactQuery} latest status timeline`
    : compactQuery;
  const engineQueries = uniqueStrings([
    ...exactSearchQueries,
    primarySearchQuery,
    ...(needsTimelySources ? [timelyQuery] : []),
    ...queryVariants.slice(1, searchVariantLimit),
  ]).filter(Boolean);
  const deadline = nowMs() + globalBudgetMs;
  const results: FetchedContext[] = [];

  const collectFromEngine = async (
    engine: 'duckduckgo' | 'google',
    queryText: string,
    pageCount: number,
    maxPages: number,
  ): Promise<FetchedContext[]> => {
    const items = await (
      engine === 'duckduckgo'
        ? fetchSearchResultPages(fetchDuckDuckGoSearchResults, queryText, {
            pageSize: searchItemLimit,
            pageCount,
          })
        : fetchSearchResultPages(fetchGoogleSearchResults, queryText, {
            pageSize: searchItemLimit,
            pageCount,
          })
    ).catch(() => []);

    if (!items.length) return [];

    return collectSearchContexts({
      items,
      summaryUrl: engine === 'duckduckgo'
        ? `https://duckduckgo.com/?q=${encodeURIComponent(queryText)}`
        : `https://www.google.com/search?q=${encodeURIComponent(queryText)}`,
      summaryTitle: `${engine === 'duckduckgo' ? 'DuckDuckGo' : 'Google Search'}: ${queryText}`,
      summaryProvider: engine === 'duckduckgo' ? 'DuckDuckGo' : 'Google Search',
      summarySourceType: needsTimelySources ? 'news' : 'search',
      summaryCredibility: needsTimelySources ? 'major-news' : 'search',
      scrapeProvider: engine === 'duckduckgo' ? 'DuckDuckGo' : 'Google Search',
      scrapeSourceType: searchFallbackSourceType,
      scrapeCredibility: searchFallbackCredibility,
      maxPages,
    }).catch(() => []);
  };

  for (let index = 0; index < engineQueries.length; index += 1) {
    if (nowMs() >= deadline) break;
    const queryText = engineQueries[index];
    const pageCount = index === 0 ? primaryResultPageCount : secondaryResultPageCount;
    const maxPages = index === 0 ? primarySearchPageLimit : secondarySearchPageLimit;

    const ddgContexts = await collectFromEngine('duckduckgo', queryText, pageCount, maxPages);
    results.push(...ddgContexts);
    if (buildNonSearchSourcePool(results, analysis).length >= Math.max(minimumRequired, desiredSourceCount)) {
      break;
    }

    if (nowMs() >= deadline) break;
    const googleContexts = await collectFromEngine('google', queryText, pageCount, maxPages);
    results.push(...googleContexts);
    if (buildNonSearchSourcePool(results, analysis).length >= Math.max(minimumRequired, desiredSourceCount)) {
      break;
    }
  }
  if (analysis.prefersCommunitySources) {
    const redditContext = await redditSearch(primarySearchQuery);
    if (!redditContext.error && redditContext.text.trim().length >= 24) {
      results.push(redditContext);
    }
    if (analysis.sourceProfile === 'technical') {
      const hnContext = await hackerNewsSearch(primarySearchQuery);
      if (!hnContext.error && hnContext.text.trim().length >= 24) {
        results.push(hnContext);
      }
    }
  }
  let selected = ensureMinimumSourceCount(
    selectBestContexts(results, analysis, options),
    results,
    analysis,
    options,
  );
  if (selected.length && (minimumRequired <= 0 || selected.length >= minimumRequired)) {
    return selected;
  }

  let recoveredResults: FetchedContext[] = [];
  if (minimumRequired > 0) {
    const recoveryResults = await recoverMinimumContexts(analysis, queryVariants, exactSearchQueries, options);
    recoveredResults = recoveryResults;
    if (recoveryResults.length) {
      selected = ensureMinimumSourceCount(
        selectBestContexts([...results, ...recoveryResults], analysis, options),
        [...results, ...recoveryResults],
        analysis,
        options,
      );
      if (selected.length >= minimumRequired) {
        return selected;
      }
    }
  }

  const fallbackDirectSources = buildNonSearchSourcePool([...results, ...recoveredResults], analysis)
    .slice(0, Math.max(Math.max(minimumRequired, 2), Math.min(desiredSourceCount, isDeep ? 10 : 6)));
  if (fallbackDirectSources.length && (minimumRequired <= 0 || fallbackDirectSources.length >= minimumRequired)) {
    return fallbackDirectSources;
  }

  const fallbackSearchPages = results
    .filter((context) => !context.error && context.text.trim().length >= 40)
    .filter((context) => !isSearchSummaryContext(context))
    .filter((context, index, array) => array.findIndex((entry) => entry.url === context.url) === index)
    .slice(0, Math.max(2, Math.min(desiredSourceCount, isDeep ? 10 : 6)));

  if (fallbackSearchPages.length) {
    return fallbackSearchPages;
  }

  return [];
}

function describeContext(context: FetchedContext, options: ContextFormattingOptions = {}): string {
  const metadata = [
    context.provider ? `Provider: ${context.provider}` : '',
    context.sourceType ? `Type: ${context.sourceType}` : '',
    context.credibility ? `Credibility: ${context.credibility}` : '',
    context.publishedAt ? `Published: ${context.publishedAt}` : '',
  ].filter(Boolean).join(' | ');
  return [
    `### ${trimContextText(context.title, 140)}`,
    metadata,
    trimContextText(context.text, resolveSystemExcerptLimit(options)),
  ].filter(Boolean).join('\n');
}

export function urlContextToSystemInject(contexts: FetchedContext[]): string {
  if (!contexts.length) return '';
  const blocks = contexts.map((context) => context.error || !context.text.trim()
    ? `[URL: ${context.url}]\nFetch failed (${context.error ?? 'empty'}). Tell the user this link could not be loaded instead of guessing its contents.`
    : `[Source: ${context.title}]\n[URL: ${context.url}]\n${trimContextText(context.text, 1600)}`);
  return ['', '---', '## Fetched URL Content', 'The user included direct links. Treat the content below as explicitly supplied source material.', '', blocks.join('\n\n---\n\n'), '---'].join('\n');
}

export function globalContextToSystemInject(
  contexts: FetchedContext[],
  options: ContextFormattingOptions = {},
): string {
  if (!contexts.length) return '';
  const exactDate = new Date().toISOString();
  const referenceDateLabel = formatReferenceDate(exactDate);
  const systemContextLimit = resolveSystemContextLimit(options);
  const sortedContexts = sortContextsForPrompt(contexts).slice(0, systemContextLimit);
  return [
    '',
    '---',
    `## Live External Research (fetched ${exactDate})`,
    '',
    'The following context was gathered live from public sources for this exact prompt.',
    'Use it as the primary grounding layer for time-sensitive answers.',
    '',
    'Rules:',
    '- Prefer official government, agency, and public-institution sources first for plans, schedules, policy, safety, and status claims.',
    '- Prefer major news reporting next for fast-moving events, timelines, and developments.',
    '- Treat search summaries and reference material as orientation, not final proof for current or future claims.',
    '- Treat directory pages, agency indexes, and site indexes as discovery aids, not as evidence for mission status, timelines, crew, or outcomes.',
    '- Community or forum material is secondary context only and must never be the sole basis for factual claims.',
    '- Only make precise status, crew, launch, landing, return, or schedule claims that are explicitly supported by the fetched evidence below.',
    '- When answering name, crew, roster, pilot, commander, or role questions, list only the names and roles explicitly shown in the fetched sources.',
    '- Do not infer a full mission schedule or exact event outcome from a partial excerpt, a search result snippet, or a general mission overview page.',
    '- For numbered missions or flights, never transfer crew, landing goals, launch outcomes, or milestone dates from a different mission number or from a different historical program.',
    '- If the user did not ask for crew names or roles, do not volunteer a crew roster unless it is essential to answer the actual question.',
    '- If the evidence only partially confirms the situation, state what the sources clearly confirm and call the rest unclear or unverified.',
    '- For current-status answers, prefer the freshest corroborated sources by actual publish date, not just sources that mention the same year.',
    `- For current, future, or ${RECENT_YEAR_FLOOR}-now questions, treat older dates as potentially stale and call that out clearly.`,
    '- Use exact dates whenever the sources provide them.',
    '- If sources disagree, say so and favor the newest corroborated official or major-news evidence.',
    '- Never claim a training-data cutoff prevents answering when live evidence is present below.',
    `- Anchor all timeline language to the fetch date ${referenceDateLabel}.`,
    '- If an event date is earlier than the fetch date, describe it as past, completed, launched, announced, or occurred. Never describe it as upcoming.',
    '- If a source only says an event was delayed, rescheduled, or scheduled to a date or month that has already arrived by the fetch date, treat that as earlier planning coverage unless the source also reports what actually happened after that date.',
    '- Avoid relative time phrases like "in four days" unless they are explicitly recomputed from the fetch date and still true.',
    '- If the evidence includes both older schedule coverage and newer status updates, describe the older material as earlier reporting or an earlier plan instead of presenting both as current.',
    '- When giving a timeline, present it in chronological order, keep the current status separate from older background milestones, and resolve contradictions plainly.',
    '- The source list below is already ordered strongest-first. Keep the strongest source or sources central in the answer.',
    '',
    sortedContexts.map((context) => describeContext(context, options)).join('\n\n'),
    '',
    '---',
  ].join('\n');
}

export function globalContextToConversationInject(
  contexts: FetchedContext[],
  userMessage: string,
  options: ContextFormattingOptions = {},
): Array<{ role: 'assistant'; content: string }> {
  if (!contexts.length) return [];
  const fetchedAt = new Date().toISOString();
  const referenceDateLabel = formatReferenceDate(fetchedAt);
  const hasSearchProbeOnly = contexts.every((context) =>
    /\b(snapshot|probe)\b/i.test(context.title) ||
    context.text.toLowerCase().includes('live search probe was issued'),
  );
  const conversationContextLimit = resolveSystemContextLimit(options);
  const conversationExcerptLimit = resolveConversationExcerptLimit(options);
  const strongest = sortContextsForPrompt(contexts).slice(0, conversationContextLimit).map((context) => {
    const metadata = [
      context.provider ? `provider=${context.provider}` : '',
      context.credibility ? `credibility=${context.credibility}` : '',
      context.publishedAt ? `published=${context.publishedAt}` : '',
    ].filter(Boolean).join(', ');
    return `- ${trimContextText(context.title, 120)}${metadata ? ` (${metadata})` : ''}: ${trimContextText(context.text, conversationExcerptLimit)}`;
  }).join('\n');
  return [{
    role: 'assistant',
    content: [
      `I reviewed live external sources before responding (fetched ${fetchedAt}).`,
      'I already have usable current research in hand and must answer from it directly.',
      'I must not say that I lack real-time access, and I must not deflect to outside search when the evidence below is enough to provide insight.',
      'I should prefer the newest corroborated official and major-news evidence over forum discussion.',
      'I must treat directory pages, agency indexes, and site indexes as discovery aids, not as evidence for mission status, timelines, crew, or outcomes.',
      'I must only make precise current-status, crew, launch, landing, return, or schedule claims that the retrieved evidence explicitly supports.',
      'If the user asks for people, crew, pilot, commander, or names, I must list only names and roles explicitly present in the retrieved sources.',
      'I must not invent exact dates or a full mission timeline from a partial excerpt, a search result snippet, or a general overview page.',
      'For numbered missions or flights, I must not transfer crew names, landing goals, launch outcomes, or milestone dates from a different mission number or from a different historical program.',
      'If the user did not ask for crew names or roles, I should not volunteer a crew roster unless it is necessary to answer the actual question.',
      'If the sources only partially confirm the situation, I should clearly separate what is confirmed from what remains unclear.',
      'For current-status answers, I should anchor my answer to the freshest corroborated sources by actual publish date, not just any source that mentions the current year.',
      'I should attribute the main status claim to the strongest source or sources by name.',
      `I must anchor all timeline language to ${referenceDateLabel}. If a cited date is already before that date, I must describe it as past or completed, not upcoming.`,
      'If a source only says an event was delayed, rescheduled, or scheduled to a date or month that has already arrived by the reference date, I must treat that as earlier planning coverage unless the source also states what actually happened after that point.',
      'I must keep chronology consistent, avoid stale relative countdowns, and treat older schedule coverage as earlier reporting when newer status exists.',
      'If newer evidence conflicts with an older schedule or plan, I must explain the conflict directly instead of blending both claims into one unclear timeline.',
      'For time-sensitive factual answers, I should format the reply cleanly with short sections for Current status, What already happened, and What comes next when that structure fits the question.',
      ...(hasSearchProbeOnly
        ? [
            'If the retrieved evidence is mostly search-engine snapshots or search probes, I must state that article extraction was partial, not that real-time access is unavailable.',
            'I should still use the live search evidence to describe what is currently being reported and what remains to be verified.',
          ]
        : []),
      '',
      strongest,
      '',
      `I will now directly answer the user using that research: "${trimContextText(userMessage, 160)}"`,
    ].join('\n'),
  }];
}

export function contextsToSystemInject(contexts: FetchedContext[]): string {
  return urlContextToSystemInject(contexts);
}
