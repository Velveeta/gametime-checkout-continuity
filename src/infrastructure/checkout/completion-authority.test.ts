import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HmacCompletionAuthority } from './completion-authority';
it('derives stable unguessable caller/key-scoped capabilities and stores only a digest', () => {
  const authority = new HmacCompletionAuthority('x'.repeat(32));
  const binding = {
    sessionId: 'session',
    callerId: 'device-a',
    idempotencyKey: 'request',
  };
  const token = authority.issue(binding);
  expect(token).toEqual(authority.issue(binding));
  expect(token.capability).toHaveLength(43);
  expect(token.digest).toBe(
    createHash('sha256').update(token.capability).digest('hex'),
  );
  expect(
    authority.issue({ ...binding, callerId: 'device-b' }).capability,
  ).not.toBe(token.capability);
  expect(
    authority.issue({ ...binding, idempotencyKey: 'other' }).capability,
  ).not.toBe(token.capability);
  expect(
    authority.issue({ ...binding, sessionId: 'other' }).capability,
  ).not.toBe(token.capability);
  expect(
    new HmacCompletionAuthority('y'.repeat(32)).issue(binding).capability,
  ).not.toBe(token.capability);
  expect(() => new HmacCompletionAuthority('short')).toThrow();
});
