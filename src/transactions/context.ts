import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBConflictError } from "../errors.js";
import { REVISION_ATTRIBUTE } from "../serialize.js";
import type { SidecarItem, StoredItem } from "../types.js";
import { chunks, intentOf, keyId, keyOf, PHYSICAL_VERSION } from "./format.js";
import type { TransactionEngine } from "./engine.js";
import type { Change, Item, Key } from "./types.js";

interface Observation { key: Key; item: StoredItem | null }
interface SidecarChange { key: Key; before: SidecarItem | null; after: SidecarItem | null }

export class CallbackContext {
  private readonly observations = new Map<string, Observation>();
  private readonly writes = new Map<string, StoredItem | null>();
  private closed = false;
  private failure: Error | undefined;

  constructor(readonly engine: TransactionEngine, private readonly sidecars: (item: StoredItem) => SidecarItem[]) {}

  client(base: DynamoDBDocumentClient): DynamoDBDocumentClient {
    const send = async (command: any) => {
      this.assertOpen();
      const result = await base.send(command);
      this.recordResponse(command, result);
      return result;
    };
    return new Proxy(base, { get: (target, property) => property === "send" ? send : Reflect.get(target, property) });
  }

  private recordResponse(command: any, result: any): void {
    if (command instanceof GetCommand) this.observe(command.input.Key as Key, result.Item ?? null);
    if (command instanceof QueryCommand) this.recordQuery(result.Items ?? []);
    if (command instanceof BatchGetCommand) this.recordBatch(command, result);
  }

  private recordQuery(items: StoredItem[]): void { for (const row of items) this.observe(keyOf(row), row); }

  private recordBatch(command: BatchGetCommand, result: any): void {
    for (const [table, request] of Object.entries(command.input.RequestItems ?? {})) {
      this.recordBatchTable(request.Keys as Key[] ?? [], result.UnprocessedKeys?.[table]?.Keys ?? [], result.Responses?.[table] ?? []);
    }
  }

  private recordBatchTable(keys: Key[], unprocessed: Key[], items: StoredItem[]): void {
    const pending = new Set(unprocessed.map(keyId));
    const rows = new Map(items.map((row) => [keyId(row), row]));
    for (const key of keys) if (!pending.has(keyId(key))) this.observe(key, rows.get(keyId(key)) ?? null);
  }

  private observe(key: Key, item: StoredItem | null): void {
    if (!key.pk.startsWith("MODEL#")) return;
    const id = keyId(key);
    const prior = this.observations.get(id);
    if (prior && !sameVersion(prior.item, item)) this.fail("A callback read observed a concurrent change. Retry the whole logical operation.");
    this.observations.set(id, { key, item: structuredClone(item) });
  }

  overlay(model: string, rows: StoredItem[]): StoredItem[] {
    this.assertOpen();
    const merged = new Map(rows.map((row) => [keyId(row), row]));
    for (const [id, item] of this.writes) {
      if (item?.model === model) merged.set(id, structuredClone(item));
      else merged.delete(id);
    }
    return [...merged.values()];
  }

  async create(item: StoredItem, client: DynamoDBDocumentClient): Promise<void> {
    this.assertOpen();
    const key = keyOf(item);
    const id = keyId(key);
    if (!this.observations.has(id)) {
      const result = await client.send(new GetCommand({ TableName: this.engine.journal.tableName, Key: key, ConsistentRead: true }));
      this.observe(key, (result.Item ?? null) as StoredItem | null);
    }
    if (this.current(id)) this.fail("A transaction cannot create a record whose id already exists.");
    this.writes.set(id, structuredClone(item));
  }

  replace(before: StoredItem, after: StoredItem | null): void {
    this.assertOpen();
    const id = keyId(before);
    if (!sameVersion(this.current(id), before)) this.fail("Concurrent operations inside a callback targeted the same record.");
    if (after && keyId(after) !== id) this.fail("Record ids cannot change inside a transaction.");
    this.writes.set(id, structuredClone(after));
  }

  private current(id: string): StoredItem | null {
    if (this.writes.has(id)) return this.writes.get(id) ?? null;
    return this.observations.get(id)?.item ?? null;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    const changes: Change[] = [...this.observations].map(([id, observed]) => ({ key: observed.key, before: observed.item, after: this.writes.has(id) ? this.writes.get(id)! : observed.item }));
    const sides = this.sidecarChanges();
    const snapshots = await this.engine.journal.getMany(sides.map((side) => side.key));
    for (const batch of chunks(sides, 16)) changes.push(...await Promise.all(batch.map((side) => this.resolveSidecar(side, snapshots.get(keyId(side.key)) ?? null))));
    await this.engine.commit(changes);
  }

  close(): void { this.closed = true; }

  private sidecarChanges(): SidecarChange[] {
    const changes = new Map<string, SidecarChange>();
    for (const [id, after] of this.writes) {
      const before = this.observations.get(id)!.item;
      this.addSidecars(changes, before, "before");
      this.addSidecars(changes, after, "after");
    }
    return [...changes.values()].filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
  }

  private addSidecars(changes: Map<string, SidecarChange>, item: StoredItem | null, side: "before" | "after"): void {
    if (!item) return;
    for (const row of this.sidecars(item)) {
      const id = keyId(row);
      const change = changes.get(id) ?? { key: keyOf(row), before: null, after: null };
      if (change[side] && !sameOwner(change[side]!, row)) this.fail("Two records in the callback claim the same unique value.");
      change[side] = row;
      changes.set(id, change);
    }
  }

  private async resolveSidecar(change: SidecarChange, snapshot: Item | null): Promise<Change> {
    let before = snapshot;
    if (intentOf(before)) {
      await this.engine.release(change.key);
      before = await this.engine.journal.get(change.key);
    }
    if (before && !allowedOwner(before, change.before)) this.fail("A transaction conflicts with an existing index or unique-value owner.");
    return { key: change.key, before, after: change.after };
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new DynamoDBConflictError("The transaction-scoped adapter is no longer active.");
  }

  private fail(message: string): never {
    this.failure = new DynamoDBConflictError(message);
    throw this.failure;
  }
}

function sameVersion(left: StoredItem | null, right: StoredItem | null): boolean {
  if (!left || !right) return left === right;
  return left[REVISION_ATTRIBUTE] === right[REVISION_ATTRIBUTE] && left[PHYSICAL_VERSION] === right[PHYSICAL_VERSION];
}

function sameOwner(left: Item, right: Item): boolean { return left.ownerPk === right.ownerPk && left.ownerSk === right.ownerSk; }
function allowedOwner(actual: Item, expected: Item | null): boolean { return expected !== null && sameOwner(actual, expected); }
