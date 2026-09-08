import { describe, expect, test } from "bun:test";
import { getAzureDevOpsProfile } from "../src/azure-devops";
import { getBitbucketUser } from "../src/bitbucket";
import { getGiteaUser } from "../src/gitea";
import { getGitHubUser } from "../src/github-app";
import { getGitLabUser } from "../src/gitlab";

/** Records the URL each call went to, so a wrong endpoint fails as a wrong
 *  endpoint rather than as a parse error further down. */
const answering = (payload: unknown) => {
  const urls: string[] = [];

  return {
    fetch: async (input: string | URL | Request) => {
      urls.push(String(input));

      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
    urls,
  };
};

describe("identifying the account a source token belongs to", () => {
  test("reads a GitHub account", async () => {
    const stub = answering({
      email: "ada@example.test",
      id: 42,
      login: "ada",
      name: "Ada",
    });

    expect(
      await getGitHubUser({ fetch: stub.fetch, userAccessToken: "ghu_1" }),
    ).toEqual({ email: "ada@example.test", id: 42, login: "ada", name: "Ada" });
    expect(stub.urls).toEqual(["https://api.github.com/user"]);
  });

  test("reports a private GitHub address as absent rather than failing", async () => {
    const stub = answering({ email: null, id: 42, login: "ada", name: null });

    expect(
      await getGitHubUser({ fetch: stub.fetch, userAccessToken: "ghu_1" }),
    ).toMatchObject({ email: null, name: null });
  });

  test("reads a GitLab account from the configured instance", async () => {
    const stub = answering({
      email: "ada@acme.test",
      id: 7,
      name: "Ada",
      username: "ada",
    });

    expect(
      await getGitLabUser({
        accessToken: "glpat",
        baseUrl: "https://gitlab.acme.test/",
        fetch: stub.fetch,
      }),
    ).toEqual({ email: "ada@acme.test", id: 7, name: "Ada", username: "ada" });
    expect(stub.urls).toEqual(["https://gitlab.acme.test/api/v4/user"]);
  });

  test("reads a Bitbucket account by its immutable uuid", async () => {
    const stub = answering({
      display_name: "Ada",
      username: "ada",
      uuid: "{1234}",
    });

    expect(
      await getBitbucketUser({ accessToken: "bb", fetch: stub.fetch }),
    ).toEqual({ displayName: "Ada", username: "ada", uuid: "{1234}" });
    expect(stub.urls).toEqual(["https://api.bitbucket.org/2.0/user"]);
  });

  test("reads a Gitea account", async () => {
    const stub = answering({
      email: "ada@git.acme.test",
      full_name: "Ada",
      id: 11,
      login: "ada",
    });

    expect(
      await getGiteaUser({
        accessToken: "gta",
        baseUrl: "https://git.acme.test",
        fetch: stub.fetch,
      }),
    ).toEqual({
      email: "ada@git.acme.test",
      fullName: "Ada",
      id: 11,
      login: "ada",
    });
  });

  test("reads an Azure DevOps profile", async () => {
    const stub = answering({
      displayName: "Ada",
      emailAddress: "ada@acme.test",
      id: "profile-1",
    });

    expect(
      await getAzureDevOpsProfile({ accessToken: "ado", fetch: stub.fetch }),
    ).toEqual({
      displayName: "Ada",
      emailAddress: "ada@acme.test",
      id: "profile-1",
    });
  });
});
