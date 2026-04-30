package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const (
	driverName              = "sqlite"
	documentKindChat        = "chat"
	documentKindSettings    = "settings"
	documentKindWorkspaces  = "workspaces"
	documentKindReplyMemory = "reply-preferences"
)

type JSONMap = map[string]any

type ProviderConnectionSettings struct {
	SelectedModels []string `json:"selectedModels"`
	AutoUpdate     bool     `json:"autoUpdate"`
}

type ProviderSettingsMap struct {
	Ollama    ProviderConnectionSettings `json:"ollama"`
	OpenAI    ProviderConnectionSettings `json:"openai"`
	Anthropic ProviderConnectionSettings `json:"anthropic"`
}

type AppSettings struct {
	DefaultModel                       string              `json:"defaultModel"`
	DefaultChatPreset                  string              `json:"defaultChatPreset"`
	DefaultReasoningEffort             string              `json:"defaultReasoningEffort"`
	DeveloperToolsEnabled              bool                `json:"developerToolsEnabled"`
	AdvancedUseEnabled                 bool                `json:"advancedUseEnabled"`
	CodeEditorAutoSaveEnabled          bool                `json:"codeEditorAutoSaveEnabled"`
	CodeEditorIndentGuidesEnabled      bool                `json:"codeEditorIndentGuidesEnabled"`
	CodeEditorSetupGuideEnabled        bool                `json:"codeEditorSetupGuideEnabled"`
	CodeEditorDependencyInstallEnabled bool                `json:"codeEditorDependencyInstallEnabled"`
	OllamaEndpoint                     string              `json:"ollamaEndpoint"`
	OpenAIApiKey                       string              `json:"openAIApiKey"`
	AnthropicApiKey                    string              `json:"anthropicApiKey"`
	ProviderSettings                   ProviderSettingsMap `json:"providerSettings"`
}

type Snapshot struct {
	Settings         AppSettings `json:"settings"`
	Workspaces       []JSONMap   `json:"workspaces"`
	Chats            []JSONMap   `json:"chats"`
	ReplyPreferences []JSONMap   `json:"replyPreferences"`
}

type Store struct {
	db   *sql.DB
	path string
}

func OpenDefault() (*Store, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user config dir: %w", err)
	}

	appDir := filepath.Join(configDir, "LarryAI")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return nil, fmt.Errorf("create app data dir: %w", err)
	}

	path := filepath.Join(appDir, "larry-ai.sqlite")
	db, err := sql.Open(driverName, path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)

	store := &Store{
		db:   db,
		path: path,
	}

	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}

	return s.db.Close()
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS app_documents (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_documents_kind_updated
  ON app_documents(kind, updated_at DESC);
`

	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	return nil
}

func defaultSettings() AppSettings {
	return AppSettings{
		DefaultModel:                       "",
		DefaultChatPreset:                  "auto-chat",
		DefaultReasoningEffort:             "balanced",
		DeveloperToolsEnabled:              false,
		AdvancedUseEnabled:                 false,
		CodeEditorAutoSaveEnabled:          true,
		CodeEditorIndentGuidesEnabled:      true,
		CodeEditorSetupGuideEnabled:        false,
		CodeEditorDependencyInstallEnabled: false,
		OllamaEndpoint:                     "http://localhost:11434",
		OpenAIApiKey:                       "",
		AnthropicApiKey:                    "",
		ProviderSettings:                   defaultProviderSettingsMap(),
	}
}

func defaultProviderConnectionSettings() ProviderConnectionSettings {
	return ProviderConnectionSettings{
		SelectedModels: []string{},
		AutoUpdate:     true,
	}
}

func defaultProviderSettingsMap() ProviderSettingsMap {
	return ProviderSettingsMap{
		Ollama:    defaultProviderConnectionSettings(),
		OpenAI:    defaultProviderConnectionSettings(),
		Anthropic: defaultProviderConnectionSettings(),
	}
}

func providerConnectionSettingsIsZero(input ProviderConnectionSettings) bool {
	return len(input.SelectedModels) == 0 &&
		!input.AutoUpdate
}

func normaliseProviderConnectionSettings(input ProviderConnectionSettings) ProviderConnectionSettings {
	defaults := defaultProviderConnectionSettings()

	if providerConnectionSettingsIsZero(input) {
		return defaults
	}

	selected := make([]string, 0, len(input.SelectedModels))
	for _, model := range input.SelectedModels {
		if model == "" {
			continue
		}
		selected = append(selected, model)
	}
	input.SelectedModels = selected

	if input.SelectedModels == nil {
		input.SelectedModels = []string{}
	}

	return input
}

func normaliseProviderSettingsMap(input ProviderSettingsMap) ProviderSettingsMap {
	return ProviderSettingsMap{
		Ollama:    normaliseProviderConnectionSettings(input.Ollama),
		OpenAI:    normaliseProviderConnectionSettings(input.OpenAI),
		Anthropic: normaliseProviderConnectionSettings(input.Anthropic),
	}
}

func normaliseSettings(input AppSettings) AppSettings {
	defaults := defaultSettings()

	if input.DefaultChatPreset == "" {
		input.DefaultChatPreset = defaults.DefaultChatPreset
	}

	switch input.DefaultReasoningEffort {
	case "light", "balanced", "high", "extra-high":
	default:
		input.DefaultReasoningEffort = defaults.DefaultReasoningEffort
	}

	if input.OllamaEndpoint == "" {
		input.OllamaEndpoint = defaults.OllamaEndpoint
	}

	input.ProviderSettings = normaliseProviderSettingsMap(input.ProviderSettings)

	return input
}

func (s *Store) LoadSnapshot() (Snapshot, error) {
	settings, err := s.LoadSettings()
	if err != nil {
		return Snapshot{}, err
	}

	workspaces, err := s.LoadWorkspaces()
	if err != nil {
		return Snapshot{}, err
	}

	chats, err := s.LoadChats()
	if err != nil {
		return Snapshot{}, err
	}

	replyPreferences, err := s.LoadReplyPreferences()
	if err != nil {
		return Snapshot{}, err
	}

	return Snapshot{
		Settings:         settings,
		Workspaces:       workspaces,
		Chats:            chats,
		ReplyPreferences: replyPreferences,
	}, nil
}

func (s *Store) LoadSettings() (AppSettings, error) {
	var payload string
	err := s.db.QueryRow(`SELECT payload FROM app_documents WHERE key = ?`, "settings").Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultSettings(), nil
	}
	if err != nil {
		return AppSettings{}, fmt.Errorf("load document %q: %w", "settings", err)
	}

	var settings AppSettings
	if err := json.Unmarshal([]byte(payload), &settings); err != nil {
		return AppSettings{}, fmt.Errorf("decode document %q: %w", "settings", err)
	}

	var rawSettings map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &rawSettings); err == nil {
		defaults := defaultSettings()
		if _, ok := rawSettings["codeEditorAutoSaveEnabled"]; !ok {
			settings.CodeEditorAutoSaveEnabled = defaults.CodeEditorAutoSaveEnabled
		}
		if _, ok := rawSettings["codeEditorIndentGuidesEnabled"]; !ok {
			settings.CodeEditorIndentGuidesEnabled = defaults.CodeEditorIndentGuidesEnabled
		}
		if _, ok := rawSettings["codeEditorSetupGuideEnabled"]; !ok {
			settings.CodeEditorSetupGuideEnabled = defaults.CodeEditorSetupGuideEnabled
		}
		if _, ok := rawSettings["codeEditorDependencyInstallEnabled"]; !ok {
			settings.CodeEditorDependencyInstallEnabled = defaults.CodeEditorDependencyInstallEnabled
		}
	}

	return normaliseSettings(settings), nil
}

func (s *Store) SaveSettings(settings AppSettings) error {
	return s.saveDocument("settings", documentKindSettings, normaliseSettings(settings), time.Now().UnixMilli())
}

func (s *Store) LoadWorkspaces() ([]JSONMap, error) {
	workspaces := []JSONMap{}
	found, err := s.loadDocument("workspaces", &workspaces)
	if err != nil {
		return nil, err
	}
	if !found {
		return []JSONMap{}, nil
	}

	return workspaces, nil
}

func (s *Store) SaveWorkspaces(workspaces []JSONMap) error {
	if workspaces == nil {
		workspaces = []JSONMap{}
	}

	return s.saveDocument("workspaces", documentKindWorkspaces, workspaces, time.Now().UnixMilli())
}

func (s *Store) LoadChats() ([]JSONMap, error) {
	rows, err := s.db.Query(`
SELECT payload
FROM app_documents
WHERE kind = ?
ORDER BY updated_at DESC
`, documentKindChat)
	if err != nil {
		return nil, fmt.Errorf("query chats: %w", err)
	}
	defer rows.Close()

	chats := make([]JSONMap, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("scan chat payload: %w", err)
		}

		var chat JSONMap
		if err := json.Unmarshal([]byte(payload), &chat); err != nil {
			return nil, fmt.Errorf("decode chat payload: %w", err)
		}

		chats = append(chats, chat)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chats: %w", err)
	}

	return chats, nil
}

func (s *Store) SaveChat(chat JSONMap) error {
	if chat == nil {
		return errors.New("chat payload is required")
	}

	id, ok := chat["id"].(string)
	if !ok || id == "" {
		return errors.New("chat id is required")
	}

	updatedAt := normaliseTimestamp(chat["updatedAt"])
	if updatedAt == 0 {
		updatedAt = time.Now().UnixMilli()
	}
	chat["updatedAt"] = updatedAt

	return s.saveDocument(chatDocumentKey(id), documentKindChat, chat, updatedAt)
}

func (s *Store) DeleteChat(id string) error {
	if id == "" {
		return nil
	}

	if _, err := s.db.Exec(`DELETE FROM app_documents WHERE key = ? AND kind = ?`, chatDocumentKey(id), documentKindChat); err != nil {
		return fmt.Errorf("delete chat %q: %w", id, err)
	}

	return nil
}

func (s *Store) DeleteAllChats() error {
	if _, err := s.db.Exec(`DELETE FROM app_documents WHERE kind = ?`, documentKindChat); err != nil {
		return fmt.Errorf("delete chats: %w", err)
	}

	return nil
}

func (s *Store) LoadReplyPreferences() ([]JSONMap, error) {
	preferences := []JSONMap{}
	found, err := s.loadDocument("reply-preferences", &preferences)
	if err != nil {
		return nil, err
	}
	if !found {
		return []JSONMap{}, nil
	}

	return preferences, nil
}

func (s *Store) ReplaceReplyPreferences(preferences []JSONMap) error {
	if preferences == nil {
		preferences = []JSONMap{}
	}

	return s.saveDocument("reply-preferences", documentKindReplyMemory, preferences, time.Now().UnixMilli())
}

func (s *Store) SeedFromBrowser(snapshot Snapshot) (bool, error) {
	empty, err := s.IsEmpty()
	if err != nil {
		return false, err
	}
	if !empty {
		return false, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return false, fmt.Errorf("begin seed transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	now := time.Now().UnixMilli()
	if err = saveDocumentTx(tx, "settings", documentKindSettings, normaliseSettings(snapshot.Settings), now); err != nil {
		return false, err
	}
	if err = saveDocumentTx(tx, "workspaces", documentKindWorkspaces, emptySlice(snapshot.Workspaces), now); err != nil {
		return false, err
	}
	if err = saveDocumentTx(tx, "reply-preferences", documentKindReplyMemory, emptySlice(snapshot.ReplyPreferences), now); err != nil {
		return false, err
	}

	for _, chat := range snapshot.Chats {
		chatID, _ := chat["id"].(string)
		if chatID == "" {
			continue
		}

		updatedAt := normaliseTimestamp(chat["updatedAt"])
		if updatedAt == 0 {
			updatedAt = now
		}
		chat["updatedAt"] = updatedAt

		if err = saveDocumentTx(tx, chatDocumentKey(chatID), documentKindChat, chat, updatedAt); err != nil {
			return false, err
		}
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("commit seed transaction: %w", err)
	}

	return true, nil
}

func (s *Store) IsEmpty() (bool, error) {
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM app_documents`).Scan(&count); err != nil {
		return false, fmt.Errorf("count documents: %w", err)
	}

	return count == 0, nil
}

func (s *Store) loadDocument(key string, target any) (bool, error) {
	var payload string
	err := s.db.QueryRow(`SELECT payload FROM app_documents WHERE key = ?`, key).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("load document %q: %w", key, err)
	}

	if err := json.Unmarshal([]byte(payload), target); err != nil {
		return false, fmt.Errorf("decode document %q: %w", key, err)
	}

	return true, nil
}

func (s *Store) saveDocument(key string, kind string, payload any, updatedAt int64) error {
	return saveDocumentTx(s.db, key, kind, payload, updatedAt)
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func saveDocumentTx(execer execer, key string, kind string, payload any, updatedAt int64) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode document %q: %w", key, err)
	}

	if _, err := execer.Exec(`
INSERT INTO app_documents (key, kind, payload, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  kind = excluded.kind,
  payload = excluded.payload,
  updated_at = excluded.updated_at
`, key, kind, string(body), updatedAt); err != nil {
		return fmt.Errorf("save document %q: %w", key, err)
	}

	return nil
}

func chatDocumentKey(id string) string {
	return "chat:" + id
}

func normaliseTimestamp(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case float32:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}

func emptySlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}

	return items
}
