import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

/*
 * Every entry point shares one copy of the package's own code. Built without
 * code splitting, each entry point carried its own GitIngestionError, so an
 * error thrown by `@absolutejs/git/github-app` was never `instanceof` the
 * one exported from `@absolutejs/git`. A consumer's error handling missed it
 * and answered GitHub's webhooks with 500s. This reads the built output, as
 * a consumer does; `check:package` builds first.
 */
const dist = path.join(import.meta.dir, "..", "dist");

describe.if(existsSync(path.join(dist, "index.js")))("built entry points", () => {
  test("share one GitIngestionError", async () => {
    const root = await import(path.join(dist, "index.js"));
    const app = await import(path.join(dist, "github-app.js"));
    let thrown: unknown;
    try {
      app.verifyGitHubAppPushWebhook({
        body: "{}",
        headers: new Headers({
          "x-github-delivery": "d",
          "x-github-event": "push",
          "x-hub-signature-256": "sha256=00",
        }),
        secret: "a-secret-long-enough",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(root.GitIngestionError);
  });
});
