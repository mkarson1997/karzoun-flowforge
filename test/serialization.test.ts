import { describe, expect, it } from "vitest";
import { decodeStoredValue, encodeStoredValue } from "../src/serialization.js";

describe("durable value serialization", () => {
  it("round-trips nested undefined values without sentinel collisions", () => {
    const value = {
      undefinedValue: undefined,
      ordinaryObject: { type: "undefined", value: "user-data" },
      list: [1, undefined, null, true, "text"],
    };

    expect(decodeStoredValue(encodeStoredValue(value))).toEqual(value);
  });

  it("rejects non-finite numbers instead of silently corrupting them", () => {
    expect(() => encodeStoredValue(Number.NaN)).toThrow(/finite numbers/);
    expect(() => encodeStoredValue(Number.POSITIVE_INFINITY)).toThrow(/finite numbers/);
  });

  it("rejects circular values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeStoredValue(value)).toThrow(/circular/);
  });
});
