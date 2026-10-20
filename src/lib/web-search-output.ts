/** Parsing of the WebSearch tool's text output, shared by its card and the tool-result summary. */

export interface SearchLink {
  title: string;
  url: string;
}

export interface ParsedWebSearchOutput {
  query: string;
  links: SearchLink[];
  summary: string;
}

/**
 * Parse WebSearch output into structured components, or null for empty output.
 * The output format is:
 * - First line: "Web search results for query: \"...\""
 * - Links line: "Links: [{...}, ...]"
 * - Rest: Summary text
 */
export function parseWebSearchOutput(output: string): ParsedWebSearchOutput | null {
  if (!output) {
    return null;
  }

  const result: ParsedWebSearchOutput = {
    query: '',
    links: [],
    summary: '',
  };

  const lines = output.split('\n');
  let summaryStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const queryMatch = line.match(/^Web search results for query: "(.+)"$/);
    if (queryMatch) {
      result.query = queryMatch[1];
      summaryStartIndex = i + 1;
      continue;
    }

    if (line.startsWith('Links: ')) {
      try {
        const parsed: unknown = JSON.parse(line.substring('Links: '.length));
        if (Array.isArray(parsed)) {
          result.links = parsed.filter(
            (item): item is SearchLink =>
              typeof item === 'object' &&
              item !== null &&
              typeof item.title === 'string' &&
              typeof item.url === 'string'
          );
        }
      } catch {
        // If parsing fails, just skip the links
      }
      summaryStartIndex = i + 1;
      continue;
    }
  }

  // Everything after the links line is the summary
  result.summary = lines.slice(summaryStartIndex).join('\n').trim();

  return result;
}
