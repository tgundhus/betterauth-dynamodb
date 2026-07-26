# Examples

These examples are standalone applications that consume this repository through a local `file:../..` dependency. Build the repository root first:

```sh
bun run build
```

- [Alchemy v2 example](./alchemy-v2/) - prerelease infrastructure-as-code example with a DynamoDB table and public Function URL.
- A component-based AWS deployment example is available in its own subdirectory.

After this package is published in your environment, replace the local file dependency with the published package version you intend to deploy.
