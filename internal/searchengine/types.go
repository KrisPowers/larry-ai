package searchengine

type Seed struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Label     string `json:"label"`
	Host      string `json:"host"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Status struct {
	DatabasePath     string        `json:"databasePath"`
	SeedCount        int           `json:"seedCount"`
	DocumentCount    int           `json:"documentCount"`
	LastIndexedAt    int64         `json:"lastIndexedAt"`
	LastCrawl        *CrawlSummary `json:"lastCrawl,omitempty"`
	DefaultMaxPages  int           `json:"defaultMaxPages"`
	DefaultMaxDepth  int           `json:"defaultMaxDepth"`
	FetchConcurrency int           `json:"fetchConcurrency"`
}

type CrawlRequest struct {
	MaxPages int `json:"maxPages"`
	MaxDepth int `json:"maxDepth"`
}

type CrawlSummary struct {
	StartedAt       int64  `json:"startedAt"`
	CompletedAt     int64  `json:"completedAt"`
	SeedCount       int    `json:"seedCount"`
	ScheduledCount  int    `json:"scheduledCount"`
	CrawledCount    int    `json:"crawledCount"`
	IndexedCount    int    `json:"indexedCount"`
	DiscoveredCount int    `json:"discoveredCount"`
	SkippedCount    int    `json:"skippedCount"`
	ErrorCount      int    `json:"errorCount"`
	LastError       string `json:"lastError,omitempty"`
}

type SearchResult struct {
	URL           string  `json:"url"`
	Title         string  `json:"title"`
	Snippet       string  `json:"snippet"`
	Content       string  `json:"content"`
	Host          string  `json:"host"`
	Source        string  `json:"source"`
	LastCrawledAt int64   `json:"lastCrawledAt"`
	Score         float64 `json:"score"`
}

type SearchResponse struct {
	Query   string         `json:"query"`
	TookMs  int64          `json:"tookMs"`
	Total   int            `json:"total"`
	Results []SearchResult `json:"results"`
}

type IndexDocument struct {
	URL           string `json:"url"`
	Title         string `json:"title"`
	Snippet       string `json:"snippet"`
	Content       string `json:"content"`
	Source        string `json:"source"`
	LastCrawledAt int64  `json:"lastCrawledAt"`
}

type IndexSummary struct {
	Received    int   `json:"received"`
	Indexed     int   `json:"indexed"`
	Skipped     int   `json:"skipped"`
	CompletedAt int64 `json:"completedAt"`
}
