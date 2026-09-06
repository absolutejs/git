import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";
import {
  AzureDevOpsApiError,
  getAzureDevOpsRepository,
  listAzureDevOpsRepositoriesForUser,
  type AzureDevOpsRepository,
} from "./azure-devops";
import { GitIngestionError } from "./index";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** An Azure DevOps repository reached through a customer's own linked
 *  account.
 *
 *  `account` is the organization, so a picker can group by it the way it
 *  groups the other hosts by owner. The project is not the account: several
 *  projects share one organization, and it is already in `fullName`. */
export type AzureDevOpsUserRepository = AzureDevOpsRepository & {
  account: { id: string; login: string };
};

export class AzureDevOpsUserCredentialUnavailableError extends GitIngestionError {}

const failureFor = (error: unknown): LinkedProviderCredentialFailureReport => {
  if (error instanceof AzureDevOpsApiError) {
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
  repository: AzureDevOpsRepository,
): AzureDevOpsUserRepository => ({
  ...repository,
  account: { id: repository.organization, login: repository.organization },
});

export const createAzureDevOpsUserClient = (options: {
  connectorProvider?: string;
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const connectorProvider = options.connectorProvider ?? "azure-devops";
  const credentialFor = async (ownerRef: string) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider,
      ownerRef,
      purpose: "interactive_test",
    });
    if (!credential)
      throw new AzureDevOpsUserCredentialUnavailableError(
        "A linked Azure DevOps user credential is unavailable",
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
      /* An Entra access token lives an hour — short enough that a large
       * clone can outlast one — so a generous validity window is asked for
       * rather than the usual minute. */
      const lease = await options.credentials.getAccessToken(credential, {
        minValidityMs: options.minTokenValidityMs ?? 300_000,
      });

      return await operation(lease.accessToken, credential);
    } catch (error) {
      await options.credentials.reportFailure(credential, failureFor(error));
      throw error;
    }
  };

  const rest = options.fetch ? { fetch: options.fetch } : {};

  /** The owner's access token. Azure DevOps takes it as a bearer header for
   *  a clone rather than as a Basic password, which is why callers ask for
   *  the token rather than a username/token pair. */
  const getAccessToken = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) => accessToken);

  const listRepositories = (ownerRef: string) =>
    withToken(ownerRef, async (accessToken) =>
      (await listAzureDevOpsRepositoriesForUser({ accessToken, ...rest })).map(
        withAccount,
      ),
    );

  const getRepository = (ownerRef: string, input: { fullName: string }) =>
    withToken(ownerRef, async (accessToken) =>
      withAccount(
        await getAzureDevOpsRepository({
          accessToken,
          fullName: input.fullName,
          ...rest,
        }),
      ),
    );

  return { getAccessToken, getRepository, listRepositories };
};
