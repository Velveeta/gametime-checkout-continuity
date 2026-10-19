import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogService } from "../../src/application/catalog-service";
import type { InventoryReservation, ListingAvailability, ReserveInventory } from "../../src/application/inventory-contracts";
import type { Result } from "../../src/domain/errors";
import { allocationQuantity } from "../../src/domain/inventory";
import { version } from "../../src/domain/values";
import { FixtureCatalog } from "../../src/infrastructure/catalog/catalog";
import { listings } from "../../src/infrastructure/catalog/fixtures";
import { RedisInventory } from "../../src/infrastructure/redis/inventory";
import { INVENTORY_LUA } from "../../src/infrastructure/redis/inventory-lua";
import { RedisHarness } from "./redis-harness";

const redis = new RedisHarness();
const catalog = new FixtureCatalog();
let inventory: RedisInventory;
let service: CatalogService;
let namespace: string;
const assigned = listings[0]!;
const ga = listings.find((listing) => listing.id === "music-ga")!;
function request(listingId = assigned.id, quantity = 2, sessionId = randomUUID()): ReserveInventory {
  return { listingId, sessionId, reservationId: randomUUID(), expectedListingVersion: version(1), selection: { kind: "QUANTITY", quantity } };
}
function exact(seats: [number, ...number[]], sessionId = randomUUID()): ReserveInventory {
  return { ...request(assigned.id, seats.length, sessionId), selection: { kind: "EXACT", allocation: { kind: "ASSIGNED", section: assigned.allocation.section, row: "18", seats } } };
}
function success(result: Result<InventoryReservation>): InventoryReservation {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}
function errorCode<T>(result: Result<T>) { return result.ok ? undefined : result.error.code; }
function conserved(snapshot: ListingAvailability) {
  expect(snapshot.counts.available + snapshot.counts.held + snapshot.counts.sold).toBe(snapshot.counts.total);
  expect(snapshot.available.reduce((sum, allocation) => sum + allocationQuantity(allocation), 0)).toBe(snapshot.counts.available);
  expect(Object.values(snapshot.counts).every((n) => n >= 0)).toBe(true);
}
async function sell(input: ReserveInventory, orderId: string = randomUUID()) {
  return inventory.commitSale({ listingId: input.listingId, reservationId: input.reservationId, sessionId: input.sessionId, orderId });
}
beforeAll(() => redis.start());
afterAll(() => redis.stop());
beforeEach(async () => {
  namespace = `test-${randomUUID()}`;
  inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 60_000 });
  service = new CatalogService(catalog, inventory);
  await inventory.initialize();
});

describe("exclusive atomic inventory on real Redis", () => {
  it("makes exactly one of 24 independent carts win the same exact seats", async () => {
    const other = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? inventory : other).reserve(exact([9,10]))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => errorCode(result) === "INVENTORY_UNAVAILABLE")).toBe(true);
    const available = await inventory.getAvailability(assigned.id);
    expect(available.counts).toEqual({ total: 8, available: 6, held: 2, sold: 0 });
    conserved(available);
  });
  it("hides held seats globally, but returns them separately to the owning checkout", async () => {
    const input = exact([9,10]);
    const hold = success(await service.reserve(input));
    const publicView = await inventory.getAvailability(assigned.id);
    const ownerView = await inventory.getAvailability(assigned.id, input.sessionId);
    expect(publicView.ownReservations).toEqual([]);
    expect(ownerView.ownReservations).toEqual([hold]);
    expect(ownerView.available).toEqual(publicView.available);
    expect(ownerView.available[0]).toMatchObject({ seats: [11,12,13,14,15,16] });
    conserved(ownerView);
  });
  it("does not extend a hold on reads or idempotent replay", async () => {
    const input = exact([9,10]);
    const first = success(await inventory.reserve(input));
    const initial = await inventory.getAvailability(assigned.id);
    expect(success(await inventory.reserve(input))).toEqual(first);
    const next = await inventory.getAvailability(assigned.id, input.sessionId);
    expect(next.version).toBe(initial.version);
    expect(next.ownReservations[0]!.expiresAt).toBe(first.expiresAt);
    expect(errorCode(await inventory.reserve({ ...input, selection: { kind: "QUANTITY", quantity: 1 } }))).toBe("RESERVATION_CONFLICT");
    expect(errorCode(await inventory.reserve({ ...input, reservationId: randomUUID() }))).toBe("RESERVATION_CONFLICT");
  });
  it("restores inventory at the Redis deadline without a worker or key TTL", async () => {
    inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 150 });
    const input = exact([9,10]);
    const hold = success(await inventory.reserve(input));
    expect(await redis.command("TTL", `checkout:{${namespace}}:inventory:${assigned.eventId}`)).toBe("-1");
    await redis.after(hold.expiresAt);
    const view = await inventory.getAvailability(assigned.id, input.sessionId);
    expect(Date.parse(view.serverNow)).toBeGreaterThanOrEqual(Date.parse(hold.expiresAt));
    expect(view.counts).toEqual({ total: 8, available: 8, held: 0, sold: 0 });
    expect(view.ownReservations).toEqual([]);
    expect(errorCode(await inventory.reserve(input))).toBe("RESERVATION_EXPIRED");
    conserved(view);
  });
  it("fences expired tokens during concurrent expiry/reacquisition and late sale", async () => {
    inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 150 });
    const original = exact([9,10]);
    const hold = success(await inventory.reserve(original));
    inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 60_000 });
    await redis.after(hold.expiresAt);
    const results = await Promise.all([inventory.reserve(original), ...Array.from({ length: 12 }, () => inventory.reserve(exact([9,10])))]);
    expect(errorCode(results[0]!)).toBe("RESERVATION_EXPIRED");
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(errorCode(await sell(original))).toBe("RESERVATION_EXPIRED");
    const view = await inventory.getAvailability(assigned.id);
    expect(view.counts.held).toBe(2);
    conserved(view);
  });
  it("keeps sold seats sold after the former hold expires; sale replay is idempotent", async () => {
    inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 150 });
    const input = exact([9,10]);
    const hold = success(await inventory.reserve(input));
    const order = randomUUID();
    const sold = success(await sell(input, order));
    expect(sold).toMatchObject({ status: "SOLD", orderId: order });
    expect(success(await sell(input, order))).toEqual(sold);
    expect(errorCode(await sell(input))).toBe("TERMINAL_SESSION");
    await redis.after(hold.expiresAt);
    const view = await inventory.getAvailability(assigned.id);
    expect(view.counts).toEqual({ total: 8, available: 6, held: 0, sold: 2 });
    expect(errorCode(await inventory.reserve(exact([9,10])))).toBe("INVENTORY_UNAVAILABLE");
    conserved(view);
  });
  it("prevents a competing owner from selling someone else's reservation", async () => {
    const input = exact([9,10]);
    success(await inventory.reserve(input));
    expect(errorCode(await inventory.commitSale({ listingId: input.listingId, reservationId: input.reservationId, sessionId: "intruder", orderId: "order" }))).toBe("RESERVATION_CONFLICT");
    expect((await inventory.getAvailability(assigned.id)).counts.held).toBe(2);
  });
  it("rejects two different sales for one order ID", async () => {
    const first = exact([9,10]); const second = exact([11,12]);
    success(await inventory.reserve(first)); success(await inventory.reserve(second));
    success(await sell(first, "same-order"));
    expect(errorCode(await sell(second, "same-order"))).toBe("RESERVATION_CONFLICT");
    conserved(await inventory.getAvailability(assigned.id));
  });
  it("returns contiguous partial availability and never stitches separated seats", async () => {
    success(await inventory.reserve(exact([11,12])));
    success(await inventory.reserve(exact([15,16])));
    const view = await inventory.getAvailability(assigned.id);
    expect(view.available).toMatchObject([{ seats: [9,10] }, { seats: [13,14] }]);
    expect(errorCode(await inventory.reserve(request(assigned.id, 3)))).toBe("INVENTORY_UNAVAILABLE");
    const hold = success(await inventory.reserve(request(assigned.id, 2)));
    expect(hold.allocation).toMatchObject({ seats: [9,10] });
    conserved(await inventory.getAvailability(assigned.id));
  });
  it("honors GA partial capacity under concurrent claims without partial fulfillment", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => inventory.reserve(request(ga.id, 5))));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(errorCode(await inventory.reserve(request(ga.id, 3)))).toBe("INVENTORY_UNAVAILABLE");
    success(await inventory.reserve(request(ga.id, 2)));
    const view = await inventory.getAvailability(ga.id);
    expect(view.available).toEqual([]);
    expect(view.counts).toEqual({ total: 12, available: 0, held: 12, sold: 0 });
    conserved(view);
  });
  it("restores only expired GA quantities, retaining sold quantities", async () => {
    inventory = new RedisInventory(redis, catalog, { namespace, holdDurationMs: 150 });
    const soldInput = request(ga.id, 3); const heldInput = request(ga.id, 4);
    success(await inventory.reserve(soldInput)); success(await sell(soldInput));
    const hold = success(await inventory.reserve(heldInput));
    await redis.after(hold.expiresAt);
    const view = await inventory.getAvailability(ga.id);
    expect(view.counts).toEqual({ total: 12, available: 9, held: 0, sold: 3 });
    conserved(view);
  });
  it("initialization never overwrites live holds, sold inventory or unrelated order keys", async () => {
    const soldInput = exact([9,10]); const heldInput = exact([11,12]);
    success(await inventory.reserve(soldInput)); success(await sell(soldInput)); success(await inventory.reserve(heldInput));
    const orderKey = `checkout:{${namespace}}:order:sentinel`;
    await redis.command("SET", orderKey, "existing-order");
    await Promise.all([inventory.initialize(), inventory.initialize()]);
    expect(await redis.command("GET", orderKey)).toBe("existing-order");
    const view = await inventory.getAvailability(assigned.id);
    expect(view.counts).toEqual({ total: 8, available: 4, held: 2, sold: 2 });
    conserved(view);
  });
  it("rejects stale listing versions, missing data and invalid selection before mutation", async () => {
    const input = exact([9,10]);
    expect(errorCode(await inventory.reserve({ ...input, expectedListingVersion: version(2) }))).toBe("VERSION_CONFLICT");
    expect(errorCode(await inventory.reserve(request("missing")))).toBe("NOT_FOUND");
    expect(errorCode(await inventory.reserve(request(assigned.id, 20)))).toBe("INVALID_SELECTION");
    expect(errorCode(await service.availability("missing"))).toBe("NOT_FOUND");
    expect(errorCode(await service.listListings("missing"))).toBe("NOT_FOUND");
    expect((await service.listListings(assigned.eventId)).ok).toBe(true);
    expect((await service.availability(assigned.id)).ok).toBe(true);
    expect((await inventory.getAvailability(assigned.id)).counts.available).toBe(8);
  });
  it("revalidates membership and CAS atomically even when the adapter boundary is bypassed", async () => {
    const input = exact([99]);
    const reply = await redis.eval<{ok: boolean; code: string}>(INVENTORY_LUA, [`checkout:{${namespace}}:inventory:${assigned.eventId}`], [JSON.stringify({kind: "RESERVE", eventId: assigned.eventId, input, holdDurationMs: 400})]);
    expect(reply).toMatchObject({ok: false, code: "INVALID_SELECTION"});
    expect((await inventory.getAvailability(assigned.id)).counts.available).toBe(8);
  });
  it("conserves all listings through mixed nonoverlapping holds and sales", async () => {
    for (const listing of listings) {
      const input = request(listing.id, listing.quantityRules.min);
      success(await inventory.reserve(input));
      success(await sell(input));
      const view = await inventory.getAvailability(listing.id);
      expect(view.counts.sold).toBe(listing.quantityRules.min);
      conserved(view);
    }
  });
  it("initializes fresh namespaces concurrently without duplicating inventory", async () => {
    const freshNamespace = `fresh-${randomUUID()}`;
    const first = new RedisInventory(redis, catalog, { namespace: freshNamespace });
    const second = new RedisInventory(redis, catalog, { namespace: freshNamespace });
    await Promise.all([first.initialize(), second.initialize()]);
    const view = await first.getAvailability(assigned.id);
    expect(view.counts).toEqual({ total: 8, available: 8, held: 0, sold: 0 });
    expect(view.version).toBe(1);
    conserved(view);
  });
  it("reports uninitialized inventory and refuses unsupported persisted schemas without overwrite", async () => {
    const freshNamespace = `fresh-${randomUUID()}`;
    const fresh = new RedisInventory(redis, catalog, { namespace: freshNamespace });
    const freshService = new CatalogService(catalog, fresh);
    expect(errorCode(await freshService.availability(assigned.id))).toBe("NOT_FOUND");
    const key = `checkout:{${freshNamespace}}:inventory:${assigned.eventId}`;
    const existing = JSON.stringify({ schemaVersion: 999, eventId: assigned.eventId, sentinel: "preserve" });
    await redis.command("SET", key, existing);
    await expect(fresh.initialize()).rejects.toThrow();
    expect(await redis.command("GET", key)).toBe(existing);
  });
  it("rejects invalid namespace and deadline policy configuration", () => {
    expect(() => new RedisInventory(redis, catalog, { namespace: "x}:other" })).toThrow();
    expect(() => new RedisInventory(redis, catalog, { namespace, holdDurationMs: 0 })).toThrow();
  });
});
