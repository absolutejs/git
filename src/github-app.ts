import { createPrivateKey, sign } from "node:crypto";
import {
  GitIngestionError,
  parseGitPullRequestEvent,
  parseGitRepository,
  type GitPullRequestEvent,
  type GitPushEvent,
} from "./index";
import { verifyGitHubPushWebhook, verifyGitHubWebhookEnvelope } from "./github";

const API_VERSION = "2022-11-28";
/* GitHub's listings are paged and its maximum page is 100. Nothing here
   followed the pages, so every one of these calls silently returned the
   first hundred and dropped the rest -- invisible while an installation was
   granted a handful of repositories, and wrong the moment it was granted an
   account with more than a hundred on it. Bounded like the GitLab and Gitea
   clients so a broken cursor cannot loop forever. */
const PER_PAGE = 100;
const MAX_PAGES = 40;
const JWT_LIFETIME_SECONDS = 9 * 60;
const JWT_CLOCK_SKEW_SECONDS = 60;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type HeaderSource = Headers | Record<string, string | undefined>;

export type GitHubAppInstallation = {
  account: { id: number; login: string };
  id: number;
  /**
   * Where this installation is configured on GitHub -- the page that adds
   * repositories to it or widens it to all of them.
   *
   * Taken from the API rather than assembled, because the path differs by
   * account type: a personal installation lives under `/settings`, an
   * organisation's under `/organizations/<login>/settings`, and a caller
   * that guesses gets one of the two wrong.
   *
   * Null when the response omits it. It is a link and nothing more, so an
   * installation that arrives without one is still an installation whose
   * repositories can be listed and deployed -- refusing the whole listing
   * over a missing link would cost the customer every repository on every
   * account to save them one dead anchor.
   */
  installationUrl: string | null;
  /**
   * What this installation has accepted, e.g. `{ contents: "read" }`. An
   * App's new permissions reach an installation only once its owner accepts
   * them, so a caller about to push checks this rather than the App's own
   * settings, and can tell the person who has to accept.
   */
  permissions: Record<string, "read" | "write">;
  repositorySelection: "all" | "selected";
};

/** The permissions a token may carry, never more than the installation has. */
export type GitHubAppTokenPermissions = Partial<
  Record<"checks" | "contents" | "metadata" | "pull_requests", "read" | "write">
>;

export type GitHubAppRepository = {
  cloneUrl: string;
  defaultBranch: string;
  fullName: string;
  id: number;
  private: boolean;
  webUrl: string;
};

export type GitHubAppInstallationToken = {
  expiresAt: string;
  token: string;
};

export class GitHubApiError extends GitIngestionError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export type GitHubCheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out";

export type GitHubCheckRunStatus = "completed" | "in_progress" | "queued";

export type GitHubCheckRunOutput = {
  summary: string;
  text?: string;
  title: string;
};

export type GitHubCheckRun = {
  conclusion: GitHubCheckRunConclusion | null;
  htmlUrl: string;
  id: number;
  status: GitHubCheckRunStatus;
};

const base64url = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");

const integer = (value: unknown, label: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new GitIngestionError(`${label} is invalid`);
  return Number(value);
};

const object = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitIngestionError(`${label} is invalid`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0)
    throw new GitIngestionError(`${label} is invalid`);
  return value;
};

/** For a field the caller only displays: absent is absent, not invalid. */
const optionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const json = async (response: Response, label: string) => {
  if (!response.ok)
    throw new GitHubApiError(
      `${label} failed with GitHub status ${response.status}`,
      response.status,
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GitIngestionError(`${label} returned invalid JSON`);
  }
};

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": API_VERSION,
});

const parsePermissions = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const permissions: Record<string, "read" | "write"> = {};
  for (const [name, level] of Object.entries(value))
    if (level === "read" || level === "write") permissions[name] = level;
  return permissions;
};

const repositoryPath = (fullName: string) => {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  )
    throw new GitIngestionError("GitHub repository full name is invalid");
  return parts.map(encodeURIComponent).join("/");
};

const parseCheckRun = (value: unknown): GitHubCheckRun => {
  const payload = object(value, "GitHub check run");
  const status = string(payload.status, "GitHub check run status");
  if (!["completed", "in_progress", "queued"].includes(status))
    throw new GitIngestionError("GitHub check run status is invalid");
  const conclusion = payload.conclusion;
  const conclusions = [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "success",
    "timed_out",
  ];
  if (conclusion !== null && !conclusions.includes(conclusion as string))
    throw new GitIngestionError("GitHub check run conclusion is invalid");
  return {
    conclusion: conclusion as GitHubCheckRunConclusion | null,
    htmlUrl: string(payload.html_url, "GitHub check run URL"),
    id: integer(payload.id, "GitHub check run id"),
    status: status as GitHubCheckRunStatus,
  };
};

const checkRunBody = (input: {
  conclusion?: GitHubCheckRunConclusion;
  detailsUrl?: string;
  externalId?: string;
  name: string;
  output?: GitHubCheckRunOutput;
  status: GitHubCheckRunStatus;
}) => {
  if (input.status === "completed" && !input.conclusion)
    throw new GitIngestionError(
      "A completed GitHub check run needs a conclusion",
    );
  if (input.status !== "completed" && input.conclusion)
    throw new GitIngestionError(
      "An incomplete GitHub check run cannot have a conclusion",
    );
  return {
    ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    ...(input.externalId ? { external_id: input.externalId } : {}),
    name: input.name,
    ...(input.output ? { output: input.output } : {}),
    status: input.status,
  };
};

export const createGitHubCheckRun = async (options: {
  conclusion?: GitHubCheckRunConclusion;
  detailsUrl?: string;
  externalId?: string;
  fetch?: Fetch;
  headSha: string;
  installationToken: string;
  name: string;
  output?: GitHubCheckRunOutput;
  repositoryFullName: string;
  status: GitHubCheckRunStatus;
}): Promise<GitHubCheckRun> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/check-runs`,
    {
      body: JSON.stringify({
        ...checkRunBody(options),
        head_sha: options.headSha,
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  return parseCheckRun(await json(response, "GitHub check run creation"));
};

export const updateGitHubCheckRun = async (options: {
  checkRunId: number;
  conclusion?: GitHubCheckRunConclusion;
  detailsUrl?: string;
  externalId?: string;
  fetch?: Fetch;
  installationToken: string;
  name: string;
  output?: GitHubCheckRunOutput;
  repositoryFullName: string;
  status: GitHubCheckRunStatus;
}): Promise<GitHubCheckRun> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/check-runs/${integer(options.checkRunId, "GitHub check run id")}`,
    {
      body: JSON.stringify(checkRunBody(options)),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "PATCH",
    },
  );
  return parseCheckRun(await json(response, "GitHub check run update"));
};

/** One check run on a commit, as a deploy gate reads it. */
export type GitHubCommitCheckRun = {
  /** The GitHub App that owns the run (GitHub Actions, a CI service, ...). */
  appId: number | null;
  conclusion: GitHubCheckRunConclusion | null;
  htmlUrl: string | null;
  name: string;
  status: GitHubCheckRunStatus;
};

/** Every check run on a commit, its latest attempt each, across all pages.
 *  Needs an installation token with checks read access. */
export const listGitHubCommitCheckRuns = async (options: {
  fetch?: Fetch;
  headSha: string;
  installationToken: string;
  repositoryFullName: string;
}): Promise<GitHubCommitCheckRun[]> => {
  if (!/^[0-9a-f]{40}$/.test(options.headSha))
    throw new GitIngestionError("GitHub commit sha is invalid");
  const entries = await listPages(
    options.fetch ?? fetch,
    (page) =>
      `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/commits/${options.headSha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`,
    options.installationToken,
    "check_runs",
    "GitHub check run listing",
  );
  return entries.map((value) => {
    const run = parseCheckRun(value);
    const payload = object(value, "GitHub check run");
    const app =
      payload.app && typeof payload.app === "object"
        ? (payload.app as Record<string, unknown>)
        : null;
    return {
      appId:
        app && Number.isSafeInteger(app.id) && Number(app.id) > 0
          ? Number(app.id)
          : null,
      conclusion: run.conclusion,
      htmlUrl: optionalString(payload.html_url),
      name: string(payload.name, "GitHub check run name"),
      status: run.status,
    };
  });
};

/** What a commit's checks say about deploying it:
 *
 *  - `none`: no check run yet (CI may not have started), so keep waiting.
 *  - `pending`: at least one run has not finished.
 *  - `passed`: every run finished as success, neutral or skipped.
 *  - `failed`: every run finished and at least one did not pass.
 *
 *  `ignoreAppIds` leaves out runs a deployer posts itself, which would
 *  otherwise wait on the very deploy they report. A failure is only final
 *  once nothing is still running, since a re-run may still turn it green. */
export type GitHubChecksVerdict =
  | { state: "none" }
  | { state: "pending"; waitingOn: string[] }
  | { state: "passed"; passed: string[] }
  | { failed: string[]; state: "failed" };

const PASSING_CONCLUSIONS = new Set<GitHubCheckRunConclusion>([
  "neutral",
  "skipped",
  "success",
]);

export const gitHubChecksVerdict = (
  runs: readonly GitHubCommitCheckRun[],
  options: { ignoreAppIds?: readonly number[] } = {},
): GitHubChecksVerdict => {
  const ignored = new Set(options.ignoreAppIds ?? []);
  const counted = runs.filter(
    (run) => run.appId === null || !ignored.has(run.appId),
  );
  if (counted.length === 0) return { state: "none" };
  const running = counted.filter((run) => run.status !== "completed");
  if (running.length > 0)
    return { state: "pending", waitingOn: running.map((run) => run.name) };
  const failed = counted.filter(
    (run) => !run.conclusion || !PASSING_CONCLUSIONS.has(run.conclusion),
  );
  if (failed.length > 0)
    return { failed: failed.map((run) => run.name), state: "failed" };
  return { passed: counted.map((run) => run.name), state: "passed" };
};

export const createGitHubAppJwt = (options: {
  appId: string | number;
  now?: () => Date;
  privateKey: string;
}) => {
  const now = Math.floor(
    (options.now ?? (() => new Date()))().getTime() / 1000,
  );
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(
    JSON.stringify({
      exp: now + JWT_LIFETIME_SECONDS,
      iat: now - JWT_CLOCK_SKEW_SECONDS,
      iss: String(options.appId),
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    createPrivateKey(options.privateKey),
  );
  return `${signingInput}.${base64url(signature)}`;
};

export const getGitHubAppInstallation = async (options: {
  appJwt: string;
  fetch?: Fetch;
  installationId: number;
}): Promise<GitHubAppInstallation> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/app/installations/${options.installationId}`,
    { headers: githubHeaders(options.appJwt) },
  );
  const payload = object(
    await json(response, "GitHub installation lookup"),
    "GitHub installation",
  );
  const account = object(payload.account, "GitHub installation account");
  const selection = string(
    payload.repository_selection,
    "GitHub repository selection",
  );
  if (selection !== "all" && selection !== "selected")
    throw new GitIngestionError("GitHub repository selection is invalid");
  return {
    account: {
      id: integer(account.id, "GitHub account id"),
      login: string(account.login, "GitHub account login"),
    },
    id: integer(payload.id, "GitHub installation id"),
    installationUrl: optionalString(payload.html_url),
    permissions: parsePermissions(payload.permissions),
    repositorySelection: selection,
  };
};

export const createGitHubAppInstallationToken = async (options: {
  appJwt: string;
  fetch?: Fetch;
  installationId: number;
  /** Narrows the token to these permissions (least privilege): a write
   *  is asked for only by the call that writes. Omitted, the token carries
   *  everything the installation has accepted. */
  permissions?: GitHubAppTokenPermissions;
  repositoryIds?: readonly number[];
}): Promise<GitHubAppInstallationToken> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      body: JSON.stringify({
        ...(options.permissions ? { permissions: options.permissions } : {}),
        ...(options.repositoryIds
          ? { repository_ids: options.repositoryIds }
          : {}),
      }),
      headers: {
        ...githubHeaders(options.appJwt),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = object(
    await json(response, "GitHub installation token exchange"),
    "GitHub installation token",
  );
  return {
    expiresAt: string(payload.expires_at, "GitHub installation token expiry"),
    token: string(payload.token, "GitHub installation token"),
  };
};

/** Walks a paged GitHub listing whose body is `{ <key>: [...] }`, stopping
 *  on the first short page. */
const listPages = async (
  call: Fetch,
  url: (page: number) => string,
  token: string,
  key: string,
  label: string,
): Promise<unknown[]> => {
  const collected: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await call(url(page), { headers: githubHeaders(token) });
    const payload = object(await json(response, label), label);
    const entries = payload[key];
    if (!Array.isArray(entries))
      throw new GitIngestionError(`${label} is invalid`);
    collected.push(...entries);
    if (entries.length < PER_PAGE) break;
  }

  return collected;
};

export const listGitHubAppRepositories = async (options: {
  fetch?: Fetch;
  installationToken: string;
}): Promise<GitHubAppRepository[]> => {
  const entries = await listPages(
    options.fetch ?? fetch,
    (page) =>
      `https://api.github.com/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
    options.installationToken,
    "repositories",
    "GitHub repository listing",
  );
  return entries.map((value) => {
    const repository = object(value, "GitHub repository");
    return {
      cloneUrl: string(repository.clone_url, "GitHub repository clone URL"),
      defaultBranch: string(repository.default_branch, "GitHub default branch"),
      fullName: string(repository.full_name, "GitHub repository full name"),
      id: integer(repository.id, "GitHub repository id"),
      private: repository.private === true,
      webUrl: string(repository.html_url, "GitHub repository web URL"),
    };
  });
};

/** The account a user access token belongs to.
 *
 *  Which installations a token can see follows from which account authorized
 *  it, so a deployment that stores one token per account has to know which
 *  account that is. GitHub answers this for a GitHub App user token as well as
 *  for an OAuth one. */
export const getGitHubUser = async (options: {
  fetch?: Fetch;
  userAccessToken: string;
}) => {
  const response = await (options.fetch ?? fetch)(
    "https://api.github.com/user",
    {
      headers: githubHeaders(options.userAccessToken),
    },
  );
  const user = object(await json(response, "GitHub user"), "GitHub user");
  const { email, name } = user;
  return {
    // A GitHub account may keep its address private, in which case /user
    // reports null rather than omitting the field.
    email: typeof email === "string" && email.length > 0 ? email : null,
    id: integer(user.id, "GitHub user id"),
    login: string(user.login, "GitHub user login"),
    name: typeof name === "string" && name.length > 0 ? name : null,
  };
};

export const listGitHubAppInstallationsForUser = async (options: {
  fetch?: Fetch;
  userAccessToken: string;
}): Promise<GitHubAppInstallation[]> => {
  const entries = await listPages(
    options.fetch ?? fetch,
    (page) =>
      `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`,
    options.userAccessToken,
    "installations",
    "GitHub user installation listing",
  );
  return entries.map((value) => {
    const installation = object(value, "GitHub installation");
    const account = object(installation.account, "GitHub installation account");
    const selection = string(
      installation.repository_selection,
      "GitHub repository selection",
    );
    if (selection !== "all" && selection !== "selected")
      throw new GitIngestionError("GitHub repository selection is invalid");
    return {
      account: {
        id: integer(account.id, "GitHub account id"),
        login: string(account.login, "GitHub account login"),
      },
      id: integer(installation.id, "GitHub installation id"),
      installationUrl: optionalString(installation.html_url),
      permissions: parsePermissions(installation.permissions),
      repositorySelection: selection,
    };
  });
};

export const listGitHubAppRepositoriesForUser = async (options: {
  fetch?: Fetch;
  installationId: number;
  userAccessToken: string;
}): Promise<GitHubAppRepository[]> => {
  const entries = await listPages(
    options.fetch ?? fetch,
    (page) =>
      `https://api.github.com/user/installations/${options.installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
    options.userAccessToken,
    "repositories",
    "GitHub user repository listing",
  );
  return entries.map((value) => {
    const repository = object(value, "GitHub repository");
    return {
      cloneUrl: string(repository.clone_url, "GitHub repository clone URL"),
      defaultBranch: string(repository.default_branch, "GitHub default branch"),
      fullName: string(repository.full_name, "GitHub repository full name"),
      id: integer(repository.id, "GitHub repository id"),
      private: repository.private === true,
      webUrl: string(repository.html_url, "GitHub repository web URL"),
    };
  });
};

export const verifyGitHubAppPushWebhook = (options: {
  body: string | Uint8Array;
  headers: HeaderSource;
  now?: () => Date;
  secret: string;
}): { event: GitPushEvent; installationId: number; repositoryId: number } => {
  const event = verifyGitHubPushWebhook(options);
  const bytes =
    typeof options.body === "string"
      ? new TextEncoder().encode(options.body)
      : options.body;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GitIngestionError("GitHub webhook body is invalid JSON");
  }
  const payload = object(decoded, "GitHub App push payload");
  const installation = object(payload.installation, "GitHub App installation");
  const repository = object(payload.repository, "GitHub repository");
  return {
    event,
    installationId: integer(installation.id, "GitHub installation id"),
    repositoryId: integer(repository.id, "GitHub repository id"),
  };
};

/** A check suite finished on a commit: the moment a deploy gated on the
 *  commit's checks can look again. Only `completed` is accepted; GitHub sends
 *  it to every App with checks access on the repository, whoever ran the
 *  suite. */
export const verifyGitHubAppCheckSuiteWebhook = (options: {
  body: string | Uint8Array;
  headers: HeaderSource;
  now?: () => Date;
  secret: string;
}): {
  deliveryId: string;
  headSha: string;
  installationId: number;
  receivedAt: string;
  repositoryFullName: string;
  repositoryId: number;
} => {
  const { deliveryId, payload, receivedAt } = verifyGitHubWebhookEnvelope(
    options,
    "check_suite",
  );
  if (string(payload.action, "GitHub check suite action") !== "completed")
    throw new GitIngestionError("GitHub check suite action is unsupported");
  const installation = object(payload.installation, "GitHub App installation");
  const repository = object(payload.repository, "GitHub repository");
  const suite = object(payload.check_suite, "GitHub check suite");
  const headSha = string(
    suite.head_sha,
    "GitHub check suite sha",
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new GitIngestionError("GitHub check suite sha is invalid");
  return {
    deliveryId,
    headSha,
    installationId: integer(installation.id, "GitHub installation id"),
    receivedAt,
    repositoryFullName: string(
      repository.full_name,
      "GitHub repository full name",
    ),
    repositoryId: integer(repository.id, "GitHub repository id"),
  };
};

export const verifyGitHubAppPullRequestWebhook = (options: {
  body: string | Uint8Array;
  headers: HeaderSource;
  now?: () => Date;
  secret: string;
}): {
  event: GitPullRequestEvent;
  installationId: number;
  repositoryId: number;
} => {
  const { deliveryId, payload, receivedAt } = verifyGitHubWebhookEnvelope(
    options,
    "pull_request",
  );
  const action = string(payload.action, "GitHub pull request action");
  if (!["opened", "reopened", "synchronize", "closed"].includes(action))
    throw new GitIngestionError("GitHub pull request action is unsupported");
  const installation = object(payload.installation, "GitHub App installation");
  const repositoryPayload = object(payload.repository, "GitHub repository");
  const pullRequest = object(payload.pull_request, "GitHub pull request");
  const base = object(pullRequest.base, "GitHub pull request base");
  const head = object(pullRequest.head, "GitHub pull request head");
  const baseRepositoryPayload = object(
    base.repo,
    "GitHub pull request base repository",
  );
  const headRepositoryPayload = object(
    head.repo,
    "GitHub pull request head repository",
  );
  const author = object(pullRequest.user, "GitHub pull request author");
  const repositoryFor = (value: Record<string, unknown>) =>
    parseGitRepository({
      cloneUrl: string(value.clone_url, "GitHub repository clone URL"),
      ...(typeof value.default_branch === "string"
        ? { defaultBranch: value.default_branch }
        : {}),
      fullName: string(value.full_name, "GitHub repository full name"),
      provider: "github",
      webUrl: string(value.html_url, "GitHub repository web URL"),
    });
  const revisionFor = (
    value: Record<string, unknown>,
    repository: ReturnType<typeof repositoryFor>,
  ) => ({
    commitSha: string(value.sha, "GitHub pull request revision").toLowerCase(),
    ref: `refs/heads/${string(value.ref, "GitHub pull request ref")}`,
    repository,
  });

  return {
    event: parseGitPullRequestEvent({
      action,
      author: { login: string(author.login, "GitHub pull request author") },
      base: revisionFor(base, repositoryFor(baseRepositoryPayload)),
      deliveryId,
      draft: pullRequest.draft === true,
      head: revisionFor(head, repositoryFor(headRepositoryPayload)),
      merged: pullRequest.merged === true,
      number: integer(payload.number, "GitHub pull request number"),
      receivedAt,
      title: string(pullRequest.title, "GitHub pull request title"),
      webUrl: string(pullRequest.html_url, "GitHub pull request URL"),
    }),
    installationId: integer(installation.id, "GitHub installation id"),
    repositoryId: integer(repositoryPayload.id, "GitHub repository id"),
  };
};

/** A pull request, as Studio's "Send to GitHub" tracks one. */
export type GitHubPullRequest = {
  baseRef: string;
  draft: boolean;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  merged: boolean;
  /** Null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** The commit the merge made on the base branch (a squash, a merge
   *  commit, or a rebase's last commit); null until it is merged. */
  mergeCommitSha: string | null;
  /** GraphQL id, for what only GraphQL can do (marking ready for review). */
  nodeId: string | null;
  number: number;
  state: "closed" | "open";
  title: string;
};

const parsePullRequest = (value: unknown): GitHubPullRequest => {
  const payload = object(value, "GitHub pull request");
  const head = object(payload.head, "GitHub pull request head");
  const base = object(payload.base, "GitHub pull request base");
  const state = string(payload.state, "GitHub pull request state");
  if (state !== "open" && state !== "closed")
    throw new GitIngestionError("GitHub pull request state is invalid");
  return {
    baseRef: string(base.ref, "GitHub pull request base ref"),
    draft: payload.draft === true,
    headRef: string(head.ref, "GitHub pull request head ref"),
    headSha: string(head.sha, "GitHub pull request head SHA"),
    htmlUrl: string(payload.html_url, "GitHub pull request URL"),
    merged: payload.merged === true || typeof payload.merged_at === "string",
    mergeable:
      typeof payload.mergeable === "boolean" ? payload.mergeable : null,
    mergeCommitSha:
      payload.merged === true || typeof payload.merged_at === "string"
        ? optionalString(payload.merge_commit_sha)
        : null,
    nodeId: optionalString(payload.node_id),
    number: integer(payload.number, "GitHub pull request number"),
    state,
    title: typeof payload.title === "string" ? payload.title : "",
  };
};

const branchName = (value: string, label: string) => {
  if (
    value.length === 0 ||
    value.length > 255 ||
    /[\s~^:?*\[\\]|\.\.|@\{|^\/|\/$|\.lock$/.test(value)
  )
    throw new GitIngestionError(`${label} is invalid`);
  return value;
};

/** The open pull request from `head` (a branch in the same repository) into
 *  `base`, if there is one. */
export const findGitHubPullRequest = async (options: {
  base: string;
  fetch?: Fetch;
  head: string;
  installationToken: string;
  repositoryFullName: string;
}): Promise<GitHubPullRequest | null> => {
  const owner = options.repositoryFullName.split("/")[0] ?? "";
  const query = new URLSearchParams({
    base: branchName(options.base, "GitHub pull request base"),
    head: `${owner}:${branchName(options.head, "GitHub pull request head")}`,
    state: "open",
  });
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls?${query}`,
    { headers: githubHeaders(options.installationToken) },
  );
  const payload = await json(response, "GitHub pull request lookup");
  if (!Array.isArray(payload))
    throw new GitIngestionError("GitHub pull request lookup is invalid");
  return payload.length > 0 ? parsePullRequest(payload[0]) : null;
};

export const getGitHubPullRequest = async (options: {
  fetch?: Fetch;
  installationToken: string;
  number: number;
  repositoryFullName: string;
}): Promise<GitHubPullRequest> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls/${integer(options.number, "GitHub pull request number")}`,
    { headers: githubHeaders(options.installationToken) },
  );
  return parsePullRequest(await json(response, "GitHub pull request read"));
};

export const createGitHubPullRequest = async (options: {
  base: string;
  body?: string;
  draft?: boolean;
  fetch?: Fetch;
  head: string;
  installationToken: string;
  repositoryFullName: string;
  title: string;
}): Promise<GitHubPullRequest> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls`,
    {
      body: JSON.stringify({
        base: branchName(options.base, "GitHub pull request base"),
        ...(options.body ? { body: options.body } : {}),
        draft: options.draft === true,
        head: branchName(options.head, "GitHub pull request head"),
        title: string(options.title, "GitHub pull request title"),
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  return parsePullRequest(await json(response, "GitHub pull request creation"));
};

export const updateGitHubPullRequest = async (options: {
  body?: string;
  fetch?: Fetch;
  installationToken: string;
  number: number;
  repositoryFullName: string;
  title?: string;
}): Promise<GitHubPullRequest> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls/${integer(options.number, "GitHub pull request number")}`,
    {
      body: JSON.stringify({
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.title === undefined
          ? {}
          : { title: string(options.title, "GitHub pull request title") }),
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "PATCH",
    },
  );
  return parsePullRequest(await json(response, "GitHub pull request update"));
};

/** Why GitHub refused a merge: its branch protection or required checks
 *  (405), or a head that moved since `sha` was read (409). */
export class GitHubMergeRefusedError extends GitIngestionError {
  constructor(
    message: string,
    readonly status: 405 | 409,
  ) {
    super(message);
  }
}

/**
 * Merges a pull request through GitHub, so the repository's branch protection
 * and required checks decide, never the caller. `sha` is the head the caller
 * reviewed: GitHub refuses the merge if the branch has moved since.
 */
export const mergeGitHubPullRequest = async (options: {
  commitTitle?: string;
  fetch?: Fetch;
  installationToken: string;
  method?: "merge" | "rebase" | "squash";
  number: number;
  repositoryFullName: string;
  sha: string;
}): Promise<{ sha: string }> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls/${integer(options.number, "GitHub pull request number")}/merge`,
    {
      body: JSON.stringify({
        ...(options.commitTitle ? { commit_title: options.commitTitle } : {}),
        merge_method: options.method ?? "squash",
        sha: string(options.sha, "GitHub pull request head SHA"),
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "PUT",
    },
  );
  if (response.status === 405 || response.status === 409) {
    const reason = await response
      .json()
      .then((body) =>
        optionalString(object(body, "GitHub merge refusal").message),
      )
      .catch(() => null);
    throw new GitHubMergeRefusedError(
      reason ?? "GitHub refused the merge",
      response.status,
    );
  }
  const payload = object(
    await json(response, "GitHub pull request merge"),
    "GitHub pull request merge",
  );
  return { sha: string(payload.sha, "GitHub merge commit SHA") };
};

/**
 * Marks a draft pull request ready for review. REST can't change a pull
 * request's draft state; GraphQL's markPullRequestReadyForReview can, with the
 * pull request's node id. A pull request that is already ready stays ready.
 */
export const markGitHubPullRequestReady = async (options: {
  fetch?: Fetch;
  installationToken: string;
  nodeId: string;
}): Promise<{ draft: boolean }> => {
  const response = await (options.fetch ?? fetch)(
    "https://api.github.com/graphql",
    {
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        variables: {
          id: string(options.nodeId, "GitHub pull request node id"),
        },
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = object(
    await json(response, "GitHub ready for review"),
    "GitHub ready for review",
  );
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const [first] = payload.errors;
    const message = optionalString(
      object(first, "GitHub GraphQL error").message,
    );
    throw new GitIngestionError(
      `GitHub refused ready for review: ${message ?? "unknown error"}`,
    );
  }
  const data = object(payload.data, "GitHub ready for review data");
  const mutation = object(
    data.markPullRequestReadyForReview,
    "GitHub ready for review result",
  );
  const pullRequest = object(mutation.pullRequest, "GitHub pull request");

  return { draft: pullRequest.isDraft === true };
};

/** One rule GitHub applies to a branch, from any ruleset that targets it. */
export type GitHubBranchRule = {
  parameters: Record<string, unknown>;
  type: string;
};

/**
 * The rules that apply to `branch`, whether or not the branch exists yet, from
 * every active ruleset (repository and organization) that targets it. Needs
 * only Metadata read. Classic branch protection is not included: GitHub only
 * shows it with Administration read.
 */
export const listGitHubBranchRules = async (options: {
  branch: string;
  fetch?: Fetch;
  installationToken: string;
  repositoryFullName: string;
}): Promise<GitHubBranchRule[]> => {
  const branch = branchName(options.branch, "GitHub branch")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const rules: GitHubBranchRule[] = [];
  const PAGE_SIZE = 100;
  for (let page = 1; ; page += 1) {
    const response = await (options.fetch ?? fetch)(
      `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/rules/branches/${branch}?per_page=${PAGE_SIZE}&page=${page}`,
      { headers: githubHeaders(options.installationToken) },
    );
    const payload = await json(response, "GitHub branch rules");
    if (!Array.isArray(payload))
      throw new GitIngestionError("GitHub branch rules are invalid");
    for (const entry of payload) {
      const rule = object(entry, "GitHub branch rule");
      rules.push({
        parameters:
          rule.parameters &&
          typeof rule.parameters === "object" &&
          !Array.isArray(rule.parameters)
            ? (rule.parameters as Record<string, unknown>)
            : {},
        type: string(rule.type, "GitHub branch rule type"),
      });
    }
    if (payload.length < PAGE_SIZE) return rules;
  }
};

/** How a repository lets pull requests merge. A field GitHub didn't return
 *  (it hides them from tokens without push access) is null: unknown. */
export type GitHubRepositoryMergeSettings = {
  allowMergeCommit: boolean | null;
  allowRebaseMerge: boolean | null;
  allowSquashMerge: boolean | null;
  archived: boolean;
  defaultBranch: string;
};

export const getGitHubRepositoryMergeSettings = async (options: {
  fetch?: Fetch;
  installationToken: string;
  repositoryFullName: string;
}): Promise<GitHubRepositoryMergeSettings> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}`,
    { headers: githubHeaders(options.installationToken) },
  );
  const payload = object(
    await json(response, "GitHub repository read"),
    "GitHub repository",
  );
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  return {
    allowMergeCommit: flag(payload.allow_merge_commit),
    allowRebaseMerge: flag(payload.allow_rebase_merge),
    allowSquashMerge: flag(payload.allow_squash_merge),
    archived: payload.archived === true,
    defaultBranch: string(payload.default_branch, "GitHub default branch"),
  };
};

/** A comment on a pull request, posted by whoever owns the token (the App,
 *  with an installation token). */
export const commentOnGitHubPullRequest = async (options: {
  body: string;
  fetch?: Fetch;
  installationToken: string;
  number: number;
  repositoryFullName: string;
}): Promise<{ id: number }> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/issues/${integer(options.number, "GitHub pull request number")}/comments`,
    {
      body: JSON.stringify({ body: string(options.body, "GitHub comment") }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = object(
    await json(response, "GitHub pull request comment"),
    "GitHub pull request comment",
  );
  return { id: integer(payload.id, "GitHub comment id") };
};

/**
 * A review submitted as the token's own user: a GitHub App user token makes
 * it the person's review, counted by branch protection like any other.
 * GitHub refuses an approval from the pull request's own author (422).
 */
export const reviewGitHubPullRequest = async (options: {
  body?: string;
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  fetch?: Fetch;
  number: number;
  repositoryFullName: string;
  token: string;
}): Promise<{ id: number; state: string }> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${repositoryPath(options.repositoryFullName)}/pulls/${integer(options.number, "GitHub pull request number")}/reviews`,
    {
      body: JSON.stringify({
        ...(options.body ? { body: options.body } : {}),
        event: options.event,
      }),
      headers: {
        ...githubHeaders(options.token),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = object(
    await json(response, "GitHub pull request review"),
    "GitHub pull request review",
  );
  return {
    id: integer(payload.id, "GitHub review id"),
    state: string(payload.state, "GitHub review state"),
  };
};

/** What GitHub still requires before a pull request can merge: its review
 *  decision under branch protection, its merge state, and each check on the
 *  latest commit. Null fields are what GitHub didn't say. */
export type GitHubPullRequestReadiness = {
  checks: Array<{ name: string; state: string }>;
  mergeState: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
};

export const getGitHubPullRequestReadiness = async (options: {
  fetch?: Fetch;
  installationToken: string;
  nodeId: string;
}): Promise<GitHubPullRequestReadiness> => {
  const response = await (options.fetch ?? fetch)(
    "https://api.github.com/graphql",
    {
      body: JSON.stringify({
        query:
          "query($id: ID!) { node(id: $id) { ... on PullRequest { reviewDecision mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } } } } }",
        variables: {
          id: string(options.nodeId, "GitHub pull request node id"),
        },
      }),
      headers: {
        ...githubHeaders(options.installationToken),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = object(
    await json(response, "GitHub pull request readiness"),
    "GitHub pull request readiness",
  );
  const data = object(payload.data, "GitHub pull request readiness data");
  const node = object(data.node, "GitHub pull request");
  const decision = node.reviewDecision;
  const commits = (node.commits as { nodes?: unknown[] } | null)?.nodes ?? [];
  const last = commits[commits.length - 1] as
    | {
        commit?: {
          statusCheckRollup?: { contexts?: { nodes?: unknown[] } } | null;
        };
      }
    | undefined;
  const contexts = last?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = contexts.flatMap((entry) => {
    const context = entry as Record<string, unknown>;
    if (context.__typename === "CheckRun" && typeof context.name === "string")
      return [
        {
          name: context.name,
          state: String(context.conclusion ?? context.status ?? "PENDING"),
        },
      ];
    if (
      context.__typename === "StatusContext" &&
      typeof context.context === "string"
    )
      return [
        { name: context.context, state: String(context.state ?? "PENDING") },
      ];
    return [];
  });
  return {
    checks,
    mergeState: optionalString(node.mergeStateStatus),
    reviewDecision:
      decision === "APPROVED" ||
      decision === "CHANGES_REQUESTED" ||
      decision === "REVIEW_REQUIRED"
        ? decision
        : null,
  };
};
