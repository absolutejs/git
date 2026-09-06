import { GitIngestionError } from "./index";

const DEFAULT_BASE_URL = "https://api.bitbucket.org";
const PAGE_LENGTH = 100;
// Bitbucket paginates by handing back a whole URL rather than a page number,
// so the stop condition is the absence of `next`. The count of requests is
// bounded because a server that keeps returning the same `next` would
// otherwise loop forever.
const MAX_PAGES = 40;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class BitbucketApiError extends GitIngestionError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A Bitbucket repository, shaped like the GitHub and GitLab ones this
 *  package returns so a consumer can list from any of them without branching
 *  on which host it came from.
 *
 *  `id` is a string here, and only here: Bitbucket identifies a repository by
 *  a braced UUID rather than a number.
 *
 *  `defaultBranch` is null for a repository with no commits yet, which is a
 *  real thing to show rather than an error to throw. */
export type BitbucketRepository = {
  cloneUrl: string;
  defaultBranch: string | null;
  fullName: string;
  id: string;
  private: boolean;
  webUrl: string;
  workspace: { slug: string; uuid: string };
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
    throw new BitbucketApiError(
      `${label} failed with Bitbucket status ${response.status}`,
      response.status,
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GitIngestionError(`${label} returned invalid JSON`);
  }
};

const bitbucketHeaders = (token: string) => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
});

const baseFor = (baseUrl?: string) =>
  (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");

/** Bitbucket writes the authenticated user into the HTTPS clone URL
 *  (`https://someone@bitbucket.org/ws/repo.git`). Userinfo there would fight
 *  the credential the caller supplies — and it pins the URL to whoever
 *  happened to list it — so it is stripped on the way out. */
const cloneUrlFrom = (value: unknown) => {
  const links = object(value, "Bitbucket repository links");
  const clones = links.clone;
  if (!Array.isArray(clones))
    throw new GitIngestionError("Bitbucket clone links are invalid");
  const https = clones
    .map((entry) => object(entry, "Bitbucket clone link"))
    .find((entry) => entry.name === "https");
  if (!https)
    throw new GitIngestionError("Bitbucket repository has no HTTPS clone URL");
  const url = new URL(string(https.href, "Bitbucket clone URL"));
  url.username = "";
  url.password = "";

  return url.toString();
};

const webUrlFrom = (value: unknown) => {
  const links = object(value, "Bitbucket repository links");
  const html = object(links.html, "Bitbucket repository web link");

  return string(html.href, "Bitbucket repository web URL");
};

const toRepository = (value: unknown): BitbucketRepository => {
  const repository = object(value, "Bitbucket repository");
  const workspace = object(repository.workspace, "Bitbucket workspace");
  const branch = repository.mainbranch;

  return {
    cloneUrl: cloneUrlFrom(repository.links),
    defaultBranch:
      branch && typeof branch === "object" && !Array.isArray(branch)
        ? ((branch as Record<string, unknown>).name as string) || null
        : null,
    fullName: string(repository.full_name, "Bitbucket repository name"),
    id: string(repository.uuid, "Bitbucket repository uuid"),
    private: repository.is_private !== false,
    webUrl: webUrlFrom(repository.links),
    workspace: {
      slug: string(workspace.slug, "Bitbucket workspace slug"),
      uuid: string(workspace.uuid, "Bitbucket workspace uuid"),
    },
  };
};

/** Bitbucket's `next` is a whole URL, and the request that follows it carries
 *  the owner's token. A response that pointed somewhere else would hand that
 *  token to another host, so a page is only followed when it stays on the
 *  origin the listing started from. */
const nextPageWithin = (origin: string, payload: Record<string, unknown>) => {
  const next = payload.next;
  if (typeof next !== "string" || next.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    throw new GitIngestionError("Bitbucket pagination URL is invalid");
  }
  if (parsed.origin !== origin)
    throw new GitIngestionError("Bitbucket pagination URL left the API origin");

  return parsed.toString();
};

/** Walk one paged collection to its end, bounded. */
const pagedValues = async (options: {
  accessToken: string;
  call: Fetch;
  label: string;
  origin: string;
  url: string;
}) => {
  const collected: unknown[] = [];
  let url: string | null = options.url;
  for (let request = 0; request < MAX_PAGES && url !== null; request += 1) {
    const response: Response = await options.call(url, {
      headers: bitbucketHeaders(options.accessToken),
    });
    const payload = object(await json(response, options.label), options.label);
    if (!Array.isArray(payload.values))
      throw new GitIngestionError(`${options.label} is invalid`);
    collected.push(...payload.values);
    url = nextPageWithin(options.origin, payload);
  }

  return collected;
};

/** The workspaces the token's owner belongs to.
 *
 *  `/2.0/user/workspaces`, and not one of the three neighbours you will find
 *  recommended: `/2.0/workspaces`, `/2.0/user/permissions/workspaces` and
 *  `/2.0/user/permissions/repositories` were all removed with the
 *  cross-workspace APIs, and answer 404 "There is no API hosted at this URL"
 *  — which reads as a typo rather than a removal. Much of the migration
 *  advice written during the deprecation window names the permissions one.
 *
 *  Needs the `account` scope, which `repository` alone does not imply.
 *
 *  Each entry is an access record wrapping the workspace, so the workspace
 *  itself is one level down. */
export const listBitbucketWorkspacesForUser = async (options: {
  accessToken: string;
  baseUrl?: string;
  fetch?: Fetch;
}): Promise<Array<{ administrator: boolean; slug: string; uuid: string }>> => {
  const base = baseFor(options.baseUrl);

  return (
    await pagedValues({
      accessToken: options.accessToken,
      call: options.fetch ?? fetch,
      label: "Bitbucket workspace listing",
      origin: new URL(base).origin,
      url: `${base}/2.0/user/workspaces?pagelen=${PAGE_LENGTH}`,
    })
  ).map((value) => {
    const access = object(value, "Bitbucket workspace access");
    const workspace = object(access.workspace, "Bitbucket workspace");

    return {
      administrator: access.administrator === true,
      slug: string(workspace.slug, "Bitbucket workspace slug"),
      uuid: string(workspace.uuid, "Bitbucket workspace uuid"),
    };
  });
};

/** Every repository the token's owner can reach, across all their workspaces.
 *
 *  Two calls deep because Bitbucket removed the flat cross-workspace listing
 *  (CHANGE-2770): `/2.0/repositories` now answers 410 whatever you ask it for,
 *  and repositories are only reachable one workspace at a time. The N+1 is
 *  the API's shape, not a missed optimisation. */
export const listBitbucketRepositoriesForUser = async (options: {
  accessToken: string;
  baseUrl?: string;
  fetch?: Fetch;
}): Promise<BitbucketRepository[]> => {
  const base = baseFor(options.baseUrl);
  const { origin } = new URL(base);
  const call = options.fetch ?? fetch;
  const workspaces = await listBitbucketWorkspacesForUser(options);
  const collected: BitbucketRepository[] = [];
  for (const workspace of workspaces)
    collected.push(
      ...(
        await pagedValues({
          accessToken: options.accessToken,
          call,
          label: "Bitbucket repository listing",
          origin,
          url: `${base}/2.0/repositories/${encodeURIComponent(workspace.slug)}?pagelen=${PAGE_LENGTH}&sort=full_name`,
        })
      ).map(toRepository),
    );

  return collected;
};

export const getBitbucketRepository = async (options: {
  accessToken: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** `workspace/repo_slug`. Bitbucket accepts braced UUIDs in either
   *  position too, which is what makes this safe to keep after a rename. */
  fullName: string;
}): Promise<BitbucketRepository> => {
  const base = baseFor(options.baseUrl);
  const path = options.fullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await (options.fetch ?? fetch)(
    `${base}/2.0/repositories/${path}`,
    { headers: bitbucketHeaders(options.accessToken) },
  );

  return toRepository(await json(response, "Bitbucket repository"));
};
