import { describe, expect, it } from "vitest";
import { finalPayouts } from "@/lib/polymarket/resolution";

describe("finalPayouts", () => {
  it("YES and NO wins", () => {
    expect(finalPayouts({ closed: true, outcomePrices: ["1", "0"], umaResolutionStatus: "resolved" })).toEqual({ payoutYes: "1", payoutNo: "0", winningSide: "YES" });
    expect(finalPayouts({ closed: true, outcomePrices: ["0", "1"], automaticallyResolved: true })).toEqual({ payoutYes: "0", payoutNo: "1", winningSide: "NO" });
  });

  it("50/50 resolution", () => {
    expect(finalPayouts({ closed: true, outcomePrices: ["0.5", "0.5"], umaResolutionStatus: "resolved" })!.winningSide).toBeNull();
  });

  it("is not final while open, unsettled, or priced near but not at 1", () => {
    expect(finalPayouts({ closed: false, outcomePrices: ["1", "0"], umaResolutionStatus: "resolved" })).toBeNull();
    expect(finalPayouts({ closed: true, outcomePrices: ["1", "0"], umaResolutionStatus: "proposed" })).toBeNull();
    expect(finalPayouts({ closed: true, outcomePrices: ["0.9995", "0.0005"], umaResolutionStatus: "resolved" })).toBeNull();
    expect(finalPayouts({ closed: true, outcomePrices: [], umaResolutionStatus: "resolved" })).toBeNull();
  });
});
