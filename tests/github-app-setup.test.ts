import { describe, expect, test } from "bun:test";
import {
  getGitHubRepositoryMergeSettings,
  listGitHubBranchRules,
} from "../src/github-app";

const recorder = (responses: Array<{ body: unknown; status?: number }>) => {
  const urls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses.shift() ?? { body: [] };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  };
  return { fetch, urls };
};

describe("listGitHubBranchRules", () => {
  test("reads the rules for a branch that need not exist, slashes kept", async () => {
    const { fetch, urls } = recorder([
      {
        body: [
          { ruleset_id: 1, type: "required_signatures" },
          {
            parameters: { max_file_size: 10 },
            ruleset_id: 2,
            type: "max_file_size",
          },
        ],
      },
    ]);
    const rules = await listGitHubBranchRules({
      branch: "studio/dana-change",
      fetch,
      installationToken: "token",
      repositoryFullName: "absolutejs/app",
    });
    expect(urls[0]).toBe(
      "https://api.github.com/repos/absolutejs/app/rules/branches/studio/dana-change?per_page=100&page=1",
    );
    expect(rules).toEqual([
      { parameters: {}, type: "required_signatures" },
      { parameters: { max_file_size: 10 }, type: "max_file_size" },
    ]);
  });

  test("follows pages until a short one", async () => {
    const full = Array.from({ length: 100 }, () => ({ type: "creation" }));
    const { fetch, urls } = recorder([
      { body: full },
      { body: [{ type: "update" }] },
    ]);
    const rules = await listGitHubBranchRules({
      branch: "main",
      fetch,
      installationToken: "token",
      repositoryFullName: "absolutejs/app",
    });
    expect(rules).toHaveLength(101);
    expect(urls[1]).toContain("page=2");
  });

  test("refuses a branch name git would refuse", async () => {
    await expect(
      listGitHubBranchRules({
        branch: "bad..name",
        fetch: recorder([]).fetch,
        installationToken: "token",
        repositoryFullName: "absolutejs/app",
      }),
    ).rejects.toThrow("GitHub branch is invalid");
  });
});

describe("getGitHubRepositoryMergeSettings", () => {
  test("reads merge methods, unknown when hidden", async () => {
    const { fetch } = recorder([
      {
        body: {
          allow_squash_merge: false,
          archived: false,
          default_branch: "main",
        },
      },
    ]);
    expect(
      await getGitHubRepositoryMergeSettings({
        fetch,
        installationToken: "token",
        repositoryFullName: "absolutejs/app",
      }),
    ).toEqual({
      allowMergeCommit: null,
      allowRebaseMerge: null,
      allowSquashMerge: false,
      archived: false,
      defaultBranch: "main",
      private: null,
    });
  });

  test("says whether the repository is private", async () => {
    const { fetch } = recorder([
      { body: { archived: false, default_branch: "main", private: false } },
      { body: { archived: false, default_branch: "main", private: true } },
    ]);
    const options = {
      fetch,
      installationToken: "token",
      repositoryFullName: "absolutejs/app",
    };
    expect((await getGitHubRepositoryMergeSettings(options)).private).toBe(
      false,
    );
    expect((await getGitHubRepositoryMergeSettings(options)).private).toBe(
      true,
    );
  });
});
