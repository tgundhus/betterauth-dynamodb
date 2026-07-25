import { describe, expect, it } from "vitest";
import { UnsupportedQueryError } from "../src/errors";
import { matchesWhere, planQuery } from "../src/where";
import type { CleanedWhere } from "../src/types";

const clause = (field: string, operator: CleanedWhere["operator"], value: CleanedWhere["value"]): CleanedWhere => ({ field, operator, value, connector: "AND", mode: "sensitive" });

describe("where planning and matching", () => {
  it("plans id and scalar equality efficiently", () => {
    expect(planQuery([clause("id", "eq", "1")]).kind).toBe("byId");
    expect(planQuery([clause("email", "eq", "a")]).kind).toBe("byFieldValue");
  });

  it("evaluates comparison, string, and set operators", () => {
    const item = { email: "Hello@Test.com", count: 2 };
    expect(matchesWhere(item, [clause("count", "gte", 2), clause("email", "ends_with", ".com")])).toBe(true);
    expect(matchesWhere(item, [clause("count", "in", [1, 2])])).toBe(true);
    expect(matchesWhere(item, [clause("count", "not_in", [3])])).toBe(true);
  });

  it("supports insensitive comparisons", () => {
    const where: CleanedWhere[] = [{ field: "email", operator: "eq", value: "hello@test.com", connector: "AND", mode: "insensitive" }];
    expect(matchesWhere({ email: "Hello@Test.com" }, where)).toBe(true);
  });

  it("rejects unknown in-memory operators actionably", () => {
    const where = [{ field: "email", operator: "regex", value: "@", connector: "AND", mode: "sensitive" }] as unknown as CleanedWhere[];
    expect(() => matchesWhere({ email: "a@example.com" }, where)).toThrow(UnsupportedQueryError);
    expect(() => matchesWhere({ email: "a@example.com" }, where)).toThrow(/Unsupported Better Auth where operator "regex"/);
  });

  it("rejects unknown operators before scan planning", () => {
    const where = [{ field: "email", operator: "regex", value: "@", connector: "AND", mode: "sensitive" }] as unknown as CleanedWhere[];
    expect(() => planQuery(where)).toThrow(UnsupportedQueryError);
    expect(() => planQuery(where)).toThrow(/Unsupported Better Auth where operator "regex"/);
  });
});
