import { GitIngestionError } from "./index";

/* Gitea and its fork Forgejo share this API, and Codeberg is a Forgejo
 * instance — so one client reaches all three. There is no default origin
 * because there is no default instance: unlike the hosted services, every
 * deployment of these lives somewhere else. */
const PAGE_LENGTH = 50;
/* Pages are numbered and the server reports no cursor, so the stop condition
 * is a short page. The request count is bounded anyway, in case an instance
 * keeps answering with full ones. */
const MAX_PAGES = 40;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class GiteaApiError extends GitIngestionError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A Gitea repository, shaped like the others this package returns.
 *
 *  `defaultBranch` is null for a repository with no commits yet, which Gitea
 *  also flags as `empty`. */
export type GiteaRepository = {
  cloneUrl: string;
  defaultBranch: string | null;
  fullName: string;
  id: number;
  owner: { id: number; login: string };
  private: boolean;
  webUrl: string;
};

const integer = (value: unknown, label: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new GitIngestionError(`${label} is invalid`);
  return Number(value);
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
    throw new GiteaApiError(
      `${label} failed with Gitea status ${response.status}`,
      response.status,
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GitIngestionError(`${label} returned invalid JSON`);
  }
};

/* Gitea accepts both `token <value>` and `Bearer <value>`; an OAuth2 access
 * token wants the latter. */
const giteaHeaders = (token: string) => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
});

const trimmed = (baseUrl: string) => baseUrl.replace(/\/+$/u, "");

const toRepository = (value: unknown): GiteaRepository => {
  const repository = object(value, "Gitea repository");
  const owner = object(repository.owner, "Gitea repository owner");
  const branch = repository.default_branch;

  return {
    cloneUrl: string(repository.clone_url, "Gitea clone URL"),
    defaultBranch:
      typeof branch === "string" && branch.length > 0 ? branch : null,
    fullName: string(repository.full_name, "Gitea repository name"),
    id: integer(repository.id, "Gitea repository id"),
    owner: {
      id: integer(owner.id, "Gitea owner id"),
      login: string(owner.login, "Gitea owner login"),
    },
    private: repository.private !== false,
    webUrl: string(repository.html_url, "Gitea repository web URL"),
  };
};

/** The account the token belongs to.
 *
 *  Needed for more than display: Gitea authenticates a clone over HTTPS with
 *  the account's own login beside the token, so a clone cannot be built from
 *  the token alone. */
export const getGiteaUser = async (options: {
  accessToken: string;
  baseUrl: string;
  fetch?: Fetch;
}) => {
  const response = await (options.fetch ?? fetch)(
    `${trimmed(options.baseUrl)}/api/v1/user`,
    { headers: giteaHeaders(options.accessToken) },
  );
  const user = object(await json(response, "Gitea user"), "Gitea user");
  const { email, full_name: fullName } = user;

  return {
    // Both are for showing a person which account this is; an instance can be
    // configured to keep the address off this response.
    email: typeof email === "string" && email.length > 0 ? email : null,
    fullName:
      typeof fullName === "string" && fullName.length > 0 ? fullName : null,
    id: integer(user.id, "Gitea user id"),
    login: string(user.login, "Gitea user login"),
  };
};

/** Every repository the token's owner can reach, their organisations'
 *  included. Unlike Bitbucket this is one call per page and needs no
 *  enumeration of owners first. */
export const listGiteaRepositoriesForUser = async (options: {
  accessToken: string;
  baseUrl: string;
  fetch?: Fetch;
}): Promise<GiteaRepository[]> => {
  const base = trimmed(options.baseUrl);
  const call = options.fetch ?? fetch;
  const collected: GiteaRepository[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await call(
      `${base}/api/v1/user/repos?page=${page}&limit=${PAGE_LENGTH}`,
      { headers: giteaHeaders(options.accessToken) },
    );
    const payload = await json(response, "Gitea repository listing");
    if (!Array.isArray(payload))
      throw new GitIngestionError("Gitea repository list is invalid");
    collected.push(...payload.map(toRepository));
    // A short page is the last one; a full one may or may not be.
    if (payload.length < PAGE_LENGTH) break;
  }

  return collected;
};

export const getGiteaRepository = async (options: {
  accessToken: string;
  baseUrl: string;
  fetch?: Fetch;
  /** `owner/repo`. */
  fullName: string;
}): Promise<GiteaRepository> => {
  const path = options.fullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await (options.fetch ?? fetch)(
    `${trimmed(options.baseUrl)}/api/v1/repos/${path}`,
    { headers: giteaHeaders(options.accessToken) },
  );

  return toRepository(await json(response, "Gitea repository"));
};
