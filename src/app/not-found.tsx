import Link from 'next/link';
import { Header, Footer } from '@/components/marketplace/chrome';

export default function NotFound() {
  return (
    <>
      <Header />
      <main id="main" className="error-page page-width">
        <span className="eyebrow">A DIFFERENT KIND OF DETOUR</span>
        <h1>That moment isn&apos;t here.</h1>
        <p>Let&apos;s find you another reason to get out there.</p>
        <Link className="hero-cta dark-cta" href="/">
          Explore events
        </Link>
      </main>
      <Footer />
    </>
  );
}
