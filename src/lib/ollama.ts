import type { Message, ModelProvider, ModelProviderState } from '../types';

export const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
export const OLLAMA_BASE_STORAGE_KEY = 'larry_ollama_base_v1';
export const OPENAI_API_KEY_STORAGE_KEY = 'larry_openai_api_key_v1';
export const ANTHROPIC_API_KEY_STORAGE_KEY = 'larry_anthropic_api_key_v1';
export const OPENAI_UI_SAMPLE_KEY = 'openai-ui-sample-key';
export const ANTHROPIC_UI_SAMPLE_KEY = 'anthropic-ui-sample-key';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';
const OPENAI_MODEL_TIMEOUT_MS = 5_000;
const ANTHROPIC_MODEL_TIMEOUT_MS = 5_000;
const OLLAMA_MODEL_TIMEOUT_MS = 3_000;
const PROVIDER_LABELS: Record<ModelProvider, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};
const MODEL_TOKEN_ALIASES: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  coder: 'Coder',
  deepseek: 'DeepSeek',
  flash: 'Flash',
  gemma: 'Gemma',
  gpt: 'GPT',
  haiku: 'Haiku',
  llama: 'Llama',
  max: 'Max',
  mini: 'Mini',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  nano: 'Nano',
  nemo: 'Nemo',
  opus: 'Opus',
  phi: 'Phi',
  pro: 'Pro',
  qwen: 'Qwen',
  reasoning: 'Reasoning',
  rtx: 'RTX',
  sonnet: 'Sonnet',
  turbo: 'Turbo',
  ultra: 'Ultra',
};
const OLLAMA_STOP_TOKENS = new Set([
  'base',
  'chat',
  'fp16',
  'fp32',
  'gguf',
  'instruct',
  'it',
  'latest',
  'preview',
  'reasoning',
  'text',
  'thinking',
  'tool',
  'tools',
  'vision',
]);
const OPENAI_UI_SAMPLE_MODELS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
];
const ANTHROPIC_UI_SAMPLE_MODELS = [
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307',
];

const ENV_OLLAMA_BASE =
  (import.meta.env?.VITE_OLLAMA_BASE as string | undefined)?.replace(/\/$/, '') ??
  DEFAULT_OLLAMA_BASE;

interface ProviderFetchOptions {
  ollamaBase?: string;
  openAIApiKey?: string;
  anthropicApiKey?: string;
}

interface ModelCatalogResult {
  models: string[];
  providers: ModelProviderState[];
}

interface DecodedModelHandle {
  provider: ModelProvider;
  modelId: string;
}

function getStoredValue(key: string): string {
  if (typeof window === 'undefined') return '';

  try {
    return localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function setStoredValue(key: string, value: string): string {
  const trimmed = value.trim();

  if (typeof window !== 'undefined') {
    try {
      if (trimmed) {
        localStorage.setItem(key, trimmed);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore storage failures and still return the trimmed value
    }
  }

  return trimmed;
}

function isLikelyTextModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!id) return false;
  if (/^(gpt|o\d|chatgpt|codex)/.test(id) === false) return false;
  if (
    /(audio|realtime|transcribe|tts|embedding|whisper|moderation|image|vision-preview|dall-e|search-preview|computer-use|omni-moderation)/.test(id)
  ) {
    return false;
  }
  return true;
}

function isSampleOpenAIKey(apiKey: string): boolean {
  return apiKey.trim() === OPENAI_UI_SAMPLE_KEY;
}

function isSampleAnthropicKey(apiKey: string): boolean {
  return apiKey.trim() === ANTHROPIC_UI_SAMPLE_KEY;
}

function parseEventStreamChunk(chunk: string): string[] {
  return chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s*/, '').trim())
    .filter(Boolean);
}

function extractAnthropicText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type?: string; text?: string } => typeof item === 'object' && item !== null)
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text ?? '')
    .join('');
}

function extractHttpErrorDetail(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: string | { message?: string };
      message?: string;
    };

    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }

    if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }

    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Fall back to the raw response body when it is not JSON.
  }

  return trimmed.replace(/\s+/g, ' ');
}

async function buildProviderHttpError(provider: ModelProvider, res: Response): Promise<Error> {
  let detail = '';

  try {
    detail = extractHttpErrorDetail(await res.text());
  } catch {
    // Ignore response parsing failures and fall back to the status text.
  }

  const label = PROVIDER_LABELS[provider];
  return new Error(`${label} error ${res.status}: ${detail || res.statusText || 'Request failed'}`);
}

export function normalizeOllamaBase(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return ENV_OLLAMA_BASE;
  if (raw.startsWith('/')) return raw.replace(/\/$/, '') || '/';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  return `http://${raw.replace(/\/$/, '')}`;
}

export function getOllamaBase(): string {
  if (typeof window === 'undefined') {
    return normalizeOllamaBase(ENV_OLLAMA_BASE);
  }

  try {
    return normalizeOllamaBase(localStorage.getItem(OLLAMA_BASE_STORAGE_KEY) ?? ENV_OLLAMA_BASE);
  } catch {
    return normalizeOllamaBase(ENV_OLLAMA_BASE);
  }
}

export function setOllamaBase(value: string): string {
  const normalized = normalizeOllamaBase(value);

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(OLLAMA_BASE_STORAGE_KEY, normalized);
    } catch {
      // ignore storage failures and still return the normalized value
    }
  }

  return normalized;
}

export function getOpenAIApiKey(): string {
  return getStoredValue(OPENAI_API_KEY_STORAGE_KEY);
}

export function setOpenAIApiKey(value: string): string {
  return setStoredValue(OPENAI_API_KEY_STORAGE_KEY, value);
}

export function getAnthropicApiKey(): string {
  return getStoredValue(ANTHROPIC_API_KEY_STORAGE_KEY);
}

export function setAnthropicApiKey(value: string): string {
  return setStoredValue(ANTHROPIC_API_KEY_STORAGE_KEY, value);
}

export function buildModelHandle(provider: ModelProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function parseModelHandle(handle?: string | null): DecodedModelHandle {
  const raw = (handle ?? '').trim();
  const match = raw.match(/^(ollama|openai|anthropic):(.+)$/i);
  if (match) {
    return {
      provider: match[1].toLowerCase() as ModelProvider,
      modelId: match[2],
    };
  }

  return {
    provider: 'ollama',
    modelId: raw,
  };
}

export function normalizeModelHandle(handle?: string | null): string {
  const { provider, modelId } = parseModelHandle(handle);
  return modelId ? buildModelHandle(provider, modelId) : '';
}

export function resolveModelHandle(
  handle: string | undefined,
  availableModels: string[],
  options: { preserveUnavailable?: boolean } = {},
): string {
  const normalized = normalizeModelHandle(handle);
  if (normalized && availableModels.includes(normalized)) return normalized;
  if (normalized && options.preserveUnavailable) return normalized;
  if (!normalized && availableModels.length) return availableModels[0];
  return normalized || availableModels[0] || '';
}

export function getModelProvider(handle?: string | null): ModelProvider {
  return parseModelHandle(handle).provider;
}

export function getModelProviderLabel(handle?: string | null): string {
  return PROVIDER_LABELS[getModelProvider(handle)];
}

function formatOpenAIModelName(modelId: string): string | null {
  const clean = modelId.trim().toLowerCase();
  if (!clean) return null;

  const gptMatch = clean.match(/^gpt-(4o|4\.1|5(?:\.\d+)?)(?:-(mini|nano))?$/i);
  if (gptMatch) {
    const family = gptMatch[1].startsWith('5') ? '5' : gptMatch[1];
    const variant = gptMatch[2] ? ` ${MODEL_TOKEN_ALIASES[gptMatch[2]] ?? gptMatch[2]}` : '';
    return `GPT-${family}${variant}`;
  }

  const reasoningMatch = clean.match(/^(o\d)(?:-(mini|pro))?$/i);
  if (reasoningMatch) {
    const variant = reasoningMatch[2] ? ` ${MODEL_TOKEN_ALIASES[reasoningMatch[2]] ?? reasoningMatch[2]}` : '';
    return `${reasoningMatch[1]}${variant}`;
  }

  return null;
}

function formatAnthropicModelName(modelId: string): string | null {
  const clean = modelId.trim().toLowerCase();
  if (!clean.startsWith('claude')) return null;

  let match = clean.match(/^claude-(opus|sonnet|haiku)-(\d)(?:-(\d))?(?:-\d+)?$/i);
  if (match) {
    const family = MODEL_TOKEN_ALIASES[match[1]] ?? match[1];
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `Claude ${family} ${version}`;
  }

  match = clean.match(/^claude-(\d)(?:-(\d))?-(sonnet|haiku)(?:-\d+)?$/i);
  if (match) {
    const family = MODEL_TOKEN_ALIASES[match[3]] ?? match[3];
    const version = match[2] ? `${match[1]}.${match[2]}` : match[1];
    return `Claude ${family} ${version}`;
  }

  return 'Claude';
}

function normalizeModelToken(token: string): string[] {
  const clean = token.trim().toLowerCase();
  if (!clean) return [];

  return clean
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d)([a-z])/gi, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

function isQuantizationToken(token: string): boolean {
  return /^(q\d|iq\d|f16|fp16|fp32|gguf|k|km|m|s|xs)$/i.test(token);
}

function formatGenericToken(token: string): string {
  const clean = token.trim().toLowerCase();
  if (!clean) return '';
  if (MODEL_TOKEN_ALIASES[clean]) return MODEL_TOKEN_ALIASES[clean];
  if (/^\d+(?:\.\d+)?$/.test(clean)) return clean;
  if (/^\d+b$/i.test(clean)) return `${clean.slice(0, -1)}B`;
  if (/^r\d+$/i.test(clean)) return `R${clean.slice(1)}`;
  if (/^v\d+$/i.test(clean)) return `V${clean.slice(1)}`;
  if (/^[a-z]\d+$/i.test(clean)) return clean[0].toUpperCase() + clean.slice(1);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function formatOllamaModelName(modelId: string): string {
  const [base, tag] = modelId.trim().split(':', 2);
  const rawTokens = [
    ...base.replace(/[._/]+/g, ' ').split(/[\s-]+/),
    ...(tag && tag.toLowerCase() !== 'latest' ? tag.replace(/[._/]+/g, ' ').split(/[\s-]+/) : []),
  ].flatMap((token) => normalizeModelToken(token));

  const filtered = rawTokens.filter((token) => {
    if (!token) return false;
    if (OLLAMA_STOP_TOKENS.has(token)) return false;
    if (isQuantizationToken(token)) return false;
    return true;
  });

  const formatted = filtered.map((token) => formatGenericToken(token)).filter(Boolean);
  return formatted.join(' ').trim() || modelId || 'No model detected';
}

export function getModelDisplayName(handle?: string | null): string {
  const { provider, modelId } = parseModelHandle(handle);
  if (!modelId) return 'No model detected';

  if (provider === 'openai') {
    return formatOpenAIModelName(modelId) ?? modelId;
  }

  if (provider === 'anthropic') {
    return formatAnthropicModelName(modelId) ?? modelId;
  }

  return formatOllamaModelName(modelId);
}

export function getModelDisplayLabel(handle?: string | null): string {
  const name = getModelDisplayName(handle);
  if (name === 'No model detected') return name;
  return `${name} · ${getModelProviderLabel(handle)}`;
}

async function fetchOllamaModels(base: string): Promise<string[]> {
  const res = await fetch(`${base}/api/tags`, {
    signal: AbortSignal.timeout(OLLAMA_MODEL_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('ollama', res);
  }

  const data = await res.json();
  return (data.models ?? [])
    .map((model: { name?: string }) => model.name?.trim() ?? '')
    .filter(Boolean)
    .map((modelId: string) => buildModelHandle('ollama', modelId));
}

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  if (isSampleOpenAIKey(apiKey)) {
    return OPENAI_UI_SAMPLE_MODELS.map((modelId) => buildModelHandle('openai', modelId));
  }

  const res = await fetch(`${OPENAI_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(OPENAI_MODEL_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('openai', res);
  }

  const data = await res.json();
  return (data.data ?? [])
    .map((model: { id?: string }) => model.id?.trim() ?? '')
    .filter(isLikelyTextModelId)
    .sort((left: string, right: string) => left.localeCompare(right))
    .map((modelId: string) => buildModelHandle('openai', modelId));
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  if (isSampleAnthropicKey(apiKey)) {
    return ANTHROPIC_UI_SAMPLE_MODELS.map((modelId) => buildModelHandle('anthropic', modelId));
  }

  const res = await fetch(`${ANTHROPIC_API_BASE}/models`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    signal: AbortSignal.timeout(ANTHROPIC_MODEL_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('anthropic', res);
  }

  const data = await res.json();
  return (data.data ?? [])
    .map((model: { id?: string }) => model.id?.trim() ?? '')
    .filter((modelId: string) => modelId.toLowerCase().startsWith('claude'))
    .sort((left: string, right: string) => left.localeCompare(right))
    .map((modelId: string) => buildModelHandle('anthropic', modelId));
}

export async function fetchModelCatalog(options: ProviderFetchOptions = {}): Promise<ModelCatalogResult> {
  const ollamaBase = normalizeOllamaBase(options.ollamaBase ?? getOllamaBase());
  const openAIApiKey = (options.openAIApiKey ?? getOpenAIApiKey()).trim();
  const anthropicApiKey = (options.anthropicApiKey ?? getAnthropicApiKey()).trim();

  const providerTasks: Array<Promise<{ models: string[]; state: ModelProviderState }>> = [
    (async () => {
      try {
        const models = await fetchOllamaModels(ollamaBase);
        return {
          models,
          state: {
            provider: 'ollama',
            label: PROVIDER_LABELS.ollama,
            enabled: true,
            online: true,
            modelCount: models.length,
          },
        };
      } catch (error) {
        return {
          models: [],
          state: {
            provider: 'ollama',
            label: PROVIDER_LABELS.ollama,
            enabled: true,
            online: false,
            modelCount: 0,
            error: error instanceof Error ? error.message : 'Unable to connect',
          },
        };
      }
    })(),
    openAIApiKey
      ? (async () => {
          try {
            const models = await fetchOpenAIModels(openAIApiKey);
            return {
              models,
              state: {
                provider: 'openai',
                label: PROVIDER_LABELS.openai,
                enabled: true,
                online: true,
                modelCount: models.length,
                mode: isSampleOpenAIKey(openAIApiKey) ? 'sample' : 'live',
              },
            };
          } catch (error) {
            return {
              models: [],
              state: {
                provider: 'openai',
                label: PROVIDER_LABELS.openai,
                enabled: true,
                online: false,
                modelCount: 0,
                error: error instanceof Error ? error.message : 'Unable to connect',
              },
            };
          }
        })()
      : Promise.resolve({
          models: [],
          state: {
            provider: 'openai' as const,
            label: PROVIDER_LABELS.openai,
            enabled: false,
            online: false,
            modelCount: 0,
          },
        }),
    anthropicApiKey
      ? (async () => {
          try {
            const models = await fetchAnthropicModels(anthropicApiKey);
            return {
              models,
              state: {
                provider: 'anthropic',
                label: PROVIDER_LABELS.anthropic,
                enabled: true,
                online: true,
                modelCount: models.length,
                mode: isSampleAnthropicKey(anthropicApiKey) ? 'sample' : 'live',
              },
            };
          } catch (error) {
            return {
              models: [],
              state: {
                provider: 'anthropic',
                label: PROVIDER_LABELS.anthropic,
                enabled: true,
                online: false,
                modelCount: 0,
                error: error instanceof Error ? error.message : 'Unable to connect',
              },
            };
          }
        })()
      : Promise.resolve({
          models: [],
          state: {
            provider: 'anthropic' as const,
            label: PROVIDER_LABELS.anthropic,
            enabled: false,
            online: false,
            modelCount: 0,
          },
        }),
  ];

  const providerResults = await Promise.all(providerTasks);
  const models = providerResults.flatMap((result) => result.models);
  const providers = providerResults.map((result) => result.state);

  return {
    models,
    providers,
  };
}

export async function fetchModels(
  base = getOllamaBase(),
  options: Pick<ProviderFetchOptions, 'openAIApiKey' | 'anthropicApiKey'> = {},
): Promise<string[]> {
  const catalog = await fetchModelCatalog({
    ollamaBase: base,
    openAIApiKey: options.openAIApiKey,
    anthropicApiKey: options.anthropicApiKey,
  });
  return catalog.models;
}

function buildPayloadMessages(messages: Message[], systemPrompt: string) {
  return [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map(({ role, content }) => ({ role, content })),
  ];
}

async function chatOnceWithOllama(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const base = getOllamaBase();
  const payload = buildPayloadMessages(messages, systemPrompt);

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model: modelId, messages: payload, stream: false }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('ollama', res);
  }

  const data = await res.json();
  return data.message?.content ?? '';
}

async function chatOnceWithOpenAI(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const payload = buildPayloadMessages(messages, systemPrompt);
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error('OpenAI API key not configured');
  if (isSampleOpenAIKey(apiKey)) {
    throw new Error('The OpenAI sample UI key only unlocks demo models. Add a real API key to send requests.');
  }

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: modelId,
      messages: payload,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('openai', res);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function chatOnceWithAnthropic(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error('Anthropic API key not configured');
  if (isSampleAnthropicKey(apiKey)) {
    throw new Error('The Anthropic sample UI key only unlocks demo models. Add a real API key to send requests.');
  }

  const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    signal,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: false,
    }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('anthropic', res);
  }

  const data = await res.json();
  return extractAnthropicText(data.content);
}

/**
 * Single non-streaming request used for the planning phase.
 */
export async function chatOnce(
  model: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const { provider, modelId } = parseModelHandle(model);
  if (!modelId) throw new Error('No model selected');

  if (provider === 'openai') {
    return chatOnceWithOpenAI(modelId, messages, systemPrompt, signal);
  }

  if (provider === 'anthropic') {
    return chatOnceWithAnthropic(modelId, messages, systemPrompt, signal);
  }

  return chatOnceWithOllama(modelId, messages, systemPrompt, signal);
}

async function* streamWithOllama(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const base = getOllamaBase();
  const payload = buildPayloadMessages(messages, systemPrompt);

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model: modelId, messages: payload, stream: true }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('ollama', res);
  }

  if (!res.body) {
    throw new Error('Ollama error: response body missing');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.message?.content) yield json.message.content as string;
      } catch {
        // skip malformed lines
      }
    }
  }
}

async function* streamWithOpenAI(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const payload = buildPayloadMessages(messages, systemPrompt);
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error('OpenAI API key not configured');
  if (isSampleOpenAIKey(apiKey)) {
    throw new Error('The OpenAI sample UI key only unlocks demo models. Add a real API key to send requests.');
  }

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: modelId,
      messages: payload,
      stream: true,
    }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('openai', res);
  }

  if (!res.body) {
    throw new Error('OpenAI error: response body missing');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const payloadLines = parseEventStreamChunk(part);
      for (const line of payloadLines) {
        if (line === '[DONE]') continue;
        try {
          const json = JSON.parse(line);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            yield delta;
          }
        } catch {
          // skip malformed event payloads
        }
      }
    }
  }
}

async function* streamWithAnthropic(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error('Anthropic API key not configured');
  if (isSampleAnthropicKey(apiKey)) {
    throw new Error('The Anthropic sample UI key only unlocks demo models. Add a real API key to send requests.');
  }

  const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    signal,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: true,
    }),
  });

  if (!res.ok) {
    throw await buildProviderHttpError('anthropic', res);
  }

  if (!res.body) {
    throw new Error('Anthropic error: response body missing');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const payloadLines = parseEventStreamChunk(part);
      for (const line of payloadLines) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'content_block_delta' && typeof json.delta?.text === 'string') {
            yield json.delta.text;
          }
        } catch {
          // skip malformed event payloads
        }
      }
    }
  }
}

/**
 * Streaming request used for implementation and single-pass reply phases.
 */
export async function* streamChat(
  model: string,
  messages: Message[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const { provider, modelId } = parseModelHandle(model);
  if (!modelId) throw new Error('No model selected');

  if (provider === 'openai') {
    yield* streamWithOpenAI(modelId, messages, systemPrompt, signal);
    return;
  }

  if (provider === 'anthropic') {
    yield* streamWithAnthropic(modelId, messages, systemPrompt, signal);
    return;
  }

  yield* streamWithOllama(modelId, messages, systemPrompt, signal);
}
