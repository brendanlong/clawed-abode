/**
 * Map of file extensions to language/file type names.
 * Used for syntax highlighting hints in tool displays.
 */
const FILE_TYPE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dockerfile: 'docker',
  prisma: 'prisma',
};

/**
 * Detect file type from extension for syntax highlighting hints.
 */
export function getFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return FILE_TYPE_MAP[ext] ?? 'text';
}
