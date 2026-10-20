import Link from 'next/link';
import { ArrowUpRight, ShieldCheck, Ticket, Zap } from 'lucide-react';

export function Header() {
  return (
    <header className="site-header">
      <Link href="/" aria-label="Gametime home" className="wordmark">
        <Ticket aria-hidden="true" size={27} />
        <span>
          gametime<span className="brand-dot">.</span>
        </span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/#events">
          Find your next event <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
        <span className="demo-pill">Simulated experience</span>
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <Link href="/" className="wordmark">
        <Ticket size={22} aria-hidden="true" />
        gametime.
      </Link>
      <p>Real moments start with a ticket.</p>
      <p className="fine-print">
        Fictional events, inventory and prices. All purchases are simulated. No
        real payments.
      </p>
      <span>Made for the moment.</span>
    </footer>
  );
}

export function Assurance() {
  return (
    <div className="assurance">
      <span>
        <ShieldCheck size={19} aria-hidden="true" />
        Secure checkout
      </span>
      <span>
        <Zap size={18} aria-hidden="true" />
        Seamless across devices
      </span>
    </div>
  );
}
