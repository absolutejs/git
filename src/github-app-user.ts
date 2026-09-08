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
  /** Which linked account this was reached through. Not the installation
   *  account above: an installation on an organisation is reachable through
   *  whichever member authorized, and only that account can list it again. */
  linkedAccountId: string;
  /**
   * What the installation this repository came through was granted: every
   * repository on the account, or only the ones somebody chose.
   *
   * Carried onto each repository because listing flattens the installations
   * away, and a caller that wants to say "anything you add later will appear"
   * has nowhere else to learn it from without repeating the installation
   * call.
   */
  repositorySelection: "all" | "selected";
  /** Where the installation this came through is configured on GitHub. */
  installationUrl: string;
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
  const credentialFor = async (ownerRef: string, bindingId?: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider: "github",
      ownerRef,
      purpose: "interactive_test",
      ...(bindingId ? { bindingId } : {}),
    });
    if (!credential)
      throw new GitHubUserCredentialUnavailableError(
        "A linked GitHub user credential is unavailable",
      );

    return credential;
  };

  /**
   * Every GitHub identity this owner has linked, or nothing when the resolver
   * does not keep more than one.
   *
   * A GitHub App installation belongs to an account, and `/user/installations`
   * only ever returns the installations the token's own user can reach. Two
   * personal accounts share none of each other's, so a caller with one
   * credential sees one account's repositories and has no way to know the
   * others exist. Asking for the bindings is how it finds out.
   */
  const githubBindings = async (ownerRef: string) => {
    const bindings = await options.credentials.listBindings({
      connectorProvider: "github",
      ownerRef,
      status: "active",
    });

    return bindings.filter((binding) => binding.connectorProvider === "github");
  };

  const withToken = async <Result>(
    ownerRef: string,
    operation: (
      accessToken: string,
      credential: ResolvedLinkedProviderCredential,
    ) => Promise<Result>,
    bindingId?: string,
  ) => {
    const credential = await credentialFor(ownerRef, bindingId);
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

  const forOneIdentity = (ownerRef: string, bindingId?: string) =>
    withToken(
      ownerRef,
      async (userAccessToken, credential) => {
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
              installationUrl: installation.installationUrl,
              linkedAccountId: credential.externalAccountId,
              repositorySelection: installation.repositorySelection,
            })),
          ),
        );

        return repositories.flat();
      },
      bindingId,
    );

  /**
   * Every repository this owner can reach, across every GitHub identity they
   * have linked.
   *
   * One identity was the old behaviour and is still the fallback, for a
   * resolver that keeps one credential and returns no bindings. With more
   * than one, each is asked separately -- there is no endpoint that spans
   * them, because the question "which installations can you see" is only ever
   * asked of one token.
   *
   * Deduplicated by repository id: two people who have both linked, and who
   * both belong to the same organisation, reach the same installation and
   * would otherwise list its repositories twice. One failing identity does
   * not lose the others, but a failure with no successes at all is raised
   * rather than passed off as an empty account.
   */
  const listRepositories = async (ownerRef: string) => {
    const bindings = await githubBindings(ownerRef);
    if (bindings.length <= 1) return forOneIdentity(ownerRef);
    const settled = await Promise.allSettled(
      bindings.map((binding) => forOneIdentity(ownerRef, binding.id)),
    );
    const reached = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (reached.length === 0) {
      const [first] = settled;
      throw first && first.status === "rejected"
        ? first.reason
        : new GitHubUserCredentialUnavailableError(
            "No linked GitHub identity could be reached",
          );
    }
    const seen = new Map<number, GitHubAppUserRepository>();
    for (const repository of reached.flat())
      if (!seen.has(repository.id)) seen.set(repository.id, repository);

    return [...seen.values()];
  };

  const oneRepository = (
    ownerRef: string,
    input: { installationId: number; repositoryId: number },
    bindingId?: string,
  ) =>
    withToken(
      ownerRef,
      async (userAccessToken) => {
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
          installationUrl: installation.installationUrl,
          repositorySelection: installation.repositorySelection,
        };
      },
      bindingId,
    );

  /**
   * The installation belongs to one account, and only the identities with
   * access to that account can see it -- so with several linked, this is a
   * search for the one that can rather than a lookup through whichever
   * credential happened to resolve first.
   */
  const getRepository = async (
    ownerRef: string,
    input: { installationId: number; repositoryId: number },
  ) => {
    const bindings = await githubBindings(ownerRef);
    if (bindings.length <= 1) return oneRepository(ownerRef, input);
    let failure: unknown;
    for (const binding of bindings)
      try {
        return await oneRepository(ownerRef, input, binding.id);
      } catch (error) {
        failure = error;
      }
    throw failure instanceof Error
      ? failure
      : new GitIngestionError(
          "GitHub repository is not accessible to any linked identity",
        );
  };

  return { getRepository, listRepositories };
};
