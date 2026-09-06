import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  BitbucketUserCredentialUnavailableError,
  createBitbucketUserClient,
} from "../src/bitbucket-user";

const credential: ResolvedLinkedProviderCredential = {
  authProviderKey: "bitbucket",
  bindingId: "binding-1",
  connectorProvider: "bitbucket",
  externalAccountId: "{aaaa}",
  externalAccountType: "user",
  grantId: "grant-1",
  ownerRef: "user-1",
  providerFamily: "bitbucket",
  scopes: ["repository"],
};

const resolver = (reports: LinkedProviderCredentialFailureReport[] = []) =>
  ({
    getAccessToken: async () => ({
      accessToken: "bb_token",
      grantedScopes: ["repository"],
    }),
    listBindings: async () => [],
    reportFailure: async (_credential, report) => {
      reports.push(report);
    },
    resolveCredential: async ({ ownerRef, connectorProvider }) =>
      ownerRef === "user-1" && connectorProvider === "bitbucket"
        ? credential
        : null,
  }) satisfies LinkedProviderCredentialResolver;

const repository = (slug: string, isPrivate: boolean) => ({
  full_name: `acme/${slug}`,
  is_private: isPrivate,
  links: {
    clone: [
      { href: `git@bitbucket.org:acme/${slug}.git`, name: "ssh" },
      // Bitbucket writes the listing user into the HTTPS href.
      { href: `https://someone@bitbucket.org/acme/${slug}.git`, name: "https" },
    ],
    html: { href: `https://bitbucket.org/acme/${slug}` },
  },
  mainbranch: { name: "main" },
  uuid: `{${slug}-uuid}`,
  workspace: { slug: "acme", uuid: "{acme-uuid}" },
});

const page = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** Bitbucket removed the flat cross-workspace listing, so every listing is
 *  now workspaces first and repositories per workspace. */
const workspaces = (...slugs: string[]) =>
  page({ values: slugs.map((slug) => ({ slug, uuid: `{${slug}-uuid}` })) });

describe("createBitbucketUserClient", () => {
  test("follows the cursor to the end and strips the clone URL's user", async () => {
    const seen: string[] = [];
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("/2.0/workspaces")) return workspaces("acme");
        if (url.includes("page=2"))
          return page({ values: [repository("two", false)] });

        return page({
          next: "https://api.bitbucket.org/2.0/repositories/acme?page=2",
          values: [repository("one", true)],
        });
      },
    });

    const repositories = await client.listRepositories("user-1");

    expect(repositories.map((entry) => entry.fullName)).toEqual([
      "acme/one",
      "acme/two",
    ]);
    // Userinfo in the href would fight the credential the caller supplies.
    expect(repositories[0]?.cloneUrl).toBe(
      "https://bitbucket.org/acme/one.git",
    );
    expect(repositories[0]?.private).toBeTrue();
    expect(repositories[1]?.private).toBeFalse();
    expect(repositories[0]?.account).toEqual({
      id: "{acme-uuid}",
      login: "acme",
    });
    // Workspaces, then two pages of that workspace's repositories.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain("/2.0/workspaces");
    expect(seen[1]).toContain("/2.0/repositories/acme");
  });

  test("refuses to carry the token to another origin", async () => {
    // `next` is a whole URL, so a response that pointed elsewhere would hand
    // the owner's token to that host.
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) =>
        String(input).includes("/2.0/workspaces")
          ? workspaces("acme")
          : page({
              next: "https://attacker.example/2.0/repositories/acme?page=2",
              values: [repository("one", true)],
            }),
    });

    expect(client.listRepositories("user-1")).rejects.toThrow(
      "left the API origin",
    );
  });

  test("stops rather than looping on a repeated cursor", async () => {
    let calls = 0;
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        if (String(input).includes("/2.0/workspaces"))
          return workspaces("acme");
        calls += 1;

        return page({
          next: "https://api.bitbucket.org/2.0/repositories/acme?page=2",
          values: [repository("one", true)],
        });
      },
    });

    await client.listRepositories("user-1");

    expect(calls).toBe(40);
  });

  test("reports an empty repository rather than throwing", async () => {
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) =>
        String(input).includes("/2.0/workspaces")
          ? workspaces("acme")
          : page({
              values: [{ ...repository("fresh", true), mainbranch: null }],
            }),
    });

    const [entry] = await client.listRepositories("user-1");

    expect(entry?.defaultBranch).toBeNull();
  });

  test("reports an unauthorized listing as a credential failure", async () => {
    const reports: LinkedProviderCredentialFailureReport[] = [];
    const client = createBitbucketUserClient({
      credentials: resolver(reports),
      fetch: async () => new Response("nope", { status: 401 }),
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow();
    expect(reports).toEqual([
      {
        code: "unauthorized",
        message: "Bitbucket workspace listing failed with Bitbucket status 401",
      },
    ]);
  });

  test("fetches one repository by its full name", async () => {
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        expect(String(input)).toContain("/2.0/repositories/acme/one");

        return page(repository("one", true));
      },
    });

    const entry = await client.getRepository("user-1", {
      fullName: "acme/one",
    });

    expect(entry.fullName).toBe("acme/one");
    expect(entry.id).toBe("{one-uuid}");
  });

  test("hands back the owner's token for a clone", async () => {
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async () => page({}),
    });

    expect(await client.getAccessToken("user-1")).toBe("bb_token");
  });

  test("refuses a token for an owner who has not linked Bitbucket", () => {
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async () => page({}),
    });

    expect(client.getAccessToken("user-2")).rejects.toBeInstanceOf(
      BitbucketUserCredentialUnavailableError,
    );
  });

  test("reaches a Data Center instance at another origin", async () => {
    const seen: string[] = [];
    const client = createBitbucketUserClient({
      baseUrl: "https://bitbucket.internal.example/",
      credentials: resolver(),
      fetch: async (input) => {
        seen.push(String(input));

        return String(input).includes("/2.0/workspaces")
          ? workspaces("acme")
          : page({ values: [] });
      },
    });

    await client.listRepositories("user-1");

    expect(seen[0]).toStartWith(
      "https://bitbucket.internal.example/2.0/workspaces",
    );
    expect(seen[1]).toStartWith(
      "https://bitbucket.internal.example/2.0/repositories/acme",
    );
  });

  test("gathers repositories from every workspace, not just the first", async () => {
    // The flat cross-workspace listing was removed (CHANGE-2770), so missing
    // this loop would silently show only one of someone's workspaces.
    const client = createBitbucketUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/2.0/workspaces")) return workspaces("acme", "other");
        if (url.includes("/2.0/repositories/other"))
          return page({ values: [repository("three", true)] });

        return page({ values: [repository("one", true)] });
      },
    });

    const repositories = await client.listRepositories("user-1");

    expect(repositories.map((entry) => entry.fullName)).toEqual([
      "acme/one",
      "acme/three",
    ]);
  });
});
