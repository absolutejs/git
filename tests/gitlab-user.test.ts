import { describe, expect, test } from "bun:test";
import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  createGitLabUserClient,
  GitLabUserCredentialUnavailableError,
} from "../src/gitlab-user";

const credential: ResolvedLinkedProviderCredential = {
  authProviderKey: "gitlab",
  bindingId: "binding-1",
  connectorProvider: "gitlab",
  externalAccountId: "42",
  externalAccountType: "user",
  grantId: "grant-1",
  ownerRef: "user-1",
  providerFamily: "gitlab",
  scopes: ["read_api"],
};

const resolver = (reports: LinkedProviderCredentialFailureReport[] = []) =>
  ({
    getAccessToken: async () => ({
      accessToken: "glpat_token",
      grantedScopes: ["read_api"],
    }),
    listBindings: async () => [],
    reportFailure: async (_credential, report) => {
      reports.push(report);
    },
    resolveCredential: async ({ ownerRef, connectorProvider }) =>
      ownerRef === "user-1" && connectorProvider === "gitlab"
        ? credential
        : null,
  }) satisfies LinkedProviderCredentialResolver;

const project = (id: number, path: string, visibility: string) => ({
  default_branch: "main",
  http_url_to_repo: `https://gitlab.com/${path}.git`,
  id,
  namespace: { full_path: path.split("/")[0], id: 7 },
  path_with_namespace: path,
  visibility,
  web_url: `https://gitlab.com/${path}`,
});

describe("createGitLabUserClient", () => {
  test("lists every page the instance reports", async () => {
    const seen: string[] = [];
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("&page=1&"))
          return new Response(
            JSON.stringify([project(1, "acme/one", "private")]),
            {
              headers: {
                "content-type": "application/json",
                "x-next-page": "2",
              },
            },
          );

        return new Response(
          JSON.stringify([project(2, "acme/two", "public")]),
          {
            headers: { "content-type": "application/json", "x-next-page": "" },
          },
        );
      },
    });

    const repositories = await client.listRepositories("user-1");

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "acme/one",
      "acme/two",
    ]);
    expect(seen).toHaveLength(2);
    // The namespace is surfaced as an account so a picker can group by it
    // without knowing which host the repository came from.
    expect(repositories[0]?.account).toEqual({ id: 7, login: "acme" });
  });

  test("stops even when the instance keeps pointing at the same page", async () => {
    // A server that answers every request with the same `x-next-page` used to
    // spin here: the guard bounded the page number, which never rose.
    let requests = 0;
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async () => {
        requests += 1;

        return new Response(
          JSON.stringify([project(1, "acme/one", "private")]),
          {
            headers: {
              "content-type": "application/json",
              "x-next-page": "2",
            },
          },
        );
      },
    });

    const repositories = await client.listRepositories("user-1");

    expect(requests).toBe(2);
    expect(repositories).toHaveLength(2);
  });

  test("treats internal visibility as private", async () => {
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async () =>
        new Response(JSON.stringify([project(3, "acme/inner", "internal")]), {
          headers: { "content-type": "application/json" },
        }),
    });

    const [repository] = await client.listRepositories("user-1");

    // Internal is not reachable by a clone URL alone, which is the only
    // distinction this flag exists to make.
    expect(repository?.private).toBe(true);
  });

  test("reads a self-managed instance from its own origin", async () => {
    const seen: string[] = [];
    const client = createGitLabUserClient({
      baseUrl: "https://git.example.com/",
      credentials: resolver(),
      fetch: async (input) => {
        seen.push(String(input));

        return new Response(JSON.stringify([]), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.listRepositories("user-1");

    expect(seen[0]?.startsWith("https://git.example.com/api/v4/projects")).toBe(
      true,
    );
  });

  test("reports an unauthorized listing back to the resolver", async () => {
    const reports: LinkedProviderCredentialFailureReport[] = [];
    const client = createGitLabUserClient({
      credentials: resolver(reports),
      fetch: async () => new Response("nope", { status: 401 }),
    });

    await expect(client.listRepositories("user-1")).rejects.toThrow();
    expect(reports[0]?.code).toBe("unauthorized");
  });

  test("refuses to work without a linked credential", async () => {
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async () => new Response("{}"),
    });

    await expect(
      client.listRepositories("someone-else"),
    ).rejects.toBeInstanceOf(GitLabUserCredentialUnavailableError);
  });

  test("fetches one project by id", async () => {
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        expect(String(input)).toContain("/api/v4/projects/9");

        return new Response(JSON.stringify(project(9, "acme/nine", "public")), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const repository = await client.getRepository("user-1", { projectId: 9 });

    expect(repository.fullName).toBe("acme/nine");
    expect(repository.private).toBe(false);
  });

  test("hands back the owner's token for a clone", async () => {
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async () => new Response("{}"),
    });

    expect(await client.getAccessToken("user-1")).toBe("glpat_token");
  });

  test("refuses a token for an owner who has not linked GitLab", () => {
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async () => new Response("{}"),
    });

    expect(client.getAccessToken("user-2")).rejects.toBeInstanceOf(
      GitLabUserCredentialUnavailableError,
    );
  });

  test("fetches one project by its full path", async () => {
    // GitLab takes a URL-encoded path wherever it takes an id, which is what
    // resolves a pasted address without knowing the id first. Nested groups
    // make the encoding load-bearing.
    const client = createGitLabUserClient({
      credentials: resolver(),
      fetch: async (input) => {
        expect(String(input)).toContain("/api/v4/projects/acme%2Fteam%2Fapp");

        return new Response(
          JSON.stringify(project(9, "acme/team/app", "private")),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const repository = await client.getRepository("user-1", {
      projectId: "acme/team/app",
    });

    expect(repository.fullName).toBe("acme/team/app");
  });
});
