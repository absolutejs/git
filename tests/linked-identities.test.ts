import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderBinding,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import { createBitbucketUserClient } from "../src/bitbucket-user";
import { createGiteaUserClient } from "../src/gitea-user";
import { createGitLabUserClient } from "../src/gitlab-user";

/** The repositories out of a listing, for the assertions that only care about
 *  those. The accounts a listing could not reach are checked where that is the
 *  point. */
const listing = async <Repository>(
  client: {
    listRepositories: (
      ownerRef: string,
    ) => Promise<{ repositories: Repository[] }>;
  },
  ownerRef: string,
) => (await client.listRepositories(ownerRef)).repositories;

/**
 * Two accounts linked on one host.
 *
 * Nothing spans them: every listing answers for the one token it was given,
 * so a customer who authorized a personal account and a company's saw only
 * whichever came back first. These cover the four hosts that reach a
 * repository with the customer's own token, where getting the account wrong
 * means cloning with a credential that cannot see it.
 */

const binding = (
  externalAccountId: string,
  connectorProvider: string,
): LinkedProviderBinding => ({
  availableScopes: [],
  connectorProvider,
  createdAt: 1,
  externalAccountId,
  externalAccountType: "user",
  grantId: `grant-${externalAccountId}`,
  id: `binding-${externalAccountId}`,
  status: "active",
  updatedAt: Number(externalAccountId),
});

const credentialFor = (
  externalAccountId: string,
  connectorProvider: string,
): ResolvedLinkedProviderCredential => ({
  authProviderKey: connectorProvider,
  bindingId: `binding-${externalAccountId}`,
  connectorProvider,
  externalAccountId,
  externalAccountType: "user",
  grantId: `grant-${externalAccountId}`,
  ownerRef: "user-1",
  providerFamily: connectorProvider,
  scopes: [],
});

/** Hands each account its own token, so a stub host can tell them apart. */
const twoAccounts = (connectorProvider: string, accounts: string[]) => {
  const asked: string[] = [];

  return {
    asked,
    resolver: {
      getAccessToken: async (credential) => ({
        accessToken: `token-${credential.externalAccountId}`,
        grantedScopes: [],
      }),
      listBindings: async ({ ownerRef }) =>
        ownerRef === "user-1"
          ? accounts.map((id) => binding(id, connectorProvider))
          : [],
      reportFailure: async () => undefined,
      resolveCredential: async ({ externalAccountId, ownerRef }) => {
        if (ownerRef !== "user-1") return null;
        const chosen = externalAccountId ?? accounts[accounts.length - 1];
        if (!chosen || !accounts.includes(chosen)) return null;
        asked.push(chosen);

        return credentialFor(chosen, connectorProvider);
      },
    } satisfies LinkedProviderCredentialResolver,
  };
};

const tokenOf = (init?: RequestInit) =>
  String(new Headers(init?.headers).get("authorization") ?? "").replace(
    "Bearer ",
    "",
  );

describe("listing across every linked account", () => {
  test("GitLab merges both accounts and says which reached each project", async () => {
    const { resolver } = twoAccounts("gitlab", ["42", "43"]);
    const client = createGitLabUserClient({
      credentials: resolver,
      fetch: async (input, init) => {
        const owned = tokenOf(init) === "token-42" ? "ada" : "grace";
        const page = new URL(String(input)).searchParams.get("page");

        return new Response(
          JSON.stringify(
            page === "1"
              ? [
                  {
                    default_branch: "main",
                    http_url_to_repo: `https://gitlab.com/${owned}/app.git`,
                    id: owned === "ada" ? 1 : 2,
                    namespace: { full_path: owned, id: 7 },
                    path_with_namespace: `${owned}/app`,
                    visibility: "private",
                    web_url: `https://gitlab.com/${owned}/app`,
                  },
                ]
              : [],
          ),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const repositories = await listing(client, "user-1");

    expect(
      repositories
        .map((repository) => repository.fullName)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["ada/app", "grace/app"]);
    expect(
      repositories.find((repository) => repository.fullName === "grace/app")
        ?.linkedAccountId,
    ).toBe("43");
  });

  test("Bitbucket asks the account a lookup names, not the newest", async () => {
    const { asked, resolver } = twoAccounts("bitbucket", ["{a}", "{b}"]);
    const client = createBitbucketUserClient({
      credentials: resolver,
      fetch: async (_input, init) => {
        if (tokenOf(init) !== "token-{a}")
          return new Response("no", { status: 404 });

        return new Response(
          JSON.stringify({
            full_name: "ada/app",
            is_private: true,
            links: {
              clone: [
                { href: "https://bitbucket.org/ada/app.git", name: "https" },
              ],
              html: { href: "https://bitbucket.org/ada/app" },
            },
            mainbranch: { name: "main" },
            uuid: "{repo}",
            workspace: { slug: "ada", uuid: "{a}" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const repository = await client.getRepository("user-1", {
      externalAccountId: "{a}",
      fullName: "ada/app",
    });

    expect(repository.linkedAccountId).toBe("{a}");
    expect(asked).toEqual(["{a}"]);
  });

  test("Gitea finds a repository the second account can see", async () => {
    // The whole point of asking them all: a name does not say which account
    // can reach it, and the first one asked is often the wrong one.
    const { resolver } = twoAccounts("gitea", ["11", "12"]);
    const client = createGiteaUserClient({
      baseUrl: "https://git.acme.test",
      credentials: resolver,
      fetch: async (_input, init) => {
        if (tokenOf(init) !== "token-12")
          return new Response("no", { status: 404 });

        return new Response(
          JSON.stringify({
            clone_url: "https://git.acme.test/grace/app.git",
            default_branch: "main",
            full_name: "grace/app",
            html_url: "https://git.acme.test/grace/app",
            id: 5,
            owner: { id: 12, login: "grace" },
            private: true,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(
      (await client.getRepository("user-1", { fullName: "grace/app" }))
        .linkedAccountId,
    ).toBe("12");
  });

  test("one dead account does not hide the other's repositories", async () => {
    const { resolver } = twoAccounts("gitlab", ["42", "43"]);
    const client = createGitLabUserClient({
      credentials: resolver,
      fetch: async (input, init) => {
        if (tokenOf(init) === "token-42")
          return new Response("unauthorized", { status: 401 });
        const page = new URL(String(input)).searchParams.get("page");

        return new Response(
          JSON.stringify(
            page === "1"
              ? [
                  {
                    default_branch: "main",
                    http_url_to_repo: "https://gitlab.com/grace/app.git",
                    id: 2,
                    namespace: { full_path: "grace", id: 7 },
                    path_with_namespace: "grace/app",
                    visibility: "private",
                    web_url: "https://gitlab.com/grace/app",
                  },
                ]
              : [],
          ),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await client.listRepositories("user-1");

    expect(result.repositories.map((r) => r.fullName)).toEqual(["grace/app"]);
    /* Named, not dropped. A list that is quietly short reads as repositories
       that have gone missing, which is the failure this whole shape exists to
       stop being invisible. */
    expect(result.unreachable).toEqual([
      {
        externalAccountId: "42",
        reason: expect.stringContaining("401"),
        username: undefined,
      },
    ]);
  });

  test("raises when no account can be reached at all", async () => {
    const { resolver } = twoAccounts("gitlab", ["42", "43"]);
    const client = createGitLabUserClient({
      credentials: resolver,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow();
  });
});
