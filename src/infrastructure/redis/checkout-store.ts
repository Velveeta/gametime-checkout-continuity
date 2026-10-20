import { createHash, timingSafeEqual } from "node:crypto";
import type { CatalogRepository, CheckoutCommand, CheckoutMutation, CheckoutRepository, OrderRepository } from "../../application/ports";
import type { ListingAvailability } from "../../application/inventory-contracts";
import { acceptCheckoutQuote, claimCheckout, createCheckout, reconcileCheckout, recoverCheckout, refreshCheckoutQuote,
  settleCheckout, validateCheckoutPolicy, type CheckoutDecision, type CheckoutEventName, type CheckoutPolicy } from "../../domain/checkout";
import { DomainError, type DomainErrorCode, type Result } from "../../domain/errors";
import { allocationQuantity, quoteSelection, validateAllocation, validateSelection } from "../../domain/inventory";
import type { CheckoutSession, CompletionCapability, Order, SeatAllocation } from "../../domain/models";
import { instant, version } from "../../domain/values";
import { validateCatalog } from "../catalog/catalog";
import type { RedisScriptExecutor } from "./inventory";
import { COMMIT_LUA, SNAPSHOT_LUA } from "./transactions";
import { emptyIndex, fingerprint, get, identifierSchema, ledgerKey, session, wire,
  type CheckoutIndex, type InventoryDocument } from "./checkout-data";

interface Snapshot { keys: string[]; raw: string[]; nowMs: number; index: CheckoutIndex; inventories: InventoryDocument[] }
interface Relative { id: string; eventKeyIndex: number; mode: "CREATE" | "PROTECT"; holdMs?: number; retentionMs?: number; processingMs?: number }
type TransactionValue = CheckoutMutation | ListingAvailability;
interface Plan {
  relative: Relative[]; newOrderId?: string; finalLedgerKey?: string; replayLedgerKey?: string;
  response: Result<TransactionValue>;
}
const pass = <T>(value: T): Result<T> => ({ ok: true, value });
function fail(code: DomainErrorCode): never { throw new DomainError(code, code); }
function parse<T>(value: T | string): T { return typeof value === "string" ? JSON.parse(value) as T : value; }
function allocationKey(a:SeatAllocation) {
  return JSON.stringify(a.kind==="ASSIGNED"?[a.kind,a.section,a.row,a.seats]:[a.kind,a.section,a.quantity]);
}
function seatKey(a: Extract<SeatAllocation,{kind:"ASSIGNED"}>, seat: number) { return JSON.stringify([a.section,a.row,seat]); }

/** All business decisions use the domain functions. Lua validates the ENTIRE read
 * set and temporal validity interval, then publishes with one MSET. No local locks.
 */
export class RedisCheckoutStore implements CheckoutRepository, OrderRepository {
  readonly prefix: string;
  constructor(private readonly redis: RedisScriptExecutor, private readonly seeds: CatalogRepository, namespace: string) {
    identifierSchema.parse(namespace);
    this.prefix = `checkout:{${namespace}}:`;
  }
  private async keySet() {
    const events = await this.seeds.listEvents();
    return [this.prefix + "checkouts:v1", ...events.map((event) => this.prefix + "inventory:" + event.id)];
  }
  private async snapshot(): Promise<Snapshot> {
    const keys = await this.keySet();
    const value = parse(await this.redis.eval<{raw: string[];nowMs: number}|string>(SNAPSHOT_LUA,keys,[]));
    const index = value.raw[0] ? wire(JSON.parse(value.raw[0]),true) as CheckoutIndex : emptyIndex();
    if (index.schemaVersion !== 1 || !index.sessions || !index.orders || !index.attempts || !index.ledger || !index.orderBySession || !index.digests) throw new Error("Unsupported checkout schema");
    for (const stored of Object.values(index.sessions)) { session(stored); validateAllocation(stored.allocation); }
    const events = await this.seeds.listEvents();
    const inventories = await Promise.all(events.map(async (event,i): Promise<InventoryDocument> => {
      if (value.raw[i+1]) {
        const existing = JSON.parse(value.raw[i+1]!) as InventoryDocument;
        if (existing.schemaVersion !== 1 || existing.eventId !== event.id || !existing.listings || !existing.reservations) throw new Error("Unsupported inventory schema");
        return existing;
      }
      return { schemaVersion: 1, eventId: event.id, version: 1, reservations: {},
        listings: Object.fromEntries((await this.seeds.listListings(event.id)).map((listing) => [listing.id,listing])) };
    }));
    validateCatalog(events,inventories.flatMap((inventory) => Object.values(inventory.listings)));
    return { ...value,keys,index,inventories };
  }
  private find(s: Snapshot, listingId: string) {
    for (const inventory of s.inventories) {
      const listing = get(inventory.listings,listingId);
      if (listing) return {inventory,listing};
    }
    return fail("NOT_FOUND");
  }
  private now(s: Snapshot) { return instant(new Date(s.nowMs).toISOString()); }
  private hold(s: Snapshot, checkout: CheckoutSession) {
    return get(this.find(s,checkout.listingId).inventory.reservations,checkout.reservationId);
  }
  private apply(s: Snapshot, decision: CheckoutDecision) {
    const checkout = decision.session;
    const {inventory,listing} = this.find(s,checkout.listingId);
    // Validate effects before mutating the candidate; it is committed only by CAS.
    for (const effect of decision.effects) {
      if (effect.kind === "RESERVE") {
        validateSelection(listing,{kind:"EXACT",allocation:effect.allocation});
        if (get(inventory.reservations,effect.reservationId)) fail("RESERVATION_CONFLICT");
        const availability = this.availability(s,listing.id);
        if (effect.allocation.kind === "GENERAL_ADMISSION") {
          if (availability.counts.available < effect.allocation.quantity) fail("INVENTORY_UNAVAILABLE");
        } else {
          const selected = effect.allocation;
          if (!availability.available.some((a) => a.kind === "ASSIGNED" && a.section === selected.section && a.row === selected.row && selected.seats.every((n) => a.seats.includes(n)))) fail("INVENTORY_UNAVAILABLE");
        }
      } else if (effect.kind !== "FENCE_ATTEMPT") {
        const hold = get(inventory.reservations,effect.reservationId);
        if (!hold || hold.sessionId !== checkout.id) fail("RESERVATION_CONFLICT");
        if (effect.kind === "SELL" && (hold.status !== "HELD" || (hold.processingDeadlineMs ?? hold.expiresAtMs) <= s.nowMs)) fail("RESERVATION_EXPIRED");
      }
    }
    if (decision.order && (get(s.index.orderBySession,checkout.id) || get(s.index.orders,decision.order.id))) fail("TERMINAL_SESSION");
    for (const effect of decision.effects) {
      if (effect.kind === "FENCE_ATTEMPT") {
        const attempt = get(s.index.attempts,effect.attemptId);
        if (attempt) attempt.status = "FENCED";
        continue;
      }
      if (effect.kind === "RESERVE") {
        inventory.reservations[effect.reservationId] = { id:effect.reservationId,sessionId:checkout.id,listingId:listing.id,
          listingVersion:listing.version,selection:{kind:"EXACT",allocation:effect.allocation},allocation:effect.allocation,
          status:"HELD",createdAtMs:s.nowMs,expiresAtMs:Date.parse(effect.until) };
      } else {
        const hold = inventory.reservations[effect.reservationId]!;
        if (effect.kind === "PROTECT") { hold.processingDeadlineMs=Date.parse(effect.until); hold.attemptId=effect.attemptId; }
        if (effect.kind === "RESTORE_BUSINESS_HOLD") { delete hold.processingDeadlineMs; delete hold.attemptId; hold.expiresAtMs=Date.parse(effect.until); }
        if (effect.kind === "RELEASE") hold.status="RELEASED";
        if (effect.kind === "SELL") { hold.status="SOLD"; hold.orderId=effect.orderId; }
      }
      inventory.version++;
    }
    s.index.sessions[checkout.id]=checkout;
    if (decision.order) { s.index.orders[decision.order.id]=decision.order; s.index.orderBySession[checkout.id]=decision.order.id; }
  }
  private reconcile(s: Snapshot) {
    const now=this.now(s);
    // Fence processing and release its inventory TOGETHER, before availability.
    for (const checkout of Object.values(s.index.sessions)) {
      const decision=reconcileCheckout(checkout,now);
      if (decision.session!==checkout) this.apply(s,decision);
    }
    for (const inventory of s.inventories) for (const hold of Object.values(inventory.reservations)) {
      if (hold.status==="HELD" && (hold.processingDeadlineMs ?? hold.expiresAtMs)<=s.nowMs) {
        hold.status="EXPIRED"; inventory.version++;
        const attempt=hold.attemptId && get(s.index.attempts,hold.attemptId);
        if (attempt) attempt.status="FENCED";
      }
    }
  }
  private projectQuote(s: Snapshot, checkout: CheckoutSession) {
    const effective=reconcileCheckout(checkout,this.now(s)).session;
    if (!["ACTIVE","PRICE_REVIEW","PAYMENT_RETRYABLE"].includes(effective.status)) return {session:effective,effects:[],events:[]} as CheckoutDecision;
    const listing=this.find(s,effective.listingId).listing;
    return refreshCheckoutQuote(effective,quoteSelection(listing,allocationQuantity(effective.allocation)),effective.version,this.now(s));
  }
  private boundary(s: Snapshot): number | undefined {
    const values: number[]=[];
    for (const checkout of Object.values(s.index.sessions)) {
      values.push(Date.parse(checkout.recoveryRetainUntil));
      if (checkout.status==="PROCESSING") values.push(Date.parse(checkout.processingDeadlineAt));
      else if (["ACTIVE","PRICE_REVIEW","PAYMENT_RETRYABLE"].includes(checkout.status)) values.push(Date.parse(checkout.reservationExpiresAt));
    }
    for (const inventory of s.inventories) for (const hold of Object.values(inventory.reservations)) {
      if (hold.status==="HELD") values.push(hold.processingDeadlineMs ?? hold.expiresAtMs);
    }
    const future=values.filter((n)=>n>s.nowMs);
    return future.length ? Math.min(...future) : undefined;
  }
  private async transaction(make: (s:Snapshot)=>Plan): Promise<Result<TransactionValue>> {
    for (let retry=0;retry<64;retry++) {
      const s=await this.snapshot();
      const validBefore=this.boundary(s);
      this.reconcile(s);
      const plan=make(s);
      s.index.revision++;
      const response = plan.response.ok ? plan.response : {ok:false,code:plan.response.error.code,message:plan.response.error.message};
      const proposal={ expected:s.raw,observedAt:s.nowMs,validBefore,values:[s.index,...s.inventories],
        relative:plan.relative,newOrderId:plan.newOrderId,finalLedgerKey:plan.finalLedgerKey,replayLedgerKey:plan.replayLedgerKey,response };
      const result=parse(await this.redis.eval<{committed:boolean;response?:unknown}|string>(COMMIT_LUA,s.keys,[JSON.stringify(wire(proposal))]));
      if (!result.committed) continue;
      const decoded=wire(result.response,true) as {ok:true;value:TransactionValue}|{ok:false;code:DomainErrorCode;message?:string};
      if (!decoded.ok) return {ok:false,error:new DomainError(decoded.code,decoded.message??decoded.code)};
      // cjson encodes empty tables as objects; normalize the only empty list here.
      const value=decoded.value;
      if ("session" in value) {
        if (!Array.isArray(value.events)) Object.assign(value,{events:[]});
        session(value.session);
      } else {
        if(!Array.isArray(value.available)) Object.assign(value,{available:[]});
        if(!Array.isArray(value.ownReservations)) Object.assign(value,{ownReservations:[]});
      }
      return pass(value);
    }
    return {ok:false,error:new DomainError("VERSION_CONFLICT","Inventory is busy; retry with the same request key")};
  }
  async initialize() {
    const seeds=await this.seeds.listEvents();
    validateCatalog(seeds,(await Promise.all(seeds.map((event)=>this.seeds.listListings(event.id)))).flat());
    // Reuses the exact CAS protocol. Existing data is preserved, never reseeded.
    const s=await this.snapshot();
    if (s.raw.every(Boolean)) return;
    for(let attempt=0;attempt<64;attempt++) {
      const current=attempt===0?s:await this.snapshot();
      if(current.raw.every(Boolean)) return;
      const p={expected:current.raw,observedAt:current.nowMs,values:[current.index,...current.inventories],relative:[],response:{ok:true}};
      const result=parse(await this.redis.eval<{committed:boolean}|string>(COMMIT_LUA,current.keys,[JSON.stringify(wire(p))]));
      if(result.committed) return;
    }
    throw new Error("Seed initialization conflicted repeatedly");
  }
  async read(id:string) {
    identifierSchema.parse(id);
    const s=await this.snapshot(); const stored=get(s.index.sessions,id);
    if(!stored || Date.parse(stored.recoveryRetainUntil)<=s.nowMs) return null;
    return {session:this.projectQuote(s,stored).session,serverNow:this.now(s)};
  }
  async execute(command:CheckoutCommand,policy:CheckoutPolicy):Promise<Result<CheckoutMutation>> {
    validateCheckoutPolicy(policy);
    // Deadline edits have no production authorization implementation before Wave 05.
    if(command.kind==="CHANGE_DEADLINE") return {ok:false,error:new DomainError("UNAUTHORIZED","Demo controls are not enabled")};
    const result=await this.transaction((s)=>this.plan(s,command,policy));
    if(!result.ok) return result;
    if(!("session" in result.value)) throw new Error("Invalid checkout result");
    return pass(result.value);
  }
  private plan(s:Snapshot,command:Exclude<CheckoutCommand,{kind:"CHANGE_DEADLINE"}>,policy:CheckoutPolicy):Plan {
    const plan:Plan={relative:[],response:{ok:false,error:new DomainError("NOT_FOUND","NOT_FOUND")}};
    const now=this.now(s);
    let events:CheckoutEventName[]=[];
    const updated=(checkout:CheckoutSession,kind:"UPDATED"|"IN_PROGRESS"|"REPLAY"="UPDATED"):CheckoutMutation=>({kind,session:checkout,serverNow:now,events});
    const relative=(checkout:CheckoutSession,mode:"CREATE"|"PROTECT")=>{
      const i=s.inventories.findIndex((inventory)=>inventory.eventId===checkout.eventId);
      plan.relative.push({id:checkout.id,eventKeyIndex:i+2,mode,holdMs:policy.holdMs,retentionMs:policy.retentionAfterExpiryMs,processingMs:policy.processingMs});
    };
    try {
      if(command.kind==="RESERVE") {
        const existing=get(s.index.sessions,command.sessionId);
        if(existing) {
          if(existing.reservationId!==command.reservationId || existing.listingId!==command.listingId || allocationKey(existing.allocation)!==allocationKey(command.allocation)) fail("RESERVATION_CONFLICT");
          plan.response=pass(updated(existing)); return plan;
        }
        const listing=this.find(s,command.listingId).listing;
        if(listing.version!==command.expectedListingVersion) fail("VERSION_CONFLICT");
        const decision=createCheckout({id:command.sessionId,reservationId:command.reservationId,listing,allocation:command.allocation},now,policy);
        this.apply(s,decision); events=[...decision.events]; relative(decision.session,"CREATE");
        plan.response=pass(updated(decision.session)); return plan;
      }
      const id=command.kind==="RECOVER"?command.expiredSessionId:command.sessionId;
      // Final operation replay outlives the checkout's recovery/read horizon.
      if(command.kind==="CLAIM_COMPLETION" || command.kind==="SETTLE_PAYMENT") {
        const key=ledgerKey(id,command.idempotencyKey);const cached=get(s.index.ledger,key);
        if(cached?.final) {
          if(cached.callerId!==command.callerId || (command.kind==="CLAIM_COMPLETION" ? cached.fingerprint!==fingerprint(command) : cached.attemptId!==command.attemptId)) fail("IDEMPOTENCY_CONFLICT");
          plan.replayLedgerKey=key;plan.response=pass(cached.final);return plan;
        }
      }
      let current=get(s.index.sessions,id);
      if(!current || Date.parse(current.recoveryRetainUntil)<=s.nowMs) fail("NOT_FOUND");
      const quoted=command.kind==="REFRESH_QUOTE" && command.expectedVersion===current.version
        ? {session:current,effects:[],events:[]} as CheckoutDecision : this.projectQuote(s,current);
      if(quoted.session!==current) {this.apply(s,quoted);current=quoted.session;events=[...quoted.events];}
      if(command.kind==="CLAIM_COMPLETION") {
        const key=ledgerKey(id,command.idempotencyKey);
        const entry=get(s.index.ledger,key);
        if(entry) {
          if(entry.callerId!==command.callerId || entry.fingerprint!==fingerprint(command)) fail("IDEMPOTENCY_CONFLICT");
          if(entry.final) {plan.replayLedgerKey=key;plan.response=pass(entry.final);return plan;}
          plan.response=pass(updated(current,"IN_PROGRESS"));return plan;
        }
        if(current.status==="PROCESSING") {plan.response=pass(updated(current,"IN_PROGRESS"));return plan;}
        const hold=this.hold(s,current);
        const decision=claimCheckout(current,command,{now,currentQuote:quoteSelection(this.find(s,current.listingId).listing,allocationQuantity(current.allocation)),
          ownsReservation:!!hold && hold.status==="HELD" && hold.sessionId===id && hold.listingId===current.listingId &&
            allocationKey(hold.allocation)===allocationKey(current.allocation) && hold.expiresAtMs===Date.parse(current.reservationExpiresAt) &&
            (hold.processingDeadlineMs??hold.expiresAtMs)>s.nowMs,
          orderExists:!!get(s.index.orderBySession,id)},policy);
        this.apply(s,decision); events.push(...decision.events); relative(decision.session,"PROTECT");
        s.index.ledger[key]={callerId:command.callerId,fingerprint:fingerprint(command),attemptId:command.attemptId};
        s.index.attempts[command.attemptId]={sessionId:id,callerId:command.callerId,key,status:"PROCESSING",ordinal:decision.session.paymentAttemptCount};
        if(decision.session.status!=="PROCESSING") throw new Error("Invalid claim decision");
        plan.response=pass({...updated(decision.session),kind:"CLAIMED",session:decision.session});return plan;
      }
      if(command.kind==="SETTLE_PAYMENT") {
        const key=ledgerKey(id,command.idempotencyKey); const entry=get(s.index.ledger,key);
        if(!entry || entry.callerId!==command.callerId || entry.attemptId!==command.attemptId) fail("IDEMPOTENCY_CONFLICT");
        if(entry.final) {plan.replayLedgerKey=key;plan.response=pass(entry.final);return plan;}
        const attempt=get(s.index.attempts,command.attemptId);
        if(!attempt) fail("VERSION_CONFLICT");
        let mutation:CheckoutMutation;
        if(attempt.status==="FENCED") mutation=updated(current);
        else {
          const owned=this.hold(s,current);
          if(!owned || owned.status!=="HELD" || owned.sessionId!==id || owned.attemptId!==command.attemptId) fail("RESERVATION_CONFLICT");
          const decision=settleCheckout(current,command,now);
          this.apply(s,decision);events.push(...decision.events);mutation=updated(decision.session);
          if(decision.order) {
            if(decision.session.status!=="COMPLETED") throw new Error("Order must complete checkout");
            s.index.digests[decision.order.id]=command.capabilityDigest;
            mutation={...mutation,kind:"COMPLETED",session:decision.session,completion:{orderId:decision.order.id}};
            plan.newOrderId=decision.order.id;attempt.status="SUCCEEDED";
          } else if(command.outcome.kind!=="UNKNOWN" && s.index.attempts[command.attemptId]?.status!=="FENCED") attempt.status=command.outcome.kind;
        }
        if(mutation.session.status!=="PROCESSING") {entry.final=mutation;plan.finalLedgerKey=key;}
        plan.response=pass(mutation);return plan;
      }
      if(command.kind==="RECOVER") {
        if(current.status!=="EXPIRED") fail("TERMINAL_SESSION");
        if(current.successorSessionId) {
          const successor=get(s.index.sessions,current.successorSessionId);
          if(!successor) fail("NOT_FOUND");
          plan.response=pass(updated(successor));return plan;
        }
        if(get(s.index.sessions,command.successorId)) fail("RESERVATION_CONFLICT");
        const decision=recoverCheckout(current,{id:command.successorId,reservationId:command.reservationId,
          listing:this.find(s,current.listingId).listing,allocation:current.allocation},now,policy);
        this.apply(s,decision); relative(decision.session,"CREATE"); events.push(...decision.events);
        s.index.sessions[id]={...current,successorSessionId:decision.session.id,version:version(current.version+1)};
        plan.response=pass(updated(decision.session));return plan;
      }
      if(command.kind==="EXPIRE_IF_DUE") {plan.response=pass(updated(current));return plan;}
      const quote=quoteSelection(this.find(s,current.listingId).listing,allocationQuantity(current.allocation));
      const decision=command.kind==="REFRESH_QUOTE" ? refreshCheckoutQuote(current,quote,command.expectedVersion,now)
        : acceptCheckoutQuote(current,command,{now,currentQuote:quote});
      this.apply(s,decision);events.push(...decision.events);plan.response=pass(updated(decision.session));
    } catch(error) {if(error instanceof DomainError) plan.response={ok:false,error};else throw error;}
    return plan;
  }
  private availability(s:Snapshot,listingId:string,ownerSessionId?:string):ListingAvailability {
    const {inventory,listing}=this.find(s,listingId);
    const live=Object.values(inventory.reservations).filter((r)=>r.listingId===listingId && (r.status==="SOLD"||r.status==="HELD"));
    const held=live.filter((r)=>r.status==="HELD").reduce((n,r)=>n+allocationQuantity(r.allocation),0);
    const sold=live.filter((r)=>r.status==="SOLD").reduce((n,r)=>n+allocationQuantity(r.allocation),0);
    const total=allocationQuantity(listing.allocation); const available:SeatAllocation[]=[];
    if(listing.allocation.kind==="GENERAL_ADMISSION") {
      if(total>held+sold) available.push({...listing.allocation,quantity:total-held-sold});
    } else {
      const pool=listing.allocation;const blocked=new Set(live.flatMap((r)=>r.allocation.kind==="ASSIGNED"?r.allocation.seats.map((n)=>seatKey(r.allocation as Extract<SeatAllocation,{kind:"ASSIGNED"}>,n)):[]));
      let run:number[]=[];
      for(const n of pool.seats) {
        if(blocked.has(seatKey(pool,n))) {run=[];continue;}
        if(!run.length) {run=[n];available.push({...pool,seats:run as [number,...number[]]});}else run.push(n);
      }
    }
    if(held+sold>total) throw new Error("Inventory conservation violated");
    return {available,counts:{total,available:total-held-sold,held,sold},version:version(inventory.version),serverNow:this.now(s),
      ownReservations:ownerSessionId?live.filter((hold)=>hold.status==="HELD"&&hold.sessionId===ownerSessionId).map((hold)=>({id:hold.id,listingId:hold.listingId,sessionId:hold.sessionId,
        allocation:hold.allocation,status:"HELD" as const,createdAt:instant(new Date(hold.createdAtMs).toISOString()),expiresAt:instant(new Date(hold.expiresAtMs).toISOString())})):[]};
  }
  async getAvailability(listingId:string,ownerSessionId?:string):Promise<ListingAvailability> {
    // Joint fencing/release is persisted through the same atomic commit protocol.
    const result=await this.transaction((s)=>({relative:[],response:pass(this.availability(s,listingId,ownerSessionId))}));
    if(!result.ok) throw result.error;
    if(!("counts" in result.value)) throw new Error("Invalid availability result");
    return result.value;
  }
  async getConfirmation(orderId:string,capability:CompletionCapability):Promise<Result<Order>> {
    const s=await this.snapshot();const order=get(s.index.orders,orderId);const stored=get(s.index.digests,orderId);
    const digest=createHash("sha256").update(capability).digest("hex");
    if(!order || !stored || stored.length!==digest.length || !timingSafeEqual(Buffer.from(stored),Buffer.from(digest))) return {ok:false,error:new DomainError("INVALID_COMPLETION_CAPABILITY","Confirmation capability required")};
    return pass(order);
  }
  /** Current persisted listing data for catalog/API reads, never stale seed prices. */
  async getListing(id:string) {const s=await this.snapshot();try{return this.find(s,id).listing;}catch(error){if(error instanceof DomainError)return null;throw error;}}
  async listListings(eventId:string) {
    const s=await this.snapshot();
    const definitions=s.inventories.find((inventory)=>inventory.eventId===eventId)?.listings??{};
    const order=new Map((await this.seeds.listListings(eventId)).map((listing,i)=>[listing.id,i]));
    return Object.values(definitions).sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity)||a.id.localeCompare(b.id));
  }
}
