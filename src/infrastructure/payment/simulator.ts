import type { Payment, PaymentOutcome } from "../../application/ports";

export type PaymentScenario = "SUCCESS" | "TRANSIENT_THEN_SUCCESS" | "ALWAYS_TRANSIENT" | "DECLINE" | "UNKNOWN";
/** Stateless simulator. Only atomic repository settlement creates a simulated
 * capture/order. Latency is cosmetic; timers never authorize holds or retry.
 */
export class SimulatedPayment implements Payment {
  constructor(private readonly scenario: PaymentScenario = "SUCCESS", private readonly delayMs = 100,
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    if (!["SUCCESS", "TRANSIENT_THEN_SUCCESS", "ALWAYS_TRANSIENT", "DECLINE", "UNKNOWN"].includes(scenario)) throw new RangeError("Unknown payment scenario");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2000) throw new RangeError("Simulator latency must be 0–2000ms");
  }
  async attempt(input: Parameters<Payment["attempt"]>[0]): Promise<PaymentOutcome> {
    await this.pause(this.delayMs);
    switch (this.scenario) {
      case "UNKNOWN": return { kind: "UNKNOWN" };
      case "DECLINE": return { kind: "DECLINED" };
      case "ALWAYS_TRANSIENT": return { kind: "TRANSIENT_FAILURE" };
      case "TRANSIENT_THEN_SUCCESS": if (input.attemptNumber === 1) return { kind: "TRANSIENT_FAILURE" };
    }
    return { kind: "SUCCEEDED", reference: `simulated:${input.attemptId}` };
  }
}
