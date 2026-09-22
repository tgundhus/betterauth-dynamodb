# Scheduled transaction recovery on Lambda

This example runs recovery against an existing authentication table. It includes a durable checkpoint, a four-minute execution budget, a five-minute schedule, one concurrent invocation, SDK deadlines, retained logs, an encrypted dead-letter queue, and CloudWatch alarms directed to your existing SNS topic. Authentication records and recovery state stay in DynamoDB.

Build and validate from the adapter repository:

```sh
bun install --frozen-lockfile
bun run verify
bun run build:recovery-worker
sam validate --lint --template-file examples/aws-lambda/recovery.template.json
```

Deploy the reviewed template to a staging account first:

```sh
sam deploy --guided --template-file examples/aws-lambda/recovery.template.json
```

Supply the table name, the transaction TTL attribute, and an SNS alarm topic with working on-call subscriptions. The TTL attribute must match the adapter and the table. This creates maintenance infrastructure, not an authentication table or public endpoint. The role permits keyed reads and transactional row changes only on that table; it grants neither Scan nor table administration. Keep table encryption, point-in-time recovery, backup retention, IAM access, and restore exercises in your application's infrastructure configuration.

The worker stores progress at `pk = BETTERAUTH#MAINTENANCE`, `sk = transactions`. Stopping an invocation leaves previously completed cleanup batches durable. An SDK deadline, checkpoint conflict, damaged journal, or failed request causes a retry or alarm; inspect the structured recovery log's transaction IDs. Never remove intents, active journals, or the checkpoint to silence an alarm. Follow the storage recovery and migration guide.

This worker repairs database transactions. Large provisioning jobs need their separate SCIM job runner. AWS limits a Lambda invocation to 15 minutes and a buffered synchronous invocation payload to 6 MB; configure the SCIM ingress payload limit below the effective gateway/Lambda limit, including its encoding overhead. Neither a longer HTTP timeout nor transaction recovery alone resumes an interrupted JavaScript callback.

Sources: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [transaction IAM permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html), [SAM scheduling](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedulev2.html).
