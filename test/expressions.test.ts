import { describe, expect, it } from "vitest";
import { buildCondition, buildUpdateExpression } from "../src/expressions.js";

describe("expression builders", () => {
  it("builds condition and update expressions", () => {
    expect(buildCondition([{ field: "remaining", operator: "gt", value: 0, connector: "AND", mode: "sensitive" }]).expression).toBe("#w0 > :w0");
    expect(buildUpdateExpression({ used: true }, { remaining: -1 }).expression).toBe("SET #s0 = :s0 ADD #a0 :a0");
  });

  it("rejects operators that are only supported by in-memory filtering", () => {
    expect(() => buildCondition([{ field: "email", operator: "ends_with", value: ".com", connector: "AND", mode: "sensitive" }])).toThrow(/cannot translate/);
    expect(() => buildCondition([{ field: "id", operator: "in", value: ["a"], connector: "AND", mode: "sensitive" }])).toThrow(/cannot translate/);
    expect(() => buildCondition([{ field: "id", operator: "not_in", value: ["a"], connector: "AND", mode: "sensitive" }])).toThrow(/cannot translate/);
  });
});
