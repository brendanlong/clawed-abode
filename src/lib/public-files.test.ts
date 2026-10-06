import { describe, it, expect } from 'vitest';
import {
  contentTypeFor,
  parseByteRange,
  parsePublicRequestPath,
  parseCookie,
  publicAuthCookie,
  publicFilesUrl,
  publicLinkPath,
  publicLoginUrl,
  renderDirectoryListing,
  renderLoginPage,
  safeNextPath,
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

describe('publicAuthCookie', () => {
  it('sets an HttpOnly, Secure, Lax cookie for the whole host', () => {
    expect(publicAuthCookie('tok', 60)).toBe(
      'public_auth=tok; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax'
    );
  });

  it('expires the cookie for a null token', () => {
    expect(publicAuthCookie(null, 60)).toContain('public_auth=; Path=/; Max-Age=0;');
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin paths with their query', () => {
    expect(safeNextPath(`/${ID}/a.html?x=1#y`)).toBe(`/${ID}/a.html?x=1#y`);
  });

  it('rejects anything that could leave the origin', () => {
    for (const raw of [
      null,
      '',
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example/',
      'a',
    ]) {
      expect(safeNextPath(raw)).toBe('/');
    }
  });
});

describe('publicLoginUrl', () => {
  it('points at the login endpoint with the code and next path', () => {
    const url = new URL(publicLoginUrl('https://h.ts.net:8444', 'c0de', `/${ID}/a b.html`));
    expect(url.origin).toBe('https://h.ts.net:8444');
    expect(url.pathname).toBe('/_login');
    expect(url.searchParams.get('code')).toBe('c0de');
    expect(url.searchParams.get('next')).toBe(`/${ID}/a b.html`);
  });
});

describe('publicLinkPath', () => {
  const base = 'https://h.ts.net:8444';

  it('returns the path, query, and fragment of links into the public server', () => {
    expect(publicLinkPath(`${base}/${ID}/a.html?x=1#top`, base)).toBe(`/${ID}/a.html?x=1#top`);
  });

  it('ignores other origins, including the app on the same host', () => {
    expect(publicLinkPath(`https://h.ts.net/${ID}/`, base)).toBeNull();
    expect(publicLinkPath(`https://other.ts.net:8444/${ID}/`, base)).toBeNull();
    expect(publicLinkPath('not a url', base)).toBeNull();
  });

  it('ignores links to the login endpoint itself', () => {
    expect(publicLinkPath(`${base}/_login?next=/`, base)).toBeNull();
  });
});

describe('renderLoginPage', () => {
  it('posts the escaped next path and error to the login endpoint', () => {
    const html = renderLoginPage({ next: '/"><script>', error: '<b>bad</b>' });
    expect(html).toContain('action="/_login"');
    expect(html).toContain('value="/&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).not.toContain('<script>');
  });
});
