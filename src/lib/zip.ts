/**
 * zip.ts — Builds a downloadable .zip from the FileRegistry using fflate.
 *
 * fflate is a pure-JS zip/deflate library (~30kb), no WASM, no server needed.
 * Each FileEntry becomes a zip entry at its full relative path, preserving
 * the directory structure the AI emitted.
 */
import { zipSync, strToU8 } from 'fflate';
import type { FileRegistry } from './fileRegistry';

export function downloadRegistryAsZip(registry: FileRegistry, zipName = 'project.zip'): void {
  if (registry.size === 0) return;

  const files: Record<string, Uint8Array> = {};

  for (const entry of registry.values()) {
    // fflate uses forward slashes; normalise any backslashes just in case
    const path = entry.path.replace(/\\/g, '/').replace(/^\//, '');
    files[path] = strToU8(entry.content);
  }

  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}
