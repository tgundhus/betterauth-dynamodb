import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { createDocumentClient, normalizeOptions } from "./client.js";
import { DynamoDBConflictError, isConditionalCheckFailed, isConditionalTransactionCanceled } from "./errors.js";
import { entitySk, indexPk, modelPk } from "./keys.js";
import { REVISION_ATTRIBUTE, fromStoredItem, isLogicallyExpired, revisionOf, stripUndefined, toIndexSidecars, toStoredItem, toUniqueLocks, ttlAttribute } from "./serialize.js";
import type { BetterAuthDynamoDBOptions, CleanedWhere, QueryPlan, SidecarItem, StoredItem, TtlOptions } from "./types.js";
import { eqWhere, firstEquality, matchesWhere, planQuery } from "./where.js";

const MAX_TRANSACT_ITEMS = 100;

export class DynamoDBStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly options: ReturnType<typeof normalizeOptions>;

  constructor(options: BetterAuthDynamoDBOptions) {
    this.options = normalizeOptions(options);
    this.client = createDocumentClient(this.options);
  }

  async create<T extends Record<string, unknown>>(model: string, data: T): Promise<T> {
    const item = toStoredItem(model, data, this.options.ttl);
    await this.transactPutNew([item, ...this.sidecars(model, data), ...this.uniqueLocks(model, data)], "create");
    return fromStoredItem<T>(item, this.options.ttl) as T;
  }

  async findOne<T>(model: string, where: CleanedWhere[]): Promise<T | null> {
    const rows = await this.findMany<T>(model, where, 1);
    return rows[0] ?? null;
  }

  async findMany<T>(model: string, where: CleanedWhere[] = [], limit = 100, offset = 0, sortBy?: { field: string; direction: "asc" | "desc" }): Promise<T[]> {
    const plan = planQuery(where, this.options.unsafeAllowScan);
    const rows = await this.loadRows(model, plan);
    return selectWindow(rows.filter((row) => matchesWhere(row, where)), limit, offset, sortBy, this.options.ttl) as T[];
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
    await Promise.all(targets.map((row) => this.transactDelete(row)));
    return targets.length;
  }

  async consumeOne<T>(model: string, where: CleanedWhere[]): Promise<T | null> {
    const target = await this.targetByWhere(model, where);
    if (!target) return null;
    try {
      await this.transactDelete(target);
      return fromStoredItem<T>(target, this.options.ttl);
    } catch (error) {
      if (isWriteRace(error)) throw conflictError("consumeOne", error);
      throw error;
    }
  }

  async incrementOne<T>(model: string, where: CleanedWhere[], increment: Record<string, number>, set?: Record<string, unknown>): Promise<T | null> {
    const target = await this.targetByWhere(model, where);
    if (!target) return null;
    const next = applyIncrement(target.entity, increment, stripUndefined(set ?? {}));
    const item = toStoredItem(model, next, this.options.ttl);
    try {
      await this.transactReplace(model, target, item);
      return fromStoredItem<T>(item, this.options.ttl);
    } catch (error) {
      if (isWriteRace(error)) throw conflictError("incrementOne", error);
      throw error;
    }
  }

  async transaction<R>(callback: (store: DynamoDBStore) => Promise<R>): Promise<R> {
    return callback(this);
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
    await Promise.all(rows.map(([row, next]) => this.transactReplace(model, row, toStoredItem(model, next, this.options.ttl))));
    return rows.length;
  }

  private async loadRows(model: string, plan: QueryPlan): Promise<StoredItem[]> {
    if (plan.kind === "byId") return this.loadById(model, plan.where);
    if (plan.kind === "byFieldValue") return this.loadByField(model, plan.where);
    return this.scanModel(model);
  }

  private async loadById(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const id = eqWhere(where, "id")?.value;
    const result = await this.client.send(new GetCommand({ TableName: this.options.tableName, Key: { pk: modelPk(model), sk: entitySk(String(id)) }, ConsistentRead: true }));
    return visibleRows(result.Item ? [result.Item as StoredItem] : [], this.options.ttl);
  }

  private async loadByField(model: string, where: CleanedWhere[]): Promise<StoredItem[]> {
    const clause = firstEquality(where);
    if (!clause) return [];
    const sidecars = await this.queryAllSidecars(model, clause);
    return this.loadOwners(sidecars, clause);
  }

  private async scanModel(model: string): Promise<StoredItem[]> {
    const items = await this.scanAllModel(model);
    return visibleRows(items, this.options.ttl);
  }

  async transactCreate(items: { model: string; data: Record<string, unknown> }[]): Promise<void> {
    await this.transactPutNew(items.flatMap((item) => [toStoredItem(item.model, item.data, this.options.ttl), ...this.sidecars(item.model, item.data), ...this.uniqueLocks(item.model, item.data)]), "transactCreate");
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
    const oldSidecars = [...this.sidecars(model, oldItem.entity), ...this.uniqueLocks(model, oldItem.entity)];
    const newSidecars = [...this.sidecars(model, newItem.entity), ...this.uniqueLocks(model, newItem.entity)];
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
    const condition = revisionCondition(item);
    const entity = { Delete: { TableName: this.options.tableName, Key: keyOf(item), ConditionExpression: condition.expression, ExpressionAttributeNames: condition.names, ExpressionAttributeValues: condition.values, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } };
    const sidecars = [...this.sidecars(String(item.model), item.entity), ...this.uniqueLocks(String(item.model), item.entity)].map((sidecar) => deleteOf(this.options.tableName, sidecar));
    const actions = [entity, ...sidecars];
    assertTransactionActions(actions);
    await this.client.send(new TransactWriteCommand(transactInput(actions)));
  }

  private async queryAllSidecars(model: string, clause: CleanedWhere): Promise<SidecarItem[]> {
    const command = sidecarQuery(this.options.tableName, model, clause, this.options.pageSize);
    return drainPages<SidecarItem>(async (key) => pageOf<SidecarItem>(await this.client.send(new QueryCommand({ ...command, ExclusiveStartKey: key }))), this.options.maxPages);
  }

  private async scanAllModel(model: string): Promise<StoredItem[]> {
    const command = modelScan(this.options.tableName, model, this.options.pageSize);
    return drainPages<StoredItem>(async (key) => pageOf<StoredItem>(await this.client.send(new ScanCommand({ ...command, ExclusiveStartKey: key }))), this.options.maxPages);
  }

  private async loadOwners(sidecars: SidecarItem[], clause: CleanedWhere): Promise<StoredItem[]> {
    const rows = await Promise.all(sidecars.map((item) => this.loadOwner(item)));
    return rows.filter((row): row is StoredItem => row !== null && matchesWhere(row, [clause]));
  }

  private async loadOwner(sidecar: SidecarItem): Promise<StoredItem | null> {
    const ownerPk = ownerKeyPart(sidecar.ownerPk, sidecar.entity.ownerPk);
    const ownerSk = ownerKeyPart(sidecar.ownerSk, sidecar.entity.ownerSk);
    if (typeof ownerPk !== "string" || typeof ownerSk !== "string") return null;
    const result = await this.client.send(new GetCommand({ TableName: this.options.tableName, Key: { pk: ownerPk, sk: ownerSk }, ConsistentRead: true }));
    return visibleOwner((result.Item as StoredItem | undefined) ?? null, this.options.ttl);
  }

  private sidecars(model: string, data: Record<string, unknown>): SidecarItem[] {
    return toIndexSidecars(model, data, this.options.ttl);
  }

  private uniqueLocks(model: string, data: Record<string, unknown>): SidecarItem[] {
    return toUniqueLocks(model, data, this.options.uniqueFields?.[model] ?? [], this.options.ttl);
  }
}

function keyOf(item: Pick<StoredItem, "pk" | "sk">): { pk: string; sk: string } {
  return { pk: item.pk, sk: item.sk };
}

function selectWindow(rows: StoredItem[], limit: number, offset: number, sortBy?: { field: string; direction: "asc" | "desc" }, ttl?: false | TtlOptions): Record<string, unknown>[] {
  const sorted = sortBy ? [...rows].sort((a, b) => compareSort(a, b, sortBy)) : rows;
  return sorted.slice(offset, offset + limit).map((row) => fromStoredItem<Record<string, unknown>>(row, ttl) ?? {});
}

function compareSort(a: StoredItem, b: StoredItem, sortBy: { field: string; direction: "asc" | "desc" }): number {
  const direction = sortBy.direction === "desc" ? -1 : 1;
  return String(a[sortBy.field] ?? "").localeCompare(String(b[sortBy.field] ?? "")) * direction;
}

function deleteOf(tableName: string, item: SidecarItem) {
  return { Delete: { TableName: tableName, Key: keyOf(item) } };
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

function assertTransactionActions(actions: NonNullable<TransactWriteCommandInput["TransactItems"]>): void {
  assertTransactionSize(actions.length);
  assertNoDuplicateActions(actions);
}

function assertTransactionSize(count: number): void {
  if (count > MAX_TRANSACT_ITEMS) throw new Error(`Better Auth DynamoDB transaction requires ${count} items, exceeding DynamoDB TransactWrite limit ${MAX_TRANSACT_ITEMS}. Reduce indexed scalar fields or split the mutation.`);
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
  return Object.entries(increment).reduce((acc, [field, amount]) => ({ ...acc, [field]: Number(acc[field] ?? 0) + amount }), { ...entity, ...set });
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

function drainPages<T>(load: (key?: Record<string, unknown>) => Promise<{ Items?: T[]; LastEvaluatedKey?: Record<string, unknown> }>, maxPages: number): Promise<T[]> {
  return drainPagesInner(load, maxPages, undefined, [], 0);
}

function pageOf<T>(result: { Items?: Record<string, unknown>[] | undefined; LastEvaluatedKey?: Record<string, unknown> | undefined }): { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> } {
  return { ...(result.Items ? { Items: result.Items as T[] } : {}), ...(result.LastEvaluatedKey ? { LastEvaluatedKey: result.LastEvaluatedKey } : {}) };
}

async function drainPagesInner<T>(load: (key?: Record<string, unknown>) => Promise<{ Items?: T[]; LastEvaluatedKey?: Record<string, unknown> }>, maxPages: number, key: Record<string, unknown> | undefined, items: T[], page: number): Promise<T[]> {
  if (page >= maxPages) throw new Error(`Better Auth DynamoDB query exceeded maxPages (${maxPages}) before DynamoDB pagination completed. Increase maxPages or narrow the predicate.`);
  const result = await load(key);
  const next = [...items, ...(result.Items ?? [])];
  return result.LastEvaluatedKey ? drainPagesInner(load, maxPages, result.LastEvaluatedKey, next, page + 1) : next;
}

function sidecarQuery(tableName: string, model: string, clause: CleanedWhere, pageSize?: number) {
  return withPageSize({ TableName: tableName, ConsistentRead: true, KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)", ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" }, ExpressionAttributeValues: { ":pk": indexPk(model, clause.field, clause.value), ":sk": "OWNER#" } }, pageSize);
}

function modelScan(tableName: string, model: string, pageSize?: number) {
  return withPageSize({ TableName: tableName, ConsistentRead: true, FilterExpression: "#model = :model", ExpressionAttributeNames: { "#model": "model" }, ExpressionAttributeValues: { ":model": model } }, pageSize);
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

function visibleOwner(owner: StoredItem | null, ttl?: false | TtlOptions): StoredItem | null {
  if (!owner) return null;
  return isLogicallyExpired(owner, ttl) ? null : owner;
}

function ownerKeyPart(primary: unknown, fallback: unknown): unknown {
  return typeof primary === "string" ? primary : fallback;
}
