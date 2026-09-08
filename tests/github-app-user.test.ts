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
          html_url: "https://github.com/settings/installations/11",
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
        installationUrl: "https://github.com/settings/installations/11",
        linkedAccountId: "octocat",
        private: true,
        repositorySelection: "selected",
        webUrl: "https://github.com/absolutejs/PAAS",
      },
    ]);
  });

  test("carries what each installation was granted onto its repositories", async () => {
    /* Two installations, granted differently. Listing flattens them into one
       array, so without this on each repository a caller cannot tell which
       account will show a repository added tomorrow and which will not. */
    const twoInstallations = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/user/installations?"))
        return Response.json({
          installations: [
            {
              account: { id: 7, login: "absolutejs" },
              id: 11,
              html_url: "https://github.com/settings/installations/11",
              repository_selection: "selected",
            },
            {
              account: { id: 8, login: "acme" },
              id: 12,
              html_url: "https://github.com/settings/installations/11",
              repository_selection: "all",
            },
          ],
        });
      const repository = (id: number, fullName: string) => ({
        clone_url: `https://github.com/${fullName}.git`,
        default_branch: "main",
        full_name: fullName,
        html_url: `https://github.com/${fullName}`,
        id,
        private: false,
      });
      if (url.includes("/user/installations/11/repositories?"))
        return Response.json({
          repositories: [repository(23, "absolutejs/PAAS")],
        });
      if (url.includes("/user/installations/12/repositories?"))
        return Response.json({ repositories: [repository(24, "acme/site")] });

      return new Response("not found", { status: 404 });
    };
    const client = createGitHubAppUserClient({
      credentials: resolver(),
      fetch: twoInstallations,
    });

    expect(
      (await client.listRepositories("user-1")).map((entry) => [
        entry.fullName,
        entry.repositorySelection,
      ]),
    ).toEqual([
      ["absolutejs/PAAS", "selected"],
      ["acme/site", "all"],
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
    ).toMatchObject({
      fullName: "absolutejs/PAAS",
      installationId: 11,
      repositorySelection: "selected",
    });
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

  test("lists across every linked GitHub identity, not just the first", async () => {
    /* A GitHub App installation belongs to an account, and
       `/user/installations` only returns the ones that token's own user can
       reach. Two personal accounts share none of each other's, so a customer
       who links both sees one account's repositories unless each identity is
       asked separately. */
    const tokens: Record<string, string> = {
      "binding-a": "ghu_a",
      "binding-b": "ghu_b",
    };
    const perToken: Record<string, { account: string; id: number }> = {
      ghu_a: { account: "absolutejs", id: 11 },
      ghu_b: { account: "alexkahndev", id: 22 },
    };
    const many: LinkedProviderCredentialResolver = {
      getAccessToken: async (used: ResolvedLinkedProviderCredential) => ({
        accessToken: tokens[used.bindingId] ?? "ghu_none",
        grantedScopes: [],
      }),
      listBindings: async () => [
        { connectorProvider: "github", id: "binding-a" },
        { connectorProvider: "github", id: "binding-b" },
      ],
      reportFailure: async () => undefined,
      resolveCredential: async ({ bindingId }: { bindingId?: string }) => ({
        ...credential,
        bindingId: bindingId ?? "binding-a",
      }),
    } as unknown as LinkedProviderCredentialResolver;
    const byToken = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const auth = String(
        new Headers(init?.headers).get("authorization") ?? "",
      ).replace("Bearer ", "");
      const who = perToken[auth];
      if (!who) return new Response("unauthorized", { status: 401 });
      const url = String(input);
      if (url.includes("/user/installations?"))
        return Response.json({
          installations: [
            {
              account: { id: who.id, login: who.account },
              html_url: `https://github.com/settings/installations/${who.id}`,
              id: who.id,
              repository_selection: "all",
            },
          ],
        });

      return Response.json({
        repositories: [
          {
            clone_url: `https://github.com/${who.account}/only.git`,
            default_branch: "main",
            full_name: `${who.account}/only`,
            html_url: `https://github.com/${who.account}/only`,
            id: who.id * 100,
            private: false,
          },
        ],
      });
    };

    const client = createGitHubAppUserClient({
      credentials: many,
      fetch: byToken,
    });

    expect(
      (await client.listRepositories("user-1")).map((r) => r.fullName).sort(),
    ).toEqual(["absolutejs/only", "alexkahndev/only"]);
  });
});
