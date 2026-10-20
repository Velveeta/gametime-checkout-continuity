'use client';
import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { secondsLeft } from '@/lib/ui/presentation';
import type { LiveSnapshot } from '@/lib/ui/http';

export function Countdown({
  snapshot,
  onZero,
}: {
  snapshot: LiveSnapshot;
  onZero: () => void;
}) {
  const { reservationExpiresAt: deadline } = snapshot.session;
  const [remaining, setRemaining] = useState(() =>
    secondsLeft(deadline, Date.parse(snapshot.serverNow), 0),
  );
  const checked = useRef<string | null>(null);
  const serverMs = snapshot.sample?.serverMs ?? Date.parse(snapshot.serverNow);
  const sampledMono = snapshot.sample?.mono;
  useEffect(() => {
    // performance.now is monotonic and independent of the device's wall clock.
    const anchor = sampledMono ?? performance.now();
    const tick = () => {
      const next = secondsLeft(deadline, serverMs, performance.now() - anchor);
      setRemaining(next);
      if (next === 0 && checked.current !== deadline) {
        checked.current = deadline;
        onZero();
      }
    };
    const immediate = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
    };
  }, [deadline, serverMs, sampledMono, onZero]);
  const label = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  return (
    <div
      className={`reservation-timer ${remaining < 60 ? 'timer-urgent' : ''}`}
    >
      <Clock3 size={19} aria-hidden="true" />
      <div>
        <strong>
          {remaining > 0
            ? 'These tickets are held for you'
            : 'Checking your reservation…'}
        </strong>
        <span>
          {remaining > 0
            ? 'Finish checkout before your hold ends.'
            : 'Confirming the latest status with the server.'}
        </span>
      </div>
      <span
        className="countdown"
        role="timer"
        aria-label="Time remaining"
        data-testid="countdown"
      >
        {label}
      </span>
    </div>
  );
}
