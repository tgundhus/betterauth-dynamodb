import type { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { DynamoDBAdapterError } from "../src/errors.js";
import { entitySk, modelPk } from "../src/keys.js";
import type { CleanedWhere } from "../src/types.js";

const idIn = (ids: string[]): CleanedWhere[] => [{ field: "id", operator: "in", value: ids, mode: "sensitive" }];
const row = (id: string) => ({ pk: modelPk("user"), sk: entitySk(id), id, entity: { id } });
const keyOf = (item: { pk: string; sk: string }) => ({ pk: item.pk, sk: item.sk });

describe("BatchGet retry progress", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("drains more than eight partial responses while requesting only remaining keys", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`u${index}`));
    const doc = {
      send: vi.fn(async (command: BatchGetCommand) => {
        const keys = command.input.RequestItems?.auth?.Keys ?? [];
        const item = rows.find((candidate) => candidate.sk === keys[0]?.sk);
        return { Responses: { auth: item ? [item] : [] }, UnprocessedKeys: { auth: { Keys: keys.slice(1) } } };
      })
    };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    const result = expect(store.findMany("user", idIn(rows.map((item) => item.id)), 20)).resolves.toEqual(rows.map((item) => item.entity));
    await vi.runAllTimersAsync();
    await result;
    expect(doc.send).toHaveBeenCalledTimes(rows.length);
    doc.send.mock.calls.forEach(([command], index) => {
      expect(command.input.RequestItems?.auth).toEqual({ Keys: rows.slice(index).map(keyOf), ConsistentRead: true });
    });
  });

  it("resets the stalled retry budget after progress", async () => {
    const rows = [row("u1"), row("u2")];
    let calls = 0;
    const doc = {
      send: vi.fn(async (command: BatchGetCommand) => {
        calls += 1;
        const keys = command.input.RequestItems?.auth?.Keys ?? [];
        if (calls === 8) return { Responses: { auth: [rows[0]] }, UnprocessedKeys: { auth: { Keys: keys.slice(1) } } };
        if (calls === 16) return { Responses: { auth: [rows[1]] } };
        return { UnprocessedKeys: command.input.RequestItems };
      })
    };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    const result = expect(store.findMany("user", idIn(["u1", "u2"]))).resolves.toEqual(rows.map((item) => item.entity));
    await vi.runAllTimersAsync();
    await result;
    expect(doc.send).toHaveBeenCalledTimes(16);
  });

  it("treats processed missing keys as progress and omits missing rows", async () => {
    const present = row("present");
    const ids = [...Array.from({ length: 10 }, (_, index) => `missing${index}`), present.id];
    const doc = {
      send: vi.fn(async (command: BatchGetCommand) => {
        const keys = command.input.RequestItems?.auth?.Keys ?? [];
        if (keys.length === 1) return { Responses: { auth: [present] } };
        return { UnprocessedKeys: { auth: { Keys: keys.slice(1) } } };
      })
    };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    const result = expect(store.findMany("user", idIn(ids))).resolves.toEqual([present.entity]);
    await vi.runAllTimersAsync();
    await result;
    expect(doc.send).toHaveBeenCalledTimes(ids.length);
  });

  it("fails after eight consecutive responses without progress", async () => {
    const doc = { send: vi.fn(async (command: BatchGetCommand) => ({ UnprocessedKeys: command.input.RequestItems })) };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    const result = expect(store.findMany("user", idIn(["u1"]))).rejects.toThrow("8 consecutive attempts without progress");
    await vi.runAllTimersAsync();
    await result;
    expect(doc.send).toHaveBeenCalledTimes(8);
  });

  it("rejects instead of returning partial rows when the remaining keys never make progress", async () => {
    const doc = {
      send: vi.fn(async (command: BatchGetCommand) => {
        const keys = command.input.RequestItems?.auth?.Keys ?? [];
        if (keys.length === 2) return { Responses: { auth: [row("u1")] }, UnprocessedKeys: { auth: { Keys: keys.slice(1) } } };
        return { UnprocessedKeys: command.input.RequestItems };
      })
    };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, consistentRead: false });

    const result = expect(store.findMany("user", idIn(["u1", "u2"]))).rejects.toBeInstanceOf(DynamoDBAdapterError);
    await vi.runAllTimersAsync();
    await result;
    expect(doc.send).toHaveBeenCalledTimes(9);
    expect(doc.send.mock.calls.every(([command]) => command.input.RequestItems?.auth?.ConsistentRead === false)).toBe(true);
  });

  it("returns no rows when all keys are processed but absent", async () => {
    const doc = { send: vi.fn(async () => ({})) };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.findMany("user", idIn(["missing"]))).resolves.toEqual([]);
    expect(doc.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates SDK request failures without adapter retries", async () => {
    const failure = new Error("Access denied");
    const doc = { send: vi.fn(async () => { throw failure; }) };
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.findMany("user", idIn(["u1"]))).rejects.toBe(failure);
    expect(doc.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
