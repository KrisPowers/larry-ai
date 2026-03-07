// FILE: src/lib/ollama.ts
import type { Message } from '../types';

export const OLLAMA_BASE = 'http://localhost:11434';

export async function fetchModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
    signal: AbortSignal.timeout(3000),
  });
  const data = await res.json();
  return (data.models ?? []).map((m: { name: string }) => m.name);
}

/**
 * Single non-streaming request — used for the planning phase.
 * Returns the full response text once complete.
 */
export async function chatOnce(
  model: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const payload = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model, messages: payload, stream: false }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  return data.message?.content ?? '';
}

/**
 * Streaming request — used for implementation phases.
 * Yields text chunks as they arrive.
 */
export async function* streamChat(
  model: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
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
