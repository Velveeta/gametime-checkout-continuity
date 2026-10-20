import type { Analytics, AnalyticsEvent } from '../../application/ports';

const funnelNames: Partial<Record<AnalyticsEvent['name'], string>> = {
  checkout_expired: 'hold_expired',
  checkout_recovered: 'recovered',
  quote_changed: 'price_changed',
  quote_accepted: 'price_acknowledged',
  payment_claimed: 'payment_attempted',
  payment_failed: 'checkout_failed',
};

/** Allowlisted structured logs, not an exactly-once analytics delivery system. */
export class ConsoleAnalytics implements Analytics {
  constructor(
    private readonly write: (line: string) => void = (line) =>
      console.info(line),
  ) {}
  async record(event: AnalyticsEvent) {
    this.write(
      JSON.stringify({
        type: 'checkout_event',
        name: funnelNames[event.name] ?? event.name,
        domainEvent: event.name,
        sessionId: event.sessionId,
        version: event.version,
        at: event.at,
        surface: event.surface ?? 'application',
        ...(event.observedAt ? { observedAt: event.observedAt } : {}),
      }),
    );
  }
}
