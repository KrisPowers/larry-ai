import { useState, useEffect, useCallback } from 'react';
import { fetchModelCatalog, normalizeOllamaBase } from '../lib/ollama';
import type { ModelCatalogStatus, ModelProviderState } from '../types';

interface UseOllamaOptions {
  endpoint?: string;
  openAIApiKey?: string;
  anthropicApiKey?: string;
}

export function useOllama({ endpoint, openAIApiKey, anthropicApiKey }: UseOllamaOptions = {}) {
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<ModelCatalogStatus>('connecting');
  const [providers, setProviders] = useState<ModelProviderState[]>([]);
  const normalizedEndpoint = normalizeOllamaBase(endpoint);

  const check = useCallback(async () => {
    try {
      const catalog = await fetchModelCatalog({
        ollamaBase: normalizedEndpoint,
        openAIApiKey,
        anthropicApiKey,
      });
      setModels(catalog.models);
      setProviders(catalog.providers);
      setStatus(catalog.models.length || catalog.providers.some((provider) => provider.online) ? 'online' : 'error');
    } catch {
      setModels([]);
      setProviders([]);
      setStatus('error');
    }
  }, [anthropicApiKey, normalizedEndpoint, openAIApiKey]);

  useEffect(() => {
    setStatus('connecting');
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [check]);

  return { models, providers, status, refresh: check };
}
