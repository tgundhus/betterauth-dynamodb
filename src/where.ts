import type { CleanedWhere, QueryPlan } from "./types";
import { UnsupportedQueryError } from "./errors";

type WhereOperator = CleanedWhere["operator"];

export function planQuery(where: CleanedWhere[] = [], allowScan = false): QueryPlan {
  assertSupportedOperators(where);
  const id = eqWhere(where, "id");
  if (id) return { kind: "byId", where };
  const unique = firstEquality(where);
  if (unique) return { kind: "byFieldValue", where };
  if (allowScan) return { kind: "byModel", where };
  throw new UnsupportedQueryError("Query requires a table scan. Pass unsafeAllowScan to enable bounded scans explicitly.");
}

export function matchesWhere(item: Record<string, unknown>, where: CleanedWhere[] = []): boolean {
  if (where.length === 0) return true;
  return where.reduce((acc, clause, index) => combine(acc, evalClause(item, clause), clause.connector, index), true);
}

export function firstEquality(where: CleanedWhere[] = []): CleanedWhere | undefined {
  return where.find((w) => w.operator === "eq" && w.connector === "AND" && isScalar(w.value));
}

export function eqWhere(where: CleanedWhere[], field: string): CleanedWhere | undefined {
  return where.find((w) => w.field === field && w.operator === "eq" && w.connector === "AND");
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

function combine(acc: boolean, value: boolean, connector: "AND" | "OR", index: number): boolean {
  if (index === 0) return value;
  return connector === "OR" ? acc || value : acc && value;
}

function normalize(value: unknown, insensitive: boolean): any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && insensitive) return value.toLowerCase();
  return value;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || value instanceof Date;
}
