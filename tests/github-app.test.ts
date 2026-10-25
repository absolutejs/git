import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createGitHubAppInstallationToken,
  createGitHubAppJwt,
  createGitHubCheckRun,
  getGitHubAppInstallation,
  gitHubChecksVerdict,
  listGitHubCommitCheckRuns,
  listGitHubAppInstallationsForUser,
  listGitHubAppRepositories,
  listGitHubAppRepositoriesForUser,
  updateGitHubCheckRun,
  verifyGitHubAppCheckSuiteWebhook,
  verifyGitHubAppPullRequestWebhook,
  verifyGitHubAppPushWebhook,
} from "../src/github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("GitHub App authentication", () => {
  test("creates and completes one installation-authenticated check run", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const responses = [
      {
        conclusion: null,
        html_url: "https://github.com/absolutejs/git/runs/9",
        id: 9,
        status: "in_progress",
      },
      {
        conclusion: "success",
        html_url: "https://github.com/absolutejs/git/runs/9",
        id: 9,
        status: "completed",
      },
    ];
    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        method: init?.method ?? "GET",
        url: String(input),
      });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    const created = await createGitHubCheckRun({
      detailsUrl: "https://paas.example/projects/1",
      externalId: "delivery:opened",
      fetch: mockFetch,
      headSha: "a".repeat(40),
      installationToken: "ghs_token",
      name: "AbsoluteJS preview",
      output: { summary: "Provisioning", title: "Preview deployment" },
      repositoryFullName: "absolutejs/git",
      status: "in_progress",
    });
    const completed = await updateGitHubCheckRun({
      checkRunId: created.id,
      conclusion: "success",
      detailsUrl: "https://preview.example",
      externalId: "delivery:success",
      fetch: mockFetch,
      installationToken: "ghs_token",
      name: "AbsoluteJS preview",
      output: { summary: "Ready", title: "Preview deployment" },
      repositoryFullName: "absolutejs/git",
      status: "completed",
    });

    expect(completed.conclusion).toBe("success");
    expect(requests).toMatchObject([
      {
        body: { head_sha: "a".repeat(40), status: "in_progress" },
        method: "POST",
        url: "https://api.github.com/repos/absolutejs/git/check-runs",
      },
      {
        body: { conclusion: "success", status: "completed" },
        method: "PATCH",
        url: "https://api.github.com/repos/absolutejs/git/check-runs/9",
      },
    ]);
  });

  test("rejects an invalid check run lifecycle before provider I/O", async () => {
    await expect(
      createGitHubCheckRun({
        fetch: async () => new Response(),
        headSha: "a".repeat(40),
        installationToken: "ghs_token",
        name: "AbsoluteJS preview",
        repositoryFullName: "absolutejs/git",
        status: "completed",
      }),
    ).rejects.toThrow("needs a conclusion");
  });

  test("creates a bounded RS256 app JWT", () => {
    const jwt = createGitHubAppJwt({
      appId: 123,
      now: () => new Date("2026-01-01T00:00:00Z"),
      privateKey: pem,
    });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      exp: 1767226140,
      iat: 1767225540,
      iss: "123",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  test("exchanges and parses installation resources", async () => {
    const responses = [
      {
        account: { id: 2, login: "absolutejs" },
        id: 3,
        html_url: "https://github.com/settings/installations/11",
        repository_selection: "selected",
      },
      { expires_at: "2026-01-01T01:00:00Z", token: "ghs_token" },
      {
        repositories: [
          {
            clone_url: "https://github.com/absolutejs/git.git",
            default_branch: "main",
            full_name: "absolutejs/git",
            html_url: "https://github.com/absolutejs/git",
            id: 4,
            private: false,
          },
        ],
      },
    ];
    const mockFetch = async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 });
    expect(
      (
        await getGitHubAppInstallation({
          appJwt: "jwt",
          fetch: mockFetch,
          installationId: 3,
        })
      ).account.login,
    ).toBe("absolutejs");
    expect(
      (
        await createGitHubAppInstallationToken({
          appJwt: "jwt",
          fetch: mockFetch,
          installationId: 3,
          repositoryIds: [4],
        })
      ).token,
    ).toBe("ghs_token");
    expect(
      (
        await listGitHubAppRepositories({
          fetch: mockFetch,
          installationToken: "ghs_token",
        })
      )[0]?.fullName,
    ).toBe("absolutejs/git");
  });

  test("discovers only installations and repositories visible to a user", async () => {
    const repository = {
      clone_url: "https://github.com/absolutejs/git.git",
      default_branch: "main",
      full_name: "absolutejs/git",
      html_url: "https://github.com/absolutejs/git",
      id: 4,
      private: false,
    };
    const responses = [
      {
        installations: [
          {
            account: { id: 2, login: "absolutejs" },
            id: 3,
            html_url: "https://github.com/settings/installations/11",
            repository_selection: "selected",
          },
        ],
      },
      { repositories: [repository] },
    ];
    const mockFetch = async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 });
    const installations = await listGitHubAppInstallationsForUser({
      fetch: mockFetch,
      userAccessToken: "ghu_token",
    });
    const repositories = await listGitHubAppRepositoriesForUser({
      fetch: mockFetch,
      installationId: installations[0]!.id,
      userAccessToken: "ghu_token",
    });
    expect(installations[0]?.account.login).toBe("absolutejs");
    expect(repositories[0]?.fullName).toBe("absolutejs/git");
  });

  test("keeps every installation when one arrives without its link", async () => {
    /* The configuration URL is a link and nothing more. Reading it strictly
       meant one installation missing it threw, and the caller -- who asks for
       installations only to list their repositories -- got none of them: every
       repository on every account gone to save one dead anchor. */
    const mockFetch = async () =>
      Response.json({
        installations: [
          {
            account: { id: 2, login: "absolutejs" },
            html_url: "https://github.com/settings/installations/11",
            id: 3,
            repository_selection: "selected",
          },
          {
            account: { id: 5, login: "acme" },
            id: 4,
            repository_selection: "all",
          },
        ],
      });

    const installations = await listGitHubAppInstallationsForUser({
      fetch: mockFetch,
      userAccessToken: "ghu_token",
    });

    expect(installations.map((installation) => installation.id)).toEqual([
      3, 4,
    ]);
    expect(installations[1]?.installationUrl).toBeNull();
  });

  test("binds App push events to installation and repository ids", () => {
    const body = JSON.stringify({
      after: "a".repeat(40),
      before: "b".repeat(40),
      deleted: false,
      forced: false,
      installation: { id: 3 },
      pusher: { name: "octocat" },
      ref: "refs/heads/main",
      repository: {
        default_branch: "main",
        full_name: "absolutejs/git",
        id: 4,
      },
    });
    const secret = "a-secure-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const result = verifyGitHubAppPushWebhook({
      body,
      headers: {
        "x-github-delivery": "delivery",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      secret,
    });
    expect(result.installationId).toBe(3);
    expect(result.repositoryId).toBe(4);
  });

  test("normalizes an authenticated pull request lifecycle event", () => {
    const repository = {
      clone_url: "https://github.com/absolutejs/git.git",
      default_branch: "main",
      full_name: "absolutejs/git",
      html_url: "https://github.com/absolutejs/git",
      id: 4,
    };
    const body = JSON.stringify({
      action: "synchronize",
      installation: { id: 3 },
      number: 42,
      pull_request: {
        base: { ref: "main", repo: repository, sha: "b".repeat(40) },
        draft: false,
        head: { ref: "feature", repo: repository, sha: "a".repeat(40) },
        html_url: "https://github.com/absolutejs/git/pull/42",
        merged: false,
        title: "Add durable previews",
        user: { login: "octocat" },
      },
      repository,
    });
    const secret = "a-secure-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const result = verifyGitHubAppPullRequestWebhook({
      body,
      headers: {
        "x-github-delivery": "pr-delivery",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      now: () => new Date("2026-07-16T18:00:00.000Z"),
      secret,
    });
    expect(result.installationId).toBe(3);
    expect(result.repositoryId).toBe(4);
    expect(result.event).toMatchObject({
      action: "synchronize",
      deliveryId: "pr-delivery",
      number: 42,
      receivedAt: "2026-07-16T18:00:00.000Z",
    });
    expect(result.event.head.commitSha).toBe("a".repeat(40));
    expect(result.event.head.ref).toBe("refs/heads/feature");
  });

  test("rejects unsupported pull request actions", () => {
    const body = JSON.stringify({ action: "labeled" });
    const secret = "a-secure-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(() =>
      verifyGitHubAppPullRequestWebhook({
        body,
        headers: {
          "x-github-delivery": "pr-delivery",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signature,
        },
        secret,
      }),
    ).toThrow("action is unsupported");
  });

  test("follows every page of a listing rather than the first hundred", async () => {
    /* Nothing here followed GitHub's pages, so an installation granted an
       account with more than a hundred repositories silently listed a
       hundred. A single-page fixture cannot fail on that. */
    const repository = (id: number) => ({
      clone_url: `https://github.com/absolutejs/r${id}.git`,
      default_branch: "main",
      full_name: `absolutejs/r${id}`,
      html_url: `https://github.com/absolutejs/r${id}`,
      id,
      private: false,
    });
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, index) => repository(index + 1)),
      "2": Array.from({ length: 30 }, (_, index) => repository(index + 101)),
    };
    const seen: string[] = [];
    const paged = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page") ?? "1";
      seen.push(page);

      return Response.json({ repositories: pages[page] ?? [] });
    };

    const listed = await listGitHubAppRepositories({
      fetch: paged,
      installationToken: "ghs_token",
    });

    expect(listed).toHaveLength(130);
    expect(listed.at(-1)?.fullName).toBe("absolutejs/r130");
    // Stops on the short page instead of asking for a third.
    expect(seen).toEqual(["1", "2"]);
  });
});

describe("commit checks as a deploy gate", () => {
  const sha = "c".repeat(40);
  const signed = (body: string, secret: string, event = "check_suite") => ({
    "x-github-delivery": "suite-delivery",
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  });

  test("reads a completed check suite event", () => {
    const secret = "a-secure-webhook-secret";
    const body = JSON.stringify({
      action: "completed",
      check_suite: { head_sha: sha.toUpperCase() },
      installation: { id: 3 },
      repository: { full_name: "alexkahndev/closer-arcade", id: 4 },
    });
    expect(
      verifyGitHubAppCheckSuiteWebhook({
        body,
        headers: signed(body, secret),
        now: () => new Date("2026-10-25T12:00:00.000Z"),
        secret,
      }),
    ).toEqual({
      deliveryId: "suite-delivery",
      headSha: sha,
      installationId: 3,
      receivedAt: "2026-10-25T12:00:00.000Z",
      repositoryFullName: "alexkahndev/closer-arcade",
      repositoryId: 4,
    });
  });

  test("refuses a forged or unfinished check suite event", () => {
    const secret = "a-secure-webhook-secret";
    const body = JSON.stringify({
      action: "completed",
      check_suite: { head_sha: sha },
      installation: { id: 3 },
      repository: { full_name: "alexkahndev/closer-arcade", id: 4 },
    });
    expect(() =>
      verifyGitHubAppCheckSuiteWebhook({
        body,
        headers: signed(body, "a-different-webhook-secret"),
        secret,
      }),
    ).toThrow("signature is invalid");
    const requested = JSON.stringify({ action: "requested" });
    expect(() =>
      verifyGitHubAppCheckSuiteWebhook({
        body: requested,
        headers: signed(requested, secret),
        secret,
      }),
    ).toThrow("action is unsupported");
  });

  test("lists every page of a commit's latest check runs", async () => {
    const urls: string[] = [];
    const run = (id: number) => ({
      app: { id: 15368 },
      conclusion: "success",
      html_url: `https://github.com/runs/${id}`,
      id,
      name: `job ${id}`,
      status: "completed",
    });
    const runs = await listGitHubCommitCheckRuns({
      fetch: (async (url: string) => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        const count = page === 1 ? 100 : 2;
        return Response.json({
          check_runs: Array.from({ length: count }, (_, i) =>
            run((page - 1) * 100 + i + 1),
          ),
        });
      }) as unknown as typeof fetch,
      headSha: sha,
      installationToken: "installation-token",
      repositoryFullName: "alexkahndev/closer-arcade",
    });
    expect(runs).toHaveLength(102);
    expect(runs[0]).toEqual({
      appId: 15368,
      conclusion: "success",
      htmlUrl: "https://github.com/runs/1",
      name: "job 1",
      status: "completed",
    });
    expect(urls[0]).toContain(`/commits/${sha}/check-runs?filter=latest`);
  });

  test("judges a commit only once every counted run has finished", () => {
    const run = (
      name: string,
      status: "completed" | "in_progress" | "queued",
      conclusion: "failure" | "neutral" | "skipped" | "success" | null,
      appId = 15368,
    ) => ({ appId, conclusion, htmlUrl: null, name, status });
    const ours = 999;

    expect(gitHubChecksVerdict([])).toEqual({ state: "none" });
    expect(
      gitHubChecksVerdict([run("preview", "queued", null, ours)], {
        ignoreAppIds: [ours],
      }),
    ).toEqual({ state: "none" });
    expect(
      gitHubChecksVerdict([
        run("unit", "completed", "failure"),
        run("integration", "in_progress", null),
      ]),
    ).toEqual({ state: "pending", waitingOn: ["integration"] });
    expect(
      gitHubChecksVerdict(
        [
          run("unit", "completed", "success"),
          run("lint", "completed", "neutral"),
          run("docs", "completed", "skipped"),
          run("preview", "queued", null, ours),
        ],
        { ignoreAppIds: [ours] },
      ),
    ).toEqual({ passed: ["unit", "lint", "docs"], state: "passed" });
    expect(
      gitHubChecksVerdict([
        run("unit", "completed", "success"),
        run("races", "completed", "failure"),
      ]),
    ).toEqual({ failed: ["races"], state: "failed" });
  });
});
