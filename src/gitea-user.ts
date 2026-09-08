import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
} from "@absolutejs/linked-providers";
import {
  GiteaApiError,
  getGiteaRepository,
  getGiteaUser,
  listGiteaRepositoriesForUser,
  type GiteaRepository,
} from "./gitea";
import { GitIngestionError } from "./index";
import { createLinkedIdentities } from "./linked-identities";

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
  /** Which linked account this was reached through. Not the owner above: a
   *  customer may have authorized two accounts on the same instance, and only
   *  the one that can see a repository can clone it. */
  linkedAccountId: string;
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

const withAccount = (
  repository: GiteaRepository,
  linkedAccountId: string,
): GiteaUserRepository => ({
  ...repository,
  account: { id: repository.owner.id, login: repository.owner.login },
  linkedAccountId,
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
  const identities = createLinkedIdentities({
    connectorProvider: options.connectorProvider ?? "gitea",
    credentials: options.credentials,
    failureFor,
    minTokenValidityMs: options.minTokenValidityMs ?? 60_000,
    unavailable: (message) => new GiteaUserCredentialUnavailableError(message),
  });
  const rest = {
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /** The owner's access token, refreshed when it is close to expiring.
   *
   *  Naming an account picks that authorization; without one the most recent
   *  is used, which is all a caller who stored no account can ask for. */
  const getAccessToken = (ownerRef: string, externalAccountId?: string) =>
    identities.withToken(
      ownerRef,
      async (accessToken) => accessToken,
      externalAccountId,
    );

  /** The token and the login that has to accompany it: Gitea authenticates a
   *  clone with the account's own username beside the token, so neither half
   *  is enough alone. */
  const getCloneCredential = (ownerRef: string, externalAccountId?: string) =>
    identities.withToken(
      ownerRef,
      async (accessToken) => ({
        token: accessToken,
        username: (await getGiteaUser({ accessToken, ...rest })).login,
      }),
      externalAccountId,
    );

  const listForOne = (ownerRef: string, externalAccountId?: string) =>
    identities.withToken(
      ownerRef,
      async (accessToken, credential) =>
        (await listGiteaRepositoriesForUser({ accessToken, ...rest })).map(
          (repository) => withAccount(repository, credential.externalAccountId),
        ),
      externalAccountId,
    );

  /** Every repository this owner can reach, across every account they have
   *  linked on this instance. */
  const listRepositories = (ownerRef: string) =>
    identities.across(ownerRef, listForOne, (repository) => repository.id);

  const getForOne = (
    ownerRef: string,
    input: { fullName: string },
    externalAccountId?: string,
  ) =>
    identities.withToken(
      ownerRef,
      async (accessToken, credential) =>
        withAccount(
          await getGiteaRepository({
            accessToken,
            fullName: input.fullName,
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
       *  first that admits to the repository answers. */
      externalAccountId?: string;
      fullName: string;
    },
  ) =>
    input.externalAccountId
      ? getForOne(ownerRef, input, input.externalAccountId)
      : identities.firstAnswering(ownerRef, (ref, accountId) =>
          getForOne(ref, input, accountId),
        );

  return {
    getAccessToken,
    getCloneCredential,
    getRepository,
    listRepositories,
  };
};
