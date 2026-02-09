import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrStatusIndicator } from './PrStatusIndicator';
import type { PullRequestInfo } from '@/hooks/usePullRequestStatus';

const basePr: PullRequestInfo = {
  number: 42,
  title: 'Add feature X',
  state: 'open',
  draft: false,
  url: 'https://github.com/owner/repo/pull/42',
  author: 'testuser',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('PrStatusIndicator', () => {
  it('renders a link to the PR', () => {
    render(<PrStatusIndicator pullRequest={basePr} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows correct aria-label for open PR', () => {
    render(<PrStatusIndicator pullRequest={basePr} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'PR #42: Add feature X (Open)');
  });

  it('shows correct aria-label for merged PR', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, state: 'merged' }} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'PR #42: Add feature X (Merged)');
  });

  it('shows correct aria-label for closed PR', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, state: 'closed' }} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'PR #42: Add feature X (Closed)');
  });

  it('shows draft label for draft PRs', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, draft: true }} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'PR #42: Add feature X (Draft)');
  });

  it('applies green color class for open PRs', () => {
    render(<PrStatusIndicator pullRequest={basePr} />);

    const link = screen.getByRole('link');
    expect(link.className).toContain('text-green-600');
  });

  it('applies purple color class for merged PRs', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, state: 'merged' }} />);

    const link = screen.getByRole('link');
    expect(link.className).toContain('text-purple-600');
  });

  it('applies red color class for closed PRs', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, state: 'closed' }} />);

    const link = screen.getByRole('link');
    expect(link.className).toContain('text-red-600');
  });

  it('applies muted color class for draft PRs', () => {
    render(<PrStatusIndicator pullRequest={{ ...basePr, draft: true }} />);

    const link = screen.getByRole('link');
    expect(link.className).toContain('text-muted-foreground');
  });

  it('renders an SVG icon', () => {
    render(<PrStatusIndicator pullRequest={basePr} />);

    const link = screen.getByRole('link');
    const svg = link.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<PrStatusIndicator pullRequest={basePr} className="custom-class" />);

    const link = screen.getByRole('link');
    expect(link.className).toContain('custom-class');
  });
});
