import { DomainError } from './errors';
import type { Listing, PriceQuote, SeatAllocation } from './models';
import { cents } from './values';

export type InventorySelection =
  | { readonly kind: 'EXACT'; readonly allocation: SeatAllocation }
  | { readonly kind: 'QUANTITY'; readonly quantity: number };

export function allocationQuantity(allocation: SeatAllocation): number {
  return allocation.kind === 'ASSIGNED'
    ? allocation.seats.length
    : allocation.quantity;
}

export function validateAllocation(allocation: SeatAllocation): void {
  const invalid = () => {
    throw new DomainError('INVALID_SELECTION', 'Invalid seat allocation');
  };
  if (!allocation.section.trim()) invalid();
  if (allocation.kind === 'GENERAL_ADMISSION') {
    if (!Number.isSafeInteger(allocation.quantity) || allocation.quantity < 1)
      invalid();
  } else {
    if (!allocation.row.trim() || !allocation.seats.length) invalid();
    allocation.seats.forEach((seat, index) => {
      if (
        !Number.isSafeInteger(seat) ||
        seat < 1 ||
        (index > 0 && seat !== allocation.seats[index - 1]! + 1)
      )
        invalid();
    });
  }
}

export function validateQuantity(listing: Listing, quantity: number): void {
  const { min, max, increment } = listing.quantityRules;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < min ||
    quantity > max ||
    (quantity - min) % increment !== 0
  ) {
    throw new DomainError(
      'INVALID_SELECTION',
      'Quantity does not satisfy listing rules',
    );
  }
}

export function validateSelection(
  listing: Listing,
  selection: InventorySelection,
): void {
  if (selection.kind === 'QUANTITY')
    return validateQuantity(listing, selection.quantity);
  const selected = selection.allocation;
  const pool = listing.allocation;
  validateAllocation(selected);
  validateQuantity(listing, allocationQuantity(selected));
  if (selected.kind !== pool.kind || selected.section !== pool.section) {
    throw new DomainError(
      'INVALID_SELECTION',
      'Selection does not belong to this listing',
    );
  }
  if (
    selected.kind === 'ASSIGNED' &&
    pool.kind === 'ASSIGNED' &&
    (selected.row !== pool.row ||
      selected.seats.some((seat) => !pool.seats.includes(seat)))
  ) {
    throw new DomainError(
      'INVALID_SELECTION',
      'Selection does not belong to this listing',
    );
  }
  if (
    selected.kind === 'GENERAL_ADMISSION' &&
    pool.kind === 'GENERAL_ADMISSION' &&
    selected.quantity > pool.quantity
  ) {
    throw new DomainError(
      'INVALID_SELECTION',
      'Selection exceeds listing capacity',
    );
  }
}

export function quoteSelection(listing: Listing, quantity: number): PriceQuote {
  validateQuantity(listing, quantity);
  const ticketSubtotal = cents(listing.unitPrice * quantity);
  const fees = cents(listing.feePerTicket * quantity);
  return {
    ticketSubtotal,
    fees,
    total: cents(ticketSubtotal + fees),
    currency: listing.currency,
    version: listing.version,
  };
}
