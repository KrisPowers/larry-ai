import { isDesktopRuntime } from './persistence';

export interface LocalSearchSeed {
  id: string;
  url: string;
  label: string;
  host: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalSearchCrawlSummary {
  startedAt: number;
  completedAt: number;
  seedCount: number;
  scheduledCount: number;
  crawledCount: number;
  indexedCount: number;
  discoveredCount: number;
  skippedCount: number;
  errorCount: number;
  lastError?: string;
}

export interface LocalSearchEngineStatus {
  databasePath: string;
  seedCount: number;
  documentCount: number;
  lastIndexedAt: number;
  lastCrawl?: LocalSearchCrawlSummary;
  defaultMaxPages: number;
  defaultMaxDepth: number;
  fetchConcurrency: number;
}

export interface LocalSearchResult {
  url: string;
  title: string;
  snippet: string;
  content: string;
  host: string;
  source: string;
  lastCrawledAt: number;
  score: number;
}

export interface LocalSearchResponse {
  query: string;
  tookMs: number;
  total: number;
  results: LocalSearchResult[];
}

export interface LocalSearchIndexDocument {
  url: string;
  title: string;
  snippet: string;
  content: string;
  source: string;
  lastCrawledAt?: number;
}

export interface LocalSearchIndexSummary {
  received: number;
  indexed: number;
  skipped: number;
  completedAt: number;
}

interface SearchEngineBridge {
  GetSearchEngineStatus(): Promise<LocalSearchEngineStatus>;
  ListSearchEngineSeeds(): Promise<LocalSearchSeed[]>;
  AddSearchEngineSeed(url: string, label: string): Promise<LocalSearchSeed>;
  DeleteSearchEngineSeed(id: string): Promise<void>;
  CrawlSearchEngine(request: { maxPages: number; maxDepth: number }): Promise<LocalSearchCrawlSummary>;
  SearchLocalIndex(query: string, limit: number): Promise<LocalSearchResponse>;
  IndexSearchDocuments(documents: LocalSearchIndexDocument[]): Promise<LocalSearchIndexSummary>;
}

function getBridge(): SearchEngineBridge | null {
  if (!isDesktopRuntime() || typeof window === 'undefined') return null;
  const app = window.go?.main?.App as Partial<SearchEngineBridge> | undefined;
  if (!app) return null;

  const requiredMethods: Array<keyof SearchEngineBridge> = [
    'GetSearchEngineStatus',
    'ListSearchEngineSeeds',
    'AddSearchEngineSeed',
    'DeleteSearchEngineSeed',
    'CrawlSearchEngine',
    'SearchLocalIndex',
    'IndexSearchDocuments',
  ];

  return requiredMethods.every((method) => typeof app[method] === 'function')
    ? app as SearchEngineBridge
    : null;
}

export function isLocalSearchEngineAvailable(): boolean {
  return Boolean(getBridge());
}

export async function getSearchEngineStatus(): Promise<LocalSearchEngineStatus | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.GetSearchEngineStatus();
}

export async function listSearchEngineSeeds(): Promise<LocalSearchSeed[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  return bridge.ListSearchEngineSeeds();
}

export async function addSearchEngineSeed(url: string, label: string): Promise<LocalSearchSeed> {
  const bridge = getBridge();
  if (!bridge) throw new Error('Local search engine is unavailable in this runtime.');
  return bridge.AddSearchEngineSeed(url, label);
}

export async function deleteSearchEngineSeed(id: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.DeleteSearchEngineSeed(id);
}

export async function crawlSearchEngine(request: { maxPages: number; maxDepth: number }): Promise<LocalSearchCrawlSummary | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.CrawlSearchEngine(request);
}

export async function searchLocalIndex(query: string, limit = 8): Promise<LocalSearchResponse> {
  const bridge = getBridge();
  if (!bridge) {
    return {
      query,
      tookMs: 0,
      total: 0,
      results: [],
    };
  }

  return bridge.SearchLocalIndex(query, limit);
}

export async function indexSearchDocuments(documents: LocalSearchIndexDocument[]): Promise<LocalSearchIndexSummary> {
  const bridge = getBridge();
  if (!bridge || documents.length === 0) {
    return {
      received: documents.length,
      indexed: 0,
      skipped: documents.length,
      completedAt: Date.now(),
    };
  }

  return bridge.IndexSearchDocuments(documents);
}
