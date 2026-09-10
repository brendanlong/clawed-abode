import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders plain text', () => {
    render(<MarkdownContent content="Hello, world!" />);
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders markdown links with target="_blank"', () => {
    render(<MarkdownContent content="Check out [Google](https://google.com)!" />);
    const link = screen.getByRole('link', { name: 'Google' });
    expect(link).toHaveAttribute('href', 'https://google.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders autolinked URLs with target="_blank"', () => {
    render(<MarkdownContent content="Visit https://example.com for more info." />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps a quote-laden link title inside its attribute', () => {
    render(<MarkdownContent content={'[x](https://example.com "a \\" onmouseover=alert(1) b")'} />);
    const link = screen.getByRole('link', { name: 'x' });
    expect(link).toHaveAttribute('title', 'a " onmouseover=alert(1) b');
    expect(link).not.toHaveAttribute('onmouseover');
  });

  it('strips a javascript: URL from a link', () => {
    const { container } = render(<MarkdownContent content="[click me](javascript:alert(1))" />);
    const anchor = container.querySelector('a');
    expect(anchor?.textContent).toBe('click me');
    expect(anchor).not.toHaveAttribute('href');
  });

  it('overrides a model-supplied target on a raw anchor', () => {
    render(<MarkdownContent content={'<a href="https://example.com" target="_top">x</a>'} />);
    const link = screen.getByRole('link', { name: 'x' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders inline markup inside link text', () => {
    render(<MarkdownContent content="[**bold** link](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'bold link' });
    expect(link.querySelector('strong')?.textContent).toBe('bold');
  });

  it('escapes tag metacharacters in link text', () => {
    const { container } = render(<MarkdownContent content="[a<b](https://example.com)" />);
    expect(screen.getByRole('link').textContent).toBe('a<b');
    expect(container.querySelector('a b')).toBeNull();
  });

  it('renders bold and italic text', () => {
    render(<MarkdownContent content="This is **bold** and *italic*." />);
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
  });

  it('keeps single tildes literal (Claude uses `~` to mean "approximately")', () => {
    const { container } = render(<MarkdownContent content="It takes ~5 minutes." />);
    expect(container.querySelector('del')).toBeNull();
    expect(container.textContent).toContain('~5 minutes');
  });

  it('still renders double-tilde strikethrough', () => {
    const { container } = render(<MarkdownContent content="This is ~~struck~~." />);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('struck');
  });

  it('renders code blocks', () => {
    render(<MarkdownContent content={'```js\nconst x = 1;\n```'} />);
    // Code blocks contain the language identifier and code
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
  });

  it('sanitizes malicious HTML', () => {
    render(<MarkdownContent content='<script>alert("xss")</script>Hello' />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    // Script should be removed
    expect(document.querySelector('script')).toBeNull();
  });

  it('applies custom className', () => {
    const { container } = render(<MarkdownContent content="Test" className="custom-class" />);
    expect(container.firstChild).toHaveClass('markdown-content', 'custom-class');
  });
});
