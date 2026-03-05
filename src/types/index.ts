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
}

export interface Panel {
  id: string;
  title: string;
  model: string;
  messages: Message[];
  streaming: boolean;
  streamingContent: string;
}

export type OllamaStatus = 'connecting' | 'online' | 'error';
