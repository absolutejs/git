import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createGitHubAppInstallationToken,
  createGitHubAppJwt,
  getGitHubAppInstallation,
  listGitHubAppInstallationsForUser,
  listGitHubAppRepositories,
  listGitHubAppRepositoriesForUser,
  verifyGitHubAppPushWebhook,
} from "../src/github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("GitHub App authentication", () => {
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
});
