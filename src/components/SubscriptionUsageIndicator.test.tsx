import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubscriptionUsageIndicator } from './SubscriptionUsageIndicator';
import type { UsageBar } from '@/lib/usage';

const resetsAtMs = Date.now() + 60 * 60 * 1000;
const session: UsageBar = { label: 'Session', percentUsed: 58, exhausted: false, resetsAtMs };
const weekly: UsageBar = { label: 'Weekly', percentUsed: 44, exhausted: false, resetsAtMs };

function meterValues() {
  return screen
    .getAllByRole('meter')
    .map((m) => [m.getAttribute('aria-label'), m.getAttribute('aria-valuenow')]);
}

describe('SubscriptionUsageIndicator', () => {
  it('shows the session and all-models weekly bars', () => {
    render(
      <SubscriptionUsageIndicator
        usage={{ fiveHour: session, weeklyAllModels: weekly, weeklyModel: null, weekly }}
      />
    );
    expect(meterValues()).toEqual([
      ['Session', '58'],
      ['Weekly', '44'],
    ]);
  });

  it('shows the chosen weekly bar, not the all-models one', () => {
    const fable: UsageBar = { ...weekly, label: 'Weekly (Fable)', percentUsed: 86 };
    render(
      <SubscriptionUsageIndicator
        usage={{
          fiveHour: session,
          weeklyAllModels: { ...weekly, label: 'Weekly (all models)' },
          weeklyModel: fable,
          weekly: fable,
        }}
      />
    );
    expect(meterValues()).toEqual([
      ['Session', '58'],
      ['Weekly (Fable)', '86'],
    ]);
  });

  it('shows an exhausted window as full', () => {
    render(
      <SubscriptionUsageIndicator
        usage={{
          fiveHour: { ...session, exhausted: true, percentUsed: null },
          weeklyAllModels: null,
          weeklyModel: null,
          weekly: null,
        }}
      />
    );
    expect(meterValues()).toEqual([['Session', '100']]);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders nothing without any window', () => {
    const { container } = render(
      <SubscriptionUsageIndicator
        usage={{ fiveHour: null, weeklyAllModels: null, weeklyModel: null, weekly: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
