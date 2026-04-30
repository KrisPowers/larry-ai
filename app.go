package main

import (
	"context"
	"sync"

	"github.com/krisp/ai-chat-ui/internal/replyreview"
	"github.com/krisp/ai-chat-ui/internal/searchengine"
	"github.com/krisp/ai-chat-ui/internal/storage"
	"github.com/krisp/ai-chat-ui/internal/workspace"
)

type App struct {
	ctx            context.Context
	store          *storage.Store
	searchEngine   *searchengine.Engine
	ollamaRequests sync.Map
}

func NewApp() (*App, error) {
	store, err := storage.OpenDefault()
	if err != nil {
		return nil, err
	}

	engine, err := searchengine.OpenDefault()
	if err != nil {
		_ = store.Close()
		return nil, err
	}

	return &App{
		store:        store,
		searchEngine: engine,
	}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(context.Context) {
	_ = a.store.Close()
	_ = a.searchEngine.Close()
}

func (a *App) GetStorageSnapshot() (storage.Snapshot, error) {
	return a.store.LoadSnapshot()
}

func (a *App) LoadChats() ([]storage.JSONMap, error) {
	return a.store.LoadChats()
}

func (a *App) SaveChat(chat storage.JSONMap) error {
	return a.store.SaveChat(chat)
}

func (a *App) DeleteChat(id string) error {
	return a.store.DeleteChat(id)
}

func (a *App) DeleteAllChats() error {
	return a.store.DeleteAllChats()
}

func (a *App) SaveAppSettings(settings storage.AppSettings) error {
	return a.store.SaveSettings(settings)
}

func (a *App) SaveWorkspaces(workspaces []storage.JSONMap) error {
	return a.store.SaveWorkspaces(workspaces)
}

func (a *App) LoadReplyPreferences() ([]storage.JSONMap, error) {
	return a.store.LoadReplyPreferences()
}

func (a *App) ReplaceReplyPreferences(preferences []storage.JSONMap) error {
	return a.store.ReplaceReplyPreferences(preferences)
}

func (a *App) SeedFromBrowser(snapshot storage.Snapshot) (bool, error) {
	return a.store.SeedFromBrowser(snapshot)
}

func (a *App) PickWorkspaceDirectory() (workspace.Selection, error) {
	return workspace.PickDirectory(a.ctx)
}

func (a *App) CreateManagedWorkspaceDirectory(label string) (workspace.Selection, error) {
	return workspace.CreateManagedWorkspace(label)
}

func (a *App) ScanWorkspace(rootPath string) (workspace.Snapshot, error) {
	return workspace.Scan(rootPath)
}

func (a *App) ReadWorkspaceFile(rootPath string, relativePath string) (workspace.Document, error) {
	return workspace.ReadFile(rootPath, relativePath)
}

func (a *App) OpenWorkspaceInExplorer(rootPath string) error {
	return workspace.OpenInExplorer(rootPath)
}

func (a *App) CreateWorkspaceDirectory(rootPath string, relativePath string) (workspace.Snapshot, error) {
	return workspace.CreateDirectory(rootPath, relativePath)
}

func (a *App) CreateWorkspaceFile(rootPath string, relativePath string, content string) (workspace.Snapshot, error) {
	return workspace.CreateFile(rootPath, relativePath, content)
}

func (a *App) WriteWorkspaceFile(rootPath string, relativePath string, content string) (workspace.Snapshot, error) {
	return workspace.WriteFile(rootPath, relativePath, content)
}

func (a *App) WriteWorkspaceFileDocument(rootPath string, relativePath string, content string) (workspace.Document, error) {
	return workspace.WriteFileDocument(rootPath, relativePath, content)
}

func (a *App) RenameWorkspaceEntry(rootPath string, relativePath string, nextRelativePath string) (workspace.Snapshot, error) {
	return workspace.RenameEntry(rootPath, relativePath, nextRelativePath)
}

func (a *App) CopyWorkspaceEntry(rootPath string, relativePath string, nextRelativePath string) (workspace.Snapshot, error) {
	return workspace.CopyEntry(rootPath, relativePath, nextRelativePath)
}

func (a *App) DeleteWorkspaceEntry(rootPath string, relativePath string) (workspace.Snapshot, error) {
	return workspace.DeleteEntry(rootPath, relativePath)
}

func (a *App) OpenWorkspaceEntry(rootPath string, relativePath string) error {
	return workspace.OpenEntry(rootPath, relativePath)
}

func (a *App) CreateWorkspaceBackup(rootPath string, workspaceID string, label string) (workspace.BackupSummary, error) {
	return workspace.CreateBackup(rootPath, workspaceID, label)
}

func (a *App) RestoreWorkspaceBackup(rootPath string, archivePath string) (workspace.Snapshot, error) {
	return workspace.RestoreBackup(rootPath, archivePath)
}

func (a *App) InspectWorkspaceRuntime(rootPath string) (workspace.RuntimeProfile, error) {
	return workspace.InspectRuntime(rootPath)
}

func (a *App) RunWorkspaceCommand(rootPath string, command string, timeoutMs int) (workspace.CommandResult, error) {
	return workspace.RunCommand(rootPath, command, timeoutMs)
}

func (a *App) RunWorkspaceWebPreview(rootPath string, command string, timeoutMs int) (workspace.CommandResult, error) {
	return workspace.RunWebPreview(rootPath, command, timeoutMs)
}

func (a *App) GetSearchEngineStatus() (searchengine.Status, error) {
	return a.searchEngine.GetStatus()
}

func (a *App) ListSearchEngineSeeds() ([]searchengine.Seed, error) {
	return a.searchEngine.ListSeeds()
}

func (a *App) AddSearchEngineSeed(url string, label string) (searchengine.Seed, error) {
	return a.searchEngine.AddSeed(url, label)
}

func (a *App) DeleteSearchEngineSeed(id string) error {
	return a.searchEngine.DeleteSeed(id)
}

func (a *App) CrawlSearchEngine(request searchengine.CrawlRequest) (searchengine.CrawlSummary, error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return a.searchEngine.Crawl(ctx, request)
}

func (a *App) SearchLocalIndex(query string, limit int) (searchengine.SearchResponse, error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return a.searchEngine.Search(ctx, query, limit)
}

func (a *App) IndexSearchDocuments(documents []searchengine.IndexDocument) (searchengine.IndexSummary, error) {
	return a.searchEngine.IndexDocuments(documents)
}

func (a *App) ReviewAssistantReply(request replyreview.Request) (replyreview.Result, error) {
	return replyreview.Review(request), nil
}
