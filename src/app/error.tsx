'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" className="error-page page-width">
      <span className="eyebrow">LET&apos;S GET YOU BACK TO IT</span>
      <h1>A small pause in the action.</h1>
      <p>
        We couldn&apos;t load the latest details. Please try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
      <Link href="/">Explore events</Link>
    </main>
  );
}
