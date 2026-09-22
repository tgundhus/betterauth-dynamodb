import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

type Row = Record<string, any>;
type Hook = (command: any, database: MemoryDynamoDB) => Promise<void> | void;

/** Independent command-level test double; integration tests verify these requests against DynamoDB Local. */
export class MemoryDynamoDB {
  readonly rows = new Map<string, Row>();
  readonly commands: any[] = [];
  readonly config = { translateConfig: { marshallOptions: { removeUndefinedValues: true } } };
  before: Hook = () => {};
  after: Hook = () => {};
  asClient(): DynamoDBDocumentClient { return this as unknown as DynamoDBDocumentClient; }
  get(key: Row): Row | undefined { return structuredClone(this.rows.get(keyId(key))); }
  put(item: Row): void { this.rows.set(keyId(item), structuredClone(item)); }

  async send(command: any): Promise<any> {
    this.commands.push(command);
    await this.before(command, this);
    const result = this.execute(command);
    await this.after(command, this);
    return structuredClone(result);
  }

  private execute(command: any): any {
    if (command instanceof GetCommand) return { Item: this.get(command.input.Key!) };
    if (command instanceof BatchGetCommand) return { Responses: Object.fromEntries(Object.entries(command.input.RequestItems ?? {}).map(([table, input]) => [table, (input.Keys ?? []).flatMap((key) => this.get(key) ?? []).reverse()])) };
    if (command instanceof QueryCommand) return this.query(command.input);
    if (command instanceof TransactWriteCommand) return this.transact(command.input.TransactItems ?? []);
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }

  private query(input: Row): Row {
    let rows = [...this.rows.values()].filter((item) => condition(input.KeyConditionExpression, item, input)).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    if (input.ExclusiveStartKey) rows = rows.filter((item) => String(item.sk).localeCompare(String(input.ExclusiveStartKey.sk)) > 0);
    const page = rows.slice(0, input.Limit ?? rows.length);
    const last = page.at(-1);
    return { Items: page, ...(last && page.length < rows.length ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
  }

  private transact(actions: Row[]): Row {
    if (actions.length > 100) throw new Error("DynamoDB supports at most 100 actions");
    const operations = actions.map((action) => Object.entries(action)[0]!);
    const keys = operations.map(([, input]) => keyId(input.Item ?? input.Key));
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate transaction key");
    const failures = operations.map(([, input]) => {
      const item = this.get(input.Item ?? input.Key);
      return condition(input.ConditionExpression, item, input) ? { Code: "None" } : { Code: "ConditionalCheckFailed", Item: item };
    });
    if (failures.some((failure) => failure.Code !== "None")) throw Object.assign(new Error("ConditionalCheckFailed"), { name: "TransactionCanceledException", CancellationReasons: failures });
    for (const [kind, input] of operations) {
      if (kind === "Put") this.put(input.Item);
      if (kind === "Delete") this.rows.delete(keyId(input.Key));
      if (kind === "Update") this.put(update(this.get(input.Key) ?? input.Key, input));
    }
    return {};
  }
}

function keyId(key: Row): string { return JSON.stringify([key.pk, key.sk]); }

function condition(expression: string | undefined, item: Row | undefined, input: Row): boolean {
  if (!expression) return true;
  const tokens = expression.match(/attribute_not_exists|attribute_exists|begins_with|AND|OR|IN|<=|>=|<>|[()=,<>]|[#:A-Za-z_][\w.:#]*/g) ?? [];
  let index = 0;
  const take = () => tokens[index++];
  const peek = () => tokens[index];
  const value = (token: string) => token.startsWith(":") ? input.ExpressionAttributeValues[token] : token.split(".").reduce((current: any, key) => current?.[input.ExpressionAttributeNames?.[key] ?? key], item);
  const atom = (): boolean => {
    const token = take()!;
    if (token === "(") { const result = or(); if (take() !== ")") throw new Error("Unclosed condition"); return result; }
    if (["attribute_exists", "attribute_not_exists", "begins_with"].includes(token)) {
      take(); const first = value(take()!);
      if (token === "begins_with") { take(); const second = value(take()!); take(); return typeof first === "string" && first.startsWith(second); }
      take(); return token === "attribute_exists" ? first !== undefined : first === undefined;
    }
    const left = value(token);
    const operator = take();
    if (operator === "IN") { take(); const choices = []; while (peek() !== ")") { const next = take()!; if (next !== ",") choices.push(value(next)); } take(); return choices.includes(left); }
    const right = value(take()!);
    if (operator === "=") return left === right;
    if (operator === "<=") return left <= right;
    if (operator === ">=") return left >= right;
    throw new Error(`Unsupported test condition ${operator}`);
  };
  const and = (): boolean => { let result = atom(); while (peek() === "AND") { take(); const next = atom(); result = result && next; } return result; };
  const or = (): boolean => { let result = and(); while (peek() === "OR") { take(); const next = and(); result = result || next; } return result; };
  const result = or();
  if (index !== tokens.length) throw new Error(`Unparsed condition ${tokens.slice(index).join(" ")}`);
  return result;
}

function update(before: Row, input: Row): Row {
  const item = structuredClone(before);
  const clauses = input.UpdateExpression.split(/\b(SET|REMOVE|ADD)\b/).slice(1);
  for (let index = 0; index < clauses.length; index += 2) {
    for (const assignment of clauses[index + 1].split(",").map((value: string) => value.trim())) {
      const [name, token] = assignment.split(/\s*=\s*|\s+/);
      const field = input.ExpressionAttributeNames?.[name] ?? name;
      if (clauses[index] === "SET") item[field] = input.ExpressionAttributeValues[token];
      if (clauses[index] === "REMOVE") delete item[field];
      if (clauses[index] === "ADD") item[field] = (item[field] ?? 0) + input.ExpressionAttributeValues[token];
    }
  }
  return item;
}
