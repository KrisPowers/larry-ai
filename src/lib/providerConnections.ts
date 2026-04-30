import type {
  ProviderConnectionSettings,
  ProviderSettingsMap,
} from '../types';

function createDefaultProviderConnectionSettings(): ProviderConnectionSettings {
  return {
    selectedModels: [],
    autoUpdate: true,
  };
}

export function createDefaultProviderSettingsMap(): ProviderSettingsMap {
  return {
    ollama: createDefaultProviderConnectionSettings(),
    openai: createDefaultProviderConnectionSettings(),
    anthropic: createDefaultProviderConnectionSettings(),
  };
}

export function normalizeProviderConnectionSettings(
  settings?: Partial<ProviderConnectionSettings> | null,
): ProviderConnectionSettings {
  const next = settings ?? {};

  return {
    selectedModels: Array.isArray(next.selectedModels)
      ? next.selectedModels
        .map((model) => (typeof model === 'string' ? model.trim() : ''))
        .filter(Boolean)
      : [],
    autoUpdate: next.autoUpdate !== false,
  };
}

export function normalizeProviderSettingsMap(
  settings?: Partial<ProviderSettingsMap> | null,
): ProviderSettingsMap {
  return {
    ollama: normalizeProviderConnectionSettings(settings?.ollama),
    openai: normalizeProviderConnectionSettings(settings?.openai),
    anthropic: normalizeProviderConnectionSettings(settings?.anthropic),
  };
}

export function cloneProviderSettingsMap(
  settings?: Partial<ProviderSettingsMap> | null,
): ProviderSettingsMap {
  return normalizeProviderSettingsMap(settings);
}
