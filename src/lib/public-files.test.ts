import { describe, it, expect } from 'vitest';
import {
  contentTypeFor,
  parsePublicRequestPath,
  publicUrlPath,
  renderDirectoryListing,
} from './public-files';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('parsePublicRequestPath', () => {
  it('splits the session id from decoded segments', () => {
    expect(parsePublicRequestPath(`/public/${ID}/plots/a%20b.png`)).toEqual({
      sessionId: ID,
      segments: ['plots', 'a b.png'],
      trailingSlash: false,
    });
  });

  it('distinguishes the root with and without a trailing slash', () => {
    expect(parsePublicRequestPath(`/public/${ID}`)).toEqual({
      sessionId: ID,
      segments: [],
      trailingSlash: false,
    });
    expect(parsePublicRequestPath(`/public/${ID}/`)).toEqual({
      sessionId: ID,
      segments: [],
      trailingSlash: true,
    });
    expect(parsePublicRequestPath(`/public/${ID}/dir/`)?.trailingSlash).toBe(true);
  });

  it('rejects non-UUID session ids', () => {
    expect(parsePublicRequestPath('/public/../etc/passwd')).toBeNull();
    expect(parsePublicRequestPath('/public/abc/x')).toBeNull();
    expect(parsePublicRequestPath('/other/x')).toBeNull();
  });

  it('rejects segments that could escape the directory', () => {
    for (const bad of ['..', '%2E%2E', '.', 'a%2Fb', 'a%5Cb', 'a%00b', '%E0%A4%A', 'a//b']) {
      expect(parsePublicRequestPath(`/public/${ID}/${bad}`)).toBeNull();
    }
  });
});

describe('contentTypeFor', () => {
  it('infers from the extension case-insensitively', () => {
    expect(contentTypeFor('index.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('plot.png')).toBe('image/png');
  });

  it('shows text-like files inline rather than downloading them', () => {
    expect(contentTypeFor('notes.md')).toBe('text/plain; charset=utf-8');
  });

  it('defaults to octet-stream', () => {
    expect(contentTypeFor('Makefile')).toBe('application/octet-stream');
    expect(contentTypeFor('data.bin')).toBe('application/octet-stream');
  });
});

describe('publicUrlPath', () => {
  it('ends in a slash so relative links resolve', () => {
    expect(publicUrlPath(ID)).toBe(`/public/${ID}/`);
  });
});

describe('renderDirectoryListing', () => {
  it('lists directories first with trailing slashes and encoded hrefs', () => {
    const html = renderDirectoryListing('/public/x/', [
      { name: 'z.png', isDirectory: false },
      { name: 'a dir', isDirectory: true },
    ]);
    expect(html.indexOf('a dir/')).toBeLessThan(html.indexOf('z.png'));
    expect(html).toContain('href="a%20dir/"');
  });

  it('escapes names', () => {
    const html = renderDirectoryListing('<t>', [{ name: '"><script>x', isDirectory: false }]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;t&gt;');
  });

  it('says when a directory is empty', () => {
    expect(renderDirectoryListing('/', [])).toContain('empty');
  });
});
