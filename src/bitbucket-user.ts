import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  BitbucketApiError,
  getBitbucketRepository,
  listBitbucketRepositoriesForUser,
  type BitbucketRepository,
} from "./bitbucket";
import { GitIngestionError } from "./index";

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
): BitbucketUserRepository => ({
  ...repository,
  account: {
    id: repository.workspace.uuid,
    login: repository.workspace.slug,
  },
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
  const credentialFor = async (ownerRef: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider: "bitbucket",
      ownerRef,
      purpose: "interactive_test",
    });
    if (!credential)
      throw new BitbucketUserCredentialUnavailableError(
        "A linked Bitbucket user credential is unavailable",
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

  /** The owner's Bitbucket access token, refreshed when it is close to
   *  expiring. Cloning a private repository needs the raw token as a
   *  Basic-auth password, with `x-token-auth` as the username. */
  const getAccessToken = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) => accessToken);

  const listRepositories = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) =>
      (
        await listBitbucketRepositoriesForUser({
          accessToken,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      ).map(withAccount),
    );

  const getRepository = (ownerRef: string, input: { fullName: string }) =>
    withToken(ownerRef, async (accessToken) =>
      withAccount(
        await getBitbucketRepository({
          accessToken,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          fullName: input.fullName,
        }),
      ),
    );

  return { getAccessToken, getRepository, listRepositories };
};
