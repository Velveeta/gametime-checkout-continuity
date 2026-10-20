import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { RedisHarness } from "./redis-harness";
import { composeCheckout } from "../../src/infrastructure/checkout/compose";
import { listings } from "../../src/infrastructure/catalog/fixtures";
import { DEFAULT_CHECKOUT_POLICY } from "../../src/domain/checkout";
import { CallerCookies, CALLER_COOKIE } from "../../src/infrastructure/http/cookies";

const redis=new RedisHarness();const listing=listings[0]!;
const selected=listing.allocation.kind==="ASSIGNED"?{...listing.allocation,seats:[9,10]}:listing.allocation;
let runtime:Awaited<ReturnType<typeof composeCheckout>>;
function request(path:string,body?:unknown,options:{cookie?:string;key?:string;origin?:string;headers?:Record<string,string>}={}) {
  return new Request("https://checkout.example"+path,{method:body===undefined?"GET":"POST",headers:{
    ...(body===undefined?{}:{"content-type":"application/json"}),...(options.cookie?{cookie:options.cookie}:{}),
    ...(options.key?{"idempotency-key":options.key}:{}),...(options.origin?{origin:options.origin}:{}),...options.headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function caller(response:Response) {return response.headers.getSetCookie().find((c)=>c.startsWith(CALLER_COOKIE+"="))!.split(";")[0]!;}
async function create() {
  const response=await runtime.api.create(request("/api/checkouts",{eventId:listing.eventId,listingId:listing.id,allocation:selected,expectedListingVersion:1}));
  expect(response.status).toBe(201);const body=await response.json();return {id:body.data.session.id,snapshot:body.data,cookie:caller(response)};
}
function versions(s:Awaited<ReturnType<typeof create>>) {return {expectedVersion:s.snapshot.session.version,quoteVersion:s.snapshot.session.quote.version};}
beforeAll(()=>redis.start());afterAll(()=>redis.stop());beforeEach(async()=>{
  runtime=await composeCheckout({redis,namespace:`api-${randomUUID()}`,callerSecret:"caller-secret-".repeat(4),completionSecret:"completion-secret-".repeat(4),secureCookies:true,
    analytics:{record:async()=>{}}});
});

describe("HTTP transport with production services and actual Redis",()=>{
  it("lists simulated events/listings with availability and rejects unknown IDs",async()=>{
    const events=await runtime.api.events();expect(events.status).toBe(200);expect((await events.json()).data.events).toHaveLength(4);
    expect((await runtime.api.event("missing")).status).toBe(404);
    const response=await runtime.api.listings(listing.eventId);const body=await response.json();expect(body.data.listings).toHaveLength(4);
    expect(body.data.listings.map((row:{listing:{id:string}})=>row.listing.id)).toEqual(listings.filter((row)=>row.eventId===listing.eventId).map((row)=>row.id));
    expect(body.data.listings[0].availability.counts.available).toBe(8);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("validates JSON, body limits, content type, identities, seats and event membership",async()=>{
    const base={eventId:listing.eventId,listingId:listing.id,allocation:selected,expectedListingVersion:1};
    for(const input of [{...base,callerId:"spoof"},{...base,expectedListingVersion:0},{...base,eventId:"wrong"},
      {...base,allocation:{...selected,seats:[]}},{...base,allocation:{...selected,seats:[9,11]}},{...base,allocation:{...selected,seats:[100]}}]){
      const response=await runtime.api.create(request("/api/checkouts",input));expect(response.status).toBe(400);
    }
    expect((await runtime.api.create(new Request("https://checkout.example/api/checkouts",{method:"POST",headers:{"content-type":"application/json"},body:"{"}))).status).toBe(400);
    expect((await runtime.api.create(new Request("https://checkout.example/api/checkouts",{method:"POST",headers:{"content-type":"text/plain"},body:"{}"}))).status).toBe(415);
    expect((await runtime.api.create(request("/api/checkouts",{...base,extra:"x".repeat(17000)}))).status).toBe(400);
    expect((await runtime.api.read(request("/api/checkouts/bad"),"bad/id")).status).toBe(400);
  });
  it("reserves once, returns 409 to a competing cart, and does not mutate on polling",async()=>{
    const a=await create();
    const duplicate=await runtime.api.create(request("/api/checkouts",{eventId:listing.eventId,listingId:listing.id,allocation:selected,expectedListingVersion:1}));
    expect(duplicate.status).toBe(409);expect((await duplicate.json()).error.code).toBe("INVENTORY_UNAVAILABLE");
    const key=runtime.store.sessionKey(a.id);const before=await redis.command("GET",key);
    for(let i=0;i<3;i++)expect((await runtime.api.read(request(`/api/checkouts/${a.id}`,undefined,{cookie:a.cookie}),a.id)).status).toBe(200);
    expect(await redis.command("GET",key)).toBe(before);
  });
  it("rejects cross-origin writes, missing keys, forged caller bindings and body-supplied callers",async()=>{
    const a=await create();const path=`/api/checkouts/${a.id}/complete`;
    expect((await runtime.api.complete(request(path,versions(a),{cookie:a.cookie,key:"key",origin:"https://evil.example"}),a.id)).status).toBe(403);
    expect((await runtime.api.complete(request(path,versions(a),{cookie:a.cookie}),a.id)).status).toBe(400);
    expect((await runtime.api.complete(request(path,versions(a),{key:"key"}),a.id)).status).toBe(401);
    const forged=a.cookie.slice(0,-1)+(a.cookie.endsWith("a")?"b":"a");
    expect((await runtime.api.complete(request(path,versions(a),{cookie:forged,key:"key"}),a.id)).status).toBe(401);
    expect((await runtime.api.complete(request(path,{...versions(a),callerId:"spoof"},{cookie:a.cookie,key:"key"}),a.id)).status).toBe(400);
  });
  it("hides confirmation tokens in JSON, sets secure cookie, refreshes confirmation and replays safely",async()=>{
    const a=await create();const path=`/api/checkouts/${a.id}/complete`;
    const response=await runtime.api.complete(request(path,versions(a),{cookie:a.cookie,key:"purchase"}),a.id);
    expect(response.status).toBe(200);const body=await response.json();expect(body.data.kind).toBe("COMPLETED");expect(body.data.capability).toBeUndefined();
    const confirmation=response.headers.getSetCookie()[0]!;expect(confirmation).toContain("HttpOnly");expect(confirmation).toContain("Secure");expect(confirmation).toContain("SameSite=Lax");
    const bearer=confirmation.split(";")[0]!;const orderId=body.data.orderId;
    expect((await runtime.api.confirmation(request(body.data.confirmationUrl),orderId)).status).toBe(403);
    for(let i=0;i<2;i++){
      const confirmed=await runtime.api.confirmation(request(body.data.confirmationUrl,undefined,{cookie:bearer}),orderId);expect(confirmed.status).toBe(200);expect((await confirmed.json()).data.id).toBe(orderId);
    }
    for(let i=0;i<3;i++){
      const replay=await runtime.api.complete(request(path,versions(a),{cookie:a.cookie,key:"purchase"}),a.id);
      expect(await replay.json()).toEqual(body);expect(replay.headers.getSetCookie()).toEqual(response.headers.getSetCookie());
    }
    const otherCookie=new CallerCookies("caller-secret-".repeat(4),true).create().split(";")[0]!;
    expect((await runtime.api.complete(request(path,versions(a),{cookie:otherCookie,key:"purchase"}),a.id)).status).toBe(409);
    expect((await runtime.api.complete(request(path,versions(a),{cookie:a.cookie,key:"new-key"}),a.id)).status).toBe(409);
    const read=await runtime.api.read(request(`/api/checkouts/${a.id}`),a.id);const text=await read.text();expect(text).not.toContain(bearer.split("=")[1]!);
  });
  it("uses 410 for retained expired checkout; only explicit fresh navigation recovers",async()=>{
    runtime=await composeCheckout({redis,namespace:`short-${randomUUID()}`,callerSecret:"caller-secret-".repeat(4),completionSecret:"completion-secret-".repeat(4),secureCookies:true,
      policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:120},analytics:{record:async()=>{}}});
    const a=await create();await redis.after(a.snapshot.session.reservationExpiresAt);
    const before=await redis.command("GET",runtime.store.sessionKey(a.id));
    const expired=await runtime.api.read(request(`/api/checkouts/${a.id}`),a.id);
    expect(expired.status).toBe(410);expect((await expired.json()).data.session.status).toBe("EXPIRED");
    expect(await redis.command("GET",runtime.store.sessionKey(a.id))).toBe(before);
    const path=`/api/checkouts/${a.id}/recover`;
    expect((await runtime.api.recover(request(path,{intent:"MOUNTED_REFRESH"},{key:"recovery"}),a.id)).status).toBe(400);
    const recovered=await runtime.api.recover(request(path,{intent:"FRESH_NAVIGATION"},{key:"recovery"}),a.id);
    expect(recovered.status).toBe(200);expect((await recovered.json()).data.kind).toBe("REDIRECT_CHECKOUT");
  });
  it("maps SSR navigation policy to current root/event/successor/render outcomes",async()=>{
    const a=await create();
    expect((await runtime.checkout.enter({sessionId:a.id,intent:"FRESH_NAVIGATION",recoveryIdempotencyKey:"ssr"})).ok).toBe(true);
    await runtime.api.complete(request(`/api/checkouts/${a.id}/complete`,versions(a),{cookie:a.cookie,key:"complete"}),a.id);
    const completed=await runtime.checkout.enter({sessionId:a.id,intent:"FRESH_NAVIGATION",recoveryIdempotencyKey:"ssr"});
    expect(completed.ok&&completed.value.kind).toBe("REDIRECT_HOME");
  });
});
