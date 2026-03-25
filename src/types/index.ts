// FILE: src/types/index.ts
import type { FileRegistry } from '../lib/fileRegistry';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  model: string;
  preset: string;
  projectId?: string;
  projectLabel?: string;
  messages: Message[];
  updatedAt: number;
  fileEntries?: Array<{ path: string; content: string; lang: string; updatedAt: number }>;
}

export interface ProjectFolder {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * Describes the current multi-phase streaming state shown in the UI.
 * Null when no multi-phase operation is in progress.
 */
export interface StreamingPhase {
  /** Full label shown in the indicator, e.g. "Step 2 of 5 — src/lib" */
  label: string;
  /** 0 = planning, 1+ = implementation steps */
  stepIndex: number;
  /** Total number of implementation steps (0 during planning) */
  totalSteps: number;
}

export interface Panel {
  id: string;
  title: string;
  model: string;
  preset: string;
  projectId?: string;
  projectLabel?: string;
  messages: Message[];
  streaming: boolean;
  streamingContent: string;
  fileRegistry: FileRegistry;
  prevRegistry: FileRegistry;
  streamingPhase: StreamingPhase | null;
}

export type OllamaStatus = 'connecting' | 'online' | 'error';
