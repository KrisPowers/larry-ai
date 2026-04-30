function workspaceBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

const CONVENTIONAL_EXTENSIONLESS_WORKSPACE_FILES = new Set([
  'Brewfile',
  'Caddyfile',
  'Dockerfile',
  'Gemfile',
  'Jenkinsfile',
  'Justfile',
  'Makefile',
  'Podfile',
  'Procfile',
  'Rakefile',
  'Tiltfile',
  'Vagrantfile',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'README',
  'readme',
]);

const CONVENTIONAL_EXTENSIONLESS_WORKSPACE_FILE_PATTERNS = [
  /^Dockerfile\.[^.]+$/i,
];

export function isConventionalExtensionlessWorkspaceFile(path: string): boolean {
  const basename = workspaceBasename(path);
  if (!basename) return false;
  if (basename.startsWith('.')) return true;
  if (CONVENTIONAL_EXTENSIONLESS_WORKSPACE_FILES.has(basename)) return true;
  return CONVENTIONAL_EXTENSIONLESS_WORKSPACE_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

export function workspaceFilePathHasDefinedType(path: string): boolean {
  const basename = workspaceBasename(path);
  if (!basename) return false;
  if (isConventionalExtensionlessWorkspaceFile(basename)) return true;

  const dotIndex = basename.lastIndexOf('.');
  return dotIndex > 0 && dotIndex < basename.length - 1;
}
