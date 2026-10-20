import 'server-only';
import { parseServerEnv, requireRedisEnv } from './env';

export function readServerEnv() {
  return parseServerEnv(process.env);
}

export function readRedisEnv() {
  return requireRedisEnv(process.env);
}
