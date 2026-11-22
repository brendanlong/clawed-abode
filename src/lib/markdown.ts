import {
  Marked,
  type MarkedExtension,
  type RendererObject,
  type Tokens,
  type TokenizerExtension,
} from 'marked';

const BASE_OPTIONS: MarkedExtension = { gfm: true, breaks: true };

// Only allow double-tilde strikethrough (`~~text~~`). Claude uses a single `~`
// to mean "approximately" (e.g. `~5 minutes`) far more often than for
// strikethrough, so match `~~…~~` only and leave single tildes as literal text.
const doubleTildeDel: MarkedExtension = {
  tokenizer: {
    del(src: string): Tokens.Del | undefined {
      const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!match) return undefined;
      return {
        type: 'del',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
  },
};

const UNSPOKEN_BLOCK = 'unspokenBlock';
const UNSPOKEN_INLINE = 'unspokenInline';

/**
 * `<unspoken>…</unspoken>` marks text for the transcript only: it renders as
 * ordinary markdown and is left out of read-aloud. A tokenizer (not a regex over
 * the source) so a literal tag inside a code span or fence stays literal. A tag
 * that opens a line and closes at the end of one is a block, so it can wrap
 * tables and lists; anywhere else it's inline. An unclosed tag runs to the end.
 */
const unspokenTokenizers: TokenizerExtension[] = [
  {
    name: UNSPOKEN_BLOCK,
    level: 'block',
    start(src) {
      const match = /(^|\n)<unspoken>/.exec(src);
      return match ? match.index + match[1].length : undefined;
    },
    tokenizer(src) {
      const match = /^<unspoken>([\s\S]*?)(?:<\/unspoken>[ \t]*(?:\n|$)|$(?![\s\S]))/.exec(src);
      if (!match) return undefined;
      return {
        type: UNSPOKEN_BLOCK,
        raw: match[0],
        tokens: this.lexer.blockTokens(match[1].trim()),
      };
    },
  },
  {
    name: UNSPOKEN_INLINE,
    level: 'inline',
    start(src) {
      const index = src.indexOf('<unspoken>');
      return index >= 0 ? index : undefined;
    },
    tokenizer(src) {
      const match = /^<unspoken>([\s\S]*?)(?:<\/unspoken>|$(?![\s\S]))/.exec(src);
      if (!match) return undefined;
      return {
        type: UNSPOKEN_INLINE,
        raw: match[0],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
  },
];

/** Renders markdown to HTML for the transcript (sanitize before inserting it). */
export const displayMarkdown = new Marked(BASE_OPTIONS, doubleTildeDel, {
  extensions: [
    ...unspokenTokenizers,
    {
      name: UNSPOKEN_BLOCK,
      renderer(token) {
        return this.parser.parse(token.tokens ?? []);
      },
    },
    {
      name: UNSPOKEN_INLINE,
      renderer(token) {
        return this.parser.parseInline(token.tokens ?? []);
      },
    },
  ],
});

const line = (text: string) => `${text}\n`;

// What a listener should hear: the words the transcript shows, without markdown
// syntax or link targets. Every block ends in a line break, which ends a speech
// request (see splitIntoSpeechChunks).
const plainTextRenderer: RendererObject<string, string> = {
  space: () => '',
  code: ({ text }) => line(text),
  blockquote({ tokens }) {
    return this.parser.parse(tokens);
  },
  html({ text, block }) {
    const stripped = text.replace(/<[^>]*>/g, '');
    return block ? line(stripped.trim()) : stripped;
  },
  def: () => '',
  heading({ tokens }) {
    return line(this.parser.parseInline(tokens));
  },
  hr: () => '',
  list({ items }) {
    return items.map((item) => this.listitem(item)).join('');
  },
  listitem({ tokens }) {
    return line(this.parser.parse(tokens).trim());
  },
  checkbox: () => '',
  paragraph({ tokens }) {
    return line(this.parser.parseInline(tokens));
  },
  table({ header, rows }) {
    return [header, ...rows]
      .map((cells) => line(cells.map((cell) => this.parser.parseInline(cell.tokens)).join(', ')))
      .join('');
  },
  strong({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  em({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  codespan: ({ text }) => text,
  br: () => '\n',
  del({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  link({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  image: ({ text }) => text,
  text(token) {
    return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : token.text;
  },
};

const speechMarkdown = new Marked(BASE_OPTIONS, doubleTildeDel, {
  renderer: plainTextRenderer,
  extensions: [
    ...unspokenTokenizers,
    { name: UNSPOKEN_BLOCK, renderer: () => '' },
    { name: UNSPOKEN_INLINE, renderer: () => '' },
  ],
});

/** The text to read aloud for a message's markdown. */
export function markdownToSpeechText(markdown: string): string {
  return speechMarkdown.parse(markdown, { async: false });
}
