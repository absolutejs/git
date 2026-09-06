import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import { GitIngestionError } from "./index";
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

const withAccount = (repository: GitLabRepository): GitLabUserRepository => ({
  ...repository,
  account: {
    id: repository.namespace.id,
    login: repository.namespace.fullPath,
  },
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
  const credentialFor = async (ownerRef: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider: "gitlab",
      ownerRef,
      purpose: "interactive_test",
    });
    if (!credential)
      throw new GitLabUserCredentialUnavailableError(
        "A linked GitLab user credential is unavailable",
      );

    return credential;
  };

  const withToken = async <Result>(
    ownerRef: string,
    operation: (
      accessToken: string,
      credential: ResolvedLinkedProviderCredential,
    ) => Promise<Result>,
  ) => {
    const credential = await credentialFor(ownerRef);
    try {
      const lease = await options.credentials.getAccessToken(credential, {
        minValidityMs: options.minTokenValidityMs ?? 60_000,
      });

      return await operation(lease.accessToken, credential);
    } catch (error) {
      await options.credentials.reportFailure(credential, failureFor(error));
      throw error;
    }
  };

  /** The owner's GitLab access token, refreshed when it is close to expiring.
   *  Cloning a private project needs the raw token as a Basic-auth password
   *  (with `oauth2` as the username), which is not something this client can
   *  do on the caller's behalf the way an API call would be. */
  const getAccessToken = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) => accessToken);

  const listRepositories = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) =>
      (
        await listGitLabProjectsForUser({
          accessToken,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      ).map(withAccount),
    );

  const getRepository = (ownerRef: string, input: { projectId: number }) =>
    withToken(ownerRef, async (accessToken) =>
      withAccount(
        await getGitLabProject({
          accessToken,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          projectId: input.projectId,
        }),
      ),
    );

  return { getAccessToken, getRepository, listRepositories };
};
