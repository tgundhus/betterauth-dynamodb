/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "betterauth-dynamodb-example",
      home: "aws",
      removal: input.stage === "production" ? "retain" : "remove"
    };
  },
  async run() {
    const authSecret = new sst.Secret("BetterAuthSecret");
    const table = new sst.aws.Dynamo("BetterAuthTable", {
      fields: {
        pk: "string",
        sk: "string"
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "ttl"
    });

    const api = new sst.aws.Function("AuthApi", {
      handler: "src/lambda.handler",
      link: [table, authSecret],
      url: true
    });

    return {
      url: api.url,
      table: table.name
    };
  }
});
