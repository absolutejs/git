import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitAuthorizationError,
  assertGitRevisionAuthorized,
  gitIngestionIdempotencyKey,
  gitProvenanceFor,
} from "../src";
import { verifyGitHubPushWebhook } from "../src/github";

const secret = "a-webhook-secret-that-is-long-enough";
const payload = JSON.stringify({
  after: "a".repeat(40),
  before: "b".repeat(40),
  deleted: false,
  forced: false,
  pusher: { email: "dev@example.com", name: "Developer" },
  ref: "refs/heads/main",
  repository: {
    default_branch: "release/main",
    full_name: "absolutejs/example",
  },
});
const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

describe("GitHub push ingestion", () => {
  test("verifies and normalizes an exact push revision", () => {
    const event = verifyGitHubPushWebhook({
      body: payload,
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      secret,
    });
    expect(event.revision.repository.cloneUrl).toBe(
      "https://github.com/absolutejs/example.git",
    );
    expect(event.revision.commitSha).toBe("a".repeat(40));
    expect(event.revision.repository.defaultBranch).toBe("release/main");
    expect(gitIngestionIdempotencyKey("github", event.deliveryId)).toBe(
      "github:delivery-1",
    );
    expect(gitProvenanceFor(event)).toEqual({
      commitSha: "a".repeat(40),
      deliveryId: "delivery-1",
      provider: "github",
      receivedAt: "2026-07-16T12:00:00.000Z",
      ref: "refs/heads/main",
      repository: "absolutejs/example",
    });
  });

  test("rejects invalid signatures and unauthorized refs", () => {
    expect(() =>
      verifyGitHubPushWebhook({
        body: payload,
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        secret,
      }),
    ).toThrow("signature is invalid");
    const event = verifyGitHubPushWebhook({
      body: payload,
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      secret,
    });
    expect(() =>
      assertGitRevisionAuthorized(
        {
          allowedRefs: ["refs/heads/release"],
          repository: { fullName: "absolutejs/example", provider: "github" },
        },
        event.revision,
      ),
    ).toThrow(GitAuthorizationError);
  });
});
