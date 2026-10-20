import { z } from 'zod';

// Explicit parsing avoids truthy coercion of the string "false".
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const schema = z
  .object({
    UPSTASH_REDIS_REST_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .url()
        .refine(
          (value) => new URL(value).protocol === 'https:',
          'Redis REST URL must use HTTPS',
        )
        .optional(),
    ),
    UPSTASH_REDIS_REST_TOKEN: optionalText,
    CHECKOUT_NAMESPACE: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .default('gametime-demo'),
    CHECKOUT_CALLER_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).optional(),
    ),
    CHECKOUT_COMPLETION_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).optional(),
    ),
    PAYMENT_SCENARIO: z
      .enum([
        'SUCCESS',
        'TRANSIENT_THEN_SUCCESS',
        'ALWAYS_TRANSIENT',
        'DECLINE',
        'UNKNOWN',
      ])
      .default('SUCCESS'),
    DEMO_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    DEMO_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(32).optional(),
    ),
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.UPSTASH_REDIS_REST_URL) !==
      Boolean(value.UPSTASH_REDIS_REST_TOKEN)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['UPSTASH_REDIS_REST_URL'],
        message: 'Provide both Redis REST credentials or neither',
      });
    }

    if (value.PAYMENT_SCENARIO !== 'SUCCESS' && !value.DEMO_MODE) {
      context.addIssue({
        code: 'custom',
        path: ['PAYMENT_SCENARIO'],
        message: 'Non-default simulation scenarios require DEMO_MODE',
      });
    }

    if (value.DEMO_MODE && !value.DEMO_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['DEMO_SECRET'],
        message: 'Demo mode requires a secret of at least 32 characters',
      });
    }
  });

/** Invoke only from server adapters. Never serialize returned secrets to clients. */
export function parseServerEnv(input: Record<string, string | undefined>) {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    // Do not include input values (tokens/secrets) in logs or error messages.
    throw new Error(
      `Invalid server environment: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  return parsed.data;
}

/** Future infrastructure calls this at runtime; scaffold builds need no Redis. */
export function requireRedisEnv(input: Record<string, string | undefined>) {
  const env = parseServerEnv(input);

  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Redis REST credentials are required for this operation');
  }

  return {
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  };
}

/** Runtime-only requirements; static builds never need live credentials. */
export function requireCheckoutEnv(input: Record<string, string | undefined>) {
  const env = parseServerEnv(input);
  const redis = requireRedisEnv(input);

  if (!env.CHECKOUT_CALLER_SECRET || !env.CHECKOUT_COMPLETION_SECRET) {
    throw new Error('Checkout caller and completion secrets are required');
  }

  if (env.CHECKOUT_CALLER_SECRET === env.CHECKOUT_COMPLETION_SECRET) {
    throw new Error('Checkout secrets must be distinct');
  }

  return {
    ...env,
    ...redis,
    callerSecret: env.CHECKOUT_CALLER_SECRET,
    completionSecret: env.CHECKOUT_COMPLETION_SECRET,
  };
}
