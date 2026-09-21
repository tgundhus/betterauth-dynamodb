import { GetCommand, QueryCommand, type BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { toIndexSidecars, toStoredItem } from "../src/serialize.js";
import type { CleanedWhere, StoredItem } from "../src/types.js";

const start = Date.parse("2030-01-01T00:00:00.000Z");
const ttl = { defaultField: "expiresAt" };
const row = (id: string, expiresAt?: string) => toStoredItem("user", { id, role: "admin", ...(expiresAt ? { expiresAt } : {}) }, ttl);
type Access = "sidecar" | "model";
const predicate = (access: Access): CleanedWhere[] => access === "sidecar" ? [{ field: "role", operator: "eq", value: "admin", mode: "sensitive" }] : [];

function delayedPages(access: Access, owners: StoredItem[], stopAfter = owners.length) {
  let page = 0;
  return {
    send: vi.fn(async (command: QueryCommand | BatchGetCommand): Promise<Record<string, unknown>> => {
      if (command instanceof QueryCommand) {
        vi.setSystemTime(start + page * 2000);
        const owner = owners[page++];
        if (!owner) throw new Error("Unexpected extra page");
        const item = access === "model" ? owner : toIndexSidecars("user", owner.entity).find((entry) => entry.indexField === "role")!;
        return { Items: [item], ...(page < stopAfter ? { LastEvaluatedKey: { pk: item.pk, sk: item.sk } } : {}) };
      }
      const keys = command.input.RequestItems?.auth?.Keys ?? [];
      return { Responses: { auth: owners.filter((owner) => keys.some((key) => key.pk === owner.pk && key.sk === owner.sk)) } };
    })
  };
}

describe("read windows crossing logical expiration", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["sidecar", "model"] as const)("refills a %s window when earlier rows expire during later page reads", async (access) => {
    const owners = [row("expires", new Date(start + 1000).toISOString()), row("b"), row("c"), row("unneeded")];
    const doc = delayedPages(access, owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl, unsafeAllowScan: true, pageSize: 1, maxPages: 3 });

    await expect(store.findMany("user", predicate(access), 2, 0, undefined, ["id"])).resolves.toEqual([{ id: "b" }, { id: "c" }]);
    expect(doc.send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(3);
  });

  it.each(["sidecar", "model"] as const)("applies offset after removing %s rows that expire between pages", async (access) => {
    const owners = [row("expires", new Date(start + 1000).toISOString()), row("b"), row("c"), row("unneeded")];
    const doc = delayedPages(access, owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl, unsafeAllowScan: true, pageSize: 1 });

    await expect(store.findMany("user", predicate(access), 1, 1, undefined, ["id"])).resolves.toEqual([{ id: "c" }]);
    expect(doc.send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(3);
  });

  it.each(["sidecar", "model"] as const)("omits newly expired %s rows when pagination ends before the window fills", async (access) => {
    const owners = [row("expires", new Date(start + 1000).toISOString()), row("b")];
    const doc = delayedPages(access, owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl, unsafeAllowScan: true, pageSize: 1 });

    await expect(store.findMany("user", predicate(access), 2)).resolves.toEqual([owners[1]!.entity]);
  });

  it.each(["sidecar", "model"] as const)("still enforces maxPages when expiration leaves the %s window incomplete", async (access) => {
    const owners = [row("expires", new Date(start + 1000).toISOString()), row("b"), row("c")];
    const doc = delayedPages(access, owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl, unsafeAllowScan: true, pageSize: 1, maxPages: 2 });

    await expect(store.findMany("user", predicate(access), 2)).rejects.toThrow(/exceeded maxPages/);
    expect(doc.send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(2);
  });

  it("returns null rather than an empty record if an entity expires during final serialization", async () => {
    const owner = row("expires", new Date(start + 1000).toISOString());
    const doc = { send: vi.fn(async (command: unknown) => command instanceof GetCommand ? { Item: owner } : {}) };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl });
    vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 2000);

    await expect(store.findOne("user", [{ field: "id", operator: "eq", value: "expires", mode: "sensitive" }])).resolves.toBeNull();
  });
});
