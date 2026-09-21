import { BatchGetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { modelPk } from "../src/keys.js";
import { toIndexSidecars, toStoredItem } from "../src/serialize.js";
import type { CleanedWhere, StoredItem } from "../src/types.js";

const ttl = { defaultField: "expiresAt" };
const eq = (field: string, value: string): CleanedWhere => ({ field, value, operator: "eq", mode: "sensitive" });
const where = [eq("organizationId", "org"), eq("active", "yes")];
const cursor = (page: number) => ({ pk: "cursor", sk: String(page) });
const row = (id: string, extra: Record<string, unknown> = {}) => toStoredItem("user", { id, organizationId: "org", active: "yes", ...extra }, ttl);
const sidecar = (item: StoredItem) => toIndexSidecars("user", item.entity).find((entry) => entry.indexField === "organizationId")!;

type Page = { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };

function pagedClient(pages: Page[], owners: StoredItem[] = []) {
  let page = 0;
  return {
    send: vi.fn(async (command: QueryCommand | BatchGetCommand | TransactWriteCommand): Promise<Record<string, unknown>> => {
      if (command instanceof QueryCommand) {
        const result = pages[page++];
        if (!result) throw new Error("Unexpected extra Query");
        return result;
      }
      if (command instanceof BatchGetCommand) {
        const keys = command.input.RequestItems?.auth?.Keys ?? [];
        // DynamoDB does not preserve request order in BatchGet responses.
        return { Responses: { auth: owners.filter((owner) => keys.some((key) => key.pk === owner.pk && key.sk === owner.sk)).reverse() } };
      }
      return {};
    })
  };
}

function queryInputs(doc: ReturnType<typeof pagedClient>) {
  return doc.send.mock.calls.flatMap(([command]) => command instanceof QueryCommand ? [command.input] : []);
}

describe("limited read windows", () => {
  it("stops a scalar findOne after its first verified owner even with a continuation key", async () => {
    const owner = row("one");
    const doc = pagedClient([{ Items: [sidecar(owner)], LastEvaluatedKey: cursor(1) }], [owner]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, maxPages: 1 });

    await expect(store.findOne("user", where, ["id"])).resolves.toEqual({ id: "one" });
    expect(queryInputs(doc)).toHaveLength(1);
    expect(queryInputs(doc)[0]?.Limit).toBeUndefined();
    expect(doc.send).toHaveBeenCalledTimes(2);
  });

  it("continues through empty pages and missing, stale, expired, or residual-filtered owners", async () => {
    const missing = row("missing");
    const stale = row("stale", { organizationId: "different" });
    const expired = row("expired", { expiresAt: "2000-01-01T00:00:00.000Z" });
    const rejected = row("rejected", { active: "no" });
    const live = row("live");
    const pages: Page[] = [
      { LastEvaluatedKey: cursor(1) },
      { Items: [], LastEvaluatedKey: cursor(2) },
      { Items: [sidecar(missing)], LastEvaluatedKey: cursor(3) },
      { Items: [sidecar(row("stale"))], LastEvaluatedKey: cursor(4) },
      { Items: [sidecar(expired)], LastEvaluatedKey: cursor(5) },
      { Items: [sidecar(rejected)], LastEvaluatedKey: cursor(6) },
      { Items: [sidecar(live)], LastEvaluatedKey: cursor(7) }
    ];
    const doc = pagedClient(pages, [stale, expired, rejected, live]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl });

    await expect(store.findOne("user", where)).resolves.toMatchObject({ id: "live" });
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual(Array(7).fill(undefined));
    expect(queryInputs(doc).map((input) => input.ExclusiveStartKey)).toEqual([undefined, ...Array.from({ length: 6 }, (_, index) => cursor(index + 1))]);
  });

  it("counts the offset after residual filtering and keeps BatchGet results in Query order", async () => {
    const owners = [row("a"), row("rejected", { active: "no" }), row("b"), row("c"), row("d")];
    const doc = pagedClient([
      { Items: owners.slice(0, 2).map(sidecar), LastEvaluatedKey: cursor(1) },
      { Items: owners.slice(2, 4).map(sidecar), LastEvaluatedKey: cursor(2) },
      { Items: owners.slice(4).map(sidecar), LastEvaluatedKey: cursor(3) }
    ], owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, pageSize: 3, maxPages: 3 });

    await expect(store.findMany("user", where, 2, 2, undefined, ["id"])).resolves.toEqual([{ id: "c" }, { id: "d" }]);
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([3, 3, 3]);
  });

  it("continues model queries until TTL and residual filters leave a live match", async () => {
    const doc = pagedClient([
      { LastEvaluatedKey: cursor(1) },
      { Items: [row("expired", { name: "match", expiresAt: "2000-01-01T00:00:00.000Z" })], LastEvaluatedKey: cursor(2) },
      { Items: [row("rejected", { name: "other" })], LastEvaluatedKey: cursor(3) },
      { Items: [row("live", { name: "match" })], LastEvaluatedKey: cursor(4) }
    ]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl, unsafeAllowScan: true });

    await expect(store.findOne("user", [{ ...eq("name", "match"), operator: "contains" }])).resolves.toMatchObject({ id: "live" });
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([undefined, undefined, undefined, undefined]);
    expect(queryInputs(doc).every((input) => input.ExpressionAttributeValues?.[":pk"] === modelPk("user"))).toBe(true);
  });

  it("preserves the configured page size while stopping after the model window", async () => {
    const doc = pagedClient([
      { Items: [row("a"), row("b")], LastEvaluatedKey: cursor(1) },
      { Items: [row("c")], LastEvaluatedKey: cursor(2) }
    ]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, pageSize: 2, maxPages: 2, unsafeAllowScan: true });

    await expect(store.findMany("user", [], 2, 1, undefined, ["id"])).resolves.toEqual([{ id: "b" }, { id: "c" }]);
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([2, 2]);
  });

  it.each(["sidecar", "model"] as const)("keeps default %s page sizing when many candidates fail residual filters", async (access) => {
    const owners = [...Array.from({ length: 30 }, (_, index) => row(String(index), { active: "no" })), row("live")];
    const doc = pagedClient([{ Items: access === "sidecar" ? owners.map(sidecar) : owners, LastEvaluatedKey: cursor(1) }], owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });
    const predicate = access === "sidecar" ? where : [{ ...eq("active", "yes"), operator: "contains" as const }];

    await expect(store.findOne("user", predicate)).resolves.toMatchObject({ id: "live" });
    expect(queryInputs(doc)).toHaveLength(1);
    expect(queryInputs(doc)[0]?.Limit).toBeUndefined();
  });

  it.each(["sidecar", "model"] as const)("returns a smaller result only when %s pagination is exhausted", async (access) => {
    const owner = row("only");
    const doc = pagedClient([
      { Items: [], LastEvaluatedKey: cursor(1) },
      { Items: [access === "sidecar" ? sidecar(owner) : owner] }
    ], [owner]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });

    await expect(store.findMany("user", access === "sidecar" ? where : [], 3, 0, undefined, ["id"])).resolves.toEqual([{ id: "only" }]);
    expect(queryInputs(doc)).toHaveLength(2);
  });

  it.each(["sidecar", "model"] as const)("throws if maxPages prevents completing a %s window", async (access) => {
    const owner = row("only");
    const doc = pagedClient([{ Items: [access === "sidecar" ? sidecar(owner) : owner], LastEvaluatedKey: cursor(1) }], [owner]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true, maxPages: 1 });

    await expect(store.findMany("user", access === "sidecar" ? where : [], 2)).rejects.toThrow(/exceeded maxPages/);
    expect(queryInputs(doc)).toHaveLength(1);
  });

  it.each(["sidecar", "model"] as const)("fully drains sorted %s reads before selecting the best result", async (access) => {
    const owners = [row("first", { score: 3 }), row("last", { score: 1 })];
    const doc = pagedClient(owners.map((owner, index) => ({ Items: [access === "sidecar" ? sidecar(owner) : owner], ...(index === 0 ? { LastEvaluatedKey: cursor(1) } : {}) })), owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });

    await expect(store.findMany("user", access === "sidecar" ? where : [], 1, 0, { field: "score", direction: "asc" }, ["id"])).resolves.toEqual([{ id: "last" }]);
    expect(queryInputs(doc)).toHaveLength(2);
    expect(queryInputs(doc).every((input) => input.Limit === undefined)).toBe(true);
  });

  it.each(["count", "updateMany", "deleteMany"] as const)("fully drains %s before returning or mutating matches", async (operation) => {
    const owners = [row("a"), row("b")];
    const doc = pagedClient([
      { Items: [sidecar(owners[0]!)], LastEvaluatedKey: cursor(1) },
      { Items: [sidecar(owners[1]!)] }
    ], owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    const result = operation === "updateMany" ? await store.updateMany("user", where, { active: "updated" }) : await store[operation]("user", where);
    expect(result).toBe(2);
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([undefined, undefined]);
    expect(doc.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(operation === "count" ? 0 : 2);
  });

  it("keeps field IN reads fully drained", async () => {
    const owners = [row("a"), row("b")];
    const doc = pagedClient([
      { Items: [sidecar(owners[0]!)], LastEvaluatedKey: cursor(1) },
      { Items: [sidecar(owners[1]!)] }
    ], owners);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.findOne("user", [{ ...eq("organizationId", "org"), operator: "in", value: ["org"] }])).resolves.toMatchObject({ id: "a" });
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([undefined, undefined]);
  });

  it.each([
    [0, 0], [-1, 0], [1.5, 0], [Infinity, 0], [1, -1], [1, 0.5], [1, Infinity], [Number.MAX_SAFE_INTEGER, 1]
  ])("preserves slice semantics without a Query cap for limit %s and offset %s", async (limit, offset) => {
    const owners = [row("a"), row("b")];
    const doc = pagedClient([{ Items: [owners[0]!], LastEvaluatedKey: cursor(1) }, { Items: [owners[1]!] }]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });

    await expect(store.findMany("user", [], limit, offset, undefined, ["id"])).resolves.toEqual(owners.slice(offset, offset + limit).map((owner) => ({ id: owner.id })));
    expect(queryInputs(doc).map((input) => input.Limit)).toEqual([undefined, undefined]);
  });
});
