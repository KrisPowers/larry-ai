import standardEnglishPrompt from '../presets/standard-english.md?raw';

export function appendSharedResponseStylePrompt(prompt: string): string {
  const basePrompt = prompt.trimEnd();
  const sharedPrompt = standardEnglishPrompt.trim();

  if (!basePrompt) return sharedPrompt;
  return `${basePrompt}\n\n---\n\n${sharedPrompt}`;
}
