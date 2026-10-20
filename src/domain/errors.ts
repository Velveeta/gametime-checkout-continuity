export type DomainErrorCode =
  | "IDEMPOTENCY_CONFLICT" | "UNAUTHORIZED" | "INVALID_QUOTE" | "RESERVATION_CONFLICT" | "NOT_FOUND" | "INVALID_SELECTION" | "INVENTORY_UNAVAILABLE"
  | "RESERVATION_EXPIRED" | "VERSION_CONFLICT" | "QUOTE_ACCEPTANCE_REQUIRED"
  | "PROCESSING_IN_PROGRESS" | "PROCESSING_DEADLINE_EXCEEDED"
  | "ATTEMPTS_EXHAUSTED" | "TERMINAL_SESSION" | "INVALID_COMPLETION_CAPABILITY";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** Expected business failures are explicit; infrastructure failures may throw. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };
