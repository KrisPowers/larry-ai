/**
 * fetcher.ts — URL scraper and global data source helper.
 *
 * Bridges the gap between Ollama's static training data and the real world by
 * fetching live content and injecting it into the model's system prompt.
 *
 * Two types of injection:
 *   1. URL context  — explicit URLs the user pasted into their message
 *   2. Global context — proactively fetched from public APIs based on the query
 *
 * The two types produce separate prompt blocks so the model knows the
 * difference between "a page the user linked" and "live world knowledge."
 */

export interface FetchedContext {
  url: string;
  title: string;
  text: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL extraction
// ─────────────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const cleaned = matches.map(u => u.replace(/[.,;:!?)>\]]+$/, ''));
  return [...new Set(cleaned)];
}

export async function fetchUrlsFromPrompt(promptText: string): Promise<FetchedContext[]> {
  const urls = extractUrlsFromText(promptText);
  if (!urls.length) return [];
  return Promise.all(urls.map(fetchUrl));
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS proxy — only used for HTML pages that don't allow cross-origin requests.
// APIs with `origin=*` or that return JSON are fetched directly.
// ─────────────────────────────────────────────────────────────────────────────

const PROXY = 'https://api.allorigins.win/get?url=';
const MAX_TEXT = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// HTML → plain text
// ─────────────────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
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
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim().slice(0, 120) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core URL fetch (proxied — for user-pasted links)
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchUrl(rawUrl: string): Promise<FetchedContext> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const res = await fetch(PROXY + encodeURIComponent(url), {
      signal: AbortSignal.timeout(14_000),
    });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);

    const wrapper = await res.json() as { contents?: string };
    const body = wrapper.contents ?? '';
    if (!body) throw new Error('Empty proxy response');

    let text: string;
    let title: string;
    if (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
      try {
        const parsed = JSON.parse(body);
        text  = JSON.stringify(parsed, null, 2).slice(0, MAX_TEXT);
        title = url;
      } catch {
        text  = htmlToText(body);
        title = extractTitle(body) || url;
      }
    } else {
      text  = htmlToText(body);
      title = extractTitle(body) || url;
    }

    return { url, title, text };
  } catch (err) {
    return { url, title: url, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct JSON fetch — for APIs that allow cross-origin requests natively.
// Avoids the proxy entirely; faster and more reliable.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJsonDirect<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual source fetchers
// ─────────────────────────────────────────────────────────────────────────────

/** DuckDuckGo Instant Answer — CORS-safe, direct fetch */
async function duckduckgoInstant(query: string): Promise<FetchedContext> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url);

    const parts: string[] = [];

    const abstract = String(data.AbstractText ?? '').trim();
    if (abstract) parts.push(abstract);

    const answer = String(data.Answer ?? '').trim();
    if (answer) parts.push(`Answer: ${answer}`);

    const definition = String(data.Definition ?? '').trim();
    if (definition) parts.push(`Definition: ${definition}`);

    // Related topics — sometimes the only content for recent events
    if (Array.isArray(data.RelatedTopics)) {
      const topics = (data.RelatedTopics as Array<{ Text?: string; Topics?: Array<{ Text?: string }> }>)
        .flatMap(t => t.Topics ? t.Topics : [t])
        .slice(0, 8)
        .map(t => t.Text?.trim())
        .filter(Boolean);
      if (topics.length) parts.push('Related:\n' + topics.join('\n'));
    }

    const infobox = data.Infobox as Record<string, unknown> | undefined;
    if (infobox?.content && Array.isArray(infobox.content)) {
      const rows = (infobox.content as Array<{ label?: string; value?: string }>)
        .slice(0, 10)
        .map(r => r.label && r.value ? `${r.label}: ${r.value}` : '')
        .filter(Boolean);
      if (rows.length) parts.push('Info:\n' + rows.join('\n'));
    }

    const text = parts.join('\n\n').slice(0, MAX_TEXT);
    return { url, title: `DuckDuckGo: ${query}`, text };
  } catch (err) {
    return { url, title: `DuckDuckGo: ${query}`, text: '', error: String(err) };
  }
}

/** Wikipedia REST summary — CORS-safe via origin=* param */
async function wikipediaSummary(title: string): Promise<FetchedContext> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url);
    const text = String(data.extract ?? '').slice(0, MAX_TEXT);
    const pageTitle = String(data.title ?? title);
    if (!text) throw new Error('No extract');
    return { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`, title: `Wikipedia: ${pageTitle}`, text };
  } catch (err) {
    return { url, title: `Wikipedia: ${title}`, text: '', error: String(err) };
  }
}

/** Wikipedia search then summary — finds the best article for any query */
async function wikipediaSearch(query: string): Promise<FetchedContext> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(searchUrl);
    const results = (data.query as Record<string, unknown>)?.search as Array<{ title: string; snippet?: string }> | undefined;
    if (!results?.length) throw new Error('No results');

    // Try the top result; if it returns nothing substantial, try the next
    for (const result of results.slice(0, 2)) {
      const ctx = await wikipediaSummary(result.title);
      if (!ctx.error && ctx.text.length > 100) return ctx;
    }
    throw new Error('No usable results');
  } catch (err) {
    return { url: '', title: `Wikipedia: ${query}`, text: '', error: String(err) };
  }
}

/**
 * Wikipedia Current Events portal — scrapes the live portal page.
 * This page is updated daily by editors with current world events.
 * Uses proxy because it's HTML.
 */
async function wikimediaCurrentEvents(): Promise<FetchedContext> {
  const url = 'https://en.wikipedia.org/wiki/Portal:Current_events';
  try {
    const res = await fetch(PROXY + encodeURIComponent(url), {
      signal: AbortSignal.timeout(14_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = await res.json() as { contents?: string };
    const html = wrapper.contents ?? '';
    if (!html) throw new Error('Empty');

    // Extract just the main content area — strip sidebar, categories etc.
    const mainMatch = html.match(/<div[^>]+id="mw-content-text"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    const relevant = mainMatch ? mainMatch[1] : html;
    const text = htmlToText(relevant).slice(0, 5000);

    return { url, title: 'Wikipedia: Current Events Portal', text };
  } catch (err) {
    return { url, title: 'Wikipedia: Current Events Portal', text: '', error: String(err) };
  }
}

/**
 * Reddit — top posts this week for the query.
 * Uses the JSON API which returns CORS headers.
 */
async function redditSearch(query: string): Promise<FetchedContext> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&t=week&limit=8&type=link`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url);
    const posts = (data.data as Record<string, unknown>)?.children as Array<{
      data: { title: string; selftext?: string; subreddit?: string; score?: number; url?: string }
    }> | undefined;
    if (!posts?.length) throw new Error('No posts');

    const text = posts
      .filter(p => p.data.title)
      .map(p => {
        const d = p.data;
        const sub = d.subreddit ? ` (r/${d.subreddit})` : '';
        const snippet = d.selftext && d.selftext.length > 20 ? `\n  ${d.selftext.slice(0, 250)}` : '';
        return `• ${d.title}${sub}${snippet}`;
      })
      .join('\n\n')
      .slice(0, MAX_TEXT);

    return { url, title: `Reddit: ${query}`, text };
  } catch (err) {
    return { url, title: `Reddit: ${query}`, text: '', error: String(err) };
  }
}

/**
 * Hacker News — top stories matching the query via Algolia API.
 * Full CORS support, no proxy needed.
 */
async function hackerNewsSearch(query: string): Promise<FetchedContext> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(url);
    const hits = data.hits as Array<{ title?: string; story_text?: string; url?: string; points?: number }> | undefined;
    if (!hits?.length) throw new Error('No hits');

    const text = hits
      .filter(h => h.title)
      .map(h => {
        const snippet = h.story_text ? `\n  ${h.story_text.slice(0, 200)}` : '';
        return `• ${h.title}${snippet}`;
      })
      .join('\n\n')
      .slice(0, MAX_TEXT);

    return { url, title: `Hacker News: ${query}`, text };
  } catch (err) {
    return { url, title: `Hacker News: ${query}`, text: '', error: String(err) };
  }
}

/**
 * OpenStreetMap Nominatim + Wikidata via Wikipedia API — for geo/country queries.
 * Fetches structured facts about a country/place.
 */
async function wikidataCountryFacts(country: string): Promise<FetchedContext> {
  // Use Wikipedia's opensearch to find the Wikidata entity, then get facts
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&titles=${encodeURIComponent(country)}&format=json&origin=*&exsentences=8`;
  try {
    const data = await fetchJsonDirect<Record<string, unknown>>(searchUrl);
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, { title?: string; extract?: string }> | undefined;
    if (!pages) throw new Error('No pages');
    const page = Object.values(pages)[0];
    const extract = page?.extract ?? '';
    const text = htmlToText(extract).slice(0, MAX_TEXT);
    if (text.length < 50) throw new Error('Too short');
    return { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(country)}`, title: `Wikipedia full extract: ${country}`, text };
  } catch (err) {
    return { url: '', title: `Wikipedia facts: ${country}`, text: '', error: String(err) };
  }
}

/**
 * Reuters RSS via allorigins — free news feed, no key required.
 * Parses RSS XML to extract recent headlines and descriptions.
 */
async function reutersRSS(query: string): Promise<FetchedContext> {
  // Reuters topic feeds - try world news which covers geopolitical topics
  const feedUrl = 'https://feeds.reuters.com/reuters/worldNews';
  const url = `https://feeds.reuters.com/reuters/topNews`;
  try {
    const res = await fetch(PROXY + encodeURIComponent(url), {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = await res.json() as { contents?: string };
    const xml = wrapper.contents ?? '';
    if (!xml) throw new Error('Empty');

    // Parse RSS items
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    const q = query.toLowerCase();

    const items = itemMatches
      .slice(0, 30)
      .map(item => {
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const title = titleMatch?.[1]?.trim() ?? '';
        const desc = descMatch?.[1]?.trim() ?? '';
        return { title, desc, relevance: (title.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) ? 2 : 1 };
      })
      .filter(i => i.title)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);

    if (!items.length) throw new Error('No items');

    const text = items.map(i => `• ${i.title}${i.desc ? `\n  ${htmlToText(i.desc).slice(0, 200)}` : ''}`).join('\n\n').slice(0, MAX_TEXT);
    return { url, title: 'Reuters: Top News', text };
  } catch (err) {
    return { url, title: 'Reuters News', text: '', error: String(err) };
  }
}

/**
 * BBC News RSS — another major international news source.
 */
async function bbcNewsRSS(query: string): Promise<FetchedContext> {
  const url = 'https://feeds.bbci.co.uk/news/world/rss.xml';
  try {
    const res = await fetch(PROXY + encodeURIComponent(url), {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = await res.json() as { contents?: string };
    const xml = wrapper.contents ?? '';
    if (!xml) throw new Error('Empty');

    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    const q = query.toLowerCase();

    const items = itemMatches
      .slice(0, 30)
      .map(item => {
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const descMatch  = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const title = titleMatch?.[1]?.trim() ?? '';
        const desc  = descMatch?.[1]?.trim() ?? '';
        return { title, desc, relevance: (title.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) ? 2 : 1 };
      })
      .filter(i => i.title)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);

    if (!items.length) throw new Error('No items');

    const text = items.map(i => `• ${i.title}${i.desc ? `\n  ${htmlToText(i.desc).slice(0, 200)}` : ''}`).join('\n\n').slice(0, MAX_TEXT);
    return { url, title: 'BBC World News', text };
  } catch (err) {
    return { url, title: 'BBC World News', text: '', error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the core search topic from a conversational message.
 * Strips filler phrases like "what is currently going on in" to get "Iran".
 */
/** Named entity patterns — countries, regions, organisations */
const COUNTRY_RE = /\b(iran|ukraine|russia|china|israel|gaza|taiwan|north korea|south korea|syria|sudan|myanmar|venezuela|belarus|cuba|turkey|egypt|saudi arabia|iraq|libya|nigeria|ethiopia|haiti|somalia|mali|niger|pakistan|india|bangladesh|sri lanka|afghanistan|yemen|lebanon|jordan|nato|un|g7|g20|eu|european union)\b/gi;

/** Keywords that signal the user wants current/live information */
const LIVE_QUERY_RE = /\b(current|currently|latest|recent|now|today|this week|last week|this month|happening|news|going on|situation|crisis|war|election|protest|conflict|attack|unrest|invasion|sanctions|ceasefire|negotiations|deal|agreement|summit|statement|announced|officials|government|military|troops|killed|arrested|detained|when is|when are|where is|schedule|date|event|match|fight|game|score|result|winner|who won|upcoming)\b/i;

/**
 * Build the combined search context from both the current message AND
 * recent conversation history. This handles follow-up questions like
 * "what is the US involvement?" where the topic (Iran) is in a prior message.
 *
 * Key principle: keep the search term as close to the user's words as possible.
 * Only strip pure filler words, never topic words.
 */
function buildSearchContext(
  currentMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
): {
  primaryTerm: string;   // clean version of current message — primary search
  contextTerm: string;   // history-enriched term for follow-up queries
  isLive: boolean;       // needs live/current sources
  countries: string[];
} {
  // Combine last 6 messages for topic continuity
  const recentHistory = conversationHistory
    .slice(-6)
    .map(m => m.content)
    .join(' ');
  const combined = `${recentHistory} ${currentMessage}`;

  // Extract country/entity names from full context
  const countryMatches = [...combined.matchAll(COUNTRY_RE)].map(m => m[0].toLowerCase());
  const countries = [...new Set(countryMatches)];

  const isLive = LIVE_QUERY_RE.test(combined);

  // Primary term: strip ONLY pure conversational filler, preserve topic words
  const primaryTerm = currentMessage
    .replace(/^(what'?s|what is|what are|tell me|can you tell me|do you know|i want to know|could you)\b/gi, '')
    .replace(/\?+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  // Context term: if the current message is short/vague, enrich with history topics
  const isShortFollowUp = primaryTerm.split(' ').length <= 4 && (countries.length > 0 || recentHistory.length > 20);
  const contextTerm = isShortFollowUp
    ? `${countries.slice(0, 2).join(' ')} ${primaryTerm}`.trim().slice(0, 100)
    : primaryTerm;

  return { primaryTerm, contextTerm, isLive, countries };
}

/**
 * DuckDuckGo HTML search — scrapes actual web search results.
 * Unlike the Instant Answer API, this returns real search snippets for any
 * query including sports, events, schedules, and anything else.
 * Uses allorigins proxy since DuckDuckGo blocks direct browser requests.
 */
async function duckduckgoSearch(query: string): Promise<FetchedContext> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(PROXY + encodeURIComponent(url), {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = await res.json() as { contents?: string };
    const html = wrapper.contents ?? '';
    if (!html) throw new Error('Empty');

    // Extract search result snippets from DDG HTML
    // DDG result structure: <div class="result__body"> with <a class="result__snippet">
    const snippetMatches = html.matchAll(
      /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    );
    const titleMatches = html.matchAll(
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    );

    const titles = [...titleMatches].map(m => htmlToText(m[1]).trim()).filter(Boolean).slice(0, 8);
    const snippets = [...snippetMatches].map(m => htmlToText(m[1]).trim()).filter(Boolean).slice(0, 8);

    if (!snippets.length && !titles.length) throw new Error('No results parsed');

    const text = titles
      .map((title, i) => `• ${title}${snippets[i] ? `\n  ${snippets[i]}` : ''}`)
      .join('\n\n')
      .slice(0, MAX_TEXT);

    return { url, title: `DuckDuckGo Search: ${query}`, text };
  } catch (err) {
    return { url, title: `DuckDuckGo Search: ${query}`, text: '', error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main global context entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch live context from multiple public sources for the user's message.
 *
 * The strategy adapts to the query type:
 * - ALL queries: DuckDuckGo web search (real snippets) + DDG Instant Answer + Wikipedia
 * - Live/current queries: also BBC RSS, Reuters RSS, Reddit, HN, Wikipedia Current Events
 * - Country-specific: also Wikipedia full extract per country
 * - Follow-up questions: enriched with topics from conversation history
 */
export async function fetchGlobalContext(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
): Promise<FetchedContext[]> {

  const { primaryTerm, contextTerm, isLive, countries } = buildSearchContext(userMessage, conversationHistory);

  if (!primaryTerm && !contextTerm) return [];

  // Always: real web search (most broadly useful) + DDG Instant + Wikipedia
  const always = [
    duckduckgoSearch(primaryTerm),
    duckduckgoInstant(primaryTerm),
    wikipediaSearch(contextTerm),
  ];

  // If contextTerm differs from primaryTerm (follow-up), also search it directly
  const followUpSearch = contextTerm !== primaryTerm
    ? [duckduckgoSearch(contextTerm)]
    : [];

  // News/live sources
  const news = isLive ? [
    bbcNewsRSS(contextTerm),
    reutersRSS(contextTerm),
    wikimediaCurrentEvents(),
    redditSearch(contextTerm),
    hackerNewsSearch(primaryTerm),
  ] : [];

  // Per-country deep extract
  const geo = countries.slice(0, 2).map(c => wikidataCountryFacts(c));

  const allSettled = await Promise.allSettled([
    ...always,
    ...followUpSearch,
    ...news,
    ...geo,
  ]);

  return allSettled
    .filter((r): r is PromiseFulfilledResult<FetchedContext> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(c => !c.error && c.text.trim().length > 60)
    .filter((c, i, arr) => arr.findIndex(x => x.title === c.title) === i);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt injection builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format user-pasted URL fetches into a prompt block.
 * The model is told these are pages the user explicitly linked.
 */
export function urlContextToSystemInject(contexts: FetchedContext[]): string {
  if (!contexts.length) return '';

  const blocks = contexts.map(c => {
    if (c.error || !c.text.trim()) {
      return `[URL: ${c.url}]\nFetch failed (${c.error ?? 'empty'}). Tell the user this link could not be loaded rather than guessing its contents.`;
    }
    return `[Source: ${c.title}]\n[URL: ${c.url}]\n${c.text.slice(0, 3000)}`;
  });

  return (
    `\n\n---\n## Fetched URL Content\n` +
    `The user included links in their message. The content of those pages has been fetched and is provided below. ` +
    `Use it as factual context for your answer.\n\n` +
    blocks.join('\n\n---\n\n') +
    `\n---\n`
  );
}

/**
 * Format live global knowledge into a system prompt block.
 */
export function globalContextToSystemInject(contexts: FetchedContext[]): string {
  if (!contexts.length) return '';

  const timestamp = new Date().toUTCString();
  const blocks = contexts.map(c =>
    `### ${c.title}\n${c.text.slice(0, 2500)}`
  );

  return (
    `\n\n---\n## Live Web Search Results & World Knowledge (fetched ${timestamp})\n\n` +
    `CRITICAL INSTRUCTION: The information below was fetched live from public sources ` +
    `(DuckDuckGo web search, Wikipedia, BBC, Reuters, Reddit) at ${timestamp}. ` +
    `It includes real search results fetched specifically for the user's question.\n\n` +
    `YOU MUST:\n` +
    `- Answer based on these search results. They were fetched for THIS question.\n` +
    `- NEVER say "I don't have access to real-time information" — search results are above.\n` +
    `- NEVER say your knowledge cutoff prevents you — the live results above cover it.\n` +
    `- If results directly answer the question, state that answer clearly and confidently.\n` +
    `- If results are partial, use what's there and note what couldn't be confirmed.\n` +
    `- Cite sources naturally (e.g. "DuckDuckGo search results show..." or "BBC reports...").\n\n` +
    blocks.join('\n\n') +
    `\n\n---\n`
  );
}

/**
 * Build a synthetic assistant-prefill message that presents the fetched context
 * as research the assistant already did. Injected as an assistant turn in the
 * conversation so even small models that deprioritise system prompts see it.
 *
 * Web search results (DuckDuckGo) are listed first since they're most specific.
 */
export function globalContextToConversationInject(
  contexts: FetchedContext[],
  userMessage: string,
): Array<{ role: string; content: string }> {
  if (!contexts.length) return [];

  const timestamp = new Date().toUTCString();

  // Prioritise: web search results first, then encyclopedic, then news feeds
  const sorted = [
    ...contexts.filter(c => c.title.startsWith('DuckDuckGo Search')),
    ...contexts.filter(c => c.title.startsWith('Wikipedia') || c.title.startsWith('DuckDuckGo:')),
    ...contexts.filter(c => c.title.startsWith('BBC') || c.title.startsWith('Reuters')),
    ...contexts.filter(c => !c.title.startsWith('DuckDuckGo') && !c.title.startsWith('Wikipedia') && !c.title.startsWith('BBC') && !c.title.startsWith('Reuters')),
  ].slice(0, 6);

  const summaries = sorted
    .map(c => `**${c.title}**\n${c.text.slice(0, 1200)}`)
    .join('\n\n---\n\n');

  const prefill = (
    `I searched for information about this before responding. Here is what I found from live sources (fetched ${timestamp}):\n\n` +
    summaries +
    `\n\n---\n\nUsing the above search results, I will now directly answer: "${userMessage.slice(0, 120)}"`
  );

  return [{ role: 'assistant', content: prefill }];
}

/**
 * Legacy combined inject — kept for backward compat with code preset path.
 * Prefer urlContextToSystemInject + globalContextToSystemInject separately.
 */
export function contextsToSystemInject(contexts: FetchedContext[]): string {
  return urlContextToSystemInject(contexts);
}
