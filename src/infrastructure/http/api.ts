import { z } from 'zod';
import type { CheckoutService } from '../../application/checkout-service';
import type { CatalogRepository, Inventory } from '../../application/ports';
import {
  DomainError,
  type DomainErrorCode,
  type Result,
} from '../../domain/errors';
import type { CompletionCapability } from '../../domain/models';
import { version } from '../../domain/values';
import { allocationSchema, identifierSchema } from '../redis/checkout-data';
import { SIMULATION_NOTICE } from '../catalog/fixtures';
import { CallerCookies, confirmationCookie, cookie } from './cookies';

export type ApiErrorCode =
  | DomainErrorCode
  | 'INVALID_INPUT'
  | 'CALLER_REQUIRED'
  | 'SERVICE_UNAVAILABLE'
  | 'UNSUPPORTED_MEDIA_TYPE';
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string }; data?: T };
const versionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .transform(version);
const versioned = z
  .object({ expectedVersion: versionSchema, quoteVersion: versionSchema })
  .strict();
const createSchema = z
  .object({
    eventId: identifierSchema,
    listingId: identifierSchema,
    allocation: allocationSchema,
    expectedListingVersion: versionSchema,
  })
  .strict();
const recoverSchema = z
  .object({ intent: z.literal('FRESH_NAVIGATION') })
  .strict();
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
function status(code: ApiErrorCode) {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RESERVATION_EXPIRED' || code === 'PROCESSING_DEADLINE_EXCEEDED')
    return 410;
  if (code === 'UNAUTHORIZED' || code === 'INVALID_COMPLETION_CAPABILITY')
    return 403;
  if (code === 'CALLER_REQUIRED') return 401;
  if (
    code === 'INVALID_INPUT' ||
    code === 'INVALID_SELECTION' ||
    code === 'INVALID_QUOTE'
  )
    return 400;
  if (code === 'SERVICE_UNAVAILABLE') return 503;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  return 409;
}
export function json<T>(body: ApiResponse<T>, code = 200) {
  return Response.json(body, {
    status: code,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Vary: 'Cookie, Authorization',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
export function apiFailure(code: ApiErrorCode, message: string) {
  return json({ ok: false, error: { code, message } }, status(code));
}
class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export interface HttpDependencies {
  checkout: CheckoutService;
  catalog: CatalogRepository;
  inventory: Inventory;
  cookies: CallerCookies;
}

/** Transport adapter only: schema, cookies, status and serialization. Domain
 * transitions/transactions belong to the injected application services.
 */
export class CheckoutHttpApi {
  constructor(private readonly services: HttpDependencies) {}
  private async body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    const origin = request.headers.get('origin');
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new HttpError('UNAUTHORIZED', 'Cross-origin mutation rejected');
    if (
      request.headers
        .get('content-type')
        ?.toLowerCase()
        .split(';')[0]
        ?.trim() !== 'application/json'
    )
      throw new HttpError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
    // Bounded stream read; Content-Length alone is not trusted.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 16_384) {
          await reader.cancel();
          throw new HttpError('INVALID_INPUT', 'Request body too large');
        }
        chunks.push(part.value);
      }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      throw new HttpError('INVALID_INPUT', 'Malformed JSON');
    }
    return schema.parse(value);
  }
  private key(request: Request) {
    return keySchema.parse(request.headers.get('idempotency-key'));
  }
  private response<T>(result: Result<T>, successStatus = 200) {
    return result.ok
      ? json({ ok: true, data: result.value }, successStatus)
      : apiFailure(result.error.code, result.error.message);
  }
  private callerCookie(request: Request, response: Response) {
    if (!this.services.cookies.read(request))
      response.headers.append('Set-Cookie', this.services.cookies.create());
    return response;
  }
  async handle(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpError)
        return apiFailure(error.code, error.message);
      if (error instanceof DomainError)
        return apiFailure(error.code, error.message);
      if (error instanceof z.ZodError)
        return apiFailure(
          'INVALID_INPUT',
          'Input does not match the API schema',
        );
      return apiFailure(
        'SERVICE_UNAVAILABLE',
        'Checkout service is temporarily unavailable',
      );
    }
  }
  events() {
    return this.handle(async () =>
      json({
        ok: true,
        data: {
          events: await this.services.catalog.listEvents(),
          simulationNotice: SIMULATION_NOTICE,
        },
      }),
    );
  }
  event(id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const event = await this.services.catalog.getEvent(id);
      return event
        ? json({
            ok: true,
            data: { event, simulationNotice: SIMULATION_NOTICE },
          })
        : apiFailure('NOT_FOUND', 'Event not found');
    });
  }
  listings(id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      if (!(await this.services.catalog.getEvent(id)))
        return apiFailure('NOT_FOUND', 'Event not found');
      const listings = await this.services.catalog.listListings(id);
      const rows = await Promise.all(
        listings.map(async (listing) => ({
          listing,
          availability: await this.services.inventory.getAvailability(
            listing.id,
          ),
        })),
      );
      return json({
        ok: true,
        data: { listings: rows, simulationNotice: SIMULATION_NOTICE },
      });
    });
  }
  create(request: Request) {
    return this.handle(async () => {
      const input = await this.body(request, createSchema);
      const listing = await this.services.catalog.getListing(input.listingId);
      if (!listing) return apiFailure('NOT_FOUND', 'Listing not found');
      if (listing.eventId !== input.eventId)
        return apiFailure(
          'INVALID_SELECTION',
          'Listing belongs to another event',
        );
      return this.callerCookie(
        request,
        this.response(await this.services.checkout.create(input), 201),
      );
    });
  }
  read(request: Request, id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const result = await this.services.checkout.getSession(id);
      const response =
        result.ok && result.value.session.status === 'EXPIRED'
          ? json(
              {
                ok: false,
                error: {
                  code: 'RESERVATION_EXPIRED',
                  message: 'Reservation expired',
                },
                data: result.value,
              },
              410,
            )
          : this.response(result);
      return this.callerCookie(request, response);
    });
  }
  acknowledge(request: Request, id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const input = await this.body(request, versioned);
      return this.response(
        await this.services.checkout.acceptQuote({ sessionId: id, ...input }),
      );
    });
  }
  complete(request: Request, id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const input = await this.body(request, versioned);
      const key = this.key(request);
      const callerId = this.services.cookies.read(request);
      if (!callerId)
        return apiFailure(
          'CALLER_REQUIRED',
          "Read the checkout first to establish this device's caller cookie",
        );
      const result = await this.services.checkout.complete({
        sessionId: id,
        ...input,
        callerId,
        idempotencyKey: key,
      });
      if (!result.ok) return this.response(result);
      if (result.value.kind !== 'COMPLETED')
        return this.response(
          result,
          result.value.kind === 'IN_PROGRESS' ? 202 : 200,
        );
      const { orderId, capability } = result.value;
      const response = json({
        ok: true,
        data: {
          kind: 'COMPLETED',
          orderId,
          confirmationUrl: `/api/orders/${orderId}/confirmation`,
        },
      });
      response.headers.append(
        'Set-Cookie',
        this.services.cookies.serialize(
          confirmationCookie(orderId),
          capability,
        ),
      );
      return response;
    });
  }
  recover(request: Request, id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const input = await this.body(request, recoverSchema);
      return this.response(
        await this.services.checkout.recoverExpiredSession({
          sessionId: id,
          intent: input.intent,
          idempotencyKey: this.key(request),
        }),
      );
    });
  }
  confirmation(request: Request, id: string) {
    return this.handle(async () => {
      identifierSchema.parse(id);
      const authorization = request.headers.get('authorization');
      const capability = authorization?.startsWith('Bearer ')
        ? authorization.slice(7)
        : cookie(request, confirmationCookie(id));
      if (!capability || !/^[A-Za-z0-9_-]{43}$/.test(capability))
        return apiFailure(
          'INVALID_COMPLETION_CAPABILITY',
          'Confirmation capability required',
        );
      return this.response(
        await this.services.checkout.confirm({
          orderId: id,
          capability: capability as CompletionCapability,
        }),
      );
    });
  }
}
