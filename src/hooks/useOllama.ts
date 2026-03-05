import { useState, useEffect, useCallback } from 'react';
import { fetchModels } from '../lib/ollama';
import type { OllamaStatus } from '../types';

export function useOllama() {
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<OllamaStatus>('connecting');

  const check = useCallback(async () => {
    try {
      const m = await fetchModels();
      setModels(m);
      setStatus('online');
    } catch {
      setModels([]);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [check]);

  return { models, status };
}
