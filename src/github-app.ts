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
  repositorySelection: "all" | "selected";
};

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

const json = async (response: Response, label: string) => {
  if (!response.ok)
    throw new GitIngestionError(
      `${label} failed with GitHub status ${response.status}`,
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
    repositorySelection: selection,
  };
};

export const createGitHubAppInstallationToken = async (options: {
  appJwt: string;
  fetch?: Fetch;
  installationId: number;
  repositoryIds?: readonly number[];
}): Promise<GitHubAppInstallationToken> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      body: JSON.stringify(
        options.repositoryIds ? { repository_ids: options.repositoryIds } : {},
      ),
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

export const listGitHubAppRepositories = async (options: {
  fetch?: Fetch;
  installationToken: string;
}): Promise<GitHubAppRepository[]> => {
  const response = await (options.fetch ?? fetch)(
    "https://api.github.com/installation/repositories?per_page=100",
    { headers: githubHeaders(options.installationToken) },
  );
  const payload = object(
    await json(response, "GitHub repository listing"),
    "GitHub repository list",
  );
  if (!Array.isArray(payload.repositories))
    throw new GitIngestionError("GitHub repository list is invalid");
  return payload.repositories.map((value) => {
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

export const listGitHubAppInstallationsForUser = async (options: {
  fetch?: Fetch;
  userAccessToken: string;
}): Promise<GitHubAppInstallation[]> => {
  const response = await (options.fetch ?? fetch)(
    "https://api.github.com/user/installations?per_page=100",
    { headers: githubHeaders(options.userAccessToken) },
  );
  const payload = object(
    await json(response, "GitHub user installation listing"),
    "GitHub user installation list",
  );
  if (!Array.isArray(payload.installations))
    throw new GitIngestionError("GitHub user installation list is invalid");
  return payload.installations.map((value) => {
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
      repositorySelection: selection,
    };
  });
};

export const listGitHubAppRepositoriesForUser = async (options: {
  fetch?: Fetch;
  installationId: number;
  userAccessToken: string;
}): Promise<GitHubAppRepository[]> => {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/user/installations/${options.installationId}/repositories?per_page=100`,
    { headers: githubHeaders(options.userAccessToken) },
  );
  const payload = object(
    await json(response, "GitHub user repository listing"),
    "GitHub user repository list",
  );
  if (!Array.isArray(payload.repositories))
    throw new GitIngestionError("GitHub user repository list is invalid");
  return payload.repositories.map((value) => {
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
