import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DemoService } from '../../application/demo';
import { identifierSchema } from '../redis/checkout-data';
import { apiFailure, json, type CheckoutHttpApi } from './api';
import { cookie } from './cookies';

const base = {
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const mutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('PRICE'),
      direction: z.enum(['INCREASE', 'DECREASE']),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('DEADLINE'),
      minutes: z.number().int().min(1).max(30),
    })
    .strict(),
  z.object({ ...base, action: z.literal('EXPIRE') }).strict(),
  z
    .object({
      ...base,
      action: z.literal('PAYMENT'),
      scenario: z.enum(['DEFAULT', 'SUCCESS', 'TRANSIENT_FAILURE', 'DECLINED']),
    })
    .strict(),
]);

function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

export class DemoHttpApi {
  constructor(
    private readonly demo: DemoService,
    private readonly transport: CheckoutHttpApi,
    private readonly options: {
      enabled: boolean;
      secret: string;
      secure: boolean;
      scope: string;
    },
  ) {}
  private capability(id: string, expiresAt: number) {
    const signature = createHmac('sha256', this.options.secret)
      .update(JSON.stringify(['demo-v1', this.options.scope, id, expiresAt]))
      .digest('base64url');

    return `${expiresAt}.${signature}`;
  }
  private authorized(request: Request, id: string) {
    const value = cookie(request, 'cc_demo') ?? '';
    const expiry = Number(value.split('.')[0]);

    return (
      Number.isSafeInteger(expiry) &&
      expiry > Date.now() &&
      equal(value, this.capability(id, expiry))
    );
  }
  dispatch(
    request: Request,
    id: string,
    action: 'status' | 'authorize' | 'mutate' | 'reset',
  ) {
    return this.transport.handle(async () => {
      if (!this.options.enabled || this.options.secret.length < 32) {
        return apiFailure('NOT_FOUND', 'Not found');
      }

      identifierSchema.parse(id);

      if (action === 'authorize') {
        const { secret } = await this.transport.body(
          request,
          z.object({ secret: z.string().min(32).max(512) }).strict(),
        );

        if (!equal(secret, this.options.secret)) {
          return apiFailure('UNAUTHORIZED', 'Demo secret is incorrect');
        }

        await this.demo.read(id);
        const response = json({ ok: true, data: { authorized: true } });

        response.headers.append(
          'Set-Cookie',
          `cc_demo=${this.capability(id, Date.now() + 3600_000)}; Path=/api/demo/checkouts/${id}; HttpOnly; SameSite=Strict; Max-Age=3600${this.options.secure ? '; Secure' : ''}`,
        );

        return response;
      }

      if (!this.authorized(request, id)) {
        return apiFailure(
          'UNAUTHORIZED',
          'Unlock developer controls for this checkout',
        );
      }

      if (action === 'status') {
        return json({ ok: true, data: await this.demo.read(id) });
      }

      if (action === 'reset') {
        const { confirmation } = await this.transport.body(
          request,
          z.object({ confirmation: z.literal('RESET DEMO DATA') }).strict(),
        );

        return json({ ok: true, data: await this.demo.reset(confirmation) });
      }

      const input = await this.transport.body(request, mutationSchema);

      return json({
        ok: true,
        data: await this.demo.mutate({ ...input, sessionId: id }),
      });
    });
  }
}
