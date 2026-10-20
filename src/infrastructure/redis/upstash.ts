import { Redis } from "@upstash/redis";

/** Same SDK configuration in production and the opt-in hosted verification. */
export function upstashRedis(credentials:{url:string;token:string}) {
  return new Redis({...credentials,automaticDeserialization:false,retry:{retries:2,backoff:(n)=>Math.min(50*2**n,500)}});
}
