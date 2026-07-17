import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import { GitIngestionError } from "./index";
import {
  GitHubApiError,
  listGitHubAppInstallationsForUser,
  listGitHubAppRepositoriesForUser,
  type GitHubAppRepository,
} from "./github-app";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GitHubAppUserRepository = GitHubAppRepository & {
  account: { id: number; login: string };
  installationId: number;
};

export class GitHubUserCredentialUnavailableError extends GitIngestionError {}

const failureFor = (error: unknown): LinkedProviderCredentialFailureReport => {
  if (error instanceof GitHubApiError) {
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

export const createGitHubAppUserClient = (options: {
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const credentialFor = async (ownerRef: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider: "github",
      ownerRef,
      purpose: "interactive_test",
    });
    if (!credential)
      throw new GitHubUserCredentialUnavailableError(
        "A linked GitHub user credential is unavailable",
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

  const listRepositories = (ownerRef: string) =>
    withToken(ownerRef, async (userAccessToken) => {
      const installations = await listGitHubAppInstallationsForUser({
        ...(options.fetch ? { fetch: options.fetch } : {}),
        userAccessToken,
      });
      const repositories = await Promise.all(
        installations.map(async (installation) =>
          (
            await listGitHubAppRepositoriesForUser({
              ...(options.fetch ? { fetch: options.fetch } : {}),
              installationId: installation.id,
              userAccessToken,
            })
          ).map((repository) => ({
            ...repository,
            account: installation.account,
            installationId: installation.id,
          })),
        ),
      );

      return repositories.flat();
    });

  const getRepository = (
    ownerRef: string,
    input: { installationId: number; repositoryId: number },
  ) =>
    withToken(ownerRef, async (userAccessToken) => {
      const installations = await listGitHubAppInstallationsForUser({
        ...(options.fetch ? { fetch: options.fetch } : {}),
        userAccessToken,
      });
      const installation = installations.find(
        (candidate) => candidate.id === input.installationId,
      );
      if (!installation)
        throw new GitIngestionError(
          "GitHub installation is not accessible to this user",
        );
      const repositories = await listGitHubAppRepositoriesForUser({
        ...(options.fetch ? { fetch: options.fetch } : {}),
        installationId: installation.id,
        userAccessToken,
      });
      const repository = repositories.find(
        (candidate) => candidate.id === input.repositoryId,
      );
      if (!repository)
        throw new GitIngestionError(
          "GitHub repository is not accessible to this installation and user",
        );

      return {
        ...repository,
        account: installation.account,
        installationId: installation.id,
      };
    });

  return { getRepository, listRepositories };
};
