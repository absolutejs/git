import { describe, expect, test } from "bun:test";
import {
  commentOnGitHubPullRequest,
  getGitHubPullRequestReadiness,
  reviewGitHubPullRequest,
} from "../src/github-app";

const recorder = (body: unknown, status = 200) => {
  const seen: Array<{
    body: unknown;
    method: string;
    token: string | null;
    url: string;
  }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      token: new Headers(init?.headers).get("authorization"),
      url: String(input),
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, seen };
};

describe("reviews, comments and readiness", () => {
  test("a comment is posted on the pull request's conversation", async () => {
    const { fetch, seen } = recorder({ id: 11 });
    expect(
      await commentOnGitHubPullRequest({
        body: "Approved in AbsoluteJS by Dana",
        fetch,
        installationToken: "ghs_app",
        number: 7,
        repositoryFullName: "absolutejs/app",
      }),
    ).toEqual({ id: 11 });
    expect(seen[0]).toMatchObject({
      body: { body: "Approved in AbsoluteJS by Dana" },
      method: "POST",
      token: "Bearer ghs_app",
      url: "https://api.github.com/repos/absolutejs/app/issues/7/comments",
    });
  });

  test("a review is submitted with the person's own token", async () => {
    const { fetch, seen } = recorder({ id: 5, state: "APPROVED" });
    expect(
      await reviewGitHubPullRequest({
        body: "Looks good",
        event: "APPROVE",
        fetch,
        number: 7,
        repositoryFullName: "absolutejs/app",
        token: "ghu_dana",
      }),
    ).toEqual({ id: 5, state: "APPROVED" });
    expect(seen[0]).toMatchObject({
      body: { body: "Looks good", event: "APPROVE" },
      token: "Bearer ghu_dana",
      url: "https://api.github.com/repos/absolutejs/app/pulls/7/reviews",
    });
  });

  test("GitHub refusing an approval is an error, not a silent success", async () => {
    const { fetch } = recorder(
      { message: "Can not approve your own pull request" },
      422,
    );
    await expect(
      reviewGitHubPullRequest({
        event: "APPROVE",
        fetch,
        number: 7,
        repositoryFullName: "absolutejs/app",
        token: "ghu_dana",
      }),
    ).rejects.toThrow("422");
  });

  test("readiness: the review decision, merge state and each check", async () => {
    const { fetch } = recorder({
      data: {
        node: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          conclusion: null,
                          name: "test",
                          status: "IN_PROGRESS",
                        },
                        {
                          __typename: "StatusContext",
                          context: "ci/lint",
                          state: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
          mergeStateStatus: "BLOCKED",
          reviewDecision: "REVIEW_REQUIRED",
        },
      },
    });
    expect(
      await getGitHubPullRequestReadiness({
        fetch,
        installationToken: "ghs_app",
        nodeId: "PR_1",
      }),
    ).toEqual({
      checks: [
        { name: "test", state: "IN_PROGRESS" },
        { name: "ci/lint", state: "SUCCESS" },
      ],
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    });
  });
});
