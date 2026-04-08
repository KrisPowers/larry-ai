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
import { appendSharedResponseStylePrompt } from './responseStyle';

export interface Preset {
  id: string;
  label: string;
  icon: string;
  systemPrompt: string;
}

export const PRESETS: Preset[] = [
  { id: 'code',     label: 'Code',     icon: 'code',     systemPrompt: appendSharedResponseStylePrompt(codePrompt) },
  { id: 'auto-chat', label: 'Auto',    icon: 'chatbot',  systemPrompt: appendSharedResponseStylePrompt(autoChatPrompt) },
  { id: 'chatbot',  label: 'Chatbot',  icon: 'chatbot',  systemPrompt: appendSharedResponseStylePrompt(chatbotPrompt) },
  { id: 'deep-research', label: 'Deep Research', icon: 'chatbot', systemPrompt: appendSharedResponseStylePrompt(deepResearchPrompt) },
  { id: 'note-taking', label: 'Note Taking', icon: 'chatbot', systemPrompt: appendSharedResponseStylePrompt(noteTakingPrompt) },
  { id: 'creative', label: 'Creative', icon: 'creative', systemPrompt: appendSharedResponseStylePrompt(creativePrompt) },
];

export const DEFAULT_PRESET_ID = 'auto-chat';

export function getPreset(id: string): Preset {
  return PRESETS.find(p => p.id === id) ?? PRESETS[0];
}

export function describePreset(id: string): string {
  if (id === 'code') {
    return 'Uses the multi-step build and edit workflow for project implementation tasks.';
  }

  if (id === 'deep-research') {
    return 'Broader live retrieval, denser source comparison, and a longer answer when the prompt needs real research.';
  }

  if (id === 'auto-chat') {
    return 'Automatically routes between conversation, note-taking, and deeper research based on the prompt.';
  }

  if (id === 'note-taking') {
    return 'Organizes content into structured notes, key points, and action items.';
  }

  if (id === 'creative') {
    return 'Keeps the answer more open-ended, imaginative, and exploratory.';
  }

  return 'Balanced everyday chat responses with lightweight structure.';
}
