import { describe, it, expect } from 'vitest';
import {
  contentTypeFor,
  parseByteRange,
  parsePublicRequestPath,
  parseCookie,
  publicFilesUrl,
  renderDirectoryListing,
} from './public-files';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('parsePublicRequestPath', () => {
  it('splits the session id from decoded segments', () => {
    expect(parsePublicRequestPath(`/${ID}/plots/a%20b.png`)).toEqual({
      sessionId: ID,
      segments: ['plots', 'a b.png'],
      trailingSlash: false,
    });
  });

  it('distinguishes the root with and without a trailing slash', () => {
    expect(parsePublicRequestPath(`/${ID}`)).toEqual({
      sessionId: ID,
      segments: [],
      trailingSlash: false,
    });
    expect(parsePublicRequestPath(`/${ID}/`)).toEqual({
      sessionId: ID,
      segments: [],
      trailingSlash: true,
    });
    expect(parsePublicRequestPath(`/${ID}/dir/`)?.trailingSlash).toBe(true);
  });

  it('rejects non-UUID session ids', () => {
    expect(parsePublicRequestPath('/../etc/passwd')).toBeNull();
    expect(parsePublicRequestPath('/abc/x')).toBeNull();
    expect(parsePublicRequestPath('/')).toBeNull();
    expect(parsePublicRequestPath(ID)).toBeNull();
  });

  it('rejects segments that could escape the directory', () => {
    for (const bad of ['..', '%2E%2E', '.', 'a%2Fb', 'a%5Cb', 'a%00b', '%E0%A4%A', 'a//b']) {
      expect(parsePublicRequestPath(`/${ID}/${bad}`)).toBeNull();
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

describe('publicFilesUrl', () => {
  it('joins the base and session and ends in a slash so relative links resolve', () => {
    expect(publicFilesUrl('https://h.ts.net:8444', ID)).toBe(`https://h.ts.net:8444/${ID}/`);
    expect(publicFilesUrl('https://h.ts.net:8444/', ID)).toBe(`https://h.ts.net:8444/${ID}/`);
  });
});

describe('parseCookie', () => {
  it('finds a named cookie among others', () => {
    expect(parseCookie('a=1; public_auth=tok; b=2', 'public_auth')).toBe('tok');
    expect(parseCookie('public_auth=tok', 'public_auth')).toBe('tok');
  });

  it('returns null when absent or empty', () => {
    expect(parseCookie(undefined, 'public_auth')).toBeNull();
    expect(parseCookie('x_public_auth=tok', 'public_auth')).toBeNull();
    expect(parseCookie('public_auth=', 'public_auth')).toBeNull();
  });
});

describe('renderDirectoryListing', () => {
  it('lists directories first with trailing slashes and encoded hrefs', () => {
    const html = renderDirectoryListing('/x/', [
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

describe('parseByteRange', () => {
  it('serves the whole file without a usable header', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=5-2', 100)).toBeNull();
  });

  it('parses bounded, open-ended, and suffix ranges, clamping to the file', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects ranges past the end', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
