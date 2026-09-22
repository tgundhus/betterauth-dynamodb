import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Test instrumentation only. Returned JSON bytes are not DynamoDB billed item bytes. */
export function measuredClient(client: DynamoDBDocumentClient) {
  const totals = { requests: 0, attempts: 0, readCapacityUnits: 0, writeCapacityUnits: 0, unclassifiedCapacityUnits: 0, capacityResponses: 0, returnedJsonBytes: 0 };
  const snapshot = () => ({ ...totals });
  const since = (before: ReturnType<typeof snapshot>) => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
  const send = async (command: any) => {
    command.input.ReturnConsumedCapacity = "TOTAL";
    totals.requests++;
    let response: any;
    try {
      response = await client.send(command);
    } catch (error) {
      totals.attempts += (error as { $metadata?: { attempts?: number } }).$metadata?.attempts ?? 1;
      throw error;
    }
    totals.attempts += response.$metadata?.attempts ?? 1;
    const capacities = Array.isArray(response.ConsumedCapacity) ? response.ConsumedCapacity : response.ConsumedCapacity ? [response.ConsumedCapacity] : [];
    for (const capacity of capacities) {
      totals.capacityResponses++;
      totals.readCapacityUnits += capacity.ReadCapacityUnits ?? 0;
      totals.writeCapacityUnits += capacity.WriteCapacityUnits ?? 0;
      // Some responses return a total without the read/write split. Do not
      // invent it, especially for retried idempotent transaction writes.
      if (capacity.ReadCapacityUnits === undefined && capacity.WriteCapacityUnits === undefined) totals.unclassifiedCapacityUnits += capacity.CapacityUnits ?? 0;
    }
    totals.returnedJsonBytes += Buffer.byteLength(JSON.stringify({ Item: response.Item, Items: response.Items, Responses: response.Responses }));
    return response;
  };
  return { client: new Proxy(client, { get: (target, property) => property === "send" ? send : Reflect.get(target, property) }), snapshot, since };
}
