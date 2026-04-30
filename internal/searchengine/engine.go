package searchengine

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	driverName                = "sqlite"
	defaultAppDirName         = "LarryAI"
	defaultDatabaseName       = "larry-search.sqlite"
	defaultMaxPagesPerCrawl   = 25_000
	hardMaxPagesPerCrawl      = 100_000
	defaultMaxCrawlDepth      = 3
	hardMaxCrawlDepth         = 6
	defaultFetchConcurrency   = 12
	maxSearchResults          = 5_000
	maxHTMLBytes              = 4 << 20
	maxRobotsBytes            = 1 << 20
	maxSitemapBytes           = 8 << 20
	maxNestedSitemaps         = 256
	crawlIndexBatchSize       = 64
	httpTimeout               = 18 * time.Second
	defaultDocumentSource     = "local-crawl"
	lastCrawlMetaKey          = "last_crawl_summary"
	defaultSeedRequestAgent   = "LarryAI-LocalSearch/1.0"
	defaultDocumentSnippetLen = 320
)

var (
	ftsTokenPattern = regexp.MustCompile(`[[:alnum:]]{2,}`)
)

type Engine struct {
	db     *sql.DB
	path   string
	client *http.Client
}

type crawlTask struct {
	url      string
	depth    int
	seedHost string
}

type crawlDocument struct {
	URL           string
	Title         string
	Snippet       string
	Content       string
	Host          string
	Source        string
	CrawlDepth    int
	HTTPStatus    int
	DiscoveredAt  int64
	LastCrawledAt int64
}

type fetchedPage struct {
	FinalURL   string
	Title      string
	Snippet    string
	Content    string
	Links      []string
	StatusCode int
}

type crawlState struct {
	mu       sync.Mutex
	cond     *sync.Cond
	queue    []crawlTask
	seen     map[string]struct{}
	active   int
	closed   bool
	maxPages int
	summary  CrawlSummary
}

func newCrawlState(maxPages int, summary CrawlSummary) *crawlState {
	state := &crawlState{
		queue:    make([]crawlTask, 0, minInt(maxPages, 256)),
		seen:     make(map[string]struct{}, minInt(maxPages, 1024)),
		maxPages: maxPages,
		summary:  summary,
	}
	state.cond = sync.NewCond(&state.mu)
	return state
}

func (s *crawlState) enqueue(task crawlTask, discovered bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return false
	}

	if _, exists := s.seen[task.url]; exists {
		s.summary.SkippedCount++
		return false
	}

	if s.summary.ScheduledCount >= s.maxPages {
		s.summary.SkippedCount++
		return false
	}

	s.seen[task.url] = struct{}{}
	s.queue = append(s.queue, task)
	s.summary.ScheduledCount++
	if discovered {
		s.summary.DiscoveredCount++
	}
	s.cond.Signal()
	return true
}

func (s *crawlState) next() (crawlTask, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for {
		if len(s.queue) > 0 {
			task := s.queue[0]
			s.queue = s.queue[1:]
			s.active++
			return task, true
		}

		if s.closed {
			return crawlTask{}, false
		}

		if s.active == 0 {
			s.closed = true
			s.cond.Broadcast()
			return crawlTask{}, false
		}

		s.cond.Wait()
	}
}

func (s *crawlState) complete(success bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if success {
		s.summary.CrawledCount++
	}

	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		s.summary.ErrorCount++
		s.summary.LastError = err.Error()
	}

	if s.active > 0 {
		s.active--
	}

	if len(s.queue) == 0 && s.active == 0 {
		s.closed = true
	}

	s.cond.Broadcast()
}

func (s *crawlState) recordIndexFlush(indexed, skipped int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.summary.IndexedCount += indexed
	s.summary.SkippedCount += skipped
	if err != nil {
		s.summary.ErrorCount++
		s.summary.LastError = err.Error()
		s.closed = true
	}
	s.cond.Broadcast()
}

func (s *crawlState) abort(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		s.summary.ErrorCount++
		s.summary.LastError = err.Error()
	}
	s.closed = true
	s.cond.Broadcast()
}

func (s *crawlState) remainingCapacity() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	remaining := s.maxPages - s.summary.ScheduledCount
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (s *crawlState) snapshot() CrawlSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.summary
}

func OpenDefault() (*Engine, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user config dir: %w", err)
	}

	appDir := filepath.Join(configDir, defaultAppDirName)
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return nil, fmt.Errorf("create app data dir: %w", err)
	}

	return Open(filepath.Join(appDir, defaultDatabaseName))
}

func Open(databasePath string) (*Engine, error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o755); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}

	db, err := sql.Open(driverName, databasePath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	engine := &Engine{
		db:   db,
		path: databasePath,
		client: &http.Client{
			Timeout: httpTimeout,
		},
	}

	if err := engine.configureDatabase(); err != nil {
		_ = db.Close()
		return nil, err
	}

	if err := engine.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}

	return engine, nil
}

func (e *Engine) Close() error {
	if e == nil || e.db == nil {
		return nil
	}
	return e.db.Close()
}

func (e *Engine) Path() string {
	if e == nil {
		return ""
	}
	return e.path
}

func (e *Engine) configureDatabase() error {
	pragmas := []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA temp_store = MEMORY;",
		"PRAGMA busy_timeout = 5000;",
	}

	for _, statement := range pragmas {
		if _, err := e.db.Exec(statement); err != nil {
			return fmt.Errorf("apply sqlite pragma %q: %w", statement, err)
		}
	}

	return nil
}

func (e *Engine) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS search_seeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_seeds_url
  ON search_seeds(url);

CREATE TABLE IF NOT EXISTS search_documents (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  crawl_depth INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  discovered_at INTEGER NOT NULL DEFAULT 0,
  last_crawled_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_search_documents_host
  ON search_documents(host);

CREATE INDEX IF NOT EXISTS idx_search_documents_last_crawled
  ON search_documents(last_crawled_at DESC);

CREATE TABLE IF NOT EXISTS search_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  title,
  snippet,
  content,
  url UNINDEXED,
  host UNINDEXED,
  content='search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts(rowid, title, snippet, content, url, host)
  VALUES (new.rowid, new.title, new.snippet, new.content, new.url, new.host);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, snippet, content, url, host)
  VALUES ('delete', old.rowid, old.title, old.snippet, old.content, old.url, old.host);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, snippet, content, url, host)
  VALUES ('delete', old.rowid, old.title, old.snippet, old.content, old.url, old.host);
  INSERT INTO search_documents_fts(rowid, title, snippet, content, url, host)
  VALUES (new.rowid, new.title, new.snippet, new.content, new.url, new.host);
END;
`

	if _, err := e.db.Exec(schema); err != nil {
		return fmt.Errorf("apply search schema: %w", err)
	}

	if _, err := e.db.Exec(`INSERT INTO search_documents_fts(search_documents_fts) VALUES ('rebuild');`); err != nil {
		return fmt.Errorf("rebuild search index: %w", err)
	}

	return nil
}

func (e *Engine) GetStatus() (Status, error) {
	if e == nil || e.db == nil {
		return Status{}, errors.New("search engine is not initialized")
	}

	status := Status{
		DatabasePath:     e.path,
		DefaultMaxPages:  defaultMaxPagesPerCrawl,
		DefaultMaxDepth:  defaultMaxCrawlDepth,
		FetchConcurrency: defaultFetchConcurrency,
	}

	if err := e.db.QueryRow(`SELECT COUNT(*) FROM search_seeds`).Scan(&status.SeedCount); err != nil {
		return Status{}, fmt.Errorf("count search seeds: %w", err)
	}

	if err := e.db.QueryRow(`SELECT COUNT(*) FROM search_documents`).Scan(&status.DocumentCount); err != nil {
		return Status{}, fmt.Errorf("count search documents: %w", err)
	}

	if err := e.db.QueryRow(`SELECT COALESCE(MAX(updated_at), 0) FROM search_documents`).Scan(&status.LastIndexedAt); err != nil {
		return Status{}, fmt.Errorf("read last indexed timestamp: %w", err)
	}

	lastCrawl, err := e.loadLastCrawl()
	if err != nil {
		return Status{}, err
	}
	status.LastCrawl = lastCrawl

	return status, nil
}

func (e *Engine) ListSeeds() ([]Seed, error) {
	rows, err := e.db.Query(`
SELECT id, url, label, host, created_at, updated_at
FROM search_seeds
ORDER BY updated_at DESC, host ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list search seeds: %w", err)
	}
	defer rows.Close()

	seeds := make([]Seed, 0)
	for rows.Next() {
		var seed Seed
		if err := rows.Scan(&seed.ID, &seed.URL, &seed.Label, &seed.Host, &seed.CreatedAt, &seed.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan search seed: %w", err)
		}
		seeds = append(seeds, seed)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate search seeds: %w", err)
	}

	return seeds, nil
}

func (e *Engine) AddSeed(rawURL string, label string) (Seed, error) {
	canonicalURL, host, err := canonicalizeURL(rawURL)
	if err != nil {
		return Seed{}, err
	}

	now := time.Now().UnixMilli()
	seed := Seed{
		ID:        buildSeedID(canonicalURL),
		URL:       canonicalURL,
		Label:     firstNonEmpty(label, host),
		Host:      host,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if _, err := e.db.Exec(`
INSERT INTO search_seeds(id, url, label, host, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  url = excluded.url,
  label = excluded.label,
  host = excluded.host,
  updated_at = excluded.updated_at
`, seed.ID, seed.URL, seed.Label, seed.Host, seed.CreatedAt, seed.UpdatedAt); err != nil {
		return Seed{}, fmt.Errorf("save search seed: %w", err)
	}

	var createdAt int64
	if err := e.db.QueryRow(`SELECT created_at FROM search_seeds WHERE id = ?`, seed.ID).Scan(&createdAt); err == nil {
		seed.CreatedAt = createdAt
	}

	return seed, nil
}

func (e *Engine) DeleteSeed(id string) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}

	if _, err := e.db.Exec(`DELETE FROM search_seeds WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete search seed: %w", err)
	}

	return nil
}

func (e *Engine) IndexDocuments(documents []IndexDocument) (IndexSummary, error) {
	summary := IndexSummary{
		Received:    len(documents),
		CompletedAt: time.Now().UnixMilli(),
	}

	if len(documents) == 0 {
		return summary, nil
	}

	normalized := make([]crawlDocument, 0, len(documents))
	for _, document := range documents {
		normalizedDocument, ok := normalizeIndexDocument(document)
		if !ok {
			summary.Skipped++
			continue
		}
		normalized = append(normalized, normalizedDocument)
	}

	indexed, skipped, err := e.upsertDocuments(normalized)
	if err != nil {
		return summary, err
	}

	summary.Indexed += indexed
	summary.Skipped += skipped
	summary.CompletedAt = time.Now().UnixMilli()
	return summary, nil
}

func (e *Engine) Search(ctx context.Context, query string, limit int) (SearchResponse, error) {
	started := time.Now()
	response := SearchResponse{
		Query: strings.TrimSpace(query),
	}

	if response.Query == "" {
		return response, nil
	}

	limit = clampInt(limit, 1, maxSearchResults)
	primaryQuery, fallbackQuery := buildFTSQuery(response.Query)
	if primaryQuery == "" {
		return response, nil
	}

	queries := []string{primaryQuery}
	if fallbackQuery != "" && fallbackQuery != primaryQuery {
		queries = append(queries, fallbackQuery)
	}

	for _, ftsQuery := range queries {
		results, total, err := e.runFTSSearch(ctx, ftsQuery, limit)
		if err != nil {
			return SearchResponse{}, err
		}
		if len(results) == 0 {
			continue
		}

		response.Results = results
		response.Total = total
		break
	}

	response.TookMs = time.Since(started).Milliseconds()
	return response, nil
}

func (e *Engine) runFTSSearch(ctx context.Context, query string, limit int) ([]SearchResult, int, error) {
	var total int
	if err := e.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM search_documents_fts WHERE search_documents_fts MATCH ?`,
		query,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count search matches: %w", err)
	}

	rows, err := e.db.QueryContext(ctx, `
SELECT
  d.url,
  d.title,
  d.snippet,
  d.content,
  d.host,
  d.source,
  d.last_crawled_at,
  -bm25(search_documents_fts, 6.0, 2.5, 1.0) AS score
FROM search_documents_fts
JOIN search_documents AS d ON d.rowid = search_documents_fts.rowid
WHERE search_documents_fts MATCH ?
ORDER BY bm25(search_documents_fts, 6.0, 2.5, 1.0), d.last_crawled_at DESC
LIMIT ?
`, query, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("query search matches: %w", err)
	}
	defer rows.Close()

	results := make([]SearchResult, 0, limit)
	for rows.Next() {
		var result SearchResult
		if err := rows.Scan(
			&result.URL,
			&result.Title,
			&result.Snippet,
			&result.Content,
			&result.Host,
			&result.Source,
			&result.LastCrawledAt,
			&result.Score,
		); err != nil {
			return nil, 0, fmt.Errorf("scan search match: %w", err)
		}
		results = append(results, result)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate search matches: %w", err)
	}

	return results, total, nil
}

func (e *Engine) Crawl(ctx context.Context, request CrawlRequest) (CrawlSummary, error) {
	seeds, err := e.ListSeeds()
	if err != nil {
		return CrawlSummary{}, err
	}
	if len(seeds) == 0 {
		return CrawlSummary{}, errors.New("add at least one search seed before crawling")
	}

	maxPages := request.MaxPages
	if maxPages <= 0 {
		maxPages = defaultMaxPagesPerCrawl
	}
	maxPages = clampInt(maxPages, 1, hardMaxPagesPerCrawl)

	maxDepth := request.MaxDepth
	if maxDepth <= 0 {
		maxDepth = defaultMaxCrawlDepth
	}
	maxDepth = clampInt(maxDepth, 0, hardMaxCrawlDepth)

	if ctx == nil {
		ctx = context.Background()
	}

	summary := CrawlSummary{
		StartedAt: time.Now().UnixMilli(),
		SeedCount: len(seeds),
	}

	crawlCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	state := newCrawlState(maxPages, summary)

	for _, seed := range seeds {
		state.enqueue(crawlTask{
			url:      seed.URL,
			depth:    0,
			seedHost: seed.Host,
		}, false)

		if state.remainingCapacity() == 0 {
			continue
		}

		sitemapURLs := e.discoverSeedSitemaps(crawlCtx, seed.URL)
		if len(sitemapURLs) == 0 {
			continue
		}

		for _, discoveredURL := range e.expandSitemapURLs(crawlCtx, seed.Host, sitemapURLs, state.remainingCapacity()) {
			state.enqueue(crawlTask{
				url:      discoveredURL,
				depth:    0,
				seedHost: seed.Host,
			}, true)
			if state.remainingCapacity() == 0 {
				break
			}
		}
	}

	docsCh := make(chan crawlDocument, defaultFetchConcurrency*4)
	writerDone := make(chan error, 1)
	go e.indexCrawlDocuments(crawlCtx, docsCh, state, writerDone, cancel)

	var workers sync.WaitGroup
	for workerIndex := 0; workerIndex < defaultFetchConcurrency; workerIndex++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			e.runCrawlWorker(crawlCtx, docsCh, state, maxDepth)
		}()
	}

	workers.Wait()
	close(docsCh)

	writerErr := <-writerDone
	finalSummary := state.snapshot()
	finalSummary.CompletedAt = time.Now().UnixMilli()

	if saveErr := e.saveLastCrawl(finalSummary); saveErr != nil && writerErr == nil {
		writerErr = saveErr
	}

	if writerErr != nil && !errors.Is(writerErr, context.Canceled) && !errors.Is(writerErr, context.DeadlineExceeded) {
		return finalSummary, writerErr
	}

	return finalSummary, nil
}

func (e *Engine) runCrawlWorker(ctx context.Context, docsCh chan<- crawlDocument, state *crawlState, maxDepth int) {
	for {
		if ctx.Err() != nil {
			return
		}

		task, ok := state.next()
		if !ok {
			return
		}

		page, err := e.fetchPage(ctx, task.url)
		if err != nil {
			state.complete(false, err)
			continue
		}

		finalURL, finalHost, err := canonicalizeURL(page.FinalURL)
		if err != nil {
			state.complete(false, err)
			continue
		}
		if !sameSiteOrSubdomain(task.seedHost, finalHost) {
			state.complete(false, fmt.Errorf("redirected outside seed host: %s", finalURL))
			continue
		}

		discoveredAt := time.Now().UnixMilli()
		document := crawlDocument{
			URL:           finalURL,
			Title:         truncate(normalizeWhitespace(page.Title), 300),
			Snippet:       truncate(firstNonEmpty(page.Snippet, page.Content), defaultDocumentSnippetLen),
			Content:       truncate(normalizeWhitespace(page.Content), maxIndexedContentLength),
			Host:          finalHost,
			Source:        defaultDocumentSource,
			CrawlDepth:    task.depth,
			HTTPStatus:    page.StatusCode,
			DiscoveredAt:  discoveredAt,
			LastCrawledAt: discoveredAt,
		}

		if document.Title == "" {
			document.Title = finalHost
		}

		select {
		case docsCh <- document:
		case <-ctx.Done():
			state.complete(false, ctx.Err())
			return
		}

		if task.depth < maxDepth {
			for _, candidate := range page.Links {
				normalizedURL, candidateHost, err := canonicalizeURL(candidate)
				if err != nil {
					continue
				}
				if !sameSiteOrSubdomain(task.seedHost, candidateHost) {
					continue
				}

				state.enqueue(crawlTask{
					url:      normalizedURL,
					depth:    task.depth + 1,
					seedHost: task.seedHost,
				}, true)

				if state.remainingCapacity() == 0 {
					break
				}
			}
		}

		state.complete(true, nil)
	}
}

func (e *Engine) indexCrawlDocuments(
	ctx context.Context,
	docsCh <-chan crawlDocument,
	state *crawlState,
	writerDone chan<- error,
	cancel context.CancelFunc,
) {
	batch := make([]crawlDocument, 0, crawlIndexBatchSize)
	var writerErr error

	flush := func() {
		if writerErr != nil || len(batch) == 0 {
			return
		}

		indexed, skipped, err := e.upsertDocuments(batch)
		if err != nil {
			writerErr = err
			state.recordIndexFlush(0, 0, err)
			cancel()
			return
		}

		state.recordIndexFlush(indexed, skipped, nil)
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			for document := range docsCh {
				if writerErr != nil {
					continue
				}
				batch = append(batch, document)
				if len(batch) >= crawlIndexBatchSize {
					flush()
				}
			}
			flush()
			writerDone <- writerErr
			return
		case document, ok := <-docsCh:
			if !ok {
				flush()
				writerDone <- writerErr
				return
			}
			if writerErr != nil {
				continue
			}
			batch = append(batch, document)
			if len(batch) >= crawlIndexBatchSize {
				flush()
			}
		}
	}
}

func (e *Engine) upsertDocuments(documents []crawlDocument) (int, int, error) {
	if len(documents) == 0 {
		return 0, 0, nil
	}

	tx, err := e.db.BeginTx(context.Background(), nil)
	if err != nil {
		return 0, 0, fmt.Errorf("begin document transaction: %w", err)
	}

	statement, err := tx.Prepare(`
INSERT INTO search_documents (
  url,
  title,
  snippet,
  content,
  host,
  source,
  crawl_depth,
  http_status,
  discovered_at,
  last_crawled_at,
  updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url) DO UPDATE SET
  title = excluded.title,
  snippet = excluded.snippet,
  content = excluded.content,
  host = excluded.host,
  source = excluded.source,
  crawl_depth = excluded.crawl_depth,
  http_status = excluded.http_status,
  discovered_at = CASE
    WHEN search_documents.discovered_at = 0 THEN excluded.discovered_at
    WHEN excluded.discovered_at = 0 THEN search_documents.discovered_at
    ELSE MIN(search_documents.discovered_at, excluded.discovered_at)
  END,
  last_crawled_at = MAX(search_documents.last_crawled_at, excluded.last_crawled_at),
  updated_at = excluded.updated_at
`)
	if err != nil {
		_ = tx.Rollback()
		return 0, 0, fmt.Errorf("prepare document upsert: %w", err)
	}
	defer statement.Close()

	indexed := 0
	skipped := 0
	now := time.Now().UnixMilli()

	for _, document := range documents {
		if strings.TrimSpace(document.URL) == "" {
			skipped++
			continue
		}

		title := truncate(normalizeWhitespace(firstNonEmpty(document.Title, document.Host)), 300)
		snippet := truncate(firstNonEmpty(document.Snippet, document.Content), defaultDocumentSnippetLen)
		content := truncate(normalizeWhitespace(document.Content), maxIndexedContentLength)
		source := firstNonEmpty(document.Source, defaultDocumentSource)
		lastCrawledAt := document.LastCrawledAt
		if lastCrawledAt <= 0 {
			lastCrawledAt = now
		}
		discoveredAt := document.DiscoveredAt
		if discoveredAt <= 0 {
			discoveredAt = lastCrawledAt
		}

		if title == "" && snippet == "" && content == "" {
			skipped++
			continue
		}

		if _, err := statement.Exec(
			document.URL,
			title,
			snippet,
			content,
			document.Host,
			source,
			document.CrawlDepth,
			document.HTTPStatus,
			discoveredAt,
			lastCrawledAt,
			now,
		); err != nil {
			_ = tx.Rollback()
			return indexed, skipped, fmt.Errorf("upsert search document %s: %w", document.URL, err)
		}

		indexed++
	}

	if err := tx.Commit(); err != nil {
		return indexed, skipped, fmt.Errorf("commit document transaction: %w", err)
	}

	return indexed, skipped, nil
}

func (e *Engine) fetchPage(ctx context.Context, targetURL string) (fetchedPage, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return fetchedPage{}, fmt.Errorf("create crawl request: %w", err)
	}

	request.Header.Set("User-Agent", defaultSeedRequestAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.2")

	response, err := e.client.Do(request)
	if err != nil {
		return fetchedPage{}, fmt.Errorf("fetch page %s: %w", targetURL, err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fetchedPage{}, fmt.Errorf("fetch page %s returned status %d", targetURL, response.StatusCode)
	}

	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if contentType != "" &&
		!strings.Contains(contentType, "text/html") &&
		!strings.Contains(contentType, "application/xhtml+xml") {
		return fetchedPage{}, fmt.Errorf("unsupported content type for %s: %s", targetURL, contentType)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxHTMLBytes+1))
	if err != nil {
		return fetchedPage{}, fmt.Errorf("read page %s: %w", targetURL, err)
	}
	if len(body) > maxHTMLBytes {
		return fetchedPage{}, fmt.Errorf("page too large for local index: %s", targetURL)
	}

	parsedPage, err := parseHTMLDocument(body, response.Request.URL)
	if err != nil {
		return fetchedPage{}, fmt.Errorf("parse page %s: %w", targetURL, err)
	}

	return fetchedPage{
		FinalURL:   response.Request.URL.String(),
		Title:      parsedPage.Title,
		Snippet:    parsedPage.Snippet,
		Content:    parsedPage.Text,
		Links:      dedupeStrings(parsedPage.Links),
		StatusCode: response.StatusCode,
	}, nil
}

func (e *Engine) discoverSeedSitemaps(ctx context.Context, seedURL string) []string {
	parsedSeed, err := url.Parse(seedURL)
	if err != nil {
		return nil
	}

	scheme := parsedSeed.Scheme
	if scheme == "" {
		scheme = "https"
	}

	root := &url.URL{
		Scheme: scheme,
		Host:   parsedSeed.Host,
	}

	sitemaps := make([]string, 0, 4)
	robotsURL := root.ResolveReference(&url.URL{Path: "/robots.txt"})
	if robotsText, ok := e.fetchTextResource(ctx, robotsURL.String(), maxRobotsBytes); ok {
		for _, line := range strings.Split(robotsText, "\n") {
			cleanLine := strings.TrimSpace(line)
			if cleanLine == "" || strings.HasPrefix(cleanLine, "#") {
				continue
			}
			if strings.HasPrefix(strings.ToLower(cleanLine), "sitemap:") {
				candidate := strings.TrimSpace(cleanLine[len("sitemap:"):])
				normalizedURL, host, err := canonicalizeURL(candidate)
				if err == nil && sameSiteOrSubdomain(normalizeHost(parsedSeed.Hostname()), host) {
					sitemaps = append(sitemaps, normalizedURL)
				}
			}
		}
	}

	for _, fallbackPath := range []string{"/sitemap.xml", "/sitemap_index.xml"} {
		sitemaps = append(sitemaps, root.ResolveReference(&url.URL{Path: fallbackPath}).String())
	}

	return dedupeStrings(sitemaps)
}

func (e *Engine) expandSitemapURLs(ctx context.Context, seedHost string, sitemapURLs []string, limit int) []string {
	if limit <= 0 || len(sitemapURLs) == 0 {
		return nil
	}

	queue := append([]string(nil), sitemapURLs...)
	seenSitemaps := make(map[string]struct{}, len(queue))
	discovered := make([]string, 0, minInt(limit, 1024))
	seenURLs := make(map[string]struct{}, minInt(limit, 2048))

	for len(queue) > 0 && len(discovered) < limit && len(seenSitemaps) < maxNestedSitemaps {
		if ctx.Err() != nil {
			break
		}

		current := queue[0]
		queue = queue[1:]

		sitemapURL, host, err := canonicalizeURL(current)
		if err != nil || !sameSiteOrSubdomain(seedHost, host) {
			continue
		}
		if _, seen := seenSitemaps[sitemapURL]; seen {
			continue
		}
		seenSitemaps[sitemapURL] = struct{}{}

		body, err := e.fetchSitemap(ctx, sitemapURL)
		if err != nil {
			continue
		}

		rootElement, locs, err := parseSitemapDocument(body)
		if err != nil {
			continue
		}

		switch rootElement {
		case "sitemapindex":
			for _, loc := range locs {
				normalizedURL, nestedHost, err := canonicalizeURL(loc)
				if err != nil || !sameSiteOrSubdomain(seedHost, nestedHost) {
					continue
				}
				if _, seen := seenSitemaps[normalizedURL]; seen {
					continue
				}
				queue = append(queue, normalizedURL)
			}
		default:
			for _, loc := range locs {
				if len(discovered) >= limit {
					break
				}
				normalizedURL, discoveredHost, err := canonicalizeURL(loc)
				if err != nil || !sameSiteOrSubdomain(seedHost, discoveredHost) {
					continue
				}
				if _, seen := seenURLs[normalizedURL]; seen {
					continue
				}
				seenURLs[normalizedURL] = struct{}{}
				discovered = append(discovered, normalizedURL)
			}
		}
	}

	return discovered
}

func (e *Engine) fetchTextResource(ctx context.Context, resourceURL string, limit int64) (string, bool) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, resourceURL, nil)
	if err != nil {
		return "", false
	}

	request.Header.Set("User-Agent", defaultSeedRequestAgent)
	request.Header.Set("Accept", "text/plain,text/html;q=0.2,*/*;q=0.1")

	response, err := e.client.Do(request)
	if err != nil {
		return "", false
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", false
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return "", false
	}

	return string(body), true
}

func (e *Engine) fetchSitemap(ctx context.Context, sitemapURL string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sitemapURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create sitemap request: %w", err)
	}

	request.Header.Set("User-Agent", defaultSeedRequestAgent)
	request.Header.Set("Accept", "application/xml,text/xml,application/octet-stream;q=0.8,*/*;q=0.2")

	response, err := e.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch sitemap %s: %w", sitemapURL, err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch sitemap %s returned status %d", sitemapURL, response.StatusCode)
	}

	reader := io.Reader(response.Body)
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(contentType, "gzip") || strings.HasSuffix(strings.ToLower(sitemapURL), ".gz") {
		gzipReader, err := gzip.NewReader(response.Body)
		if err != nil {
			return nil, fmt.Errorf("open sitemap gzip %s: %w", sitemapURL, err)
		}
		defer gzipReader.Close()
		reader = gzipReader
	}

	body, err := io.ReadAll(io.LimitReader(reader, maxSitemapBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read sitemap %s: %w", sitemapURL, err)
	}
	if len(body) > maxSitemapBytes {
		return nil, fmt.Errorf("sitemap too large: %s", sitemapURL)
	}

	return body, nil
}

func parseSitemapDocument(body []byte) (string, []string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	rootElement := ""
	locs := make([]string, 0, 128)

	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", nil, fmt.Errorf("decode sitemap xml: %w", err)
		}

		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}

		if rootElement == "" {
			rootElement = strings.ToLower(start.Name.Local)
		}

		if !strings.EqualFold(start.Name.Local, "loc") {
			continue
		}

		var loc string
		if err := decoder.DecodeElement(&loc, &start); err != nil {
			return "", nil, fmt.Errorf("decode sitemap location: %w", err)
		}

		loc = strings.TrimSpace(loc)
		if loc != "" {
			locs = append(locs, loc)
		}
	}

	return rootElement, dedupeStrings(locs), nil
}

func normalizeIndexDocument(document IndexDocument) (crawlDocument, bool) {
	normalizedURL, host, err := canonicalizeURL(document.URL)
	if err != nil {
		return crawlDocument{}, false
	}

	now := time.Now().UnixMilli()
	lastCrawledAt := document.LastCrawledAt
	if lastCrawledAt <= 0 {
		lastCrawledAt = now
	}

	title := truncate(normalizeWhitespace(document.Title), 300)
	content := truncate(normalizeWhitespace(document.Content), maxIndexedContentLength)
	snippet := truncate(firstNonEmpty(document.Snippet, content), defaultDocumentSnippetLen)
	if title == "" {
		title = host
	}

	if title == "" && snippet == "" && content == "" {
		return crawlDocument{}, false
	}

	return crawlDocument{
		URL:           normalizedURL,
		Title:         title,
		Snippet:       snippet,
		Content:       content,
		Host:          host,
		Source:        firstNonEmpty(document.Source, "external-search"),
		CrawlDepth:    0,
		HTTPStatus:    200,
		DiscoveredAt:  lastCrawledAt,
		LastCrawledAt: lastCrawledAt,
	}, true
}

func (e *Engine) loadLastCrawl() (*CrawlSummary, error) {
	var payload string
	err := e.db.QueryRow(`SELECT value FROM search_meta WHERE key = ?`, lastCrawlMetaKey).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load last crawl summary: %w", err)
	}

	var summary CrawlSummary
	if err := json.Unmarshal([]byte(payload), &summary); err != nil {
		return nil, fmt.Errorf("decode last crawl summary: %w", err)
	}

	return &summary, nil
}

func (e *Engine) saveLastCrawl(summary CrawlSummary) error {
	payload, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("encode last crawl summary: %w", err)
	}

	if _, err := e.db.Exec(`
INSERT INTO search_meta(key, value, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
`, lastCrawlMetaKey, string(payload), time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("save last crawl summary: %w", err)
	}

	return nil
}

func buildSeedID(seedURL string) string {
	hash := sha1.Sum([]byte(seedURL))
	return hex.EncodeToString(hash[:])
}

func buildFTSQuery(input string) (string, string) {
	tokens := dedupeStrings(ftsTokenPattern.FindAllString(strings.ToLower(input), -1))
	if len(tokens) == 0 {
		return "", ""
	}
	if len(tokens) > 8 {
		tokens = tokens[:8]
	}

	terms := make([]string, 0, len(tokens))
	for _, token := range tokens {
		terms = append(terms, fmt.Sprintf(`%s*`, token))
	}

	if len(terms) == 1 {
		return terms[0], terms[0]
	}

	return strings.Join(terms, " AND "), strings.Join(terms, " OR ")
}

func canonicalizeURL(raw string) (string, string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", errors.New("url is required")
	}

	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", "", fmt.Errorf("parse url: %w", err)
	}

	if parsed.Scheme == "" {
		parsed.Scheme = "https"
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", "", fmt.Errorf("unsupported url scheme: %s", parsed.Scheme)
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", "", errors.New("url host is required")
	}

	port := parsed.Port()
	switch {
	case port == "":
		parsed.Host = host
	case parsed.Scheme == "http" && port == "80":
		parsed.Host = host
	case parsed.Scheme == "https" && port == "443":
		parsed.Host = host
	default:
		parsed.Host = host + ":" + port
	}

	parsed.Fragment = ""
	cleanPath := parsed.Path
	if cleanPath == "" {
		cleanPath = "/"
	}
	cleanPath = path.Clean("/" + strings.TrimSpace(cleanPath))
	if cleanPath == "." || cleanPath == "" {
		cleanPath = "/"
	}
	if cleanPath != "/" && strings.HasSuffix(parsed.Path, "/") {
		cleanPath = strings.TrimSuffix(cleanPath, "/")
	}
	parsed.Path = cleanPath
	parsed.RawPath = ""

	values := parsed.Query()
	keys := make([]string, 0, len(values))
	for key := range values {
		if shouldDropQueryKey(key) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	filtered := url.Values{}
	for _, key := range keys {
		cleanValues := make([]string, 0, len(values[key]))
		for _, value := range values[key] {
			value = strings.TrimSpace(value)
			if value != "" {
				cleanValues = append(cleanValues, value)
			}
		}
		sort.Strings(cleanValues)
		for _, value := range cleanValues {
			filtered.Add(key, value)
		}
	}
	parsed.RawQuery = filtered.Encode()

	return parsed.String(), normalizeHost(host), nil
}

func shouldDropQueryKey(key string) bool {
	normalizedKey := strings.ToLower(strings.TrimSpace(key))
	if normalizedKey == "" {
		return true
	}

	if strings.HasPrefix(normalizedKey, "utm_") {
		return true
	}

	switch normalizedKey {
	case "fbclid", "gclid", "gclsrc", "mc_cid", "mc_eid", "ref", "ref_src", "ref_url", "source", "spm":
		return true
	default:
		return false
	}
}

func sameSiteOrSubdomain(seedHost string, candidateHost string) bool {
	seed := normalizeHost(seedHost)
	candidate := normalizeHost(candidateHost)
	if seed == "" || candidate == "" {
		return false
	}

	return seed == candidate ||
		strings.HasSuffix(candidate, "."+seed) ||
		strings.HasSuffix(seed, "."+candidate)
}

func normalizeHost(host string) string {
	cleanHost := strings.ToLower(strings.TrimSpace(host))
	cleanHost = strings.TrimPrefix(cleanHost, "www.")
	return cleanHost
}

func normalizeWhitespace(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func truncate(value string, limit int) string {
	value = normalizeWhitespace(value)
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return strings.TrimSpace(value[:limit])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		cleanValue := normalizeWhitespace(value)
		if cleanValue != "" {
			return cleanValue
		}
	}
	return ""
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(values))
	deduped := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		deduped = append(deduped, value)
	}
	return deduped
}

func clampInt(value, minValue, maxValue int) int {
	switch {
	case value < minValue:
		return minValue
	case value > maxValue:
		return maxValue
	default:
		return value
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
