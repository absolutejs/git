import type {
  LinkedProviderCredentialFailureReport,
  LinkedProviderCredentialResolver,
  ResolvedLinkedProviderCredential,
} from "@absolutejs/linked-providers";

/**
 * The accounts one customer has linked on one host, and how to speak as each.
 *
 * A host that grants access per account rather than per person can hold
 * several authorizations for the same customer -- a personal account and a
 * company's, say -- and no endpoint spans them: every listing answers for the
 * one token it was given. So each is asked separately and the answers merged,
 * which is the only way a picker shows everything the customer can reach.
 *
 * Every client here needs the same four things to do that, and had three of
 * them already; the differences between the hosts are in what they are asked,
 * not in how their identities are resolved.
 */

/**
 * A listing, and the accounts it could not include.
 *
 * One account failing is not a reason to show none of the others, and it is
 * also not a reason to say nothing: half a list with no explanation reads as
 * repositories that have gone missing.
 */
export type LinkedListing<Item> = {
  repositories: Item[];
  unreachable: {
    externalAccountId: string;
    reason: string;
    username?: string;
  }[];
};

type Options = {
  connectorProvider: string;
  credentials: LinkedProviderCredentialResolver;
  failureFor: (error: unknown) => LinkedProviderCredentialFailureReport;
  minTokenValidityMs: number;
  /** Names the host in the errors a customer may read, and is what a caller
   *  catches to tell "never connected" apart from "the call failed". */
  unavailable: (message: string) => Error;
};

export const createLinkedIdentities = (options: Options) => {
  const credentialFor = async (
    ownerRef: string,
    externalAccountId?: string,
  ) => {
    const credential = await options.credentials.resolveCredential({
      connectorProvider: options.connectorProvider,
      ownerRef,
      purpose: "interactive_test",
      ...(externalAccountId ? { externalAccountId } : {}),
    });
    if (!credential)
      throw options.unavailable(
        externalAccountId
          ? `The linked ${options.connectorProvider} account ${externalAccountId} is unavailable`
          : `A linked ${options.connectorProvider} user credential is unavailable`,
      );

    return credential;
  };

  const withToken = async <Result>(
    ownerRef: string,
    operation: (
      accessToken: string,
      credential: ResolvedLinkedProviderCredential,
    ) => Promise<Result>,
    externalAccountId?: string,
  ) => {
    const credential = await credentialFor(ownerRef, externalAccountId);
    try {
      const lease = await options.credentials.getAccessToken(credential, {
        minValidityMs: options.minTokenValidityMs,
      });

      return await operation(lease.accessToken, credential);
    } catch (error) {
      await options.credentials.reportFailure(
        credential,
        options.failureFor(error),
      );
      throw error;
    }
  };

  /** Every account this customer has linked on this host, or nothing from a
   *  resolver that keeps one credential and lists no bindings. */
  const accounts = async (ownerRef: string) =>
    (
      await options.credentials.listBindings({
        connectorProvider: options.connectorProvider,
        ownerRef,
        status: "active",
      })
    )
      .filter(
        (binding) => binding.connectorProvider === options.connectorProvider,
      )
      .map((binding) => ({
        externalAccountId: binding.externalAccountId,
        username: binding.username,
      }));

  const unreachable = (settled: PromiseSettledResult<unknown>[]) => {
    const [first] = settled;

    return first && first.status === "rejected"
      ? first.reason
      : options.unavailable(
          `No linked ${options.connectorProvider} account could be reached`,
        );
  };

  /**
   * One listing per account, merged and deduplicated.
   *
   * A single account is the fallback and stays a single call. One account
   * failing does not lose the others -- an expired authorization on one is no
   * reason to show none of the rest -- but a failure with no successes at all
   * is raised rather than passed off as an empty account.
   */
  const across = async <Item>(
    ownerRef: string,
    forOne: (ownerRef: string, externalAccountId?: string) => Promise<Item[]>,
    idOf: (item: Item) => number | string,
  ): Promise<LinkedListing<Item>> => {
    const linked = await accounts(ownerRef);
    if (linked.length <= 1)
      return { repositories: await forOne(ownerRef), unreachable: [] };
    const settled = await Promise.allSettled(
      linked.map(({ externalAccountId }) =>
        forOne(ownerRef, externalAccountId),
      ),
    );
    const reached = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (reached.length === 0) throw unreachable(settled);
    /* Two accounts that both belong to the same organisation reach the same
     * repository, and it should appear once. */
    const seen = new Map<number | string, Item>();
    for (const item of reached.flat())
      if (!seen.has(idOf(item))) seen.set(idOf(item), item);

    return {
      repositories: [...seen.values()],
      /* The accounts that answered with nothing rather than an empty list.
       * Dropping them silently is how somebody ends up looking at half their
       * repositories with the page insisting everything is fine. */
      unreachable: settled.flatMap((result, index) => {
        const account = linked[index];
        if (result.status !== "rejected" || !account) return [];

        return [
          {
            externalAccountId: account.externalAccountId,
            reason:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            username: account.username,
          },
        ];
      }),
    };
  };

  /**
   * The one account that admits to a repository, for a lookup by name.
   *
   * What a caller has is a name -- an address somebody pasted, or the row a
   * project was imported from -- and a name does not say which account can
   * reach it. Asking them all and taking the first answer is what makes the
   * lookup work when the repository belongs to the second account rather than
   * the first.
   */
  const firstAnswering = async <Item>(
    ownerRef: string,
    forOne: (ownerRef: string, externalAccountId?: string) => Promise<Item>,
  ) => {
    const linked = await accounts(ownerRef);
    if (linked.length <= 1) return forOne(ownerRef);
    const settled = await Promise.allSettled(
      linked.map(({ externalAccountId }) =>
        forOne(ownerRef, externalAccountId),
      ),
    );
    const answered = settled.find((result) => result.status === "fulfilled");
    if (answered && answered.status === "fulfilled") return answered.value;
    throw unreachable(settled);
  };

  return { accounts, across, credentialFor, firstAnswering, withToken };
};
