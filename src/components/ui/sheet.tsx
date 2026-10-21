'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetTitle = Dialog.Title;
export const SheetDescription = Dialog.Description;

export function SheetContent({
  children,
  className,
  side = 'right',
  closeLabel = 'Close developer menu',
  ...props
}: ComponentProps<typeof Dialog.Content> & {
  side?: 'right' | 'bottom';
  closeLabel?: string;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="sheet-overlay" />
      <Dialog.Content
        className={cn(
          side === 'bottom' ? 'sheet-bottom' : 'developer-sheet',
          className,
        )}
        {...props}
      >
        <Dialog.Close className="sheet-close" aria-label={closeLabel}>
          <X aria-hidden="true" size={20} />
        </Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
