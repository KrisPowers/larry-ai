package main

import (
	"context"
	"fmt"
	"sync"

	"github.com/krisp/ai-chat-ui/internal/ollama"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const ollamaStreamEventPrefix = "ollama-stream:"

func (a *App) FetchOllamaModels(endpoint string) ([]string, error) {
	return ollama.FetchModels(endpoint)
}

func (a *App) ChatOllama(
	endpoint string,
	requestID string,
	model string,
	messages []ollama.ChatMessage,
) (string, error) {
	ctx, cleanup := a.trackOllamaRequest(requestID)
	defer cleanup()

	return ollama.Chat(ctx, endpoint, model, messages)
}

func (a *App) StartOllamaChatStream(
	endpoint string,
	requestID string,
	model string,
	messages []ollama.ChatMessage,
) error {
	ctx, cleanup := a.trackOllamaRequest(requestID)
	defer cleanup()

	eventName := ollamaStreamEventPrefix + requestID
	return ollama.StreamChat(ctx, endpoint, model, messages, func(chunk string) {
		runtime.EventsEmit(a.ctx, eventName, chunk)
	})
}

func (a *App) CancelOllamaRequest(requestID string) error {
	if requestID == "" {
		return nil
	}

	cancel, ok := a.ollamaRequests.Load(requestID)
	if !ok {
		return nil
	}

	cancelFunc, ok := cancel.(context.CancelFunc)
	if !ok {
		return fmt.Errorf("invalid Ollama request handle for %q", requestID)
	}

	cancelFunc()
	return nil
}

func (a *App) trackOllamaRequest(requestID string) (context.Context, func()) {
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}

	ctx, cancel := context.WithCancel(parent)
	if requestID != "" {
		a.ollamaRequests.Store(requestID, cancel)
	}

	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel()
			if requestID != "" {
				a.ollamaRequests.Delete(requestID)
			}
		})
	}
}
