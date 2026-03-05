import type { Message } from '../types';

export const OLLAMA_BASE = 'http://localhost:11434';

/**
 * Base system prompt injected before every conversation.
 * Instructs the model to always use full relative paths as code block
 * filenames so we can build an accurate file registry and zip.
 */
export const BASE_SYSTEM_PROMPT = `You are a programming assistant. When you write code or file content, follow these rules exactly:

1. Every code block that represents a file MUST begin with a comment on the very first line declaring its path, using this exact format:
   - For JS/TS/CSS/etc: // FILE: path/to/filename.ext
   - For Python:        # FILE: path/to/filename.ext
   - For HTML/XML:     <!-- FILE: path/to/filename.ext -->
   - For Markdown:      <!-- FILE: path/to/filename.md -->
   - For JSON/YAML:    place the path only in the fence label, e.g. \`\`\`json src/config.json

2. Always use full relative paths (e.g. src/components/Button.tsx, not just Button.tsx).

3. When editing an existing file, output the COMPLETE file — never use "..." or "unchanged" placeholders.

4. When creating multiple related files for a project, organise them into logical directories (src/, public/, etc.).

5. Do not wrap entire project responses in a single code block. Each file gets its own fenced block.`;

export async function fetchModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
    signal: AbortSignal.timeout(3000),
  });
  const data = await res.json();
  return (data.models ?? []).map((m: { name: string }) => m.name);
}

export async function* streamChat(
  model: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  // Build the messages array with system prompt prepended
  const payload = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model, messages: payload, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama error ${res.status}: ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.message?.content) yield j.message.content as string;
      } catch {
        // skip malformed lines
      }
    }
  }
}
