import { UnsupportedQueryError } from "./errors.js";
import type { CleanedWhere, QueryPlan } from "./types.js";

type WhereOperator = CleanedWhere["operator"];

export function planQuery(where: CleanedWhere[] = [], allowScan = false): QueryPlan {
  assertSupportedOperators(where);
  const keyedProblem = keyedAccessProblem(where);
  if (keyedProblem) return scanOrThrow(where, allowScan, keyedProblem);
  const keyed = keyedPlan(where);
  if (keyed) return keyed;
  if (allowScan) return { kind: "byModel", where };
  throw new UnsupportedQueryError("Query requires a table scan. Pass unsafeAllowScan to enable bounded scans explicitly.");
}

function keyedPlan(where: CleanedWhere[]): QueryPlan | undefined {
  if (eqWhere(where, "id")) return { kind: "byId", where };
  if (inWhere(where, "id")) return { kind: "byIdValues", where };
  if (firstEquality(where)) return { kind: "byFieldValue", where };
  if (safeInWhere(where)) return { kind: "byFieldValues", where };
  return undefined;
}

export function matchesWhere(item: Record<string, unknown>, where: CleanedWhere[] = []): boolean {
  if (where.length === 0) return true;
  return where.reduce((acc, clause, index) => combine(acc, evalClause(item, clause), clause.connector, index), true);
}

export function firstEquality(where: CleanedWhere[] = []): CleanedWhere | undefined {
  return where.find((w) => isKeyedEquality(w) && isScalar(w.value));
}

export function inWhere(where: CleanedWhere[], field: string): CleanedWhere | undefined {
  return where.find((w) => w.field === field && isSafeIn(w));
}

export function scalarValues(clause: CleanedWhere): (string | number | boolean | Date | null)[] {
  return Array.isArray(clause.value) ? clause.value.filter(isScalar) as (string | number | boolean | Date | null)[] : [];
}

export function safeInWhere(where: CleanedWhere[]): CleanedWhere | undefined {
  return where.find(isSafeIn);
}

export function eqWhere(where: CleanedWhere[], field: string): CleanedWhere | undefined {
  return where.find((w) => w.field === field && isKeyedEquality(w));
}

export function compareValues(left: unknown, operator: CleanedWhere["operator"], right: CleanedWhere["value"], insensitive: boolean): boolean {
  assertSupportedOperator(operator);
  const l = normalize(left, insensitive);
  const r = normalize(right, insensitive);
  return comparators[operator](l, r);
}

const comparators: Record<WhereOperator, (left: any, right: any) => boolean> = {
  eq: (left, right) => left === right,
  ne: (left, right) => left !== right,
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  contains: (left, right) => String(left).includes(String(right)),
  starts_with: (left, right) => String(left).startsWith(String(right)),
  ends_with: (left, right) => String(left).endsWith(String(right)),
  in: (left, right) => Array.isArray(right) && right.includes(left),
  not_in: (left, right) => Array.isArray(right) && !right.includes(left)
};

function assertSupportedOperator(operator: string): asserts operator is WhereOperator {
  if (operator in comparators) return;
  throw new UnsupportedQueryError(`Unsupported Better Auth where operator "${operator}". Supported operators: ${Object.keys(comparators).join(", ")}.`);
}

function assertSupportedOperators(where: CleanedWhere[]): void {
  where.forEach((clause) => assertSupportedOperator(clause.operator));
}

function evalClause(item: Record<string, unknown>, clause: CleanedWhere): boolean {
  return compareValues(item[clause.field], clause.operator, clause.value, clause.mode === "insensitive");
}

function combine(acc: boolean, value: boolean, connector: "AND" | "OR" | undefined, index: number): boolean {
  if (index === 0) return value;
  return connector === "OR" ? acc || value : acc && value;
}

function keyedAccessProblem(where: CleanedWhere[]): string | undefined {
  if (hasOrPredicate(where)) return "OR predicates cannot use DynamoDB keyed access without risking incomplete results. Pass unsafeAllowScan: true to evaluate OR predicates with an explicit bounded scan.";
  if (hasSafeKeyedEquality(where)) return undefined;
  if (hasInsensitiveEquality(where)) return "Case-insensitive equality cannot use DynamoDB keyed access (including case-insensitive IN) because id and scalar sidecar keys are case-sensitive. Pass unsafeAllowScan: true to evaluate it with an explicit bounded scan.";
  return undefined;
}

function scanOrThrow(where: CleanedWhere[], allowScan: boolean, message: string): QueryPlan {
  if (allowScan) return { kind: "byModel", where };
  throw new UnsupportedQueryError(message);
}

function hasOrPredicate(where: CleanedWhere[]): boolean {
  return where.length > 1 && where.some((clause) => clause.connector === "OR");
}

function hasSafeKeyedEquality(where: CleanedWhere[]): boolean {
  return where.some((clause) => (isKeyedEquality(clause) && isScalar(clause.value)) || isSafeIn(clause));
}

function hasInsensitiveEquality(where: CleanedWhere[]): boolean {
  return where.some((clause) => clause.mode === "insensitive" && (clause.operator === "eq" || clause.operator === "in"));
}

function isSafeIn(clause: CleanedWhere): boolean {
  return clause.operator === "in" && clause.mode !== "insensitive" && isScalarArray(clause.value);
}

function isKeyedEquality(clause: CleanedWhere): boolean {
  return clause.operator === "eq" && clause.mode !== "insensitive";
}

function normalize(value: unknown, insensitive: boolean): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, insensitive));
  if (typeof value === "string" && insensitive) return value.toLowerCase();
  return value;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || value instanceof Date;
}

function isScalarArray(value: unknown): boolean { return Array.isArray(value) && value.every(isScalar); }
