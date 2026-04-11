package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultEndpoint = "http://localhost:11434"
	modelTimeout    = 3 * time.Second
)

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type listResponse struct {
	Models []struct {
		Name string `json:"name"`
	} `json:"models"`
}

type chatResponse struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
}

type chatStreamChunk struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
	Error string `json:"error"`
	Done  bool   `json:"done"`
}

type providerErrorPayload struct {
	Error   any    `json:"error"`
	Message string `json:"message"`
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

func NormalizeEndpoint(endpoint string) string {
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" {
		return defaultEndpoint
	}

	if strings.HasPrefix(trimmed, "/") {
		return strings.TrimRight(trimmed, "/")
	}

	if strings.HasPrefix(strings.ToLower(trimmed), "http://") || strings.HasPrefix(strings.ToLower(trimmed), "https://") {
		return strings.TrimRight(trimmed, "/")
	}

	return "http://" + strings.TrimRight(trimmed, "/")
}

func FetchModels(endpoint string) ([]string, error) {
	base := NormalizeEndpoint(endpoint)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, base+"/api/tags", nil)
	if err != nil {
		return nil, fmt.Errorf("build Ollama models request: %w", err)
	}

	client := &http.Client{Timeout: modelTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("unable to connect to Ollama: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, buildHTTPError(res)
	}

	var payload listResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode Ollama models: %w", err)
	}

	models := make([]string, 0, len(payload.Models))
	for _, model := range payload.Models {
		name := strings.TrimSpace(model.Name)
		if name == "" {
			continue
		}
		models = append(models, name)
	}

	return models, nil
}

func Chat(ctx context.Context, endpoint string, model string, messages []ChatMessage) (string, error) {
	base := NormalizeEndpoint(endpoint)
	req, err := newChatRequest(ctx, base, model, messages, false)
	if err != nil {
		return "", err
	}

	res, err := (&http.Client{}).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("unable to connect to Ollama: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", buildHTTPError(res)
	}

	var payload chatResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode Ollama chat response: %w", err)
	}

	return payload.Message.Content, nil
}

func StreamChat(
	ctx context.Context,
	endpoint string,
	model string,
	messages []ChatMessage,
	emit func(chunk string),
) error {
	base := NormalizeEndpoint(endpoint)
	req, err := newChatRequest(ctx, base, model, messages, true)
	if err != nil {
		return err
	}

	res, err := (&http.Client{}).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("unable to connect to Ollama: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return buildHTTPError(res)
	}

	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		var chunk chatStreamChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			return fmt.Errorf("decode Ollama stream chunk: %w", err)
		}

		if strings.TrimSpace(chunk.Error) != "" {
			return fmt.Errorf("Ollama error: %s", strings.TrimSpace(chunk.Error))
		}

		if chunk.Message.Content != "" {
			emit(chunk.Message.Content)
		}

		if chunk.Done {
			return nil
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("read Ollama stream: %w", err)
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}

	return nil
}

func newChatRequest(
	ctx context.Context,
	base string,
	model string,
	messages []ChatMessage,
	stream bool,
) (*http.Request, error) {
	body, err := json.Marshal(chatRequest{
		Model:    model,
		Messages: messages,
		Stream:   stream,
	})
	if err != nil {
		return nil, fmt.Errorf("encode Ollama chat request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build Ollama chat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

func buildHTTPError(res *http.Response) error {
	detail := ""
	body, err := io.ReadAll(res.Body)
	if err == nil {
		detail = extractErrorDetail(body)
	}

	if detail == "" {
		detail = strings.TrimSpace(res.Status)
	}

	return fmt.Errorf("Ollama error %d: %s", res.StatusCode, detail)
}

func extractErrorDetail(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}

	var payload providerErrorPayload
	if err := json.Unmarshal([]byte(trimmed), &payload); err == nil {
		switch typed := payload.Error.(type) {
		case string:
			if text := strings.TrimSpace(typed); text != "" {
				return text
			}
		case map[string]any:
			if message, ok := typed["message"].(string); ok && strings.TrimSpace(message) != "" {
				return strings.TrimSpace(message)
			}
		}

		if text := strings.TrimSpace(payload.Message); text != "" {
			return text
		}
	}

	return strings.Join(strings.Fields(trimmed), " ")
}
