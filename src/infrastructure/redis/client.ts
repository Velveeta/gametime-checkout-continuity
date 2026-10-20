import 'server-only';
import { Redis } from '@upstash/redis';
import { readRedisEnv } from '../../lib/server-env';
import { FixtureCatalog } from '../catalog/catalog';
import { RedisInventory } from './inventory';

/** Explicit factory: import/build never connects, seeds, or needs credentials. */
export function createDemoInventory(namespace: string) {
  return new RedisInventory(new Redis(readRedisEnv()), new FixtureCatalog(), {
    namespace,
  });
}
