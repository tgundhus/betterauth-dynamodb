# Callback transaction storage preview

This is an opt-in 2.0 preview under active validation. Published SCIM and SSO workflow tests pass against DynamoDB Local, but production compatibility still requires the [enterprise release gates](./enterprise-transactions.md). Keep 1.2 production tables on their existing configuration until those gates pass.

## Initialize in a maintenance window

Stop all authentication readers, writers, maintenance jobs, and direct table consumers that do not understand this protocol. Deploy compatible code to every participating process. Do not mix 1.2 processes with transaction-mode processes.

The same table can serve ordinary authentication and SCIM. After initialization, configure ordinary Better Auth instances with `transactionStorage: true` and SCIM or transaction-dependent SSO instances with `transactions: true`. Ordinary instances still resolve prepared versions and guard writes, but report no callback transaction capability to Better Auth. Do not run either a 1.2 adapter or a 2.0 adapter with both options omitted against this table.

```ts
import {
  dynamoDBAdapter,
  initializeDynamoDBTransactions,
} from "@bjorntech/betterauth-dynamodb";

const databaseOptions = { tableName, client, transactions: true };

// Run once in maintenance, not during ordinary application requests.
await initializeDynamoDBTransactions(databaseOptions);

const database = dynamoDBAdapter(databaseOptions);
```

An ordinary auth instance that does not register SCIM or transaction-dependent SSO hooks can use the same table and client with `transactionStorage: true` instead of `transactions: true`. This split limits callback transactions to the paths that need them; it does not permit mixed storage-protocol versions.

Initialization writes a format marker. Existing entity/index keys and entity revision UUIDs are preserved; existing records do not require an eager rewrite. Participating writes add a physical revision attribute to every changed row, including sidecars and unique locks. The protocol reserves `__betterAuthDynamoDBTransaction` and `__betterAuthDynamoDBPhysicalRevision`; these are not application fields.

Both participating modes force strong reads. Callback transaction mode also removes the default 25-page and 1,000-value IN limits, while retaining chunked requests and bounded concurrency. Storage-only participants keep those ordinary query limits. An explicitly configured `maxPages` remains an application-selected budget. Query shapes without an indexed anchor still follow the documented `unsafeAllowScan` policy; plugin query coverage remains a release gate.

## Commit and recovery

The callback's reads see its staged entity changes. It does not publish data before the callback finishes. The adapter serializes before/after versions into bounded journal pages and prepares conditional intents on every changed item and observed point-read dependency. One durable decision commits all prepared versions. Normal writes respect intents, and normal reads resolve the appropriate committed version.

This is an optimistic protocol. Concurrent changes or uniqueness conflicts can abort a callback, and the adapter does not automatically replay user callbacks. Direct point-read absence is protected. Arbitrary query predicates do not gain serializable range isolation; SCIM's group, subject, and connection fences must be validated by the plugin integration tests.

Query dependencies cover the records returned after filtering, sorting, offset, and limit, plus records counted or targeted by mutations. Candidates discarded by those steps do not enter the commit journal. This avoids conflicts and journal writes caused by unrelated candidate records. Direct ID and ID-IN reads retain their point dependencies, including physical absence. A query returning no matches does not lock the predicate or prevent a concurrent matching insertion; applications requiring that guarantee must use a shared revision fence or unique constraint.

No transaction-item-count cap is imposed on callbacks. Individual AWS calls stay within native limits. Transaction-scoped multi-row creates batch strongly consistent absence checks in groups of at most 100 keys before staging the rows. This reduces large relation-insert round trips without publishing partial results or splitting the callback's commit decision. Ordinary operations outside a callback retain their existing single-mutation limits and are not aggregate-atomic when using bulk methods. AWS item size, throughput, and transport limits still apply.

The journal batches payload reads and cleanup writes and stores large before/after payloads in 128 KiB parts. A conservative item-size check runs before preparation, including adapter metadata. It budgets numbers at DynamoDB's maximum numeric representation size, so a number-heavy item close to 400 KiB can be rejected before AWS would reject it. Keep individual authentication records comfortably below the item limit; group membership remains a relation of separate rows.

New manifest entries include an optional `restoreBytes` upper bound covering both encoded payloads and native item size. Cleanup uses it to pack up to 99 small items without budgeting every tiny record as a full 128 KiB chunk. Entries from older previews still recover using the conservative chunk estimate, and older preview workers can ignore the extra field. This additive journal hint does not change logical visibility, entity keys, or the transaction format marker.

Before commit, an interrupted transaction is aborted after its renewable preparation lease expires. After commit, cleanup failure leaves the committed decision and prepared versions readable. An ordinary writer can help release a conflicting terminal intent. Cleanup is idempotent and checks ownership before changing a row.

An acknowledgement failure with an unresolved outcome throws `DynamoDBTransactionOutcomeUnknownError`, including `transactionId`. Do not blindly replay the mutation. Its durable root is `pk = BETTERAUTH#TXDATA#<transactionId>`, `sk = ROOT`. A `COMMITTED` decision is final. A missing decision is not evidence of rollback.

## Run a recovery worker

`runDynamoDBRecoveryWorker(options, workerOptions)` supplies a bounded worker with a durable checkpoint in the authentication table. Each invocation resumes the checkpoint; completing a registry pass resets it for the next pass. It reports per-transaction failures and continues unrelated recovery. Conditional checkpoint writes prevent overlapping workers from overwriting each other's progress. Monitor reported failures and repeat passes, including after an empty pass.

The [Lambda example](../examples/aws-lambda/README.md) includes a scheduled handler, request deadlines, restricted table permissions, alarms, and a dead-letter queue. No bearer credentials or HTTP endpoint are needed for transaction recovery.

For custom workers, the fourth argument to `recoverDynamoDBTransactions` accepts `{ maxBatchesPerTransaction: 1, continueOnError: true }`. Cleanup deletes each manifest entry only after releasing its intent. That provides durable progress between invocations without imposing a transaction size limit. A cleanup batch processes at most 99 manifest entries, further bounded by its byte budget, or 99 payload rows; it can require multiple native reads/writes. `failures` identifies entries requiring attention. A partial cleanup is not counted as recovered and retains its registry entry. No decision or live payload expires while recovery remains incomplete.

Schedule an application-owned worker with the same table and injected client. It walks only the dedicated transaction registry. Each returned cursor can be persisted between worker invocations. Finish a pass, then start a new pass periodically so live transactions skipped in an earlier pass are revisited.

```ts
import { recoverDynamoDBTransactions } from "@bjorntech/betterauth-dynamodb";

let cursor;
do {
  const result = await recoverDynamoDBTransactions(databaseOptions, cursor, 25);
  cursor = result.cursor;
} while (cursor);
```

The limit bounds registry entries examined, not a transaction's logical size. Cleanup progress is durable in the restored records and can be retried after worker interruption. Active transaction records and payloads have no TTL. Once cleanup finishes, the decision receives seven days of retention using the configured TTL attribute, or `ttl` when no attribute is configured. Enable DynamoDB TTL on that attribute to remove completed decision records automatically; otherwise they remain stored. Never independently expire active journal records.

Transaction initialization rejects TTL names that collide with journal fields: `pk`, `sk`, `id`, `state`, `count`, `prepared`, `expires`, `cleaned`, `before`, `after`, `restoreBytes`, `target`, and `bytes`. Numeric entry counts and size hints must never become expiration timestamps. Use a dedicated attribute such as `ttl`.

The protocol uses existing Get, Query, BatchGet, and TransactWrite permissions. Raw DynamoDB readers, streams, and exports can contain prepared intents and journal records. They do not automatically expose the same logical view as the adapter. Restore the complete table together, including transaction metadata.

## Rollback

Stop all compatible writers and callback executions. Recover every outstanding transaction until the registry is empty and verify that no prepared intents remain. Rehearse this procedure before any production migration. Disabling `transactions` while intents remain is not a safe rollback. A downgrade also requires removing the format marker under maintenance and verifying that the older version tolerates the retained physical revision metadata.

External side effects in callbacks cannot be rolled back. Better Auth's own deferred hooks run after the adapter reports commit, with Better Auth's existing delivery semantics. Journal recovery does not replay JavaScript callbacks or hooks.
