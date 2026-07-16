import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createGitCheckout } from "../src/checkout";

describe("exact revision checkout", () => {
  test("uses argument arrays, strips Git metadata, and measures source", async () => {
    const commitSha = "c".repeat(40);
    const commands: string[][] = [];
    const checkout = await createGitCheckout({
      credential: { token: "never-log-this-token" },
      revision: {
        commitSha,
        ref: "refs/heads/main",
        repository: {
          cloneUrl: "https://github.com/absolutejs/example.git",
          fullName: "absolutejs/example",
          provider: "github",
          webUrl: "https://github.com/absolutejs/example",
        },
      },
      run: async (command, options) => {
        commands.push([...command]);
        if (command[1] === "checkout") {
          await mkdir(path.join(options.cwd, ".git"), { recursive: true });
          await writeFile(path.join(options.cwd, "package.json"), "{}");
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: command[1] === "rev-parse" ? commitSha : "",
        };
      },
    });
    try {
      expect(commands).toEqual([
        ["git", "init", "--quiet"],
        [
          "git",
          "remote",
          "add",
          "origin",
          "https://github.com/absolutejs/example.git",
        ],
        [
          "git",
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "origin",
          commitSha,
        ],
        ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
        ["git", "rev-parse", "HEAD"],
      ]);
      expect(checkout.files).toBe(1);
      expect(
        await Bun.file(path.join(checkout.sourceRoot, ".git")).exists(),
      ).toBeFalse();
    } finally {
      await checkout.dispose();
    }
  });
});
