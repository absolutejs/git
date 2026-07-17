import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  createGitHubAppUserClient,
  GitHubUserCredentialUnavailableError,
} from "../src/github-app-user";

const credential: ResolvedLinkedProviderCredential = {
  authProviderKey: "github",
  bindingId: "binding-1",
  connectorProvider: "github",
  externalAccountId: "octocat",
  externalAccountType: "user",
  grantId: "grant-1",
  ownerRef: "user-1",
  providerFamily: "github",
  scopes: [],
};

const resolver = (reports: LinkedProviderCredentialFailureReport[] = []) =>
  ({
    getAccessToken: async () => ({
      accessToken: "ghu_token",
      grantedScopes: [],
    }),
    listBindings: async () => [],
    reportFailure: async (_credential, report) => {
      reports.push(report);
    },
    resolveCredential: async ({ ownerRef, connectorProvider }) =>
      ownerRef === "user-1" && connectorProvider === "github"
        ? credential
        : null,
  }) satisfies LinkedProviderCredentialResolver;

const githubFetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/user/installations?"))
    return Response.json({
      installations: [
        {
          account: { id: 7, login: "absolutejs" },
          id: 11,
          repository_selection: "selected",
        },
      ],
    });
  if (url.includes("/user/installations/11/repositories?"))
    return Response.json({
      repositories: [
        {
          clone_url: "https://github.com/absolutejs/PAAS.git",
          default_branch: "main",
          full_name: "absolutejs/PAAS",
          html_url: "https://github.com/absolutejs/PAAS",
          id: 23,
          private: true,
        },
      ],
    });

  return new Response("not found", { status: 404 });
};

describe("GitHub App user client", () => {
  test("discovers repositories through a linked credential lease", async () => {
    const client = createGitHubAppUserClient({
      credentials: resolver(),
      fetch: githubFetch,
    });

    expect(await client.listRepositories("user-1")).toEqual([
      {
        account: { id: 7, login: "absolutejs" },
        cloneUrl: "https://github.com/absolutejs/PAAS.git",
        defaultBranch: "main",
        fullName: "absolutejs/PAAS",
        id: 23,
        installationId: 11,
        private: true,
        webUrl: "https://github.com/absolutejs/PAAS",
      },
    ]);
  });

  test("validates installation and repository access", async () => {
    const client = createGitHubAppUserClient({
      credentials: resolver(),
      fetch: githubFetch,
    });

    expect(
      await client.getRepository("user-1", {
        installationId: 11,
        repositoryId: 23,
      }),
    ).toMatchObject({ fullName: "absolutejs/PAAS", installationId: 11 });
  });

  test("requires a linked GitHub credential", async () => {
    const client = createGitHubAppUserClient({
      credentials: resolver(),
      fetch: githubFetch,
    });

    expect(client.listRepositories("missing-user")).rejects.toBeInstanceOf(
      GitHubUserCredentialUnavailableError,
    );
  });

  test("reports GitHub authorization failures to the resolver", async () => {
    const reports: LinkedProviderCredentialFailureReport[] = [];
    const client = createGitHubAppUserClient({
      credentials: resolver(reports),
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow(
      "GitHub status 401",
    );
    expect(reports).toEqual([
      { code: "unauthorized", message: expect.stringContaining("401") },
    ]);
  });
});
