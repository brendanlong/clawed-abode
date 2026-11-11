// Speech recognizers don't reliably space separately recognized results:
// desktop Chrome prefixes later results with a space, Android Chrome doesn't,
// and nothing spaces across recognition sessions or after typed text.
export function joinSpeechText(...parts: string[]): string {
  return parts.reduce((joined, part) => {
    if (!joined || !part || /\s$/.test(joined) || /^\s/.test(part)) return joined + part;
    return `${joined} ${part}`;
  }, '');
}
