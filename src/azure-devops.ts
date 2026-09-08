import { GitIngestionError } from "./index";

/* Azure DevOps splits what the other hosts keep together: an account is an
 * *organization*, repositories live inside *projects* inside it, and the two
 * halves are served by different origins — identity from vssps, repositories
 * from dev.azure.com. So a repository is named by three segments here,
 * `organization/project/repository`, and reaching one takes two hops.
 *
 * Listing does not need the third: one call returns an organization's
 * repositories across every project in it, so projects are never enumerated.
 */
const IDENTITY_ORIGIN = "https://app.vssps.visualstudio.com";
const RESOURCE_ORIGIN = "https://dev.azure.com";
const API_VERSION = "7.1";
/* Repositories come back for a whole organization at once, so the bound is
 * on organizations rather than pages. */
const MAX_ORGANIZATIONS = 40;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class AzureDevOpsApiError extends GitIngestionError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** An Azure DevOps repository, shaped like the others this package returns.
 *
 *  `id` is a GUID string. `fullName` is `organization/project/repository`,
 *  which is what makes one addressable at all — the same repository name can
 *  exist in every project of every organization. */
export type AzureDevOpsRepository = {
  cloneUrl: string;
  defaultBranch: string | null;
  fullName: string;
  id: string;
  organization: string;
  private: boolean;
  project: string;
  webUrl: string;
};

const object = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitIngestionError(`${label} is invalid`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0)
    throw new GitIngestionError(`${label} is invalid`);
  return value;
};

const json = async (response: Response, label: string) => {
  if (!response.ok)
    throw new AzureDevOpsApiError(
      `${label} failed with Azure DevOps status ${response.status}`,
      response.status,
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GitIngestionError(`${label} returned invalid JSON`);
  }
};

const headersFor = (token: string) => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
});

/** Azure DevOps writes the organization into the clone URL as userinfo
 *  (`https://acme@dev.azure.com/...`), which would fight the credential the
 *  caller supplies — the same trap Bitbucket sets. */
const withoutUserInfo = (raw: string) => {
  const url = new URL(raw);
  url.username = "";
  url.password = "";

  return url.toString();
};

/** The signed-in user, whose id the organization listing is keyed by. */
export const getAzureDevOpsProfile = async (options: {
  accessToken: string;
  fetch?: Fetch;
}) => {
  const response = await (options.fetch ?? fetch)(
    `${IDENTITY_ORIGIN}/_apis/profile/profiles/me?api-version=${API_VERSION}`,
    { headers: headersFor(options.accessToken) },
  );
  const profile = object(
    await json(response, "Azure DevOps profile"),
    "Azure DevOps profile",
  );

  const { displayName, emailAddress } = profile;
  return {
    // What the organization listing is keyed by, and what a stored connection
    // is keyed by. The other two are for showing a person which account this
    // is, and Azure DevOps omits either one on a profile that has none.
    displayName:
      typeof displayName === "string" && displayName.length > 0
        ? displayName
        : null,
    emailAddress:
      typeof emailAddress === "string" && emailAddress.length > 0
        ? emailAddress
        : null,
    id: string(profile.id, "Azure DevOps profile id"),
  };
};

/** The organizations the user belongs to. Served from the identity origin,
 *  not dev.azure.com, and keyed by the profile id rather than by "me". */
export const listAzureDevOpsOrganizations = async (options: {
  accessToken: string;
  fetch?: Fetch;
  memberId: string;
}) => {
  const response = await (options.fetch ?? fetch)(
    `${IDENTITY_ORIGIN}/_apis/accounts?memberId=${encodeURIComponent(options.memberId)}&api-version=${API_VERSION}`,
    { headers: headersFor(options.accessToken) },
  );
  const payload = object(
    await json(response, "Azure DevOps organization listing"),
    "Azure DevOps organization listing",
  );
  if (!Array.isArray(payload.value))
    throw new GitIngestionError("Azure DevOps organization list is invalid");

  return payload.value.map((value) => {
    const account = object(value, "Azure DevOps organization");

    return {
      id: string(account.accountId, "Azure DevOps organization id"),
      name: string(account.accountName, "Azure DevOps organization name"),
    };
  });
};

const toRepository = (
  organization: string,
  value: unknown,
): AzureDevOpsRepository => {
  const repository = object(value, "Azure DevOps repository");
  const project = object(repository.project, "Azure DevOps project");
  const projectName = string(project.name, "Azure DevOps project name");
  const name = string(repository.name, "Azure DevOps repository name");
  const branch = repository.defaultBranch;

  return {
    cloneUrl: withoutUserInfo(
      string(repository.remoteUrl, "Azure DevOps clone URL"),
    ),
    /* Reported as a whole ref (`refs/heads/main`) where every other host
     * reports a bare branch name, and absent entirely for a repository with
     * no commits yet. */
    defaultBranch:
      typeof branch === "string" && branch.startsWith("refs/heads/")
        ? branch.slice("refs/heads/".length)
        : null,
    fullName: `${organization}/${projectName}/${name}`,
    id: string(repository.id, "Azure DevOps repository id"),
    organization,
    /* Azure DevOps projects carry the visibility, not repositories, and a
     * listing does not always include it — so anything not positively public
     * is treated as private, which is the safe direction: it means a
     * credential is used where one may not have been needed. */
    private:
      object(repository.project, "Azure DevOps project").visibility !==
      "public",
    project: projectName,
    /* `webUrl` is not in the default listing response — only `includeAllUrls`
     * asks for it — so it is derived when absent rather than demanded. */
    webUrl:
      typeof repository.webUrl === "string" && repository.webUrl.length > 0
        ? repository.webUrl
        : `${RESOURCE_ORIGIN}/${organization}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(name)}`,
  };
};

/** Every repository in one organization, across all of its projects. */
export const listAzureDevOpsRepositoriesForOrganization = async (options: {
  accessToken: string;
  fetch?: Fetch;
  organization: string;
}) => {
  const response = await (options.fetch ?? fetch)(
    `${RESOURCE_ORIGIN}/${encodeURIComponent(options.organization)}/_apis/git/repositories?includeAllUrls=true&api-version=${API_VERSION}`,
    { headers: headersFor(options.accessToken) },
  );
  const payload = object(
    await json(response, "Azure DevOps repository listing"),
    "Azure DevOps repository listing",
  );
  if (!Array.isArray(payload.value))
    throw new GitIngestionError("Azure DevOps repository list is invalid");

  return payload.value
    .map((value) => toRepository(options.organization, value))
    .filter((repository) => repository.cloneUrl.length > 0);
};

/** Every repository the token's owner can reach: organizations first, then
 *  each organization's repositories. */
export const listAzureDevOpsRepositoriesForUser = async (options: {
  accessToken: string;
  fetch?: Fetch;
}): Promise<AzureDevOpsRepository[]> => {
  const profile = await getAzureDevOpsProfile(options);
  const organizations = (
    await listAzureDevOpsOrganizations({ ...options, memberId: profile.id })
  ).slice(0, MAX_ORGANIZATIONS);
  const collected: AzureDevOpsRepository[] = [];
  for (const organization of organizations)
    collected.push(
      ...(await listAzureDevOpsRepositoriesForOrganization({
        ...options,
        organization: organization.name,
      })),
    );

  return collected;
};

export const getAzureDevOpsRepository = async (options: {
  accessToken: string;
  fetch?: Fetch;
  /** `organization/project/repository`. */
  fullName: string;
}): Promise<AzureDevOpsRepository> => {
  const [organization, project, name, extra] = options.fullName.split("/");
  if (!organization || !project || !name || extra !== undefined)
    throw new GitIngestionError(
      "An Azure DevOps repository is organization/project/repository",
    );
  const response = await (options.fetch ?? fetch)(
    `${RESOURCE_ORIGIN}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(name)}?api-version=${API_VERSION}`,
    { headers: headersFor(options.accessToken) },
  );

  return toRepository(
    organization,
    await json(response, "Azure DevOps repository"),
  );
};
