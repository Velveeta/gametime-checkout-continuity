import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,expect,it } from "vitest";
import { composeCheckout } from "../../src/infrastructure/checkout/compose";
import { upstashRedis } from "../../src/infrastructure/redis/upstash";
import { FixtureCatalog } from "../../src/infrastructure/catalog/catalog";
import { listings } from "../../src/infrastructure/catalog/fixtures";
import { version } from "../../src/domain/values";

const namespace=`live-test-${randomUUID()}`;
let client:ReturnType<typeof upstashRedis>;
let a:Awaited<ReturnType<typeof composeCheckout>>;
let b:Awaited<ReturnType<typeof composeCheckout>>;
beforeAll(async()=>{
  const url=process.env.UPSTASH_REDIS_REST_URL;const token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error("Live Upstash validation requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. No hosted guarantees were verified.");
  if(new URL(url).protocol!=="https:")throw new Error("Use the HTTPS Upstash REST endpoint");
  client=upstashRedis({url,token});
  const options={redis:client,namespace,callerSecret:randomUUID()+randomUUID(),completionSecret:randomUUID()+randomUUID(),secureCookies:true,analytics:{record:async()=>{}}};
  a=await composeCheckout(options);b=await composeCheckout(options);
});
afterAll(async()=>{
  if(!client)return;
  const keys=[`checkout:{${namespace}}:checkouts:v1`,...(await new FixtureCatalog().listEvents()).map((event)=>`checkout:{${namespace}}:inventory:${event.id}`)];
  // Delete exactly this generated test namespace, never scan or flush shared data.
  await client.eval("return redis.call('DEL',unpack(KEYS))",keys,[]);
});
it("verifies real hosted SDK/EVAL transport, competing claims, cross-instance completion and replay",async()=>{
  const listing=listings[0]!;
  if(listing.allocation.kind!=="ASSIGNED")throw new Error();
  const input={listingId:listing.id,allocation:{...listing.allocation,seats:[9,10] as [number,number]},expectedListingVersion:version(1)};
  const reservations=await Promise.all([a.checkout.create(input),b.checkout.create(input),a.checkout.create(input)]);
  expect(reservations.filter((r)=>r.ok)).toHaveLength(1);
  const winner=reservations.find((r)=>r.ok);if(!winner)throw new Error("No reservation winner");
  const snapshot=winner.value;
  const complete={sessionId:snapshot.session.id,expectedVersion:snapshot.session.version,quoteVersion:snapshot.session.quote.version,callerId:"live-device",idempotencyKey:"live-purchase"};
  const outcomes=await Promise.all([a.checkout.complete(complete),b.checkout.complete({...complete,idempotencyKey:"competing-key",callerId:"other-device"})]);
  const done=outcomes.find((r)=>r.ok&&r.value.kind==="COMPLETED");expect(done).toBeDefined();
  if(!done?.ok||done.value.kind!=="COMPLETED")throw new Error("No completed caller");
  const winningInput=outcomes[0]?.ok&&outcomes[0].value.kind==="COMPLETED"?complete:{...complete,idempotencyKey:"competing-key",callerId:"other-device"};
  expect(await b.checkout.complete(winningInput)).toEqual(done);
  const confirmation=await a.checkout.confirm(done.value);expect(confirmation.ok).toBe(true);
  expect((await b.store.getAvailability(listing.id)).counts).toEqual({total:8,available:6,held:0,sold:2});
});
