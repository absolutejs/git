import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  GiteaApiError,
  getGiteaRepository,
  getGiteaUser,
  listGiteaRepositoriesForUser,
  type GiteaRepository,
} from "./gitea";
import { GitIngestionError } from "./index";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A Gitea repository reached through a customer's own linked account.
 *
 *  `owner` is repeated as `account` so this and the other clients hand back
 *  the same shape: a consumer grouping a picker by account should not have to
 *  know which host it is talking to. */
export type GiteaUserRepository = GiteaRepository & {
  account: { id: number; login: string };
};

export class GiteaUserCredentialUnavailableError extends GitIngestionError {}

const failureFor = (error: unknown): LinkedProviderCredentialFailureReport => {
  if (error instanceof GiteaApiError) {
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

const withAccount = (repository: GiteaRepository): GiteaUserRepository => ({
  ...repository,
  account: { id: repository.owner.id, login: repository.owner.login },
});

/**
 * Gitea, Forgejo and Codeberg through one client.
 *
 * `baseUrl` is required rather than defaulted: every deployment of these
 * lives somewhere else, and a default origin would only ever be wrong.
 *
 * `connectorProvider` is a parameter too, because one deployment may have
 * several of these connected at once — a company's own Gitea and Codeberg,
 * say — and each needs its own credential in the vault.
 */
export const createGiteaUserClient = (options: {
  baseUrl: string;
  /** How this instance's credential is filed. Defaults to `gitea`, which is
   *  right when there is only one. */
  connectorProvider?: string;
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const connectorProvider = options.connectorProvider ?? "gitea";
  const credentialFor = async (ownerRef: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider,
      ownerRef,
      purpose: "interactive_test",
    });
    if (!credential)
      throw new GiteaUserCredentialUnavailableError(
        "A linked Gitea user credential is unavailable",
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

  const rest = {
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /** The owner's access token, refreshed when it is close to expiring. */
  const getAccessToken = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) => accessToken);

  /** The token and the login that has to accompany it: Gitea authenticates a
   *  clone with the account's own username beside the token, so neither half
   *  is enough alone. */
  const getCloneCredential = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) => ({
      token: accessToken,
      username: (await getGiteaUser({ accessToken, ...rest })).login,
    }));

  const listRepositories = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) =>
      (await listGiteaRepositoriesForUser({ accessToken, ...rest })).map(
        withAccount,
      ),
    );

  const getRepository = (ownerRef: string, input: { fullName: string }) =>
    withToken(ownerRef, async (accessToken) =>
      withAccount(
        await getGiteaRepository({
          accessToken,
          fullName: input.fullName,
          ...rest,
        }),
      ),
    );

  return {
    getAccessToken,
    getCloneCredential,
    getRepository,
    listRepositories,
  };
};
