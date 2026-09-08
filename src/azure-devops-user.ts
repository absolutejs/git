import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
} from "@absolutejs/linked-providers";
import {
  AzureDevOpsApiError,
  getAzureDevOpsRepository,
  listAzureDevOpsRepositoriesForUser,
  type AzureDevOpsRepository,
} from "./azure-devops";
import { GitIngestionError } from "./index";
import { createLinkedIdentities } from "./linked-identities";

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
  /** Which linked account this was reached through. Not the organization
   *  above: a customer may have authorized two Entra accounts, and only the
   *  one that can see a repository can clone it. */
  linkedAccountId: string;
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
  linkedAccountId: string,
): AzureDevOpsUserRepository => ({
  ...repository,
  account: { id: repository.organization, login: repository.organization },
  linkedAccountId,
});

export const createAzureDevOpsUserClient = (options: {
  connectorProvider?: string;
  credentials: LinkedProviderCredentialResolver;
  fetch?: Fetch;
  minTokenValidityMs?: number;
}) => {
  const identities = createLinkedIdentities({
    connectorProvider: options.connectorProvider ?? "azure-devops",
    credentials: options.credentials,
    failureFor,
    /* An Entra access token lives an hour -- short enough that a large clone
     * can outlast one -- so a generous validity window is asked for rather
     * than the usual minute. */
    minTokenValidityMs: options.minTokenValidityMs ?? 300_000,
    unavailable: (message) =>
      new AzureDevOpsUserCredentialUnavailableError(message),
  });
  const rest = options.fetch ? { fetch: options.fetch } : {};

  /** The owner's access token. Azure DevOps takes it as a bearer header for
   *  a clone rather than as a Basic password, which is why callers ask for
   *  the token rather than a username/token pair.
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
        (
          await listAzureDevOpsRepositoriesForUser({ accessToken, ...rest })
        ).map((repository) =>
          withAccount(repository, credential.externalAccountId),
        ),
      externalAccountId,
    );

  /** Every repository this owner can reach, across every Azure DevOps account
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
          await getAzureDevOpsRepository({
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
