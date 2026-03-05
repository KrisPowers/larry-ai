/**
 * FileRegistry — tracks every file the AI has written in a chat session.
 *
 * Stored as a simple Map<relativePath, content>.
 * The path comes from the suggestedFilename on each CodeBlock — the AI is
 * instructed (via system prompt) to always use full relative paths like
 * src/components/App.tsx rather than bare filenames.
 *
 * The registry is rebuilt from scratch whenever a panel's message history is
 * loaded, by replaying all assistant messages in order.
 */

export interface FileEntry {
  path: string;       // e.g. "src/components/App.tsx"
  content: string;
  lang: string;
  updatedAt: number;  // message index it was last written in
}

export type FileRegistry = Map<string, FileEntry>;

export function createRegistry(): FileRegistry {
  return new Map();
}

/**
 * Merges newly parsed code blocks into the registry.
 * Called after each assistant message is finalised.
 */
export function updateRegistry(
  registry: FileRegistry,
  blocks: Array<{ path: string; content: string; lang: string }>,
  messageIndex: number,
): FileRegistry {
  const next = new Map(registry);
  for (const b of blocks) {
    if (!b.path || !b.content.trim()) continue;
    next.set(b.path, {
      path: b.path,
      content: b.content,
      lang: b.lang,
      updatedAt: messageIndex,
    });
  }
  return next;
}

/**
 * Rebuilds a fresh registry by replaying all assistant messages.
 * Used when loading a chat from history.
 */
export function buildRegistryFromMessages(
  messages: Array<{ role: string; content: string }>,
  parseCodeBlocks: (raw: string) => Array<{ path: string; content: string; lang: string }>,
): FileRegistry {
  let registry = createRegistry();
  messages.forEach((msg, idx) => {
    if (msg.role === 'assistant') {
      const blocks = parseCodeBlocks(msg.content);
      registry = updateRegistry(registry, blocks, idx);
    }
  });
  return registry;
}

/**
 * Renders the registry as a compact system-prompt section so the AI
 * knows exactly what files already exist and what their contents are.
 */
export function registryToSystemPrompt(registry: FileRegistry): string {
  if (registry.size === 0) return '';

  const entries = [...registry.values()].sort((a, b) => a.path.localeCompare(b.path));

  const fileList = entries
    .map(e => `- ${e.path}`)
    .join('\n');

  const fileContents = entries
    .map(e => `### ${e.path}\n\`\`\`${e.lang}\n${e.content}\n\`\`\``)
    .join('\n\n');

  return `\n\n---\n## Current project files\n\nThe following files have already been written. When editing, output the COMPLETE updated file content — do not use placeholders or omit unchanged sections.\n\n**File tree:**\n${fileList}\n\n**File contents:**\n${fileContents}\n---`;
}
