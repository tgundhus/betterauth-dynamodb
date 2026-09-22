import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
  type DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { createDocumentClient, normalizeOptions } from "./client.js";
import { DynamoDBAdapterError, DynamoDBConflictError, isConditionalCheckFailed, isConditionalTransactionCanceled, transactionCancellationCodes } from "./errors.js";
import { entitySk, indexPk, modelPk } from "./keys.js";
import { REVISION_ATTRIBUTE, fromStoredItem, isLogicallyExpired, revisionOf, stripUndefined, toIndexSidecars, toSchemaUniqueLocks, toStoredItem, toUniqueLocks, ttlAttribute } from "./serialize.js";
import type { CleanedWhere, DynamoDBStoreOptions, QueryPlan, SidecarItem, StoredItem, TtlOptions } from "./types.js";
import { eqWhere, firstEquality, inWhere, matchesWhere, planQuery, safeInWhere, scalarValues } from "./where.js";
import { CallbackContext } from "./transactions/context.js";
import { TransactionEngine } from "./transactions/engine.js";
import { Journal } from "./transactions/journal.js";
import { participatingClient } from "./transactions/client.js";

const MAX_TRANSACT_ITEMS = 100;
const MAX_IN_VALUES = 1000;
const MAX_BATCH_GET_ITEMS = 100;
const MAX_BATCH_GET_STALLED_ATTEMPTS = 8;

export class DynamoDBStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly options: ReturnType<typeof normalizeOptions<DynamoDBStoreOptions>>;
  private readonly engine: TransactionEngine | undefined;
  private readonly context: CallbackContext | undefined;

  constructor(options: DynamoDBStoreOptions) {
    this.options = normalizeOptions(transactionOptions(options));
    const raw = createDocumentClient(this.options);
    this.engine = storeEngine(options, raw);
    this.context = options.transactionContext;
    const client = this.engine && !options.transactionEngine ? participatingClient(raw, this.engine) : raw;
    this.client = this.context ? this.context.client(client) : client;
  }

  async transaction<R>(callback: (store: DynamoDBStore) => Promise<R>): Promise<R> {
    if (this.context) return callback(this);
    if (!this.engine) throw new DynamoDBAdapterError("Callback transactions are not enabled.");
    const context = new CallbackContext(this.engine, (item) => this.allSidecars(item.model, item.entity));
    const scoped = new DynamoDBStore({ ...this.options, client: this.client, transactionContext: context, transactionEngine: this.engine });
    try {
      const result = await callback(scoped);
      await context.commit();
      return result;
    } finally { context.close(); }
  }

  async create<T extends Record<string, unknown>>(model: string, data: T): Promise<T> {
    const item = toStoredItem(model, data, this.options.ttl);
    if (this.context) await this.context.create(item, this.client);
    else await this.transactPutNew([item, ...this.allSidecars(model, data)], "create");
    return fromStoredItem<T>(item, this.options.ttl) as T;
  }

  async findOne<T>(model: string, where: CleanedWhere[], select?: string[]): Promise<T | null> {
    const rows = await this.findMany<T>(model, where, 1, 0, undefined, select);
    return rows[0] ?? null;
  }

  async findMany<T>(model: string, where: CleanedWhere[] = [], limit = 100, offset = 0, sortBy?: { field: string; direction: "asc" | "desc" }, select?: string[]): Promise<T[]> {
    const plan = planQuery(where, this.options.unsafeAllowScan);
    const rows = await this.loadRows(model, plan, sortBy ? undefined : readWindowSize(limit, offset));
    return selectWindow(rows.filter((row) => matchesWhere(row, where)), limit, offset, sortBy, this.options.ttl, select) as T[];
  }

  async count(model: string, where: CleanedWhere[] = []): Promise<number> {
    const plan = planQuery(where, this.options.unsafeAllowScan);
    const rows = await this.loadRows(model, plan);
    return rows.filter((row) => matchesWhere(row, where)).length;
  }

  async update<T>(model: string, where: CleanedWhere[], update: Record<string, unknown>): Promise<T | null> {
    const target = await this.targetByWhere(model, where);
    if (!target) return null;
    const next = { ...target.entity, ...stripUndefined(update) };
    const item = toStoredItem(model, next, this.options.ttl);
    try {
      await this.transactReplace(model, target, item);
      return fromStoredItem<T>(item, this.options.ttl);
    } catch (error) {
      if (isWriteRace(error)) throw conflictError("update", error);
      throw error;
    }
  }

  async updateMany(model: string, where: CleanedWhere[], update: Record<string, unknown>): Promise<number> {
    const targets = await this.matchingTargets(model, where);
    return this.writeMany(targets.map((row) => [row, { ...row.entity, ...stripUndefined(update) }] as const), model);
  }

  async delete(model: string, where: CleanedWhere[]): Promise<void> {
    const target = await this.targetByWhere(model, where);
    if (!target) return;
    try {
      await this.transactDelete(target);
    } catch (error) {
      if (isWriteRace(error)) throw conflictError("delete", error);
      throw error;
    }
  }

  async deleteMany(model: string, where: CleanedWhere[]): Promise<number> {
    const targets = await this.matchingTargets(model, where);
    await runBounded(targets, this.options.maxBulkConcurrency, (row) => this.transactDelete(row));
    return targets.length;
  }

  async consumeOne<T>(model: string, where: CleanedWhere[]): Promise<T | null> {
    const target = await this.targetByWhere(model, where);
    if (!target) return null;
    try {
      await this.transactDelete(target);
      return fromStoredItem<T>(target, this.options.ttl);
    } catch (error) {
      if (isWriteRace(error)) return null;
      throw error;
    }
  }

  async incrementOne<T>(model: string, where: CleanedWhere[], increment: Record<string, number>, set?: Record<string, unknown>): Promise<T | null> {
    const target = await this.targetByWhere(model, where);
    if (!target) return null;
    const cleanedSet = stripUndefined(set ?? {});
    validateIncrementInput(increment);
    const next = applyIncrement(target.entity, increment, cleanedSet);
    const item = toStoredItem(model, next, this.options.ttl);
    try {
      await this.transactIncrement(model, target, item, increment, cleanedSet);
      return fromStoredItem<T>(item, this.options.ttl);
    } catch (error) {
      return handleIncrementError(error);
    }
  }

  private async targetByWhere(model: string, where: CleanedWhere[]): Promise<StoredItem | null> {
    const rows = await this.loadRows(model, planQuery(where, this.options.unsafeAllowScan));
    return rows.find((row) => matchesWhere(row, where)) ?? null;
  }

  private async matchingTargets(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const rows = await this.loadRows(model, planQuery(where, this.options.unsafeAllowScan));
    return rows.filter((row) => matchesWhere(row, where));
  }

  private async writeMany(rows: readonly (readonly [StoredItem, Record<string, unknown>])[], model: string): Promise<number> {
    await runBounded(rows, this.options.maxBulkConcurrency, ([row, next]) => this.transactReplace(model, row, toStoredItem(model, next, this.options.ttl)));
    return rows.length;
  }

  private async loadRows(model: string, plan: QueryPlan, take?: number): Promise<StoredItem[]> {
    if (!this.context) return this.loadRawRows(model, plan, take);
    const rows = await this.loadRawRows(model, plan);
    const matches = visibleRows(this.context.overlay(model, rows), this.options.ttl).filter((row) => matchesWhere(row, plan.where));
    return transactionReadOrder(matches, plan);
  }

  private async loadRawRows(model: string, plan: QueryPlan, take?: number): Promise<StoredItem[]> {
    if (plan.kind === "byId") return this.loadById(model, plan.where);
    if (plan.kind === "byIdValues") return this.loadByIds(model, plan.where);
    if (plan.kind === "byFieldValue") return this.loadByField(model, plan.where, take);
    if (plan.kind === "byFieldValues") return this.loadByFields(model, plan.where);
    return this.queryModel(model, plan.where, take);
  }

  private async loadById(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const id = eqWhere(where, "id")?.value;
    const result = await this.client.send(new GetCommand({ TableName: this.options.tableName, Key: { pk: modelPk(model), sk: entitySk(String(id)) }, ConsistentRead: this.options.consistentRead }));
    return visibleRows(result.Item ? [result.Item as StoredItem] : [], this.options.ttl);
  }

  private async loadByField(model: string, where: CleanedWhere[], take?: number): Promise<StoredItem[]> {
    const clause = firstEquality(where);
    if (!clause) return [];
    if (take !== undefined) {
      const command = sidecarQuery(this.options.tableName, model, clause, this.options.consistentRead, this.options.pageSize);
      return this.queryWindow<SidecarItem>(command, where, take, (items) => this.loadOwners(items, clause));
    }
    const sidecars = await this.queryAllSidecars(model, clause);
    return this.loadOwners(sidecars, clause);
  }

  private async queryModel(model: string, where: CleanedWhere[], take?: number): Promise<StoredItem[]> {
    if (take !== undefined) {
      const command = modelQuery(this.options.tableName, model, this.options.consistentRead, this.options.pageSize);
      return this.queryWindow<StoredItem>(command, where, take, async (items) => items);
    }
    const items = await this.queryAllModel(model);
    return visibleRows(items, this.options.ttl);
  }

  private async queryWindow<T>(command: QueryCommandInput, where: CleanedWhere[], take: number, hydrate: (items: T[]) => Promise<StoredItem[]>): Promise<StoredItem[]> {
    return drainPages<StoredItem>(async (key) => {
      const page = await this.client.send(new QueryCommand({ ...command, ExclusiveStartKey: key }));
      const owners = await hydrate((page.Items ?? []) as T[]);
      const rows = visibleRows(owners, this.options.ttl).filter((row) => matchesWhere(row, where));
      return { ...pageOf<StoredItem>(page), Items: rows };
    }, this.options.maxPages, undefined, (rows) => visibleRows(rows, this.options.ttl).length >= take);
  }

  async transactCreate(items: { model: string; data: Record<string, unknown> }[]): Promise<void> {
    if (this.context) { for (const item of items) await this.create(item.model, item.data); return; }
    await this.transactPutNew(items.flatMap((item) => [toStoredItem(item.model, item.data, this.options.ttl), ...this.allSidecars(item.model, item.data)]), "transactCreate");
  }

  private async transactPutNew(items: (StoredItem | SidecarItem)[], operation: string): Promise<void> {
    const actions = items.map((item) => putNewOf(this.options.tableName, item));
    assertTransactionActions(actions);
    try {
      await this.client.send(new TransactWriteCommand(transactInput(actions)));
    } catch (error) {
      if (isWriteRace(error)) throw conflictError(operation, error);
      throw error;
    }
  }

  private async transactReplace(model: string, oldItem: StoredItem, newItem: StoredItem): Promise<void> {
    if (this.context) { this.context.replace(oldItem, newItem); return; }
    const oldSidecars = this.allSidecars(model, oldItem.entity);
    const newSidecars = this.allSidecars(model, newItem.entity);
    const deletes = removedSidecars(oldSidecars, newSidecars).map((item) => deleteOf(this.options.tableName, item));
    const puts = addedSidecars(oldSidecars, newSidecars).map((item) => putNewOf(this.options.tableName, item));
    const updates = retainedSidecars(oldSidecars, newSidecars).flatMap(([oldSidecar, newSidecar]) => ttlUpdateOf(this.options.tableName, oldSidecar, newSidecar, this.options.ttl));
    const condition = revisionCondition(oldItem);
    const entity = { Put: { TableName: this.options.tableName, Item: newItem, ConditionExpression: condition.expression, ExpressionAttributeNames: condition.names, ExpressionAttributeValues: condition.values, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
    const actions = [entity, ...deletes, ...puts, ...updates];
    assertTransactionActions(actions);
    await this.client.send(new TransactWriteCommand(transactInput(actions)));
  }

  private async transactDelete(item: StoredItem): Promise<void> {
    if (this.context) { this.context.replace(item, null); return; }
    const condition = revisionCondition(item);
    const entity = { Delete: { TableName: this.options.tableName, Key: keyOf(item), ConditionExpression: condition.expression, ExpressionAttributeNames: condition.names, ExpressionAttributeValues: condition.values, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
    const sidecars = this.allSidecars(String(item.model), item.entity).map((sidecar) => deleteOf(this.options.tableName, sidecar));
    const actions = [entity, ...sidecars];
    assertTransactionActions(actions);
    await this.client.send(new TransactWriteCommand(transactInput(actions)));
  }

  private async transactIncrement(model: string, oldItem: StoredItem, newItem: StoredItem, increment: Record<string, number>, set: Record<string, unknown>): Promise<void> {
    if (this.context) { this.context.replace(oldItem, newItem); return; }
    const oldSidecars = this.allSidecars(model, oldItem.entity);
    const newSidecars = this.allSidecars(model, newItem.entity);
    const actions = [incrementUpdateOf(this.options.tableName, oldItem, newItem, increment, set, this.options.ttl), ...removedSidecars(oldSidecars, newSidecars).map((item) => deleteOf(this.options.tableName, item)), ...addedSidecars(oldSidecars, newSidecars).map((item) => putNewOf(this.options.tableName, item)), ...retainedSidecars(oldSidecars, newSidecars).flatMap(([oldSidecar, newSidecar]) => ttlUpdateOf(this.options.tableName, oldSidecar, newSidecar, this.options.ttl))];
    assertTransactionActions(actions);
    await this.client.send(new TransactWriteCommand(transactInput(actions)));
  }

  private async queryAllSidecars(model: string, clause: CleanedWhere, budget?: { remaining: number }): Promise<SidecarItem[]> {
    const command = sidecarQuery(this.options.tableName, model, clause, this.options.consistentRead, this.options.pageSize);
    return drainPages<SidecarItem>(async (key) => pageOf<SidecarItem>(await this.client.send(new QueryCommand({ ...command, ExclusiveStartKey: key }))), this.options.maxPages, budget);
  }

  private async queryAllModel(model: string): Promise<StoredItem[]> {
    const command = modelQuery(this.options.tableName, model, this.options.consistentRead, this.options.pageSize);
    return drainPages<StoredItem>(async (key) => pageOf<StoredItem>(await this.client.send(new QueryCommand({ ...command, ExclusiveStartKey: key }))), this.options.maxPages);
  }

  private async loadOwners(sidecars: SidecarItem[], clause: CleanedWhere): Promise<StoredItem[]> {
    const keys = sidecars.flatMap(ownerKeyOf);
    const rows = await this.batchGetRows(keys);
    return rows.filter((row) => matchesWhere(row, [clause]));
  }

  private async batchGetRows(keys: { pk: string; sk: string }[]): Promise<StoredItem[]> {
    const uniqueKeys = [...new Map(keys.map((key) => [keyString(key), key])).values()];
    const batches = chunk(uniqueKeys, MAX_BATCH_GET_ITEMS);
    const rows = await mapBounded(batches, this.options.maxBulkConcurrency, (batch) => this.batchGet(batch));
    const rowsByKey = new Map(rows.flat().map((row) => [keyString(row), row]));
    return visibleRows(uniqueKeys.flatMap((key) => rowsByKey.get(keyString(key)) ?? []), this.options.ttl);
  }

  private async batchGet(keys: { pk: string; sk: string }[]): Promise<StoredItem[]> {
    return batchGetAttempts(this.client, this.options.tableName, keys, this.options.consistentRead);
  }

  private sidecars(model: string, data: Record<string, unknown>): SidecarItem[] {
    return toIndexSidecars(model, data, this.options.ttl);
  }

  private uniqueLocks(model: string, data: Record<string, unknown>): SidecarItem[] {
    return toUniqueLocks(model, data, this.options.uniqueFields?.[model] ?? [], this.options.ttl);
  }

  private allSidecars(model: string, data: Record<string, unknown>): SidecarItem[] {
    return [...this.sidecars(model, data), ...this.uniqueLocks(model, data), ...toSchemaUniqueLocks(model, data, (this.options.schemaUniqueIndexes ?? []).filter((index) => index.model === model), this.options.ttl)];
  }

  private async loadByIds(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const clause = inWhere(where, "id");
    if (!clause) return [];
    const ids = [...new Set(scalarValues(clause).map(String))];
    this.assertInValues(ids.length);
    return this.batchGetRows(ids.map((id) => ({ pk: modelPk(model), sk: entitySk(id) })));
  }

  private async loadByFields(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const clause = safeInWhere(where);
    if (!clause) return [];
    const values = [...new Map(scalarValues(clause).map((value) => [JSON.stringify([typeof value, value instanceof Date ? value.toISOString() : value]), value])).values()];
    this.assertInValues(values.length);
    const budget = { remaining: this.options.maxPages };
    const pages = await mapBounded(values, this.options.maxBulkConcurrency, (value) => this.queryAllSidecars(model, { ...clause, operator: "eq", value } as CleanedWhere, budget));
    const unique = new Map(pages.flat().map((item) => [sidecarKey(item), item]));
    return this.loadOwners([...unique.values()], clause);
  }

  private assertInValues(count: number): void { if (!this.engine) assertInValueCount(count); }
}

function transactionOptions(options: DynamoDBStoreOptions): DynamoDBStoreOptions {
  return options.transactions ? { ...options, consistentRead: true, maxPages: options.maxPages ?? Number.MAX_SAFE_INTEGER } : options;
}

function storeEngine(options: DynamoDBStoreOptions, raw: DynamoDBDocumentClient): TransactionEngine | undefined {
  if (options.transactionEngine) return options.transactionEngine;
  return options.transactions ? new TransactionEngine(new Journal(raw, options.tableName, ttlAttribute(options.ttl))) : undefined;
}

function transactionReadOrder(rows: StoredItem[], plan: QueryPlan): StoredItem[] {
  if (plan.kind !== "byIdValues") return rows;
  const clause = inWhere(plan.where, "id")!;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...new Set(scalarValues(clause).map(String))].flatMap((id) => byId.get(id) ?? []);
}

function keyOf(item: Pick<StoredItem, "pk" | "sk">): { pk: string; sk: string } {
  return { pk: item.pk, sk: item.sk };
}

function readWindowSize(limit: number, offset: number): number | undefined {
  if (!Number.isSafeInteger(limit) || limit <= 0) return undefined;
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return Number.isSafeInteger(offset + limit) ? offset + limit : undefined;
}

function selectWindow(rows: StoredItem[], limit: number, offset: number, sortBy?: { field: string; direction: "asc" | "desc" }, ttl?: false | TtlOptions, select?: string[]): Record<string, unknown>[] {
  const sorted = sortBy ? [...rows].sort((a, b) => compareSort(a, b, sortBy)) : rows;
  const records = sorted.flatMap((row) => {
    const record = fromStoredItem<Record<string, unknown>>(row, ttl);
    return record ? [record] : [];
  });
  return records.slice(offset, offset + limit).map((row) => projectRecord(row, select));
}

function projectRecord(row: Record<string, unknown>, select?: string[]): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(select.map((field) => [field, row[field]]));
}

function compareSort(a: StoredItem, b: StoredItem, sortBy: { field: string; direction: "asc" | "desc" }): number {
  const direction = sortBy.direction === "desc" ? -1 : 1;
  return compareSortValues(a[sortBy.field], b[sortBy.field]) * direction;
}

function compareSortValues(left: unknown, right: unknown): number {
  const numeric = numericSortValue(left, right);
  if (numeric !== null) return numeric;
  const dated = dateSortValue(left, right);
  if (dated !== null) return dated;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function numericSortValue(left: unknown, right: unknown): number | null {
  return typeof left === "number" && typeof right === "number" ? left - right : null;
}

function dateSortValue(left: unknown, right: unknown): number | null {
  return left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : null;
}

function deleteOf(tableName: string, item: SidecarItem) {
  return { Delete: { TableName: tableName, Key: keyOf(item), ConditionExpression: "attribute_not_exists(#pk) OR (#ownerPk = :ownerPk AND #ownerSk = :ownerSk)", ExpressionAttributeNames: { "#pk": "pk", "#ownerPk": "ownerPk", "#ownerSk": "ownerSk" }, ExpressionAttributeValues: { ":ownerPk": item.ownerPk, ":ownerSk": item.ownerSk }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
}

function putNewOf(tableName: string, item: StoredItem | SidecarItem) {
  return { Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)", ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
}

function ttlUpdateOf(tableName: string, oldItem: SidecarItem, newItem: SidecarItem, ttl?: false | TtlOptions) {
  if (!ttl) return [];
  const attribute = ttlAttribute(ttl);
  const oldTtl = oldItem[attribute];
  const newTtl = newItem[attribute];
  if (oldTtl === newTtl) return [];
  return [newTtl === undefined ? removeTtlOf(tableName, newItem, attribute) : setTtlOf(tableName, newItem, attribute, newTtl)];
}

function setTtlOf(tableName: string, item: SidecarItem, attribute: string, ttlValue: unknown) {
  return { Update: { ...ownerUpdateBase(tableName, item, attribute), UpdateExpression: "SET #ttl = :ttl", ExpressionAttributeValues: { ...ownerValues(item), ":ttl": ttlValue } } };
}

function removeTtlOf(tableName: string, item: SidecarItem, attribute: string) {
  return { Update: { ...ownerUpdateBase(tableName, item, attribute), UpdateExpression: "REMOVE #ttl", ExpressionAttributeValues: ownerValues(item) } };
}

function ownerUpdateBase(tableName: string, item: SidecarItem, ttlName: string) {
  return { TableName: tableName, Key: keyOf(item), ConditionExpression: "attribute_exists(#pk) AND #ownerPk = :ownerPk AND #ownerSk = :ownerSk", ExpressionAttributeNames: { "#pk": "pk", "#ownerPk": "ownerPk", "#ownerSk": "ownerSk", "#ttl": ttlName }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const };
}

function ownerValues(item: SidecarItem) {
  return { ":ownerPk": item.ownerPk, ":ownerSk": item.ownerSk };
}

function incrementUpdateOf(tableName: string, oldItem: StoredItem, newItem: StoredItem, increment: Record<string, number>, set: Record<string, unknown>, ttl?: false | TtlOptions) {
  const expression = incrementUpdateExpression(oldItem, newItem, increment, set, ttl);
  return { Update: { TableName: tableName, Key: keyOf(oldItem), ConditionExpression: expression.condition.expression, UpdateExpression: expression.update, ExpressionAttributeNames: expression.names, ExpressionAttributeValues: expression.values, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
}

function incrementUpdateExpression(oldItem: StoredItem, newItem: StoredItem, increment: Record<string, number>, set: Record<string, unknown>, ttl?: false | TtlOptions) {
  const condition = revisionCondition(oldItem);
  const names: Record<string, string> = { ...condition.names, "#entity": "entity", "#revision": REVISION_ATTRIBUTE, "#model": "model", "#id": "id" };
  const values: Record<string, unknown> = { ...condition.values, ":entity": newItem.entity, ":newRevision": newItem[REVISION_ATTRIBUTE], ":model": newItem.model, ":id": newItem.id };
  const addable = addableIncrementFields(oldItem.entity, increment);
  const setParts = ["#entity = :entity", "#revision = :newRevision", "#model = :model", "#id = :id", ...setAttributeParts(oldItem.entity, newItem, increment, set, names, values), ...optionalMetadataSetParts(newItem, names, values, ttl)];
  const removeParts = optionalMetadataRemoveParts(oldItem, newItem, names, ttl);
  const addParts = incrementAttributeParts(addable, names, values);
  return { condition, names, values, update: [setParts.length ? `SET ${setParts.join(", ")}` : "", removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "", addParts.length ? `ADD ${addParts.join(", ")}` : ""].filter(Boolean).join(" ") };
}

function setAttributeParts(oldEntity: Record<string, unknown>, newItem: StoredItem, increment: Record<string, number>, set: Record<string, unknown>, names: Record<string, string>, values: Record<string, unknown>): string[] {
  const fields = new Set([...Object.keys(set), ...nonAddableIncrementFields(oldEntity, increment)]);
  return [...fields].filter((field) => !isAddableIncrementField(oldEntity, increment, field) && field in newItem).map((field, index) => {
    const name = `#set${index}`;
    const value = `:set${index}`;
    names[name] = field;
    values[value] = newItem[field];
    return `${name} = ${value}`;
  });
}

function incrementAttributeParts(increment: Record<string, number>, names: Record<string, string>, values: Record<string, unknown>): string[] {
  return Object.entries(increment).map(([field, amount], index) => {
    const name = `#inc${index}`;
    const value = `:inc${index}`;
    names[name] = field;
    values[value] = amount;
    return `${name} ${value}`;
  });
}

function addableIncrementFields(entity: Record<string, unknown>, increment: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(increment).filter(([field]) => isAddableNumber(entity[field])));
}

function nonAddableIncrementFields(entity: Record<string, unknown>, increment: Record<string, number>): string[] {
  return Object.keys(increment).filter((field) => !isAddableNumber(entity[field]));
}

function isAddableIncrementField(entity: Record<string, unknown>, increment: Record<string, number>, field: string): boolean {
  return field in increment && isAddableNumber(entity[field]);
}

function isAddableNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function optionalMetadataSetParts(newItem: StoredItem, names: Record<string, string>, values: Record<string, unknown>, ttl?: false | TtlOptions): string[] {
  const parts: string[] = [];
  if (newItem.createdAtSort !== undefined) parts.push(assignMetadata("#createdAtSort", "createdAtSort", ":createdAtSort", newItem.createdAtSort, names, values));
  if (!ttl) return parts;
  const ttlName = ttlAttribute(ttl);
  if (newItem[ttlName] !== undefined) parts.push(assignMetadata("#ttl", ttlName, ":ttl", newItem[ttlName], names, values));
  return parts;
}

function optionalMetadataRemoveParts(oldItem: StoredItem, newItem: StoredItem, names: Record<string, string>, ttl?: false | TtlOptions): string[] {
  const parts: string[] = [];
  if (oldItem.createdAtSort !== undefined && newItem.createdAtSort === undefined) parts.push(removeMetadata("#createdAtSort", "createdAtSort", names));
  if (!ttl) return parts;
  const ttlName = ttlAttribute(ttl);
  if (oldItem[ttlName] !== undefined && newItem[ttlName] === undefined) parts.push(removeMetadata("#ttl", ttlName, names));
  return parts;
}

function assignMetadata(nameToken: string, name: string, valueToken: string, value: unknown, names: Record<string, string>, values: Record<string, unknown>): string {
  names[nameToken] = name;
  values[valueToken] = value;
  return `${nameToken} = ${valueToken}`;
}

function removeMetadata(nameToken: string, name: string, names: Record<string, string>): string {
  names[nameToken] = name;
  return nameToken;
}

function assertTransactionActions(actions: NonNullable<TransactWriteCommandInput["TransactItems"]>): void {
  assertTransactionSize(actions.length);
  assertNoDuplicateActions(actions);
  const bytes = Buffer.byteLength(JSON.stringify(actions), "utf8");
  if (bytes > 4_000_000) throw new Error("Better Auth DynamoDB transaction exceeds the practical 4 MB item-size limit.");
}

function assertTransactionSize(count: number): void {
  if (count > MAX_TRANSACT_ITEMS) throw new Error(`Better Auth DynamoDB transaction requires ${count} items, exceeding DynamoDB TransactWrite limit ${MAX_TRANSACT_ITEMS}. Reduce indexed scalar fields or split the mutation.`);
}

function assertInValueCount(count: number): void {
  if (count > MAX_IN_VALUES) throw new DynamoDBAdapterError(`Better Auth DynamoDB indexed IN predicate contains ${count} distinct values, exceeding the bounded limit of ${MAX_IN_VALUES}. Narrow the predicate.`);
}

function assertNoDuplicateActions(actions: NonNullable<TransactWriteCommandInput["TransactItems"]>): void {
  const seen = new Set<string>();
  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) throw new Error(`Better Auth DynamoDB transaction contains duplicate operation for item key ${key}. Check duplicate uniqueFields or colliding sidecar metadata.`);
    seen.add(key);
  }
}

function applyIncrement(entity: Record<string, unknown>, increment: Record<string, number>, set: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(increment).reduce((acc, [field, amount]) => ({ ...acc, [field]: incrementBase(entity[field]) + amount }), { ...entity, ...set });
}

function incrementBase(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function validateIncrementInput(increment: Record<string, number>): void {
  for (const [field, amount] of Object.entries(increment)) validateIncrementField(field, amount);
}

function validateIncrementField(field: string, amount: number): void {
  if (!Number.isFinite(amount)) throw new DynamoDBAdapterError(`Better Auth DynamoDB incrementOne delta for field "${field}" must be a finite number.`);
}

function sidecarKey(item: SidecarItem): string {
  return `${item.pk}\u0000${item.sk}`;
}

function removedSidecars(oldItems: SidecarItem[], newItems: SidecarItem[]): SidecarItem[] {
  const keep = new Set(newItems.map(sidecarKey));
  return oldItems.filter((item) => !keep.has(sidecarKey(item)));
}

function addedSidecars(oldItems: SidecarItem[], newItems: SidecarItem[]): SidecarItem[] {
  const keep = new Set(oldItems.map(sidecarKey));
  return newItems.filter((item) => !keep.has(sidecarKey(item)));
}

function retainedSidecars(oldItems: SidecarItem[], newItems: SidecarItem[]): (readonly [SidecarItem, SidecarItem])[] {
  const oldByKey = new Map(oldItems.map((item) => [sidecarKey(item), item]));
  return newItems.flatMap((item) => {
    const oldItem = oldByKey.get(sidecarKey(item));
    return oldItem ? [[oldItem, item] as const] : [];
  });
}

function isWriteRace(error: unknown): boolean {
  return isConditionalCheckFailed(error) || isConditionalTransactionCanceled(error);
}

function isStaleTargetRace(error: unknown): boolean {
  if (isConditionalCheckFailed(error)) return true;
  return transactionCancellationCodes(error)[0] === "ConditionalCheckFailed";
}

function handleIncrementError(error: unknown): null {
  if (isStaleTargetRace(error)) return null;
  if (isWriteRace(error)) throw conflictError("incrementOne", error);
  throw error;
}

function actionKey(action: NonNullable<TransactWriteCommandInput["TransactItems"]>[number]): string {
  const key = action.Put?.Item ?? action.Delete?.Key ?? action.Update?.Key ?? action.ConditionCheck?.Key;
  return `${String(key?.pk)}\u0000${String(key?.sk)}`;
}

function transactInput(actions: NonNullable<TransactWriteCommandInput["TransactItems"]>): TransactWriteCommandInput {
  return { TransactItems: actions, ClientRequestToken: newClientRequestToken() };
}

function newClientRequestToken(): string {
  return randomUUID();
}

function conflictError(operation: string, cause: unknown): DynamoDBConflictError {
  return new DynamoDBConflictError(`Better Auth DynamoDB ${operation} conflicted with a concurrent write after the target row was read. Retry the operation.`, { cause });
}

function drainPages<T>(load: (key?: Record<string, unknown>) => Promise<{ Items?: T[]; LastEvaluatedKey?: Record<string, unknown> }>, maxPages: number, budget?: { remaining: number }, complete?: (items: T[]) => boolean): Promise<T[]> {
  return drainPagesInner(load, maxPages, undefined, [], 0, budget, complete);
}

function pageOf<T>(result: { Items?: Record<string, unknown>[] | undefined; LastEvaluatedKey?: Record<string, unknown> | undefined }): { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> } {
  return { ...(result.Items ? { Items: result.Items as T[] } : {}), ...(result.LastEvaluatedKey ? { LastEvaluatedKey: result.LastEvaluatedKey } : {}) };
}

async function drainPagesInner<T>(load: (key?: Record<string, unknown>) => Promise<{ Items?: T[]; LastEvaluatedKey?: Record<string, unknown> }>, maxPages: number, key: Record<string, unknown> | undefined, items: T[], page: number, budget: { remaining: number } | undefined, complete?: (items: T[]) => boolean): Promise<T[]> {
  consumePageBudget(page, maxPages, budget);
  const result = await load(key);
  for (const item of result.Items ?? []) items.push(item);
  if (complete?.(items)) return items;
  return result.LastEvaluatedKey ? drainPagesInner(load, maxPages, result.LastEvaluatedKey, items, page + 1, budget, complete) : items;
}

function consumePageBudget(page: number, maxPages: number, budget?: { remaining: number }): void {
  if (!budget && page >= maxPages) throw new Error(`Better Auth DynamoDB query exceeded maxPages (${maxPages}) before DynamoDB pagination completed. Increase maxPages or narrow the predicate.`);
  if (!budget) return;
  if (budget.remaining <= 0) throw new Error("Better Auth DynamoDB indexed IN query exceeded the global pagination budget. Increase maxPages or narrow the predicate.");
  budget.remaining -= 1;
}

function sidecarQuery(tableName: string, model: string, clause: CleanedWhere, consistentRead: boolean, pageSize?: number) {
  return withPageSize({ TableName: tableName, ConsistentRead: consistentRead, KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)", ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" }, ExpressionAttributeValues: { ":pk": indexPk(model, clause.field, clause.value), ":sk": "OWNER#" } }, pageSize);
}

function modelQuery(tableName: string, model: string, consistentRead: boolean, pageSize?: number) {
  return withPageSize({ TableName: tableName, ConsistentRead: consistentRead, KeyConditionExpression: "#pk = :pk", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: { ":pk": modelPk(model) } }, pageSize);
}

function withPageSize<T extends Record<string, unknown>>(command: T, pageSize?: number): T & { Limit?: number } {
  return pageSize ? { ...command, Limit: pageSize } : command;
}

function revisionCondition(item: StoredItem) {
  return { expression: "attribute_exists(#pk) AND #revision = :revision", names: { "#pk": "pk", "#revision": REVISION_ATTRIBUTE }, values: { ":revision": revisionOf(item) } };
}

function visibleRows(rows: StoredItem[], ttl?: false | TtlOptions): StoredItem[] {
  return rows.filter((row) => !isLogicallyExpired(row, ttl));
}

function ownerKeyPart(primary: unknown, fallback: unknown): unknown {
  return typeof primary === "string" ? primary : fallback;
}

function ownerKeyOf(sidecar: SidecarItem): { pk: string; sk: string }[] {
  const pk = ownerKeyPart(sidecar.ownerPk, sidecar.entity.ownerPk);
  const sk = ownerKeyPart(sidecar.ownerSk, sidecar.entity.ownerSk);
  return typeof pk === "string" && typeof sk === "string" ? [{ pk, sk }] : [];
}

function keyString(key: { pk: string; sk: string }): string {
  return `${key.pk}\u0000${key.sk}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

async function batchGetAttempts(client: DynamoDBDocumentClient, tableName: string, keys: { pk: string; sk: string }[], consistentRead: boolean, stalledAttempts = 0, rows: StoredItem[] = []): Promise<StoredItem[]> {
  if (keys.length === 0) return rows;
  const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: consistentRead } } }));
  const nextRows = [...rows, ...((result.Responses?.[tableName] ?? []) as StoredItem[])];
  const unprocessed = (result.UnprocessedKeys?.[tableName]?.Keys ?? []) as { pk: string; sk: string }[];
  if (unprocessed.length === 0) return nextRows;
  const nextStalledAttempts = batchGetStalledAttempts(keys.length, unprocessed.length, stalledAttempts);
  await batchGetBackoff(Math.max(1, nextStalledAttempts));
  return batchGetAttempts(client, tableName, unprocessed, consistentRead, nextStalledAttempts, nextRows);
}

function batchGetStalledAttempts(requested: number, unprocessed: number, previous: number): number {
  // Size-limited responses and missing items can make progress without completing a batch.
  const attempts = unprocessed < requested ? 0 : previous + 1;
  if (attempts >= MAX_BATCH_GET_STALLED_ATTEMPTS) throw new DynamoDBAdapterError(`Better Auth DynamoDB BatchGet still had ${unprocessed} unprocessed keys after ${attempts} consecutive attempts without progress.`);
  return attempts;
}

function batchGetBackoff(attempt: number): Promise<void> {
  const maximum = Math.min(2 ** attempt * 10, 1000);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * maximum));
}

/** Runs independent records with bounded parallelism; failures stop new claims and all started work settles before rejection. */
async function runBounded<T>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<unknown>): Promise<void> {
  const state = { cursor: 0, failure: undefined as unknown, stopped: false, hasFailure: false };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker(items, state, operation)));
  if (state.hasFailure) throw state.failure;
}

async function runWorker<T>(items: readonly T[], state: { cursor: number; failure: unknown; stopped: boolean; hasFailure: boolean }, operation: (item: T) => Promise<unknown>): Promise<void> {
  while (true) {
    if (state.stopped || state.cursor >= items.length) return;
    const item = items[state.cursor++];
    if (item === undefined) return;
    try {
      await operation(item);
    } catch (error) {
      recordFirstFailure(state, error);
    }
  }
}

function recordFirstFailure(state: { failure: unknown; stopped: boolean; hasFailure: boolean }, error: unknown): void {
  if (!state.hasFailure) state.failure = error;
  state.hasFailure = true;
  state.stopped = true;
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  await runBounded(items.map((item, index) => ({ item, index })), concurrency, async ({ item, index }) => { result[index] = await operation(item); });
  return result;
}
