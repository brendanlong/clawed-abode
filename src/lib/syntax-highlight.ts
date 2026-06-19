import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import { getFileType } from './file-types';

/**
 * Map a {@link getFileType} result to a registered highlight.js language id.
 * File types with no corresponding grammar (e.g. `prisma`, `text`) are absent
 * and fall back to plain, escaped rendering.
 */
const FILE_TYPE_TO_HLJS: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
  go: 'go',
  java: 'java',
  kotlin: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  markdown: 'markdown',
  sql: 'sql',
  shell: 'bash',
  docker: 'dockerfile',
};

let registered = false;

/** Register the curated language set once (highlight.js is a singleton). */
function ensureRegistered(): void {
  if (registered) return;
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('ruby', ruby);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('kotlin', kotlin);
  hljs.registerLanguage('swift', swift);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('scss', scss);
  hljs.registerLanguage('less', less);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('dockerfile', dockerfile);
  registered = true;
}

/** Escape HTML so plain (un-highlighted) code is rendered safely as text. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlight `code` for the given {@link getFileType} result, returning an HTML
 * string of `<span class="hljs-...">` tokens (themed via CSS). Languages without
 * a grammar — or any highlighting error — fall back to escaped plain text, so
 * the output is always safe to inject. Pure function: same inputs → same output.
 */
export function highlightCode(code: string, fileType: string): string {
  const language = FILE_TYPE_TO_HLJS[fileType];
  if (!language) return escapeHtml(code);

  ensureRegistered();
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** Convenience: highlight by file path rather than a pre-computed file type. */
export function highlightCodeForFile(code: string, filePath: string): string {
  return highlightCode(code, getFileType(filePath));
}
