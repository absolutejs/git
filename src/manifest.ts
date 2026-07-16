import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

type GitManifestSettings = {
  allowedRefs?: string[];
  provider?: "bitbucket" | "generic" | "github" | "gitlab";
  repository?: string;
};

export const manifest = defineManifest<GitManifestSettings, unknown>()({
  contract: 1,
  identity: {
    accent: "#f97316",
    category: "infrastructure",
    description:
      "Authenticated, provider-neutral Git push ingestion with exact-revision checkout, source limits, idempotency identity, and portable provenance.",
    docsUrl: "https://github.com/absolutejs/git",
    name: "@absolutejs/git",
    tagline:
      "Turn an authenticated Git push into one exact, attributable source tree.",
  },
  settings: Type.Object({
    allowedRefs: Type.Optional(
      Type.Array(Type.String({ pattern: "^refs/" }), {
        title: "Allowed Git refs",
      }),
    ),
    provider: Type.Optional(
      Type.Union(
        [
          Type.Literal("github"),
          Type.Literal("gitlab"),
          Type.Literal("bitbucket"),
          Type.Literal("generic"),
        ],
        { title: "Git provider" },
      ),
    ),
    repository: Type.Optional(
      Type.String({
        pattern: "^[^/]+/[^/]+$",
        title: "Repository",
      }),
    ),
  }),
  wiring: [],
});
