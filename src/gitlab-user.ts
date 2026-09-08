import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
} from "@absolutejs/linked-providers";
import { GitIngestionError } from "./index";
import { createLinkedIdentities } from "./linked-identities";
import {
  getGitLabProject,
  GitLabApiError,
  listGitLabProjectsForUser,
  type GitLabRepository,
} from "./gitlab";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A GitLab project reached through a customer's own linked account.
 *
 *  `namespace` is repeated as `account` so this and the GitHub App client
 *  hand back the same shape: a consumer grouping a picker by account should
 *  not have to know which host it is talking to. */
export type GitLabUserRepository = GitLabRepository & {
  account: { id: number; login: string };
  /** Which linked account this was reached through. Not the namespace above:
   *  a customer may have authorized two GitLab accounts, and only the one
   *  that can see a repository can clone it. */
  linkedAccountId: string;
};

export class GitLabUserCredentialUnavailableError extends GitIngestionError {}

const failureFor = (error: unknown): LinkedProviderCredentialFailureReport => {
  if (error instanceof GitLabApiError) {
    if (error.status === 401)
      return { code: "unauthorized", message: error.message };
    if (error.status === 403)
      return { code: "insufficient_scope", message: error.message };
    if (error.status === 429)
      return { code: "rate_limited", message: error.message };
  }

  return {
    code: "provider_error",
    message: error instanceof Error ? error.message : String(error),
  };
};

const withAccount = (
  repository: GitLabRepository,
  linkedAccountId: string,
): GitLabUserRepository => ({
  ...repository,
  account: {
    id: repository.namespace.id,
    login: repository.namespace.fullPath,
  },
  linkedAccountId,
});

export const createGitLabUserClient = (options: {
  /** Where the instance lives. Defaults to gitlab.com; a self-managed server
   *  is the same API at a different origin, which is most of why this is a
   *  parameter rather than a constant. */
  baseUrl?: string;
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const identities = createLinkedIdentities({
    connectorProvider: "gitlab",
    credentials: options.credentials,
    failureFor,
    minTokenValidityMs: options.minTokenValidityMs ?? 60_000,
    unavailable: (message) => new GitLabUserCredentialUnavailableError(message),
  });
  const rest = {
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /** The owner's GitLab access token, refreshed when it is close to expiring.
   *  Cloning a private project needs the raw token as a Basic-auth password
   *  (with `oauth2` as the username), which is not something this client can
   *  do on the caller's behalf the way an API call would be.
   *
   *  Naming an account picks that authorization; without one the most recent
   *  is used, which is all a caller who stored no account can ask for. */
  const getAccessToken = (ownerRef: string, externalAccountId?: string) =>
    identities.withToken(
      ownerRef,
      async (accessToken) => accessToken,
      externalAccountId,
    );

  const listForOne = (ownerRef: string, externalAccountId?: string) =>
    identities.withToken(
      ownerRef,
      async (accessToken, credential) =>
        (await listGitLabProjectsForUser({ accessToken, ...rest })).map(
          (repository) => withAccount(repository, credential.externalAccountId),
        ),
      externalAccountId,
    );

  /** Every project this owner can reach, across every GitLab account they
   *  have linked. */
  const listRepositories = (ownerRef: string) =>
    identities.across(ownerRef, listForOne, (repository) => repository.id);

  const getForOne = (
    ownerRef: string,
    input: { projectId: number | string },
    externalAccountId?: string,
  ) =>
    identities.withToken(
      ownerRef,
      async (accessToken, credential) =>
        withAccount(
          await getGitLabProject({
            accessToken,
            projectId: input.projectId,
            ...rest,
          }),
          credential.externalAccountId,
        ),
      externalAccountId,
    );

  const getRepository = (
    ownerRef: string,
    input: {
      /** Which linked account to ask. Omitted, every one is asked and the
       *  first that admits to the project answers. */
      externalAccountId?: string;
      projectId: number | string;
    },
  ) =>
    input.externalAccountId
      ? getForOne(ownerRef, input, input.externalAccountId)
      : identities.firstAnswering(ownerRef, (ref, accountId) =>
          getForOne(ref, input, accountId),
        );

  return { getAccessToken, getRepository, listRepositories };
};
