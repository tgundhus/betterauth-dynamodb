import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const traverseAst = typeof traverse === "function" ? traverse : traverse.default;

const [lcovPath, sourceRoot = "src"] = process.argv.slice(2);
if (!lcovPath) throw new Error("Usage: bun scripts/crap-check.ts coverage/lcov.info src");

const coverage = readLcov(lcovPath);
const functions = listFunctions(sourceRoot);
const failures = functions.map((fn) => ({ ...fn, crap: crap(fn.complexity, lineCoverage(coverage, fn.file, fn.line)) })).filter((fn) => fn.crap > 6);
const max = Math.max(...functions.map((fn) => crap(fn.complexity, lineCoverage(coverage, fn.file, fn.line))), 0);

console.log(`CRAP max=${max.toFixed(2)} functions=${functions.length}`);
if (failures.length) {
  for (const fn of failures) console.error(`${fn.file}:${fn.line} ${fn.name} complexity=${fn.complexity} crap=${fn.crap.toFixed(2)}`);
  process.exit(1);
}

interface FnMetric { file: string; line: number; name: string; complexity: number }

function crap(complexity: number, coveragePercent: number): number {
  const uncovered = 1 - coveragePercent / 100;
  return complexity ** 2 * uncovered ** 3 + complexity;
}

function lineCoverage(lcov: Map<string, Map<number, number>>, file: string, line: number): number {
  return (lcov.get(file)?.get(line) ?? 0) > 0 ? 100 : 0;
}

function readLcov(path: string): Map<string, Map<number, number>> {
  const records = new Map<string, Map<number, number>>();
  let current = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) current = relative(process.cwd(), line.slice(3));
    if (line.startsWith("DA:")) addLine(records, current, line);
  }
  return records;
}

function addLine(records: Map<string, Map<number, number>>, file: string, line: string): void {
  const [lineNo, hits] = line.slice(3).split(",").map(Number);
  const map = records.get(file) ?? new Map<number, number>();
  map.set(lineNo ?? 0, hits ?? 0);
  records.set(file, map);
}

function listFunctions(root: string): FnMetric[] {
  return walk(root).flatMap((file) => metricsForFile(file));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])).filter((file) => file.endsWith(".ts"));
}

function metricsForFile(file: string): FnMetric[] {
  const ast = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript"] });
  const metrics: FnMetric[] = [];
  traverseAst(ast, {
    Function(path: any) {
      metrics.push({ file, line: path.node.loc?.start.line ?? 1, name: functionName(path), complexity: complexity(path) });
    }
  });
  return metrics;
}

function complexity(path: any): number {
  let score = 1;
  path.traverse({
    IfStatement: () => { score++; },
    ConditionalExpression: () => { score++; },
    LogicalExpression: (p: any) => { if (["&&", "||", "??"].includes(p.node.operator)) score++; },
    ForStatement: () => { score++; },
    ForOfStatement: () => { score++; },
    ForInStatement: () => { score++; },
    WhileStatement: () => { score++; },
    DoWhileStatement: () => { score++; },
    CatchClause: () => { score++; },
    SwitchCase: (p: any) => { if (p.node.test) score++; }
  });
  return score;
}

function functionName(path: any): string {
  return path.node.id?.name ?? path.parentPath.node.id?.name ?? path.parentPath.node.key?.name ?? "anonymous";
}
