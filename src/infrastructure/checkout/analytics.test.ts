import { describe, expect, it } from 'vitest';
import { ConsoleAnalytics } from './analytics';
import type { AnalyticsEvent } from '../../application/ports';
import { instant, version } from '../../domain/values';

describe('submission telemetry contract', () => {
  it('publishes the nine funnel event names with session/surface correlation', async () => {
    const lines: string[] = [];
    const sink = new ConsoleAnalytics((line) => lines.push(line));
    const pairs: [AnalyticsEvent['name'], string][] = [
      ['checkout_created', 'checkout_created'],
      ['checkout_resumed', 'checkout_resumed'],
      ['checkout_expired', 'hold_expired'],
      ['checkout_recovered', 'recovered'],
      ['quote_changed', 'price_changed'],
      ['quote_accepted', 'price_acknowledged'],
      ['payment_claimed', 'payment_attempted'],
      ['checkout_completed', 'checkout_completed'],
      ['payment_failed', 'checkout_failed'],
    ];

    for (const [name, expected] of pairs) {
      await sink.record(
        Object.assign(
          {
            name,
            sessionId: 'session-1',
            version: version(2),
            at: instant('2027-01-01T00:00:00.000Z'),
            surface: 'http' as const,
          },
          { capability: 'never-log-this', callerSecret: 'never-log-this' },
        ),
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        name: expected,
        domainEvent: name,
        sessionId: 'session-1',
        version: 2,
        surface: 'http',
      });
    }

    expect(lines).toHaveLength(9);
    expect(lines.join('')).not.toContain('never-log-this');
  });
});
