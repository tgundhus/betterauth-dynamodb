# Contributing

Thanks for considering a contribution. This Better Auth DynamoDB adapter expects small, tested changes that are explicit about DynamoDB trade-offs.

## Local workflow

```sh
bun install
bun run verify
bun run test:integration:local
```

`bun run verify` runs typecheck, ESLint, coverage tests, the CRAP quality gate, and build. Run it before opening a PR or handing off work. For storage, transaction, pagination, TTL, client-construction, or key/index behavior changes, also run `bun run test:integration:local`.

The local integration suite requires Docker. It uses Testcontainers with AWS's official `amazon/dynamodb-local:2.6.1` image, in-memory/shared DB mode, disabled telemetry, a random mapped port, fake credentials, isolated local tables, and Better Auth's official adapter conformance suites. CI runs it as a separate Docker-capable job and must fail if the container or tests fail.

Useful focused commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:coverage`
- `bun run test:integration:local`
- `bun run quality:crap`
- `bun run build`
- `bun run verify:integration`

## Quality bar

- Production functions must have CRAP <= 6. If the gate fails, add tests for the uncovered branch or simplify the function.
- Do not lower coverage thresholds or exclude production implementation files to make a change pass.
- Preserve the no-hidden-scan invariant: scan-shaped work must require explicit `unsafeAllowScan: true`.
- Preserve atomic behavior for uniqueness, `consumeOne`, and `incrementOne`.
- Use DynamoDB Local integration coverage for changes touching stored rows, sidecars, unique locks, logical TTL, pagination, injected-client behavior, or transaction conflicts. Do not treat DynamoDB Local as production parity for IAM, throttling, streams, TTL deletion timing, global tables, or AWS service capacity behavior.

## Documentation

Update `README.md` for public API, option, storage-layout, table provisioning, concurrency, or limitation changes. Update `AGENTS.md` if contributor rules or invariants change.

## Releasing

1. On a release branch, bump `version` in `package.json`, finalize the `CHANGELOG.md` entry (date and compare link), and update the README upgrade note if needed.
2. Merge the release PR after `ci` passes.
3. Tag the merge commit on `main` and push the tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. The `publish` workflow runs `bun run verify`, checks that the tag matches `package.json`, and publishes to npm with provenance using npm trusted publishing (OIDC). It has no npm token; the repository and workflow file must be registered as a trusted publisher for `@bjorntech/betterauth-dynamodb` on npmjs.com.

## Public repository hygiene

Do not commit secrets, `.env` files, private infrastructure identifiers, generated `dist/`, or `coverage/`. The project license is MIT; do not add package metadata, security contacts, or governance details unless they are actual project decisions.
