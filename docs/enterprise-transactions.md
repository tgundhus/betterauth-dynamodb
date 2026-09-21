# DynamoDB-only enterprise transactions

Status: design proposal. No transaction engine or enterprise compatibility fix is implemented by this document. Version 1.2 continues to report `transaction: false`.

## Requirements

Keep all authentication data and transaction state in DynamoDB. Support large SCIM groups and provisioning many users, including failures and concurrent sign-in or deprovisioning. Preserve Better Auth's callback semantics: reads see the callback's writes, exceptions abort its database changes, and account, membership, profile, and session changes become visible together.

The requested scope includes groups above the upstream 1,000-member cap and a SCIM `/Bulk` endpoint. Both the adapter and the SCIM plugin therefore need implementation changes.

A valid supported provisioning request must not be rejected merely because its expanded item count exceeds one DynamoDB transaction, batch, or query page. Chunking, pagination, backpressure, and recovery are implementation details. The caller must not split an otherwise valid logical mutation to accommodate the adapter. A bounded callback adapter that returns a size error is not a solution to this requirement.

This is a separate major-version candidate. The compatible 1.2 performance release must not acquire a new storage protocol through a patch disguised as a capability flag.

## Verified blockers

The published `@better-auth/scim@1.7.5` package rejects initialization unless `adapter.options.adapterConfig.transaction` is a function. The published `@better-auth/sso@1.7.5` package requires that capability and transaction async context for `resolveUser` and `guardProviderMutation`. Better Auth defers transaction hooks until the callback transaction succeeds. Its sequential fallback cannot provide rollback.

AWS allows at most 100 distinct items and 4 MB in one `TransactWriteItems` request. Condition checks count, and an item cannot appear twice. Multiple requests do not form one atomic transaction. Strongly consistent `Query` and `BatchGet` requests also do not create a transaction snapshot.

The current serializer expands a new SCIM membership as follows:

| Item kind                                                                                          | Count |
| -------------------------------------------------------------------------------------------------- | ----: |
| Membership entity                                                                                  |     1 |
| Scalar indexes for `id`, `connectionId`, `groupId`, `scimUserId`, `membershipKey`, and `createdAt` |     6 |
| Unique lock for `membershipKey`                                                                    |     1 |
| Total per new membership                                                                           |     8 |

Thus, 13 additions require 104 items and 1,000 additions require 8,000 items, before group revisions, source validation, role projection, or other callback work. These counts were reproduced with this repository's serializer and the published plugin's membership schema. Removing some indexes would reduce cost but would not let 1,000 membership entities fit in 100 items.

There are two independent plugin limits. Version 1.7.5 caps a group at 1,000 direct members and advertises SCIM `/Bulk` as unsupported. Provisioning many users through repeated User and Group requests is a different requirement from the optional SCIM `/Bulk` endpoint. Larger groups or `/Bulk` require plugin work as well as adapter work; an adapter cannot change those HTTP contracts.

## Proposed implementation boundary

Use an adapter-managed transaction layer backed entirely by DynamoDB. Prefer record-level coordination over a database-wide mutex, which would make a large directory update stall unrelated authentication. Keep the SSO plugin and carry the required SCIM changes in a separate, version-pinned fork or upstream contribution. The SCIM fork should preserve existing authentication, authorization, connection fencing, identity handling, and projection code.

The transaction layer needs three components:

1. A callback-scoped adapter that stages logical entity changes, overlays them on reads, and collapses repeated changes to each entity into one final state. It must use Better Auth's public adapter factory so schema mapping, dates, selections, and generated IDs remain correct.
2. Durable transaction records and per-item prepared versions or intents. Entity rows, equality indexes, and unique locks must all participate. Store large manifests in bounded pages; neither a manifest item nor an individual DynamoDB request may exceed AWS limits.
3. A conditional commit decision that makes all prepared versions logically visible, plus idempotent recovery and compaction. Every adapter reader must resolve transaction state, and every writer must respect prepared ownership. Preparing 8,000 items in chunks is safe only when preparation is invisible and the commit decision controls all those items.

This is atomic visibility through the adapter, not a claim that AWS atomically writes thousands of physical items. Direct table readers, exports, and stream consumers would need the new protocol or a separately defined committed-change interface. Existing raw table consumers cannot be assumed compatible.

## Protocol that needs implementation and validation

Use explicit, durable states such as `PREPARING`, `COMMITTED`, and `ABORTED`. A terminal decision must be immutable. Every prepare write must be fenced by the transaction's current state and ownership so a timed-out process cannot resume and mutate data after recovery has aborted it.

Before the commit decision, persist and verify the complete manifest, prepare every final write, and validate dependencies. Guard existing entities with their original revision; guard point-read absence and uniqueness claims explicitly. Read-only dependencies must remain protected while the transaction commits. Acquire conflicting ownership deterministically or abort conflicts to avoid deadlocks. Do not automatically replay application callbacks that might have external side effects.

Readers must select the committed version or the previous committed version based on the transaction decision. This applies to ID reads, model queries, index queries, owner hydration, counts, pagination, sorting, and TTL filtering. Pending insertions and deletions must not leak through indexes. A missing decision record must cause a safe reread or an explicit error, never an assumption that data committed.

Query isolation must be explicit. Record revision checks alone do not prevent a new matching row from appearing. Validate SCIM's connection, subject, and group revision fences against each query and concurrent mutation path. Add scoped predicate or generation protection where required; do not advertise serializable query isolation based only on strongly consistent reads.

Before commit, callback failure or failed dependency validation must leave committed data unchanged. After commit, cleanup failure must not undo the transaction. Recovery must be safe for multiple helpers, expired owners, duplicate requests, network timeouts, and process death at every batch boundary. Commit acknowledgement loss needs a transaction ID and a resolvable outcome. Recovery cannot replay JavaScript hooks; post-commit hooks retain Better Auth's existing delivery limitations.

Do not TTL-delete a transaction record while any prepared item still refers to it. Cleanup must verify ownership and be resumable. Expiration is not a substitute for rollback or recovery. Transactions that touch expiring sessions or tokens need explicit visibility and conflict tests.

## Migration and performance requirements

All writers and readers must understand the new storage protocol before it is enabled. A maintenance window and validated migration are required unless a separately tested online transition is designed. Existing revision UUIDs help detect conflicts but cannot make old writers respect new prepared intents.

Document a format marker, supported reader/writer versions, migration checkpoints, repair commands, and a rollback procedure that resolves all outstanding transactions first. Old and new adapters must not run concurrently against a migrated table. Keep credentials, IAM, region configuration, and the injected document client application-owned.

Preserve efficient ordinary operations where correctness permits. Measure the extra reads, writes, storage, and contention introduced by decision lookups, preparation, validation, and cleanup. Avoid a global lock or globally updated revision counter. Bound each unit of work and concurrency, and store resumable progress instead of imposing an arbitrary total item limit on valid plugin requests. The 1,000-member workflow must complete across internal batches. Request deadlines and serverless execution limits require an explicit execution and recovery strategy; an HTTP success response must not precede the durable commit decision.

Query support is part of compatibility too. Exercise every published SCIM filter and pagination shape, along with the adapter's existing query guards. Do not remove a transaction blocker only to replace it with an unexpected page cap, unsupported query, or partial result. Any new index or scoped query path must have a cost model and migration plan.

## SCIM plugin work

The source is available in [Better Auth's `packages/scim` at v1.7.5](https://github.com/better-auth/better-auth/tree/v1.7.5/packages/scim). There is no public option in that version that enables `/Bulk` or lifts group cardinality. Patching only the request schema would leave other cardinality checks and bounded membership reads unchanged.

| Source area                                                   | Required change                                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group-schemas.ts`, `group-state.ts`, `group-provisioning.ts` | Remove the fixed 1,000-member assumption from validation, PATCH deltas, count checks, and membership loading; use complete internal pagination and chunked predicates. |
| `projection.ts`, `identity.ts`, `connection-decommission.ts`  | Validate large-group lifecycle, role reconciliation, source deletion, and decommissioning without truncation or partial permission changes.                            |
| `index.ts`, `discovery.ts`, new bulk request handler          | Register `/Bulk`, advertise the implemented capability, and reuse resource handlers with the authenticated connection and each operation's required scopes.            |
| Existing HTTP and concurrency suites                          | Preserve upstream behavior and add large-group and bulk request coverage on the DynamoDB adapter.                                                                      |

Bulk execution must implement `bulkId` references, dependency ordering, per-operation responses, and `failOnErrors`. A Bulk envelope is not one aggregate database transaction: each resource mutation must remain atomic while the response can report different outcomes for different operations. Invalid references and circular dependencies need protocol-correct handling. See [RFC 7644 section 3.7](https://www.rfc-editor.org/rfc/rfc7644.html#section-3.7).

The RFC requires advertised maximum operations and payload size for Bulk requests. These are HTTP service limits, not DynamoDB's 100-item internal limit. Advertise values supported by the deployment and complete accepted valid operations across internal batches. Do not claim unlimited request size or advertise capacities that ordinary valid inputs cannot reach. Request parsing, proxy limits, runtime deadlines, response size, and retry behavior must be tested together.

Use 1,001-member and 10,000-member groups as initial regression and load-test fixtures, not new hard limits. Cover replacing the complete membership, incremental PATCH, delete, role projection, and simultaneous sign-in. Bulk tests must include creating users and a group referencing their `bulkId` values, updates and deletes, scoped credentials, failed dependencies, and retries after lost responses.

## Release gates

The compatibility flag stays disabled until the implementation passes these gates:

| Area                      | Required evidence                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth contract      | Official transaction conformance suite; callback rollback; read-your-writes; repeated create/update/delete; increment/consume races; mapped schemas; nested transaction behavior; hooks only after commit |
| SCIM                      | Actual plugin requests for create/update/deactivate/delete, groups with 1,001 and 10,000 members, role projection, session revocation, managed credential rotation, and connection decommissioning        |
| Concurrent authentication | SSO account linking racing SCIM deactivation/deletion; guarded provider replacement racing login; no session or access grant from an invalidated identity                                                 |
| Isolation                 | Competing uniqueness claims, absent-row reads, membership insertions/deletions during queries, read-only transactions, and normal operations overlapping callback transactions                            |
| Recovery                  | Kill or fault injection before and after every prepare batch and commit decision; competing recovery workers; lost acknowledgement; TTL cleanup; idempotent compaction                                    |
| Provisioning scale        | Large User/Group requests and `/Bulk`, temporary ID references, per-operation outcomes, bounded execution concurrency, measured progress and retry behavior, and no partial resource changes on failure   |
| Performance               | Compare ID/session lookup and ordinary writes against 1.2; p50/p95/p99, requests, consumed capacity, bytes, contention, and recovery overhead for large group changes                                     |
| Deployment                | Migration and rollback tests, mixed-version rejection where enforceable, real AWS throttling/conflict/IAM checks, and documented stream/export behavior                                                   |

Run the repository's full verification and DynamoDB Local integration suites. Local tests are necessary but do not replace targeted AWS validation for this storage and concurrency change. Passing the plugin's initialization check alone is not compatibility evidence.

## Implementation order

1. Build and fault-test the transaction protocol independently, including competing writers and recovery. Prove that only a durable commit decision exposes prepared data.
2. Integrate all adapter reads and writes, add migration and recovery tooling, and pass Better Auth's transaction conformance suite.
3. Exercise the unmodified SCIM and SSO packages against that implementation, including lifecycle and sign-in races.
4. Extend the separate SCIM source package for larger groups and `/Bulk`, retaining its existing tests and adding the cases above.
5. Benchmark ordinary authentication and large provisioning, validate deployment limits, and complete a migration rehearsal before declaring compatibility.

## Sources

- [AWS transaction APIs and isolation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
- [Better Auth SCIM transaction requirements](https://better-auth.com/docs/plugins/scim#enable-database-transactions)
- [Better Auth SSO user resolution](https://better-auth.com/docs/plugins/sso#resolve-sso-users)
- [SCIM Bulk protocol, RFC 7644 section 3.7](https://www.rfc-editor.org/rfc/rfc7644.html#section-3.7)
- [Published SCIM 1.7.5 source archive](https://registry.npmjs.org/@better-auth/scim/-/scim-1.7.5.tgz): `assertNativeSCIMTransactions`, `replaceGroupMemberships`, `SCIM_MAX_GROUP_MEMBERS`, the `scimGroupMember` schema, and `ServiceProviderConfig`.
- [Published SSO 1.7.5 source archive](https://registry.npmjs.org/@better-auth/sso/-/sso-1.7.5.tgz): `assertSSOUserResolutionNativeTransactionSupport` and `assertProviderMutationGuardCapabilities`.
