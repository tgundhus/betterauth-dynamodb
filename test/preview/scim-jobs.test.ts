import { betterAuth } from "better-auth";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { previewDatabase } from "./database.js";
import { dynamoDBAdapter, initializeDynamoDBTransactions } from "../../src/index.js";

interface JobResult { id: string; status: string; completedOperations: number; processed: number }
interface JobAPI {
  processSCIMBulkJob(input: { headers: Headers; body: { jobId: string; maxOperations: number } }): Promise<JobResult>;
  purgeSCIMBulkJob(input: { body: { jobId: string; maxRows: number } }): Promise<JobResult>;
}

it("resumes durable Bulk jobs across fresh auth instances with atomic outcomes and bounded cleanup", async ({ onTestFinished }) => {
  if (!process.env.SCIM_PREVIEW_MODULE) throw new Error("Set SCIM_PREVIEW_MODULE to the built enterprise SCIM module.");
  const { scim } = await import(pathToFileURL(resolve(process.env.SCIM_PREVIEW_MODULE)).href);
  const database = await previewDatabase();
  onTestFinished(database.close);
  await initializeDynamoDBTransactions(database.options);
  const createAuth = () => betterAuth({ baseURL: "http://localhost:3000", secret: "bulk-job-test-secret-at-least-32-characters", database: dynamoDBAdapter(database.options), plugins: [scim({ groups: { maxMembers: null }, bulk: { jobs: true }, connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test" }] }] })] });
  const auth = createAuth();
  const headers = new Headers({ authorization: "Bearer test", "content-type": "application/scim+json" });
  const body = { schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"], Operations: [
    { method: "POST", path: "/Groups", bulkId: "group", data: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Async group", members: Array.from({ length: 55 }, (_, index) => ({ value: `bulkId:user-${index}` })) } },
    ...Array.from({ length: 55 }, (_, index) => ({ method: "POST", path: "/Users", bulkId: `user-${index}`, data: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `async-${index}@example.com`, ...(index === 0 ? { ignored: "😀".repeat(120_000) } : {}) } }))
  ] };
  const submit = () => auth.handler(new Request("http://localhost:3000/api/auth/scim/v2/Bulk", { method: "POST", headers: { ...Object.fromEntries(headers), prefer: "respond-async", "idempotency-key": "native-async-job" }, body: JSON.stringify(body) }));
  const accepted = await submit();
  expect(accepted.status).toBe(202);
  const job = await accepted.json() as JobResult;
  expect((await (await submit()).json() as JobResult).id).toBe(job.id);
  let completed = 0;
  for (let invocation = 0; invocation < 4; invocation++) {
    const fresh = createAuth();
    const api = fresh.api as unknown as JobAPI;
    const result = await api.processSCIMBulkJob({ headers, body: { jobId: job.id, maxOperations: 17 } });
    expect(result.completedOperations).toBeGreaterThan(completed);
    completed = result.completedOperations;
  }
  expect(completed).toBe(56);
  const api = createAuth().api as unknown as JobAPI;
  expect(await api.processSCIMBulkJob({ headers, body: { jobId: job.id, maxOperations: 17 } })).toMatchObject({ status: "complete", processed: 0 });
  const adapter = (await auth.$context).adapter;
  expect(await adapter.count({ model: "scimUser", where: [{ field: "connectionId", value: "workforce" }] })).toBe(55);
  expect(await adapter.count({ model: "scimGroupMember", where: [{ field: "connectionId", value: "workforce" }] })).toBe(55);
  expect(await adapter.count({ model: "scimBulkOutcome", where: [{ field: "jobId", value: job.id }] })).toBe(56);
  let cursor = 0;
  const indices = new Set<number>();
  while (indices.size < 56) {
    const response = await auth.handler(new Request(`${accepted.headers.get("location")}?startIndex=${cursor}&count=11`, { headers }));
    expect(response.status).toBe(200);
    const page = await response.json() as { Operations: { operationIndex: number; status: string }[]; nextStartIndex: number };
    for (const result of page.Operations) { expect(result.status).toBe("201"); indices.add(result.operationIndex); }
    expect(page.nextStartIndex).toBeGreaterThan(cursor);
    cursor = page.nextStartIndex;
  }
  let purged = false;
  for (let call = 0; call < 25; call++) {
    if ((await api.purgeSCIMBulkJob({ body: { jobId: job.id, maxRows: 10 } })).status === "expired") { purged = true; break; }
  }
  expect(purged).toBe(true);
  expect(await adapter.count({ model: "scimBulkBlob", where: [{ field: "jobId", value: job.id }] })).toBe(0);
  expect((await (await submit()).json() as JobResult)).toMatchObject({ id: job.id, status: "expired" });
  expect(await api.processSCIMBulkJob({ headers, body: { jobId: job.id, maxOperations: 17 } })).toMatchObject({ processed: 0 });
}, 180_000);
