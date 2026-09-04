# GitHub App integration

FlowForge includes a small GitHub integration foundation for verified webhooks and GitHub REST API calls made with a GitHub App installation token.

## Security model

- Verify every webhook against the **raw request body** with `verifyGitHubWebhookSignature` before parsing JSON or starting a workflow.
- Keep the GitHub App private key, webhook secret, and installation tokens outside source control.
- Supply short-lived installation tokens to `GitHubApiClient`; the client never writes tokens into request bodies or error messages.
- The API client accepts HTTPS endpoints only and constrains requests to relative GitHub API paths.
- Grant the GitHub App only the repository permissions required by the workflows you enable.

## Register the GitHub App

Create a GitHub App named **Karzoun FlowForge Bridge** (or another unique name) in GitHub Developer settings.

Recommended starting configuration:

- Homepage URL: `https://github.com/mkarson1997/karzoun-flowforge`
- Webhook: enabled
- Webhook URL: your public FlowForge bridge endpoint, for example `https://YOUR-HOST/webhooks/github`
- Webhook secret: a randomly generated secret stored only in your deployment secret manager
- Installation scope: only the repositories where FlowForge workflows should run

Start with least privilege. A repository-health or workflow-trigger integration can usually begin with:

- Metadata: Read-only (GitHub requires metadata access)
- Actions: Read-only when reading workflow-run state
- Contents: Read-only when workflow definitions or repository files are read
- Issues: Read-only if issue events become triggers
- Pull requests: Read-only if pull request events become triggers

Subscribe only to events you actually handle, such as `pull_request`, `issues`, or `workflow_run`.

## Webhook verification

```ts
import { verifyGitHubWebhookSignature } from "@karzoun/flowforge";

const valid = verifyGitHubWebhookSignature(
  process.env.GITHUB_WEBHOOK_SECRET ?? "",
  rawRequestBody,
  request.headers["x-hub-signature-256"],
);

if (!valid) {
  throw new Error("Invalid GitHub webhook signature");
}
```

Do not reconstruct or re-stringify JSON before verification. GitHub signs the exact raw bytes delivered to the webhook endpoint.

## GitHub REST API

Obtain a short-lived installation token through GitHub App authentication, then inject it into the client:

```ts
import { GitHubApiClient } from "@karzoun/flowforge";

const github = new GitHubApiClient({
  token: process.env.GITHUB_INSTALLATION_TOKEN ?? "",
});

const repository = await github.getRepository("mkarson1997", "karzoun-flowforge");
const runs = await github.listWorkflowRuns("mkarson1997", "karzoun-flowforge", repository.default_branch);
```

A completed FlowForge execution can also emit an explicit `repository_dispatch` event when the installed app has the required permission:

```ts
await github.createRepositoryDispatch(
  "mkarson1997",
  "karzoun-flowforge",
  "flowforge.completed",
  { executionId: "run-123" },
);
```

## Production boundary

This module deliberately does not generate GitHub App JWTs or persist private keys. App authentication and token minting belong at the deployment boundary or in a dedicated secrets-aware adapter. That keeps FlowForge's core runtime free of long-lived GitHub credentials.
