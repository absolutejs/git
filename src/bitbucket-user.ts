import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
} from "@absolutejs/linked-providers";
import {
  BitbucketApiError,
  getBitbucketRepository,
  listBitbucketRepositoriesForUser,
  type BitbucketRepository,
} from "./bitbucket";
import { GitIngestionError } from "./index";
import { createLinkedIdentities } from "./linked-identities";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A Bitbucket repository reached through a customer's own linked account.
 *
 *  `workspace` is repeated as `account` so this and the GitHub and GitLab
 *  clients hand back the same shape: a consumer grouping a picker by account
 *  should not have to know which host it is talking to. The id is a string
 *  because Bitbucket numbers nothing — it is UUIDs all the way down. */
export type BitbucketUserRepository = BitbucketRepository & {
  account: { id: string; login: string };
  /** Which linked account this was reached through. Not the workspace above:
   *  a customer may have authorized two Bitbucket accounts, and only the one
   *  that can see a repository can clone it. */
  linkedAccountId: string;
};

export class BitbucketUserCredentialUnavailableError extends GitIngestionError {}

const failureFor = (error: unknown): LinkedProviderCredentialFailureReport => {
  if (error instanceof BitbucketApiError) {
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
  repository: BitbucketRepository,
  linkedAccountId: string,
): BitbucketUserRepository => ({
  ...repository,
  account: {
    id: repository.workspace.uuid,
    login: repository.workspace.slug,
  },
  linkedAccountId,
});

export const createBitbucketUserClient = (options: {
  /** Where the API lives. Bitbucket Data Center serves the same shape at
   *  another origin, which is why this is a parameter rather than a
   *  constant. */
  baseUrl?: string;
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const identities = createLinkedIdentities({
    connectorProvider: "bitbucket",
    credentials: options.credentials,
    failureFor,
    minTokenValidityMs: options.minTokenValidityMs ?? 60_000,
    unavailable: (message) =>
      new BitbucketUserCredentialUnavailableError(message),
  });
  const rest = {
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /** The owner's Bitbucket access token, refreshed when it is close to
   *  expiring. Cloning a private repository needs the raw token as a
   *  Basic-auth password, with `x-token-auth` as the username.
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
        (await listBitbucketRepositoriesForUser({ accessToken, ...rest })).map(
          (repository) => withAccount(repository, credential.externalAccountId),
        ),
      externalAccountId,
    );

  /** Every repository this owner can reach, across every Bitbucket account
   *  they have linked. */
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
          await getBitbucketRepository({
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

  return { getAccessToken, getRepository, listRepositories };
};
