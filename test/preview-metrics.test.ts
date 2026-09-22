import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { expect, it, vi } from "vitest";
import { measuredClient } from "./preview/metrics.js";

it("measures request attempts and reported capacity without inventing a missing read/write split", async () => {
  const send = vi.fn().mockResolvedValueOnce({ $metadata: { attempts: 2 }, Items: [{ id: "one" }], ConsumedCapacity: { CapacityUnits: 3 } })
    .mockResolvedValueOnce({ $metadata: { attempts: 1 }, ConsumedCapacity: [{ ReadCapacityUnits: 1, WriteCapacityUnits: 4 }] })
    .mockRejectedValueOnce(Object.assign(new Error("throttled"), { $metadata: { attempts: 3 } }));
  const metrics = measuredClient({ send } as unknown as DynamoDBDocumentClient);
  const before = metrics.snapshot();
  const query = new QueryCommand({ TableName: "test" });
  await metrics.client.send(query);
  expect(query.input.ReturnConsumedCapacity).toBe("TOTAL");
  await metrics.client.send(new TransactWriteCommand({ TransactItems: [] }));
  await expect(metrics.client.send(query)).rejects.toThrow("throttled");
  expect(metrics.since(before)).toEqual({ requests: 3, attempts: 6, readCapacityUnits: 1, writeCapacityUnits: 4, unclassifiedCapacityUnits: 3, capacityResponses: 2, returnedJsonBytes: Buffer.byteLength(JSON.stringify({ Items: [{ id: "one" }] })) + 2 });
  expect(before.requests).toBe(0);
});
