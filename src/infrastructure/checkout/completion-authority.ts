import { createHash, createHmac } from 'node:crypto';
import type { CompletionAuthority } from '../../application/ports';
import type { CompletionCapability } from '../../domain/models';

/** Server composition only. Do not serialize the secret or put tokens in URLs.
 * No process-local token cache; same initiating caller/key can recover a response.
 */
export class HmacCompletionAuthority implements CompletionAuthority {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32)
      throw new RangeError('Completion secret must be at least 32 bytes');
  }
  issue(input: Parameters<CompletionAuthority['issue']>[0]) {
    const binding = JSON.stringify([
      'checkout-confirmation-v1',
      input.sessionId,
      input.callerId,
      input.idempotencyKey,
    ]);
    const capability = createHmac('sha256', this.secret)
      .update(binding)
      .digest('base64url') as CompletionCapability;
    return {
      capability,
      digest: createHash('sha256').update(capability).digest('hex'),
    };
  }
}
