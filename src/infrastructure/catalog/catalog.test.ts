import { describe, expect, it } from "vitest";
import { FixtureCatalog, validateCatalog } from "./catalog";
import { events, listings, SIMULATION_NOTICE } from "./fixtures";
import { quoteSelection } from "../../domain/inventory";

describe("deterministic fictional catalog", () => {
  it("contains four future-dated clearly simulated events, each with four listings", async () => {
    const catalog = new FixtureCatalog();
    expect(await catalog.listEvents()).toHaveLength(4);
    for (const event of events) {
      expect(event.title).toContain("[SIMULATED]");
      expect(Date.parse(event.startsAt)).toBeGreaterThan(Date.parse("2026-10-19T00:00:00Z"));
      expect(await catalog.listListings(event.id)).toHaveLength(4);
      expect(await catalog.getEvent(event.id)).toEqual(event);
    }
    expect(SIMULATION_NOTICE).toContain("not scheduled events");
  });
  it("has appropriate local event times", () => {
    const times = events.map((event) => new Intl.DateTimeFormat("en-US", { timeZone: event.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(event.startsAt)));
    expect(times).toEqual(["15:25", "19:30", "19:30", "13:20"]);
  });
  it("keeps prices in the specified per-ticket bands with explicit fees", () => {
    const bands = [[9500,57500], [8500,125000], [6500,24500], [4000,22500]] as const;
    events.forEach((event, index) => {
      const [min,max] = bands[index]!;
      for (const listing of listings.filter((item) => item.eventId === event.id)) {
        expect(listing.unitPrice).toBeGreaterThanOrEqual(min);
        expect(listing.unitPrice).toBeLessThanOrEqual(max);
        expect(quoteSelection(listing, listing.quantityRules.min).fees).toBe(listing.feePerTicket * listing.quantityRules.min);
      }
    });
  });
  it("is deeply frozen and never uses runtime randomness or rolling dates", () => {
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(listings[0]!.allocation)).toBe(true);
    expect(() => Object.assign(listings[0]!, { unitPrice: 1 })).toThrow();
    expect(() => validateCatalog(events, listings)).not.toThrow();
  });
  it("rejects duplicate seat aliases, duplicate GA pools and invalid identity/rules", () => {
    const seat = listings[0]!;
    expect(() => validateCatalog(events, [...listings, { ...seat, id: "duplicate-seat" }])).toThrow("Overlapping");
    const ga = listings.find((item) => item.allocation.kind === "GENERAL_ADMISSION")!;
    expect(() => validateCatalog(events, [...listings, { ...ga, id: "duplicate-ga" }])).toThrow("Overlapping");
    expect(() => validateCatalog(events, [seat, seat])).toThrow("identity");
    expect(() => validateCatalog(events, [{ ...seat, eventId: "absent" }])).toThrow();
    expect(() => validateCatalog(events, [{ ...seat, quantityRules: { min: 0, max: 4, increment: 0 } }])).toThrow();
  });
  it("returns null/empty for unknown catalog IDs", async () => {
    const catalog = new FixtureCatalog();
    expect(await catalog.getEvent("missing")).toBeNull();
    expect(await catalog.getListing("missing")).toBeNull();
    expect(await catalog.listListings("missing")).toEqual([]);
  });
});
