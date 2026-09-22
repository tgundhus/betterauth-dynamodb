import { randomUUID } from "node:crypto";
import { DynamoDBAdapterError, DynamoDBConflictError, isConditionalTransactionCanceled } from "../errors.js";
import { chunks, dataPk, INTENT, keyId, LEASE_MS, ownedGuard, placeholder, rootKey, snapshotGuard, versioned, intentOf } from "./format.js";
import type { Journal } from "./journal.js";
import type { Action } from "./journal.js";
import type { Change, Decision, Entry, Intent, Item, Key } from "./types.js";

export class DynamoDBTransactionOutcomeUnknownError extends DynamoDBAdapterError {
  constructor(readonly transactionId: string, cause: unknown) {
    super(`DynamoDB transaction ${transactionId} has an unknown outcome. Resolve its durable decision before retrying the logical mutation.`, { cause });
  }
}

export class TransactionEngine {
  constructor(readonly journal: Journal) {}

  async commit(input: Change[]): Promise<void> {
    if (input.length === 0) return;
    const changes = validateChanges(input);
    for (const change of changes) this.journal.codec.validate(change.after);
    await this.releaseIncomingIntents(changes);
    const id = randomUUID();
    await this.journal.start(id, changes.length);
    try {
      await this.journal.save(id, changes);
      await this.prepare(id, changes);
      await this.decide(id, changes.length);
    } catch (error) {
      if (!await this.committedOrAbort(id, error)) {
        await this.tryRecover(id);
        throw error;
      }
    }
    // A cleanup failure cannot turn an already committed callback into a rollback.
    // The durable registry retains it for the application's recovery worker.
    await this.tryRecover(id);
  }

  private async releaseIncomingIntents(changes: Change[]): Promise<void> {
    const rows = await this.journal.getMany(changes.map((change) => change.key));
    for (const change of changes) if (intentOf(rows.get(keyId(change.key)) ?? null)) await this.release(change.key);
  }

  private async prepare(id: string, changes: Change[]): Promise<void> {
    let prepared = 0;
    for (const batch of chunks(changes, 99)) {
      const puts = batch.map((change, offset): Action => ({ Put: { TableName: this.journal.tableName, Item: placeholder(id, prepared + offset, change.key), ...snapshotGuard(change) } }));
      await this.journal.send([this.progress(id, prepared, batch.length), ...puts]);
      prepared += batch.length;
    }
  }

  private progress(id: string, before: number, count: number): Action {
    return { Update: { TableName: this.journal.tableName, Key: rootKey(id), UpdateExpression: "SET prepared = :after, expires = :expires", ConditionExpression: "#state = :preparing AND prepared = :before", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":after": before + count, ":expires": Date.now() + LEASE_MS, ":preparing": "PREPARING", ":before": before } } };
  }

  private async decide(id: string, count: number): Promise<void> {
    await this.journal.send([{ Update: { TableName: this.journal.tableName, Key: rootKey(id), UpdateExpression: "SET #state = :committed", ConditionExpression: "#state = :preparing AND prepared = :count", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":preparing": "PREPARING", ":committed": "COMMITTED", ":count": count } } }]);
  }

  private async committedOrAbort(id: string, original: unknown): Promise<boolean> {
    try {
      const decision = await this.journal.decision(id);
      if (!decision) throw new DynamoDBAdapterError("The transaction decision is missing.");
      if (decision?.state === "COMMITTED") return true;
      await this.abort(id);
      return (await this.journal.decision(id))?.state === "COMMITTED";
    } catch (cause) {
      throw new DynamoDBTransactionOutcomeUnknownError(id, { original, cause });
    }
  }

  private async abort(id: string, expiredOnly = false): Promise<void> {
    const condition = expiredOnly ? "#state = :preparing AND expires <= :now" : "#state = :preparing";
    try {
      await this.journal.send([{ Update: { TableName: this.journal.tableName, Key: rootKey(id), UpdateExpression: "SET #state = :aborted", ConditionExpression: condition, ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":preparing": "PREPARING", ":aborted": "ABORTED", ...(expiredOnly ? { ":now": Date.now() } : {}) } } }]);
    } catch (error) { if (!isConditionalTransactionCanceled(error)) throw error; }
  }

  async resolve(item: Item | null, key: Key): Promise<Item | null> {
    let current = item;
    for (let attempt = 0; attempt < 4; attempt++) {
      const intent = intentOf(current);
      if (!intent) return current;
      const value = await this.resolveIntent(intent);
      if (value !== undefined) return value;
      current = await this.journal.get(key);
    }
    throw new DynamoDBAdapterError("DynamoDB transaction metadata could not be resolved. The target has been retained; run transaction recovery or repair the journal.");
  }

  private async resolveIntent(intent: Intent): Promise<Item | null | undefined> {
    const decision = await this.journal.decision(intent.id);
    if (!decision) return undefined;
    const entry = await this.journal.entry(intent.id, intent.entry);
    if (!entry) return undefined;
    try { return await this.journal.payload(intent.id, intent.entry, entry, decision.state === "COMMITTED" ? "after" : "before"); }
    catch (error) { if (error instanceof DynamoDBAdapterError) return undefined; throw error; }
  }

  async recover(id: string, batches = Infinity): Promise<boolean> {
    const decision = await this.recoveryDecision(id);
    if (!decision) throw new DynamoDBAdapterError("The recovery registry references a missing transaction decision; restore or repair the journal.");
    if (decision.state === "PREPARING") return false;
    const remaining = await this.restoreEntries(decision, batches);
    return remaining > 0 && await this.journal.purge(id, remaining);
  }

  /** Ordinary writes help release terminal intents and wait for live owners without stealing their locks. */
  async release(key: Key): Promise<void> {
    while (true) {
      const intent = intentOf(await this.journal.get(key));
      if (!intent) return;
      const decision = await this.recoveryDecision(intent.id);
      if (!decision) throw new DynamoDBAdapterError("A prepared item has no durable transaction decision.");
      if (decision.state !== "PREPARING") await this.releaseEntry(intent, decision);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async releaseEntry(intent: Intent, decision: Decision): Promise<void> {
    const entry = await this.journal.entry(intent.id, intent.entry);
    if (!entry) throw new DynamoDBAdapterError("A prepared item has no journal entry.");
    await this.restore(decision, intent.entry, entry);
  }

  private async recoveryDecision(id: string): Promise<Decision | null> {
    const decision = await this.journal.decision(id);
    if (!decision) return null;
    if (decision.state !== "PREPARING" || decision.expires > Date.now()) return decision;
    await this.abort(id, true);
    return this.journal.decision(id);
  }

  private async restoreEntries(decision: Decision, batches: number): Promise<number> {
    let entries: { entry: Entry; index: number }[] = [];
    let bytes = 0;
    for await (const row of this.journal.rows(dataPk(decision.id), "E#")) {
      const entry = row as Entry;
      // New journals record a conservative encoded/native byte bound. Older journals
      // retain the conservative full-chunk estimate during recovery.
      const size = Number(entry.restoreBytes ?? (Number(entry.before) + Number(entry.after)) * 128 * 1024 + 1024);
      if (restoreBatchFull(entries.length, bytes + size)) {
        await this.restoreAndCheckpoint(decision, entries); entries = []; bytes = 0;
        if (--batches === 0) return 0;
      }
      entries.push({ entry, index: Number(String(row.sk).slice(2)) });
      bytes += size;
    }
    if (entries.length) { await this.restoreAndCheckpoint(decision, entries); batches--; }
    return batches;
  }

  private async restoreAndCheckpoint(decision: Decision, entries: { entry: Entry; index: number }[]): Promise<void> {
    await this.restoreBatch(decision, entries);
    // A missing manifest is safe only after its target no longer carries this
    // transaction's intent. Deletion checkpoints progress without a size cap.
    await this.journal.removeEntries(decision.id, entries.map(({ index }) => index));
  }

  private async restoreBatch(decision: Decision, entries: { entry: Entry; index: number }[], retry = true): Promise<void> {
    const rows = await this.journal.getMany(entries.map(({ entry }) => entry.target));
    const owned = entries.filter(({ entry, index }) => ownedBy(rows.get(keyId(entry.target)) ?? null, decision.id, index));
    if (!owned.length) return;
    const values = await this.journal.payloads(decision.id, owned, decision.state === "COMMITTED" ? "after" : "before");
    const actions = owned.map(({ entry, index }, position) => this.restoreAction(decision.id, index, entry.target, values[position]!));
    try { await this.journal.send([this.journal.terminalGuard(decision.id), ...actions]); }
    catch (error) {
      if (!isConditionalTransactionCanceled(error)) throw error;
      await this.retryRestore(decision, entries, owned, retry);
    }
  }

  private async retryRestore(decision: Decision, entries: { entry: Entry; index: number }[], owned: { entry: Entry; index: number }[], retry: boolean): Promise<void> {
    if (retry) await this.restoreBatch(decision, entries, false);
    else await this.restoreIndividually(decision, owned);
  }

  private async restoreIndividually(decision: Decision, entries: { entry: Entry; index: number }[]): Promise<void> {
    for (const { entry, index } of entries) await this.restore(decision, index, entry);
  }

  private async restore(decision: Decision, index: number, entry: Entry): Promise<void> {
    if (!ownedBy(await this.journal.get(entry.target), decision.id, index)) return;
    const value = await this.journal.payload(decision.id, index, entry, decision.state === "COMMITTED" ? "after" : "before");
    const target = this.restoreAction(decision.id, index, entry.target, value);
    try { await this.journal.send([this.journal.terminalGuard(decision.id), target]); }
    catch (error) { if (ownedBy(await this.journal.get(entry.target), decision.id, index)) throw error; }
  }

  private restoreAction(id: string, index: number, key: Key, item: Item | null): Action {
    const guard = { TableName: this.journal.tableName, ...ownedGuard(id, index) };
    return item ? { Put: { ...guard, Item: item } } : { Delete: { ...guard, Key: key } };
  }

  private async tryRecover(id: string): Promise<void> {
    try { await this.recover(id); } catch { /* Registry is durable; explicit recovery retries this work. */ }
  }
}

function ownedBy(item: Item | null, id: string, entry: number): boolean {
  const intent = intentOf(item);
  return intent?.id === id && intent.entry === entry;
}

function restoreBatchFull(count: number, bytes: number): boolean { return count > 0 && (count === 99 || bytes > 3_000_000); }

function validateChanges(input: Change[]): Change[] {
  const keys = input.map((change) => keyId(change.key));
  if (new Set(keys).size !== keys.length) throw new DynamoDBAdapterError("Transaction changes contain duplicate physical keys.");
  return input.map(prepareChange);
}

function prepareChange(change: Change): Change {
  if (change.before?.[INTENT] || change.after?.[INTENT]) throw new DynamoDBConflictError("Transaction changes must use resolved committed records.");
  if (change.before === change.after || !change.after) return change;
  return { ...change, after: versioned(change.after) };
}
