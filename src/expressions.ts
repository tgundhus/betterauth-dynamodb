import type { CleanedWhere } from "./types.js";
import { compareValues } from "./where.js";

export interface ExpressionBuild {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

export function buildUpdateExpression(set: Record<string, unknown>, increment: Record<string, number> = {}): ExpressionBuild {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = setParts(set, names, values);
  const adds = addParts(increment, names, values);
  return { expression: [part("SET", sets), part("ADD", adds)].filter(Boolean).join(" "), names, values };
}

export function buildCondition(where: CleanedWhere[]): ExpressionBuild {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = where.map((clause, index) => conditionPart(clause, index, names, values));
  return { expression: joinConditions(where, parts), names, values };
}

export function assertAtomicWhere(item: Record<string, unknown> | undefined, where: CleanedWhere[]): boolean {
  if (!item) return false;
  return where.every((clause) => compareValues(item[clause.field], clause.operator, clause.value, clause.mode === "insensitive"));
}

function setParts(set: Record<string, unknown>, names: Record<string, string>, values: Record<string, unknown>): string[] {
  return Object.entries(set).map(([field, value], index) => assignPart(field, value, index, names, values));
}

function addParts(increment: Record<string, number>, names: Record<string, string>, values: Record<string, unknown>): string[] {
  return Object.entries(increment).map(([field, value], index) => addPart(field, value, index, names, values));
}

function assignPart(field: string, value: unknown, index: number, names: Record<string, string>, values: Record<string, unknown>): string {
  names[`#s${index}`] = field;
  values[`:s${index}`] = value;
  return `#s${index} = :s${index}`;
}

function addPart(field: string, value: number, index: number, names: Record<string, string>, values: Record<string, unknown>): string {
  names[`#a${index}`] = field;
  values[`:a${index}`] = value;
  return `#a${index} :a${index}`;
}

function conditionPart(clause: CleanedWhere, index: number, names: Record<string, string>, values: Record<string, unknown>): string {
  names[`#w${index}`] = clause.field;
  values[`:w${index}`] = clause.value;
  return conditionExpression(clause.operator, `#w${index}`, `:w${index}`);
}

function conditionExpression(operator: CleanedWhere["operator"], name: string, value: string): string {
  const builder = conditionBuilders[operator];
  if (!builder) throw new Error(`Better Auth DynamoDB cannot translate where operator '${operator}' to a DynamoDB condition expression`);
  return builder(name, value);
}

const conditionBuilders: Partial<Record<CleanedWhere["operator"], (name: string, value: string) => string>> = {
  eq: (name, value) => `${name} = ${value}`,
  ne: (name, value) => `${name} <> ${value}`,
  lt: (name, value) => `${name} < ${value}`,
  lte: (name, value) => `${name} <= ${value}`,
  gt: (name, value) => `${name} > ${value}`,
  gte: (name, value) => `${name} >= ${value}`,
  contains: (name, value) => `contains(${name}, ${value})`,
  starts_with: (name, value) => `begins_with(${name}, ${value})`
};

function joinConditions(where: CleanedWhere[], parts: string[]): string {
  return parts.reduce((acc, text, index) => (index === 0 ? text : `${acc} ${where[index]?.connector ?? "AND"} ${text}`), "");
}

function part(label: string, parts: string[]): string {
  return parts.length ? `${label} ${parts.join(", ")}` : "";
}
