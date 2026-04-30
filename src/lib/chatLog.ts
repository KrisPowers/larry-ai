export const EXPORTED_SOURCE_METADATA_START = '<!-- LARRY-SOURCES-START -->';
export const EXPORTED_SOURCE_METADATA_END = '<!-- LARRY-SOURCES-END -->';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripExportedChatMetadata(text: string): string {
  if (!text) return '';
  const pattern = new RegExp(
    `${escapeRegex(EXPORTED_SOURCE_METADATA_START)}[\\s\\S]*?${escapeRegex(EXPORTED_SOURCE_METADATA_END)}`,
    'g',
  );
  return text.replace(pattern, '').trim();
}
