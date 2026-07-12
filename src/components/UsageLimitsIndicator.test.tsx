import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { UsageLimitsIndicator } from './UsageLimitsIndicator';
import type { UsageLimit } from '@/lib/usage-limits';

const LIMITS: UsageLimit[] = [
  {
    kind: 'session',
    group: 'session',
    percent: 58,
    severity: 'normal',
    resets_at: '2026-07-03T05:00:00.050706+00:00',
    scope: null,
    is_active: false,
  },
  {
    kind: 'weekly_all',
    group: 'weekly',
    percent: 44,
    severity: 'normal',
    resets_at: '2026-07-07T13:00:00.050731+00:00',
    scope: null,
    is_active: false,
  },
  {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 86,
    severity: 'warning',
    resets_at: '2026-07-07T13:00:00.051043+00:00',
    scope: { model: { id: null, display_name: 'Fable' } },
    is_active: true,
  },
];

describe('UsageLimitsIndicator', () => {
  it('renders nothing when limits are unavailable', () => {
    const { container: nullCase } = render(<UsageLimitsIndicator limits={null} model={null} />);
    expect(nullCase.textContent).toBe('');

    const { container: emptyCase } = render(<UsageLimitsIndicator limits={[]} model={null} />);
    expect(emptyCase.textContent).toBe('');
  });

  it('shows session and the scoped weekly limit for a matching model', () => {
    const { container } = render(<UsageLimitsIndicator limits={LIMITS} model="claude-fable-5" />);
    expect(container.textContent).toContain('58% session');
    expect(container.textContent).toContain('86% week');
    expect(container.textContent).not.toContain('44%');
  });

  it('shows the all-models weekly limit for a non-matching model', () => {
    const { container } = render(<UsageLimitsIndicator limits={LIMITS} model="claude-opus-4-8" />);
    expect(container.textContent).toContain('58% session');
    expect(container.textContent).toContain('44% week');
  });
});
