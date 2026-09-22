import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoDBAdapterError } from "../errors.js";
import { JournalCodec } from "./codec.js";
import { blobKey, dataPk, entryKey, keyOf, LEASE_MS, registryKey, rootKey } from "./format.js";
import type { Change, Decision, Entry, Item, Key } from "./types.js";

export type Action = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export class Journal {
  readonly codec: JournalCodec;
  constructor(readonly client: DynamoDBDocumentClient, readonly tableName: string, readonly ttlAttribute = "ttl") {
    const translate = client.config?.translateConfig;
    this.codec = new JournalCodec(translate?.marshallOptions, translate?.unmarshallOptions);
  }

  async get(key: Key): Promise<Item | null> {
    return (await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))).Item ?? null;
  }

  async decision(id: string): Promise<Decision | null> { return await this.get(rootKey(id)) as Decision | null; }

  async send(actions: Action[]): Promise<void> {
    await this.client.send(new TransactWriteCommand({ TransactItems: actions, ClientRequestToken: randomUUID() }));
  }

  async start(id: string, count: number): Promise<void> {
    const item: Decision = { ...rootKey(id), id, state: "PREPARING", count, prepared: 0, expires: Date.now() + LEASE_MS };
    await this.send([item, { ...registryKey(id), id }].map((Item) => ({ Put: { TableName: this.tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } })));
  }

  heartbeat(id: string): Action {
    return { Update: { TableName: this.tableName, Key: rootKey(id), UpdateExpression: "SET expires = :expires", ConditionExpression: "#state = :preparing", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":expires": Date.now() + LEASE_MS, ":preparing": "PREPARING" } } };
  }

  async save(id: string, changes: Change[]): Promise<void> {
    let rows: Item[] = [];
    let bytes = 0;
    for (let index = 0; index < changes.length; index++) {
      for (const row of this.entryRows(id, index, changes[index]!)) {
        const size = journalRowSize(row);
        if (rows.length === 98 || bytes + size > 3_000_000) { await this.saveRows(id, rows); rows = []; bytes = 0; }
        rows.push(row);
        bytes += size;
      }
    }
    if (rows.length) await this.saveRows(id, rows);
  }

  private entryRows(id: string, index: number, change: Change): Item[] {
    const before = this.codec.encode(change.before);
    const after = this.codec.encode(change.after);
    const entry: Entry = { ...entryKey(id, index), target: change.key, before: before.length, after: after.length };
    return [entry, ...blobRows(id, index, "before", before), ...blobRows(id, index, "after", after)];
  }

  private async saveRows(id: string, rows: Item[]): Promise<void> {
    await this.send([this.heartbeat(id), ...rows.map((Item) => ({ Put: { TableName: this.tableName, Item } }))]);
  }

  async entry(id: string, index: number): Promise<Entry | null> { return await this.get(entryKey(id, index)) as Entry | null; }

  async payload(id: string, index: number, entry: Entry, side: "before" | "after"): Promise<Item | null> {
    const parts: Uint8Array[] = [];
    for (let part = 0; part < entry[side]; part++) parts.push(requireBlob(await this.get(blobKey(id, index, side, part))));
    return this.codec.decode(parts);
  }

  async *rows(pk: string): AsyncGenerator<Item> {
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: 50, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const row of result.Items ?? []) yield row;
      cursor = result.LastEvaluatedKey;
    } while (cursor);
  }

  async purge(id: string): Promise<void> {
    let actions: Action[] = [];
    for await (const item of this.rows(dataPk(id))) {
      if (item.sk === "ROOT") continue;
      actions.push({ Delete: { TableName: this.tableName, Key: keyOf(item) } });
      if (actions.length === 99) { await this.send([this.terminalGuard(id), ...actions]); actions = []; }
    }
    if (actions.length) await this.send([this.terminalGuard(id), ...actions]);
    const guard = this.terminalGuard(id).ConditionCheck!;
    await this.send([
      { Update: { ...guard, UpdateExpression: "SET cleaned = :cleaned, #ttl = :ttl", ExpressionAttributeNames: { ...guard.ExpressionAttributeNames, "#ttl": this.ttlAttribute }, ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ":cleaned": true, ":ttl": Math.floor(Date.now() / 1000) + 7 * 86400 } } },
      { Delete: { TableName: this.tableName, Key: registryKey(id) } }
    ]);
  }

  terminalGuard(id: string): Action {
    return { ConditionCheck: { TableName: this.tableName, Key: rootKey(id), ConditionExpression: "#state IN (:committed, :aborted)", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":committed": "COMMITTED", ":aborted": "ABORTED" } } };
  }
}

function blobRows(id: string, index: number, side: string, parts: Uint8Array[]): Item[] {
  return parts.map((bytes, part) => ({ ...blobKey(id, index, side, part), bytes }));
}

function requireBlob(item: Item | null): Uint8Array {
  if (!item?.bytes) throw new DynamoDBAdapterError("Transaction journal payload is unavailable; reread the target after concurrent recovery.");
  return item.bytes as Uint8Array;
}

function journalRowSize(item: Item): number { return item.bytes ? (item.bytes as Uint8Array).byteLength + 4096 : Buffer.byteLength(JSON.stringify(item)) + 1024; }
