'use client';

import { useState } from 'react';
import qrcode from 'qrcode-generator';
import Image from 'next/image';
import { Check, Copy, Smartphone, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ShareCheckout({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [message, setMessage] = useState('');

  function reveal() {
    const value = `${window.location.origin}/checkout/${id}`;

    setUrl(value);
    const code = qrcode(0, 'M');

    code.addData(value);
    code.make();
    setQr(code.createDataURL(4, 8));
    setOpen(!open);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('Checkout link copied.');
    } catch {
      setMessage('Select the link below to copy it.');
    }
  }

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Your Gametime checkout', url });
      } else {
        await copy();
      }
    } catch {
      setMessage('You can copy the link instead.');
    }
  }

  return (
    <section className="handoff">
      <div>
        <Smartphone size={24} aria-hidden="true" />
        <div>
          <h3>Pick up where you left off.</h3>
          <p>Open this checkout on your phone. Your tickets stay together.</p>
        </div>
      </div>
      <Button
        variant="outline"
        onClick={reveal}
        aria-expanded={open}
        aria-controls="share-panel"
      >
        {open ? 'Close sharing' : 'Continue on another device'}
      </Button>
      {open && (
        <div id="share-panel" className="share-panel">
          <Image
            unoptimized
            src={qr}
            width={160}
            height={160}
            alt="Scan to open this same checkout on your phone"
          />
          <div>
            <strong>Same tickets. Same countdown.</strong>
            <p>
              This link shares your checkout, not your booking confirmation.
            </p>
            <label>
              Checkout link
              <input
                value={url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <div className="share-actions">
              <Button variant="outline" onClick={copy}>
                {message.startsWith('Checkout') ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Copy size={16} aria-hidden="true" />
                )}
                Copy link
              </Button>
              <Button variant="outline" onClick={share}>
                <Share2 size={16} aria-hidden="true" />
                Share
              </Button>
            </div>
          </div>
          <p role="status" className="fine-print">
            {message}
          </p>
        </div>
      )}
    </section>
  );
}
