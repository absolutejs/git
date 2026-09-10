import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  createGiteaUserClient,
  GiteaUserCredentialUnavailableError,
} from "../src/gitea-user";

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

const credential: ResolvedLinkedProviderCredential = {
  authProviderKey: "gitea",
  bindingId: "binding-1",
  connectorProvider: "gitea",
  externalAccountId: "11",
  externalAccountType: "user",
  grantId: "grant-1",
  ownerRef: "user-1",
  providerFamily: "gitea",
  scopes: ["read:repository"],
};

const resolver = (
  reports: LinkedProviderCredentialFailureReport[] = [],
  connectorProvider = "gitea",
) =>
  ({
    getAccessToken: async () => ({
      accessToken: "gta_token",
      grantedScopes: ["read:repository"],
    }),
    listBindings: async () => [],
    reportFailure: async (_credential, report) => {
      reports.push(report);
    },
    resolveCredential: async (request) =>
      request.ownerRef === "user-1" &&
      request.connectorProvider === connectorProvider
        ? { ...credential, connectorProvider }
        : null,
  }) satisfies LinkedProviderCredentialResolver;

const repository = (id: number, name: string, isPrivate: boolean) => ({
  clone_url: `https://git.acme.test/acme/${name}.git`,
  default_branch: "main",
  full_name: `acme/${name}`,
  html_url: `https://git.acme.test/acme/${name}`,
  id,
  owner: { id: 7, login: "acme" },
  private: isPrivate,
});

const page = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const base = { baseUrl: "https://git.acme.test" };

describe("createGiteaUserClient", () => {
  test("lists repositories until a short page ends it", async () => {
    const seen: string[] = [];
    const full = Array.from({ length: 50 }, (_unused, index) =>
      repository(index + 1, `r${index}`, true),
    );
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(),
      fetch: async (input) => {
        const url = String(input);
        seen.push(url);

        return url.includes("page=1")
          ? page(full)
          : page([repository(99, "last", false)]);
      },
    });

    const repositories = await listing(client, "user-1");

    expect(repositories).toHaveLength(51);
    expect(seen).toHaveLength(2);
    expect(repositories.at(-1)?.private).toBeFalse();
    expect(repositories[0]?.account).toEqual({ id: 7, login: "acme" });
  });

  test("stops at the page bound rather than following a lying instance", async () => {
    let calls = 0;
    const full = Array.from({ length: 50 }, (_unused, index) =>
      repository(index + 1, `r${index}`, true),
    );
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(),
      fetch: async () => {
        calls += 1;

        return page(full);
      },
    });

    await listing(client, "user-1");

    expect(calls).toBe(40);
  });

  test("reports an empty repository rather than throwing", async () => {
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(),
      fetch: async () =>
        page([{ ...repository(1, "fresh", true), default_branch: "" }]),
    });

    const [entry] = await listing(client, "user-1");

    expect(entry?.defaultBranch).toBeNull();
  });

  test("pairs the token with the login a clone needs beside it", async () => {
    // Gitea authenticates a clone with the account's own username, so the
    // token alone is not a credential.
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(),
      fetch: async (input) => {
        expect(String(input)).toBe("https://git.acme.test/api/v1/user");

        return page({ id: 11, login: "alex" });
      },
    });

    expect(await client.getCloneCredential("user-1")).toEqual({
      token: "gta_token",
      username: "alex",
    });
  });

  test("files each instance's credential under its own provider", async () => {
    // One deployment may have a company Gitea and Codeberg connected at once.
    const client = createGiteaUserClient({
      ...base,
      connectorProvider: "instance:codeberg",
      credentials: resolver([], "instance:codeberg"),
      fetch: async () => page([]),
    });

    expect(await listing(client, "user-1")).toEqual([]);

    const wrong = createGiteaUserClient({
      ...base,
      connectorProvider: "instance:other",
      credentials: resolver([], "instance:codeberg"),
      fetch: async () => page([]),
    });

    expect(wrong.listRepositories("user-1")).rejects.toBeInstanceOf(
      GiteaUserCredentialUnavailableError,
    );
  });

  test("reports an unauthorized listing as a credential failure", async () => {
    const reports: LinkedProviderCredentialFailureReport[] = [];
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(reports),
      fetch: async () => new Response("nope", { status: 401 }),
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow();
    expect(reports).toEqual([
      {
        code: "unauthorized",
        message: "Gitea repository listing failed with Gitea status 401",
      },
    ]);
  });

  test("fetches one repository by its full name", async () => {
    const client = createGiteaUserClient({
      ...base,
      credentials: resolver(),
      fetch: async (input) => {
        expect(String(input)).toBe(
          "https://git.acme.test/api/v1/repos/acme/one",
        );

        return page(repository(3, "one", true));
      },
    });

    expect(
      (await client.getRepository("user-1", { fullName: "acme/one" })).fullName,
    ).toBe("acme/one");
  });

  test("trims a trailing slash off the instance URL", async () => {
    const seen: string[] = [];
    const client = createGiteaUserClient({
      baseUrl: "https://codeberg.org/",
      credentials: resolver(),
      fetch: async (input) => {
        seen.push(String(input));

        return page([]);
      },
    });

    await listing(client, "user-1");

    expect(seen[0]).toStartWith("https://codeberg.org/api/v1/user/repos");
  });
});
