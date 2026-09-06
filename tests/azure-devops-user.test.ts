import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  AzureDevOpsUserCredentialUnavailableError,
  createAzureDevOpsUserClient,
} from "../src/azure-devops-user";

const credential: ResolvedLinkedProviderCredential = {
  authProviderKey: "azure-devops",
  bindingId: "binding-1",
  connectorProvider: "azure-devops",
  externalAccountId: "profile-1",
  externalAccountType: "user",
  grantId: "grant-1",
  ownerRef: "user-1",
  providerFamily: "azure-devops",
  scopes: ["vso.code"],
};

const resolver = (reports: LinkedProviderCredentialFailureReport[] = []) =>
  ({
    getAccessToken: async () => ({
      accessToken: "entra_token",
      grantedScopes: ["vso.code"],
    }),
    listBindings: async () => [],
    reportFailure: async (_credential, report) => {
      reports.push(report);
    },
    resolveCredential: async ({ ownerRef }) =>
      ownerRef === "user-1" ? credential : null,
  }) satisfies LinkedProviderCredentialResolver;

const page = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** The three calls a listing makes, in the order it makes them. */
const host = (repositories: unknown[], organizations = ["acme"]) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/profile/profiles/me")) return page({ id: "member-1" });
    if (url.includes("/_apis/accounts"))
      return page({
        value: organizations.map((name) => ({
          accountId: `${name}-id`,
          accountName: name,
        })),
      });

    return page({ value: repositories });
  }) as unknown as typeof fetch;

const repository = (over: Record<string, unknown> = {}) => ({
  defaultBranch: "refs/heads/main",
  id: "11111111-2222-3333-4444-555555555555",
  name: "Web",
  project: { id: "p1", name: "Platform", visibility: "private" },
  // Azure DevOps writes the organization in as userinfo.
  remoteUrl: "https://acme@dev.azure.com/acme/Platform/_git/Web",
  ...over,
});

describe("createAzureDevOpsUserClient", () => {
  test("names a repository by organization, project and name", async () => {
    // The same repository name can exist in every project of every
    // organization, so two segments would not identify one.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository()]),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.fullName).toBe("acme/Platform/Web");
    expect(entry?.account).toEqual({ id: "acme", login: "acme" });
  });

  test("strips the organization out of the clone URL", async () => {
    // Userinfo there would fight the credential the caller supplies.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository()]),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.cloneUrl).toBe(
      "https://dev.azure.com/acme/Platform/_git/Web",
    );
  });

  test("reduces a whole ref to the branch name it means", async () => {
    // Azure DevOps reports `refs/heads/main` where every other host reports
    // `main`, and the caller builds the ref back up itself.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository()]),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.defaultBranch).toBe("main");
  });

  test("reports a repository with no commits rather than throwing", async () => {
    // An empty repository has no `defaultBranch` key at all.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository({ defaultBranch: undefined })]),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.defaultBranch).toBeNull();
  });

  test("derives a web URL when the listing omits one", async () => {
    // `webUrl` is not in the default response shape.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository()]),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.webUrl).toBe("https://dev.azure.com/acme/Platform/_git/Web");
  });

  test("treats anything not positively public as private", async () => {
    // Visibility lives on the project and is not always present; assuming
    // public would clone without a credential and fail.
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([
        repository({ project: { id: "p1", name: "Platform" } }),
        repository({
          name: "Docs",
          project: { id: "p2", name: "Open", visibility: "public" },
        }),
      ]),
    });

    const entries = await client.listRepositories("user-1");

    expect(entries[0]?.private).toBeTrue();
    expect(entries[1]?.private).toBeFalse();
  });

  test("gathers repositories from every organization", async () => {
    const seen: string[] = [];
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("/profile/profiles/me"))
          return page({ id: "member-1" });
        if (url.includes("/_apis/accounts"))
          return page({
            value: [
              { accountId: "1", accountName: "acme" },
              { accountId: "2", accountName: "other" },
            ],
          });

        return page({ value: [repository()] });
      }) as unknown as typeof fetch,
    });

    expect(await client.listRepositories("user-1")).toHaveLength(2);
    // Profile, accounts, then one listing per organization — projects are
    // never enumerated, because one call spans all of them.
    expect(seen).toHaveLength(4);
    expect(seen[2]).toContain("/acme/_apis/git/repositories");
    expect(seen[3]).toContain("/other/_apis/git/repositories");
  });

  test("refuses a name that is not organization/project/repository", () => {
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([repository()]),
    });

    expect(
      client.getRepository("user-1", { fullName: "acme/Web" }),
    ).rejects.toThrow("organization/project/repository");
  });

  test("reports an unauthorized listing as a credential failure", async () => {
    const reports: LinkedProviderCredentialFailureReport[] = [];
    const client = createAzureDevOpsUserClient({
      credentials: resolver(reports),
      fetch: (async () =>
        new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow();
    expect(reports[0]?.code).toBe("unauthorized");
  });

  test("refuses a token for an owner who has not linked Azure DevOps", () => {
    const client = createAzureDevOpsUserClient({
      credentials: resolver(),
      fetch: host([]),
    });

    expect(client.getAccessToken("user-2")).rejects.toBeInstanceOf(
      AzureDevOpsUserCredentialUnavailableError,
    );
  });
});
