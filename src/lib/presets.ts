/**
 * presets.ts — Loads preset system prompts from src/presets/*.md.
 *
 * To add or edit a preset: modify the corresponding .md file in
 * src/presets/ — no TypeScript changes needed beyond registering it here.
 *
 * The Code preset always uses the deep-planning execution engine in
 * ChatPanel — the user just picks Code and sends their task.
 */

import codePrompt     from '../presets/code.md?raw';
import autoChatPrompt from '../presets/auto-chat.md?raw';
import chatbotPrompt  from '../presets/chatbot.md?raw';
import creativePrompt from '../presets/creative.md?raw';
import deepResearchPrompt from '../presets/deep-research.md?raw';
import noteTakingPrompt from '../presets/note-taking.md?raw';

export interface Preset {
  id: string;
  label: string;
  icon: string;
  systemPrompt: string;
}

export const PRESETS: Preset[] = [
  { id: 'code',     label: 'Code',     icon: 'code',     systemPrompt: codePrompt },
  { id: 'auto-chat', label: 'Auto',    icon: 'chatbot',  systemPrompt: autoChatPrompt },
  { id: 'chatbot',  label: 'Chatbot',  icon: 'chatbot',  systemPrompt: chatbotPrompt },
  { id: 'deep-research', label: 'Deep Research', icon: 'chatbot', systemPrompt: deepResearchPrompt },
  { id: 'note-taking', label: 'Note Taking', icon: 'chatbot', systemPrompt: noteTakingPrompt },
  { id: 'creative', label: 'Creative', icon: 'creative', systemPrompt: creativePrompt },
];

export const DEFAULT_PRESET_ID = 'code';

export function getPreset(id: string): Preset {
  return PRESETS.find(p => p.id === id) ?? PRESETS[0];
}
