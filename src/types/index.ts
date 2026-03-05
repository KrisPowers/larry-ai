import type { FileRegistry } from '../lib/fileRegistry';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  model: string;
  messages: Message[];
  updatedAt: number;
  // Serialised file registry: array of FileEntry values for IndexedDB storage
  fileEntries?: Array<{ path: string; content: string; lang: string; updatedAt: number }>;
}

export interface Panel {
  id: string;
  title: string;
  model: string;
  messages: Message[];
  streaming: boolean;
  streamingContent: string;
  fileRegistry: FileRegistry;
}

export type OllamaStatus = 'connecting' | 'online' | 'error';
