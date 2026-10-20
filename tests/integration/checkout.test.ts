import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as pause } from "node:timers/promises";
import { RedisHarness } from "./redis-harness";
import { composeCheckout } from "../../src/infrastructure/checkout/compose";
import type { CheckoutSnapshot, CompleteCheckoutInput } from "../../src/application/checkout-service";
import type { Payment } from "../../src/application/ports";
import type { Result } from "../../src/domain/errors";
import { DEFAULT_CHECKOUT_POLICY, type CheckoutPolicy } from "../../src/domain/checkout";
import { version } from "../../src/domain/values";
import { listings } from "../../src/infrastructure/catalog/fixtures";
import type { RedisScriptExecutor } from "../../src/infrastructure/redis/inventory";
import { COMMIT_LUA } from "../../src/infrastructure/redis/transactions";

const redis=new RedisHarness();
const listing=listings[0]!;
const allocation=listing.allocation.kind==="ASSIGNED"?{...listing.allocation,seats:[9,10] as [number,number]}:listing.allocation;
let namespace:string;
const callerSecret="caller-test-secret-".repeat(3);
const completionSecret="completion-test-secret-".repeat(3);
async function instance(options:{payment?:Payment;policy?:CheckoutPolicy;executor?:RedisScriptExecutor}={}) {
  return composeCheckout({redis:options.executor??redis,namespace,callerSecret,completionSecret,secureCookies:true,
    payment:options.payment??{attempt:async()=>({kind:"SUCCEEDED",reference:"simulated"})},
    ...(options.policy?{policy:options.policy}:{}),analytics:{record:async()=>{}}});
}
function value<T>(result:Result<T>):T {if(!result.ok)throw result.error;return result.value;}
function code<T>(result:Result<T>) {return result.ok?undefined:result.error.code;}
async function create(runtime:Awaited<ReturnType<typeof instance>>,listingId=listing.id,selection=allocation) {
  return value(await runtime.checkout.create({listingId,allocation:selection,expectedListingVersion:version(1)}));
}
function request(s:CheckoutSnapshot,key="payment",callerId="device-a"):CompleteCheckoutInput {
  return {sessionId:s.session.id,expectedVersion:s.session.version,quoteVersion:s.session.quote.version,idempotencyKey:key,callerId};
}
async function price(unitPrice:number,fees:number) {
  await redis.command("EVAL",`local d=cjson.decode(redis.call('GET',KEYS[1]));local l=d.listings[ARGV[1]];l.unitPrice=tonumber(ARGV[2]);l.feePerTicket=tonumber(ARGV[3]);l.version=l.version+1;redis.call('SET',KEYS[1],cjson.encode(d));return 1`,"1",`checkout:{${namespace}}:inventory:${listing.eventId}`,listing.id,String(unitPrice),String(fees));
}
function pending() {
  let release!:()=>void;let entered!:()=>void;
  const started=new Promise<void>((resolve)=>{entered=resolve;});
  const gate=new Promise<void>((resolve)=>{release=resolve;});let calls=0;
  return {started,release:()=>release(),get calls(){return calls;},payment:{attempt:async()=>{calls++;entered();await gate;return {kind:"SUCCEEDED" as const,reference:"simulated"};}}};
}
async function conserved(runtime:Awaited<ReturnType<typeof instance>>,id=listing.id) {
  const view=await runtime.store.getAvailability(id);
  expect(view.counts.total).toBe(view.counts.held+view.counts.sold+view.counts.available);
  return view.counts;
}
beforeAll(()=>redis.start());afterAll(()=>redis.stop());beforeEach(()=>{namespace=`checkout-${randomUUID()}`;});

describe("real Redis checkout transactions across independent instances",()=>{
  it("admits exactly one among 16 carts and persists it across fresh compositions",async()=>{
    const a=await instance();const b=await instance();
    const results=await Promise.all(Array.from({length:16},(_,n)=>(n%2?a:b).checkout.create({listingId:listing.id,allocation,expectedListingVersion:version(1)})));
    expect(results.filter((r)=>r.ok)).toHaveLength(1);
    expect(results.filter((r)=>!r.ok).every((r)=>code(r)==="INVENTORY_UNAVAILABLE")).toBe(true);
    const winner=results.find((r)=>r.ok)!;const c=await instance();
    expect(value(await c.checkout.getSession(value(winner).session.id)).session.id).toBe(value(winner).session.id);
    expect(await conserved(c)).toEqual({total:8,held:2,sold:0,available:6});
  });
  it("GET-style reads leave Redis bytes/deadlines unchanged; expiry restores without TTL/worker",async()=>{
    const r=await instance({policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:150}});const s=await create(r);
    const key=r.store.prefix+"checkouts:v1";const before=await redis.command("GET",key);
    value(await r.checkout.getSession(s.session.id));
    expect(await redis.command("GET",key)).toBe(before);
    expect(await redis.command("TTL",key)).toBe("-1");
    await redis.after(s.session.reservationExpiresAt);
    expect(value(await r.checkout.getSession(s.session.id)).session.status).toBe("EXPIRED");
    expect(await redis.command("GET",key)).toBe(before);
    expect((await conserved(r)).available).toBe(8);
    const replacement=await create(await instance());
    expect(replacement.session.id).not.toBe(s.session.id);
  });
  it("one claim protects stock, competing keys do not create duplicate orders, same binding replays",async()=>{
    const payment=pending();const a=await instance({payment:payment.payment});const b=await instance({payment:payment.payment});const s=await create(a);const input=request(s);
    const original=a.checkout.complete(input);await payment.started;
    const results=await Promise.all(Array.from({length:12},(_,n)=>b.checkout.complete(request(s,`key-${n}`,`device-${n}`))));
    expect(results.every((r)=>r.ok&&r.value.kind==="IN_PROGRESS")).toBe(true);
    expect(payment.calls).toBe(1);payment.release();
    const complete=value(await original);expect(complete.kind).toBe("COMPLETED");
    const c=await instance();
    for(let i=0;i<3;i++)expect(value(await c.checkout.complete(input))).toEqual(complete);
    expect(code(await c.checkout.complete({...input,callerId:"intruder"}))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(await c.checkout.complete(request(s,"new-final-key")))).toBe("TERMINAL_SESSION");
    if(complete.kind!=="COMPLETED")throw new Error();
    expect(value(await c.checkout.confirm(complete)).id).toBe(complete.orderId);
    expect(await conserved(c)).toEqual({total:8,held:0,sold:2,available:6});
    const data=JSON.parse(await redis.command("GET",c.store.prefix+"checkouts:v1"));
    expect(Object.keys(data.orders)).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(complete.capability);
  });
  it("keeps processing protected across business expiry and releases only after fenced timeout",async()=>{
    const payment=pending();const a=await instance({payment:payment.payment,policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:400,processingMs:800}});
    const s=await create(a);const purchase=a.checkout.complete(request(s));await payment.started;
    const processing=value(await a.checkout.read(s.session.id)).session;if(processing.status!=="PROCESSING")throw new Error();
    await redis.after(s.session.reservationExpiresAt);
    const b=await instance();expect((await conserved(b)).held).toBe(2);
    expect(code(await b.checkout.create({listingId:listing.id,allocation,expectedListingVersion:version(1)}))).toBe("INVENTORY_UNAVAILABLE");
    await redis.after(processing.processingDeadlineAt);
    expect((await conserved(b)).available).toBe(8);
    const replacement=await create(b);
    payment.release();const result=value(await purchase);expect(result.kind).toBe("UPDATED");
    expect(value(await b.checkout.read(s.session.id)).session).toMatchObject({status:"PAYMENT_FAILED",failureCode:"PROCESSING_TIMEOUT"});
    expect(value(await b.checkout.read(replacement.session.id)).session.status).toBe("ACTIVE");
    expect((await conserved(b)).sold).toBe(0);
  });
  it("success may settle after business expiry while its processing window remains live",async()=>{
    const payment=pending();const a=await instance({payment:payment.payment,policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:200,processingMs:1200}});
    const s=await create(a);const purchase=a.checkout.complete(request(s));await payment.started;
    await redis.after(s.session.reservationExpiresAt);payment.release();
    expect(value(await purchase).kind).toBe("COMPLETED");expect((await conserved(a)).sold).toBe(2);
    await redis.after(new Date(Date.parse(s.session.reservationExpiresAt)+100).toISOString());
    expect((await conserved(await instance())).sold).toBe(2);
  });
  it("creates one fresh successor under 12 concurrent recovery keys and does not recover polling",async()=>{
    const a=await instance({policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:150}});const s=await create(a);await redis.after(s.session.reservationExpiresAt);
    const b=await instance();
    expect(value(await b.checkout.enter({sessionId:s.session.id,intent:"MOUNTED_REFRESH",recoveryIdempotencyKey:"unused"}))).toEqual({kind:"REDIRECT_EVENT",eventId:listing.eventId});
    await price(10000,2200);
    const results=await Promise.all(Array.from({length:12},(_,n)=>b.checkout.recoverExpiredSession({sessionId:s.session.id,intent:"FRESH_NAVIGATION",idempotencyKey:`recover-${n}`})));
    const ids=results.map((r)=>{const entry=value(r);if(entry.kind!=="REDIRECT_CHECKOUT")throw new Error(JSON.stringify(entry));return entry.sessionId;});
    expect(new Set(ids).size).toBe(1);
    const successor=value(await b.checkout.read(ids[0]!)).session;
    expect(successor).toMatchObject({status:"ACTIVE",paymentAttemptCount:0,acknowledgedQuoteVersion:2,acceptedTotal:24400});
    expect(successor.reservationId).not.toBe(s.session.reservationId);
    expect((await conserved(b)).held).toBe(2);
  });
  it("price races either lock the acknowledged old quote or reject, never charge an unseen increase",async()=>{
    const a=await instance();const s=await create(a);
    const [result]=await Promise.all([a.checkout.complete(request(s)),price(9000,4000)]);
    if(result.ok&&result.value.kind==="COMPLETED") {
      const order=value(await a.checkout.confirm(result.value));expect(order.quote.total).toBe(s.session.quote.total);
    } else expect(code(result)).toBe("VERSION_CONFLICT");
    if(!result.ok) {
      const latest=value(await a.checkout.read(s.session.id));expect(latest.session.status).toBe("PRICE_REVIEW");
      expect(code(await a.checkout.complete(request(latest,"retry")))).toBe("QUOTE_ACCEPTANCE_REQUIRED");
      const accepted=value(await a.checkout.acceptQuote({sessionId:s.session.id,expectedVersion:latest.session.version,quoteVersion:latest.session.quote.version}));
      expect(value(await a.checkout.complete(request(accepted,"accepted"))).kind).toBe("COMPLETED");
    }
  });
  it("projects lower pricing read-only and persists the same version at claim",async()=>{
    const a=await instance();const s=await create(a);await price(8000,1900);
    const before=await redis.command("GET",a.store.prefix+"checkouts:v1");
    const latest=value(await a.checkout.read(s.session.id));expect(latest.session).toMatchObject({status:"ACTIVE",acceptedTotal:19800,acknowledgedQuoteVersion:2});
    expect(await redis.command("GET",a.store.prefix+"checkouts:v1")).toBe(before);
    const done=value(await a.checkout.complete(request(latest)));if(done.kind!=="COMPLETED")throw new Error();
    expect(value(await a.checkout.confirm(done)).quote.total).toBe(19800);
  });
  it("three confirmed transient attempts exhaust across distinct server instances",async()=>{
    const payment:Payment={attempt:async()=>({kind:"TRANSIENT_FAILURE"})};let a=await instance({payment});let s=await create(a);
    for(let n=1;n<=3;n++){
      value(await a.checkout.complete(request(s,`try-${n}`)));a=await instance({payment});s=value(await a.checkout.read(s.session.id));expect(s.session.paymentAttemptCount).toBe(n);
    }
    expect(s.session).toMatchObject({status:"PAYMENT_FAILED",failureCode:"ATTEMPTS_EXHAUSTED"});expect((await conserved(a)).available).toBe(8);
  });
  it("conserves GA capacity under competing partial-quantity claims and a sale",async()=>{
    const a=await instance();const ga=listings.find((row)=>row.id==="music-ga")!;
    if(ga.allocation.kind!=="GENERAL_ADMISSION")throw new Error();
    const selection={...ga.allocation,quantity:5};
    const results=await Promise.all(Array.from({length:12},()=>a.checkout.create({listingId:ga.id,allocation:selection,expectedListingVersion:version(1)})));
    expect(results.filter((r)=>r.ok)).toHaveLength(2);
    const tooMany=await a.checkout.create({listingId:ga.id,allocation:{...ga.allocation,quantity:3},expectedListingVersion:version(1)});
    expect(code(tooMany)).toBe("INVENTORY_UNAVAILABLE");
    value(await a.checkout.create({listingId:ga.id,allocation:{...ga.allocation,quantity:2},expectedListingVersion:version(1)}));
    const winner=results.find((r)=>r.ok)!;
    value(await a.checkout.complete(request(value(winner))));
    expect(await conserved(a,ga.id)).toEqual({total:12,available:0,held:7,sold:5});
  });
  it("replays confirmed noncapture without another attempt, and definitive decline releases stock",async()=>{
    const a=await instance({payment:{attempt:async()=>({kind:"TRANSIENT_FAILURE"})}});const s=await create(a);const input=request(s);
    const first=value(await a.checkout.complete(input));
    const b=await instance({payment:{attempt:async()=>({kind:"DECLINED"})}});
    expect(value(await b.checkout.complete(input))).toEqual(first);
    const latest=value(await b.checkout.read(s.session.id));expect(latest.session.paymentAttemptCount).toBe(1);
    value(await b.checkout.complete(request(latest,"decline")));
    expect(value(await b.checkout.read(s.session.id)).session).toMatchObject({status:"PAYMENT_FAILED",failureCode:"DECLINED",paymentAttemptCount:2});
    expect((await conserved(b)).available).toBe(8);
  });
  it("initialization preserves sold stock, holds and completed order/digest/attempt records",async()=>{
    const a=await instance();const s=await create(a);value(await a.checkout.complete(request(s)));
    const before=await redis.command("GET",a.store.prefix+"checkouts:v1");await Promise.all([instance(),instance(),instance()]);
    expect(await redis.command("GET",a.store.prefix+"checkouts:v1")).toBe(before);expect((await conserved(a)).sold).toBe(2);
  });
  it("metadata expires logically after retention while orders remain durable",async()=>{
    const a=await instance({policy:{holdMs:120,processingMs:50,retentionAfterExpiryMs:120}});const s=await create(a);
    await redis.after(s.session.recoveryRetainUntil);
    expect(code(await a.checkout.read(s.session.id))).toBe("NOT_FOUND");
    expect(value(await a.checkout.enter({sessionId:s.session.id,intent:"FRESH_NAVIGATION",recoveryIdempotencyKey:"gone"})).kind).toBe("REDIRECT_HOME");
  });
  it("preserves final replay and confirmation beyond the checkout metadata read horizon",async()=>{
    const a=await instance({policy:{holdMs:200,processingMs:100,retentionAfterExpiryMs:200}});const s=await create(a);const input=request(s);
    const completed=value(await a.checkout.complete(input));expect(completed.kind).toBe("COMPLETED");
    await redis.after(s.session.recoveryRetainUntil);const b=await instance();
    expect(code(await b.checkout.read(s.session.id))).toBe("NOT_FOUND");
    expect(value(await b.checkout.complete(input))).toEqual(completed);
    if(completed.kind!=="COMPLETED")throw new Error();expect(value(await b.checkout.confirm(completed)).id).toBe(completed.orderId);
  });
  it("commit-time temporal validation rejects a claim planned before but committed after expiry",async()=>{
    const a=await instance({policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:180}});const s=await create(a);
    let delayed=false;
    const executor:RedisScriptExecutor={eval:async<T>(script:string,keys:string[],args:(string|number)[]):Promise<T>=>{
      if(script===COMMIT_LUA&&!delayed){delayed=true;await redis.after(s.session.reservationExpiresAt);}
      return redis.eval<T>(script,keys,args);
    }};
    const b=await instance({executor});const result=await b.checkout.complete(request(s));
    expect(code(result)).toBe("RESERVATION_EXPIRED");expect((await conserved(a)).available).toBe(8);
  });
  it("recovers a lost successful settlement response with the same binding and one durable order",async()=>{
    let drop=false;
    const executor:RedisScriptExecutor={eval:async<T>(script:string,keys:string[],args:(string|number)[]):Promise<T>=>{
      const result=await redis.eval<T>(script,keys,args);
      if(script===COMMIT_LUA&&drop){
        const proposal=JSON.parse(String(args[0]));
        if(proposal.response?.value?.kind==="COMPLETED"&&(result as {committed?:boolean}).committed){drop=false;throw new Error("response lost after commit");}
      }
      return result;
    }};
    const a=await instance({executor});const s=await create(a);const input=request(s);drop=true;
    await expect(a.checkout.complete(input)).rejects.toThrow("response lost");
    const b=await instance();const replay=value(await b.checkout.complete(input));expect(replay.kind).toBe("COMPLETED");
    if(replay.kind!=="COMPLETED")throw new Error();
    expect(value(await b.checkout.confirm(replay)).id).toBe(replay.orderId);
    expect((await conserved(b)).sold).toBe(2);
    expect(Object.keys(JSON.parse(await redis.command("GET",b.store.prefix+"checkouts:v1")).orders)).toHaveLength(1);
  });
  it("commit starts new hold at commit time, not at a delayed snapshot/planning time",async()=>{
    let delayCommit=false;
    const executor:RedisScriptExecutor={eval:async<T>(script:string,keys:string[],args:(string|number)[]):Promise<T>=>{
      if(script===COMMIT_LUA&&delayCommit){delayCommit=false;await pause(100);}
      return redis.eval<T>(script,keys,args);
    }};
    const a=await instance({executor,policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:200}});delayCommit=true;
    const s=await create(a);
    expect(Date.parse(s.session.reservationExpiresAt)-Date.parse(s.serverNow)).toBe(200);
    expect(s.session.createdAt).toBe(s.serverNow);
  });
});
