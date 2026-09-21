import { GetCommand, type TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { toStoredItem } from "../src/serialize.js";
import type { CleanedWhere } from "../src/types.js";

const where: CleanedWhere[] = [{ field: "id", value: "p1", operator: "eq", mode: "sensitive" }];

describe("incrementOne ordinary ttl fields", () => {
  it.each([undefined, false] as const)("increments ttl without overlapping SET/ADD when TTL is %s", async (ttl) => {
    const row = toStoredItem("plugin", { id: "p1", ttl: 2 });
    const send = vi.fn(async (command: unknown) => command instanceof GetCommand ? { Item: row } : {});
    const store = new DynamoDBStore({ tableName: "auth", client: { send } as never, ...(ttl === false ? { ttl } : {}) });

    await expect(store.incrementOne("plugin", where, { ttl: 1 })).resolves.toEqual({ id: "p1", ttl: 3 });

    const command = send.mock.calls[1]?.[0] as TransactWriteCommand;
    const update = command.input.TransactItems?.[0]?.Update;
    expect(update?.UpdateExpression).toContain("ADD #inc0 :inc0");
    expect(update?.ExpressionAttributeNames?.["#inc0"]).toBe("ttl");
    expect(Object.values(update?.ExpressionAttributeNames ?? {}).filter((name) => name === "ttl")).toHaveLength(1);
    expect(update?.ExpressionAttributeValues?.[":entity"]).toEqual({ id: "p1", ttl: 3 });
  });

  it.each([undefined, false] as const)("sets ttl without duplicate update paths when TTL is %s", async (ttl) => {
    const row = toStoredItem("plugin", { id: "p1", ttl: 2 });
    const send = vi.fn(async (command: unknown) => command instanceof GetCommand ? { Item: row } : {});
    const store = new DynamoDBStore({ tableName: "auth", client: { send } as never, ...(ttl === false ? { ttl } : {}) });

    await expect(store.incrementOne("plugin", where, {}, { ttl: 4 })).resolves.toEqual({ id: "p1", ttl: 4 });

    const command = send.mock.calls[1]?.[0] as TransactWriteCommand;
    const update = command.input.TransactItems?.[0]?.Update;
    expect(update?.UpdateExpression).toContain("#set0 = :set0");
    expect(Object.values(update?.ExpressionAttributeNames ?? {}).filter((name) => name === "ttl")).toHaveLength(1);
    expect(update?.ExpressionAttributeValues?.[":entity"]).toEqual({ id: "p1", ttl: 4 });
  });
});
