# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-26

### Added

- Provides a production-oriented Better Auth DynamoDB adapter for Better Auth `^1.6.25` through the official `createAdapterFactory` API.
- Supports the Better Auth adapter operation set with transactional entity, scalar equality sidecar, and unique-lock maintenance for single-record writes.
- Guarantees atomic uniqueness, `consumeOne`, and `incrementOne` behavior with DynamoDB transactions, conditional checks, hidden revision guards, and native numeric `ADD` where applicable.
- Uses a no-hidden-scan query-planning model: id equality and scalar equality use keyed reads, while scan-shaped operations, `OR` predicates, and case-insensitive equality require explicit `unsafeAllowScan: true`.
- Supports injected `DynamoDBDocumentClient` instances so applications own AWS region, credentials, middleware, tracing, and marshalling behavior; local development can also configure client creation through adapter options.
- Provides adapter-managed DynamoDB TTL derivation from configured Better Auth date fields, including logical expiration filtering before DynamoDB physically removes expired rows.
- Defines the 1.0 storage layout contract for entity rows, scalar equality sidecar rows, unique lock rows, delimiter-safe length-prefixed key components, hashed sidecar/lock values, and hidden revision metadata.
- Includes unit coverage, DynamoDB Local integration tests, Better Auth official adapter conformance suites, coverage thresholds, and a per-production-function CRAP `<= 6` quality gate through `bun run verify`.

[1.0.0]: https://github.com/bjorntech/betterauth-dynamodb/releases/tag/v1.0.0
