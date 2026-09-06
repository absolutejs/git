import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitAuthorizationError,
  assertGitRevisionAuthorized,
  gitIngestionIdempotencyKey,
  gitProvenanceFor,
  parseGitRepository,
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

describe("parseGitRepository", () => {
  const repository = (fullName: string) => ({
    cloneUrl: `https://gitlab.com/${fullName}.git`,
    defaultBranch: "main",
    fullName,
    provider: "gitlab" as const,
    webUrl: `https://gitlab.com/${fullName}`,
  });

  test("accepts a nested GitLab group path", () => {
    expect(parseGitRepository(repository("acme/team/app")).fullName).toBe(
      "acme/team/app",
    );
  });

  test("still rejects a name with no owner segment", () => {
    expect(() => parseGitRepository(repository("app"))).toThrow();
  });

  test("accepts plain http only on a loopback host", () => {
    /* Somebody developing against a self-hosted instance on their own
     * machine has no network to protect and no certificate to have. Without
     * this the exception is a trap: such an instance lists and connects, then
     * fails at the clone — the furthest possible point from the cause.
     *
     * `localhost.evil.example` is the case a prefix check would let through. */
    const at = (cloneUrl: string) => ({
      cloneUrl,
      defaultBranch: "main",
      fullName: "acme/app",
      provider: "generic" as const,
      webUrl: cloneUrl,
    });

    expect(
      parseGitRepository(at("http://localhost:3002/acme/app.git")).cloneUrl,
    ).toBe("http://localhost:3002/acme/app.git");
    expect(
      parseGitRepository(at("http://127.0.0.1:3002/acme/app.git")).cloneUrl,
    ).toBe("http://127.0.0.1:3002/acme/app.git");
    expect(() =>
      parseGitRepository(at("http://evil.example/acme/app.git")),
    ).toThrow();
    expect(() =>
      parseGitRepository(at("http://localhost.evil.example/acme/app.git")),
    ).toThrow();
  });
});
