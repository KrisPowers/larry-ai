package searchengine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestIndexAndSearch(t *testing.T) {
	engine := openTestEngine(t)
	defer engine.Close()

	summary, err := engine.IndexDocuments([]IndexDocument{
		{
			URL:     "https://example.com/guides/go-search",
			Title:   "Go Search Engine Guide",
			Snippet: "Building an in-house search engine in Go.",
			Content: "This guide explains crawling, indexing, ranking, and local search in Go.",
			Source:  "test",
		},
		{
			URL:     "https://example.com/guides/rust",
			Title:   "Rust Guide",
			Snippet: "Something else.",
			Content: "This page is about Rust systems programming.",
			Source:  "test",
		},
	})
	if err != nil {
		t.Fatalf("IndexDocuments returned error: %v", err)
	}
	if summary.Indexed != 2 {
		t.Fatalf("expected 2 indexed documents, got %d", summary.Indexed)
	}

	results, err := engine.Search(context.Background(), "go search indexing", 5)
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if results.Total < 1 {
		t.Fatalf("expected at least one search match, got %d", results.Total)
	}
	if len(results.Results) == 0 || results.Results[0].URL != "https://example.com/guides/go-search" {
		t.Fatalf("expected Go guide to rank first, got %#v", results.Results)
	}
}

func TestCrawlIndexesSeededPages(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Home</title></head><body><p>Distributed search systems start here.</p><a href="/docs">Docs</a><a href="https://external.example/outside">Outside</a></body></html>`))
	})
	mux.HandleFunc("/docs", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Docs</title></head><body><p>Millions of indexed documents require crawling, ranking, and persistence.</p></body></html>`))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	engine := openTestEngine(t)
	defer engine.Close()

	if _, err := engine.AddSeed(server.URL, "Test Seed"); err != nil {
		t.Fatalf("AddSeed returned error: %v", err)
	}

	summary, err := engine.Crawl(context.Background(), CrawlRequest{
		MaxPages: 8,
		MaxDepth: 2,
	})
	if err != nil {
		t.Fatalf("Crawl returned error: %v", err)
	}
	if summary.CrawledCount < 2 {
		t.Fatalf("expected at least 2 crawled pages, got %d", summary.CrawledCount)
	}

	results, err := engine.Search(context.Background(), "millions indexed documents", 5)
	if err != nil {
		t.Fatalf("Search returned error after crawl: %v", err)
	}
	if len(results.Results) == 0 {
		t.Fatal("expected crawled content to be searchable")
	}
	if results.Results[0].Title != "Docs" {
		t.Fatalf("expected /docs page to rank first, got %#v", results.Results[0])
	}
}

func TestCrawlDiscoversSitemapURLs(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Home</title></head><body><p>Seed page.</p></body></html>`))
	})
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("User-agent: *\nSitemap: " + serverURL(r, "/sitemap.xml") + "\n"))
	})
	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>` + serverURL(r, "/docs/sitemap-target") + `</loc></url>
  <url><loc>` + serverURL(r, "/docs/second-target") + `</loc></url>
</urlset>`))
	})
	mux.HandleFunc("/docs/sitemap-target", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Sitemap Target</title></head><body><p>Sitemap-only discovery improves crawl coverage for large sites.</p></body></html>`))
	})
	mux.HandleFunc("/docs/second-target", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Second Target</title></head><body><p>Nested docs stay searchable even without page links.</p></body></html>`))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	engine := openTestEngine(t)
	defer engine.Close()

	if _, err := engine.AddSeed(server.URL, "Sitemap Seed"); err != nil {
		t.Fatalf("AddSeed returned error: %v", err)
	}

	summary, err := engine.Crawl(context.Background(), CrawlRequest{
		MaxPages: 12,
		MaxDepth: 1,
	})
	if err != nil {
		t.Fatalf("Crawl returned error: %v", err)
	}
	if summary.IndexedCount < 3 {
		t.Fatalf("expected sitemap crawl to index at least 3 pages, got %d", summary.IndexedCount)
	}

	results, err := engine.Search(context.Background(), "sitemap discovery crawl coverage", 5)
	if err != nil {
		t.Fatalf("Search returned error after sitemap crawl: %v", err)
	}
	if len(results.Results) == 0 {
		t.Fatal("expected sitemap-only page to be searchable")
	}
	if results.Results[0].Title != "Sitemap Target" {
		t.Fatalf("expected sitemap target to rank first, got %#v", results.Results[0])
	}
}

func openTestEngine(t *testing.T) *Engine {
	t.Helper()

	engine, err := Open(filepath.Join(t.TempDir(), "search.sqlite"))
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	return engine
}

func serverURL(r *http.Request, path string) string {
	return "http://" + r.Host + path
}
