import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const CommitShaSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const HttpsUrlSchema = Type.String({
  maxLength: 2048,
  pattern: "^https://[^\\s]+$",
});
const IsoTimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});

export const GitRepositorySchema = Type.Object({
  cloneUrl: HttpsUrlSchema,
  defaultBranch: Type.Optional(Type.String({ maxLength: 255, minLength: 1 })),
  fullName: Type.String({
    maxLength: 201,
    minLength: 3,
    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
  }),
  provider: Type.Union([
    Type.Literal("github"),
    Type.Literal("gitlab"),
    Type.Literal("bitbucket"),
    Type.Literal("generic"),
  ]),
  webUrl: HttpsUrlSchema,
});

export const GitRevisionSchema = Type.Object({
  commitSha: CommitShaSchema,
  ref: Type.String({ maxLength: 512, minLength: 6, pattern: "^refs/" }),
  repository: GitRepositorySchema,
});

export const GitPushEventSchema = Type.Object({
  after: CommitShaSchema,
  before: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
  deleted: Type.Boolean(),
  deliveryId: Type.String({ maxLength: 255, minLength: 1 }),
  forced: Type.Boolean(),
  pusher: Type.Object({
    email: Type.Optional(
      Type.String({ maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" }),
    ),
    name: Type.String({ maxLength: 255, minLength: 1 }),
  }),
  receivedAt: IsoTimestampSchema,
  revision: GitRevisionSchema,
});

export const GitPullRequestEventSchema = Type.Object({
  action: Type.Union([
    Type.Literal("opened"),
    Type.Literal("reopened"),
    Type.Literal("synchronize"),
    Type.Literal("closed"),
  ]),
  author: Type.Object({
    login: Type.String({ maxLength: 255, minLength: 1 }),
  }),
  base: GitRevisionSchema,
  deliveryId: Type.String({ maxLength: 255, minLength: 1 }),
  draft: Type.Boolean(),
  head: GitRevisionSchema,
  merged: Type.Boolean(),
  number: Type.Integer({ minimum: 1 }),
  receivedAt: IsoTimestampSchema,
  title: Type.String({ maxLength: 512, minLength: 1 }),
  webUrl: HttpsUrlSchema,
});

export const GitProvenanceSchema = Type.Object({
  commitSha: CommitShaSchema,
  deliveryId: Type.String({ maxLength: 255, minLength: 1 }),
  provider: GitRepositorySchema.properties.provider,
  receivedAt: IsoTimestampSchema,
  ref: GitRevisionSchema.properties.ref,
  repository: GitRepositorySchema.properties.fullName,
});

export type GitRepository = Static<typeof GitRepositorySchema>;
export type GitRevision = Static<typeof GitRevisionSchema>;
export type GitPushEvent = Static<typeof GitPushEventSchema>;
export type GitPullRequestEvent = Static<typeof GitPullRequestEventSchema>;
export type GitProvenance = Static<typeof GitProvenanceSchema>;

export class GitIngestionError extends Error {}
export class GitAuthorizationError extends GitIngestionError {}

const decode = <Schema extends Parameters<typeof Value.Decode>[0]>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> => {
  try {
    return Value.Decode(schema, value) as Static<Schema>;
  } catch {
    throw new GitIngestionError(`${label} is invalid`);
  }
};

export const parseGitRepository = (value: unknown): GitRepository =>
  decode(GitRepositorySchema, value, "Git repository");

export const parseGitRevision = (value: unknown): GitRevision =>
  decode(GitRevisionSchema, value, "Git revision");

export const parseGitPushEvent = (value: unknown): GitPushEvent =>
  decode(GitPushEventSchema, value, "Git push event");

export const parseGitPullRequestEvent = (value: unknown): GitPullRequestEvent =>
  decode(GitPullRequestEventSchema, value, "Git pull request event");

export type GitAuthorizationPolicy = {
  allowedRefs?: readonly string[];
  repository: Pick<GitRepository, "fullName" | "provider">;
};

export const assertGitRevisionAuthorized = (
  policy: GitAuthorizationPolicy,
  revision: GitRevision,
) => {
  if (
    policy.repository.provider !== revision.repository.provider ||
    policy.repository.fullName.toLowerCase() !==
      revision.repository.fullName.toLowerCase()
  )
    throw new GitAuthorizationError("Git repository is not authorized");
  if (policy.allowedRefs?.length && !policy.allowedRefs.includes(revision.ref))
    throw new GitAuthorizationError("Git ref is not authorized");

  return revision;
};

export const gitIngestionIdempotencyKey = (
  provider: GitRepository["provider"],
  deliveryId: string,
) => `${provider}:${deliveryId}`;

export const gitProvenanceFor = (event: GitPushEvent): GitProvenance => ({
  commitSha: event.revision.commitSha,
  deliveryId: event.deliveryId,
  provider: event.revision.repository.provider,
  receivedAt: event.receivedAt,
  ref: event.revision.ref,
  repository: event.revision.repository.fullName,
});
