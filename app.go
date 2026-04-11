package main

import (
	"context"
	"sync"

	"github.com/krisp/ai-chat-ui/internal/storage"
	"github.com/krisp/ai-chat-ui/internal/workspace"
)

type App struct {
	ctx            context.Context
	store          *storage.Store
	ollamaRequests sync.Map
}

func NewApp() (*App, error) {
	store, err := storage.OpenDefault()
	if err != nil {
		return nil, err
	}

	return &App{
		store: store,
	}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(context.Context) {
	_ = a.store.Close()
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

func (a *App) DeleteWorkspaceEntry(rootPath string, relativePath string) (workspace.Snapshot, error) {
	return workspace.DeleteEntry(rootPath, relativePath)
}
