import { describe, expect, test } from "bun:test";
import {
  createGitHubAppInstallationToken,
  createGitHubPullRequest,
  findGitHubPullRequest,
  getGitHubPullRequest,
  getGitHubAppInstallation,
  GitHubMergeRefusedError,
  markGitHubPullRequestReady,
  mergeGitHubPullRequest,
  updateGitHubPullRequest,
} from "../src/github-app";

type Seen = { body: unknown; method: string; url: string };

const recorder = (responses: Array<{ body: unknown; status?: number }>) => {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url: String(input),
    });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  };
  return { fetch, seen };
};

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  base: { ref: "main" },
  draft: false,
  head: { ref: "studio/checkout", sha: "b".repeat(40) },
  html_url: "https://github.com/absolutejs/app/pull/7",
  mergeable: true,
  merged: false,
  node_id: "PR_kwDOAbc123",
  number: 7,
  state: "open",
  title: "Checkout copy",
  ...overrides,
});

describe("GitHub App writes", () => {
  test("a token asks only for the permissions the call needs", async () => {
    const { fetch, seen } = recorder([
      { body: { expires_at: "2026-11-09T12:00:00Z", token: "ghs_write" } },
    ]);
    await createGitHubAppInstallationToken({
      appJwt: "jwt",
      fetch,
      installationId: 11,
      permissions: { contents: "write", pull_requests: "write" },
      repositoryIds: [42],
    });
    expect(seen[0]?.body).toEqual({
      permissions: { contents: "write", pull_requests: "write" },
      repository_ids: [42],
    });
  });

  test("an installation reports what it has accepted, ignoring unknown levels", async () => {
    const { fetch } = recorder([
      {
        body: {
          account: { id: 1, login: "absolutejs" },
          id: 11,
          permissions: { admin: "admin", contents: "write", metadata: "read" },
          repository_selection: "all",
        },
      },
    ]);
    const installation = await getGitHubAppInstallation({
      appJwt: "jwt",
      fetch,
      installationId: 11,
    });
    expect(installation.permissions).toEqual({
      contents: "write",
      metadata: "read",
    });
  });

  test("finds, opens, and updates a pull request from a branch", async () => {
    const { fetch, seen } = recorder([
      { body: [] },
      { body: pullRequest() },
      { body: pullRequest({ title: "Checkout copy, round two" }) },
    ]);
    const options = {
      fetch,
      installationToken: "ghs_write",
      repositoryFullName: "absolutejs/app",
    };
    expect(
      await findGitHubPullRequest({
        ...options,
        base: "main",
        head: "studio/checkout",
      }),
    ).toBeNull();
    expect(seen[0]?.url).toBe(
      "https://api.github.com/repos/absolutejs/app/pulls?base=main&head=absolutejs%3Astudio%2Fcheckout&state=open",
    );
    const opened = await createGitHubPullRequest({
      ...options,
      base: "main",
      body: "Sent from AbsoluteJS Studio.",
      head: "studio/checkout",
      title: "Checkout copy",
    });
    expect(opened).toMatchObject({
      headRef: "studio/checkout",
      merged: false,
      number: 7,
      state: "open",
    });
    expect(seen[1]?.body).toMatchObject({
      base: "main",
      draft: false,
      head: "studio/checkout",
    });
    const updated = await updateGitHubPullRequest({
      ...options,
      number: 7,
      title: "Checkout copy, round two",
    });
    expect(updated.title).toBe("Checkout copy, round two");
    expect(seen[2]?.method).toBe("PATCH");
  });

  test("refuses branch names git would reject", async () => {
    const { fetch } = recorder([]);
    for (const head of ["studio/..", "a b", "x.lock", "/x", "a~b"])
      await expect(
        createGitHubPullRequest({
          base: "main",
          fetch,
          head,
          installationToken: "t",
          repositoryFullName: "absolutejs/app",
          title: "x",
        }),
      ).rejects.toThrow("GitHub pull request head is invalid");
  });

  test("merges through GitHub, which can refuse for protection or a moved head", async () => {
    const options = {
      installationToken: "ghs_write",
      number: 7,
      repositoryFullName: "absolutejs/app",
      sha: "b".repeat(40),
    };
    const merged = recorder([{ body: { merged: true, sha: "c".repeat(40) } }]);
    expect(
      await mergeGitHubPullRequest({ ...options, fetch: merged.fetch }),
    ).toEqual({ sha: "c".repeat(40) });
    expect(merged.seen[0]?.body).toEqual({
      merge_method: "squash",
      sha: "b".repeat(40),
    });
    const protectedBranch = recorder([
      { body: { message: "Required status check is expected." }, status: 405 },
    ]);
    const refusal = await mergeGitHubPullRequest({
      ...options,
      fetch: protectedBranch.fetch,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GitHubMergeRefusedError);
    expect(refusal).toMatchObject({
      message: "Required status check is expected.",
      status: 405,
    });
    const moved = recorder([
      { body: { message: "Head branch was modified." }, status: 409 },
    ]);
    await expect(
      mergeGitHubPullRequest({ ...options, fetch: moved.fetch }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("marks a draft ready for review through GraphQL, by its node id", async () => {
    const { fetch, seen } = recorder([
      {
        body: {
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        },
      },
      { body: { errors: [{ message: "Pull request is not a draft" }] } },
    ]);
    expect(
      await markGitHubPullRequestReady({
        fetch,
        installationToken: "ghs_write",
        nodeId: "PR_kwDOAbc123",
      }),
    ).toEqual({ draft: false });
    expect(seen[0]?.url).toBe("https://api.github.com/graphql");
    expect(seen[0]?.body).toMatchObject({ variables: { id: "PR_kwDOAbc123" } });
    await expect(
      markGitHubPullRequestReady({
        fetch,
        installationToken: "ghs_write",
        nodeId: "PR_kwDOAbc123",
      }),
    ).rejects.toThrow(
      "GitHub refused ready for review: Pull request is not a draft",
    );
  });

  test("reads a pull request's node id", async () => {
    const { fetch } = recorder([{ body: pullRequest() }]);
    const opened = await createGitHubPullRequest({
      base: "main",
      fetch,
      head: "studio/x",
      installationToken: "t",
      repositoryFullName: "absolutejs/app",
      title: "x",
    });
    expect(opened.nodeId).toBe("PR_kwDOAbc123");
  });

  test("a merged pull request names the commit its merge made; an open one names none", async () => {
    const { fetch } = recorder([
      { body: pullRequest({ merge_commit_sha: "f".repeat(40) }) },
      {
        body: pullRequest({
          merge_commit_sha: "e".repeat(40),
          merged: true,
          merged_at: "2026-11-11T12:00:00Z",
          state: "closed",
        }),
      },
    ]);
    const options = {
      fetch,
      installationToken: "ghs_write",
      number: 7,
      repositoryFullName: "absolutejs/app",
    };
    // GitHub's test merge of an open pull request is not a merge.
    expect((await getGitHubPullRequest(options)).mergeCommitSha).toBeNull();
    expect(await getGitHubPullRequest(options)).toMatchObject({
      merged: true,
      mergeCommitSha: "e".repeat(40),
    });
  });
});
