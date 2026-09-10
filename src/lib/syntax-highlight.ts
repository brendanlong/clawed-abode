import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import { escapeHtml } from '@/lib/html-escape';
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

interface Language {
  /** The file type name shown in the UI and used as the highlight.js language id. */
  name: string;
  extensions: string[];
  /** Grammar registered under `name`; null for types rendered as plain text. */
  grammar: LanguageFn | null;
}

/**
 * The one table behind file-type detection and highlighting: add a language here
 * and both `getFileType` and `highlightCode` pick it up.
 */
const LANGUAGES: Language[] = [
  { name: 'typescript', extensions: ['ts', 'tsx'], grammar: typescript },
  { name: 'javascript', extensions: ['js', 'jsx'], grammar: javascript },
  { name: 'python', extensions: ['py'], grammar: python },
  { name: 'ruby', extensions: ['rb'], grammar: ruby },
  { name: 'rust', extensions: ['rs'], grammar: rust },
  { name: 'go', extensions: ['go'], grammar: go },
  { name: 'java', extensions: ['java'], grammar: java },
  { name: 'kotlin', extensions: ['kt'], grammar: kotlin },
  { name: 'swift', extensions: ['swift'], grammar: swift },
  { name: 'c', extensions: ['c', 'h'], grammar: c },
  { name: 'cpp', extensions: ['cpp', 'hpp'], grammar: cpp },
  { name: 'css', extensions: ['css'], grammar: css },
  { name: 'scss', extensions: ['scss'], grammar: scss },
  { name: 'less', extensions: ['less'], grammar: less },
  { name: 'html', extensions: ['html'], grammar: xml },
  { name: 'xml', extensions: ['xml'], grammar: xml },
  { name: 'json', extensions: ['json'], grammar: json },
  { name: 'yaml', extensions: ['yaml', 'yml'], grammar: yaml },
  { name: 'markdown', extensions: ['md'], grammar: markdown },
  { name: 'sql', extensions: ['sql'], grammar: sql },
  { name: 'shell', extensions: ['sh', 'bash', 'zsh'], grammar: bash },
  { name: 'docker', extensions: ['dockerfile'], grammar: dockerfile },
  { name: 'prisma', extensions: ['prisma'], grammar: null },
];

const EXTENSION_TO_FILE_TYPE = new Map(
  LANGUAGES.flatMap((lang) => lang.extensions.map((ext) => [ext, lang.name] as const))
);

const HIGHLIGHTABLE = new Set(LANGUAGES.filter((lang) => lang.grammar).map((lang) => lang.name));

/** Detect file type from extension; `text` when unknown. */
export function getFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TO_FILE_TYPE.get(ext) ?? 'text';
}

let registered = false;

/** Register the curated language set once (highlight.js is a singleton). */
function ensureRegistered(): void {
  if (registered) return;
  for (const lang of LANGUAGES) {
    if (lang.grammar) hljs.registerLanguage(lang.name, lang.grammar);
  }
  registered = true;
}

/**
 * Above this length, skip highlighting and render escaped plain text. hljs runs
 * synchronously on the render thread, so a huge file would freeze the tab.
 */
const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * Highlight `code` for the given `getFileType` result, returning an HTML
 * string of `<span class="hljs-...">` tokens (themed via CSS). Languages without
 * a grammar, inputs over {@link MAX_HIGHLIGHT_CHARS}, or any highlighting error
 * fall back to escaped plain text, so the output is always safe to inject. Pure
 * function: same inputs → same output.
 */
export function highlightCode(code: string, fileType: string): string {
  if (!HIGHLIGHTABLE.has(fileType) || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);

  ensureRegistered();
  try {
    return hljs.highlight(code, { language: fileType, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
