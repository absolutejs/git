# @absolutejs/git

Authenticated Git source ingestion for Bun control planes and AbsoluteJS.

The package turns a signed provider webhook into a normalized, authorized exact
revision, checks that revision out without a shell, strips Git metadata, applies
source-size and file-count limits, and emits portable provenance. It does not
own credentials, databases, queues, build sandboxes, deployment, or UI.
GitHub App installations can also create and update normalized Check Runs so a
control plane reports exact-revision deployment posture without hand-writing
provider payloads.

```ts
import { assertGitRevisionAuthorized, gitProvenanceFor } from "@absolutejs/git";
import { createGitCheckout } from "@absolutejs/git/checkout";
import { verifyGitHubPushWebhook } from "@absolutejs/git/github";

const event = verifyGitHubPushWebhook({
  body: rawBody,
  headers: request.headers,
  secret: webhookSecret,
});

assertGitRevisionAuthorized(
  {
    allowedRefs: ["refs/heads/main"],
    repository: { provider: "github", fullName: "acme/site" },
  },
  event.revision,
);

const checkout = await createGitCheckout({
  credential: { token: installationToken },
  revision: event.revision,
});
try {
  await isolatedBuild(checkout.sourceRoot, gitProvenanceFor(event));
} finally {
  await checkout.dispose();
}
```

## Security boundary

- Verify signatures against the untouched request bytes before parsing JSON.
- Derive canonical provider URLs instead of trusting webhook clone URLs.
- Authorize both repository identity and full ref before checkout.
- Fetch and verify the exact commit, never a moving branch tip.
- Pass Git arguments as an array; credentials use child-process environment
  configuration and are never embedded in repository URLs or errors.
- Remove `.git`, reject links and special files, and enforce source bounds before
  handing a tree to a build system.
- Run installation and builds in a separate sandbox with network, CPU, memory,
  time, and output limits. That policy belongs to the host control plane.

`@absolutejs/deploy/release-artifact` remains the ecosystem owner of immutable
deployment archives and their SHA-256 integrity contract.
