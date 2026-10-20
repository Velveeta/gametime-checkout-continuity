import type { Analytics, AnalyticsEvent } from './ports';
import type { CheckoutSnapshot } from './checkout-service';

/** Observational only: delivery/clock failures must not block state transitions. */
export function recordEvents(
  analytics: Analytics,
  snapshot: CheckoutSnapshot,
  names: readonly AnalyticsEvent['name'][],
  surface: NonNullable<AnalyticsEvent['surface']>,
  observedAt?: () => AnalyticsEvent['at'],
) {
  void Promise.allSettled(
    names.map(async (name) =>
      analytics.record({
        name,
        sessionId: snapshot.session.id,
        version: snapshot.session.version,
        at: snapshot.serverNow,
        surface,
        ...(observedAt ? { observedAt: observedAt() } : {}),
      }),
    ),
  );
}
