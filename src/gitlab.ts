import { GitIngestionError } from "./index";

const DEFAULT_BASE_URL = "https://gitlab.com";
const PER_PAGE = 100;
// GitLab paginates by header rather than by cursor, so the stop condition
// comes from the server. Bounding the page *number* is not enough: an
// instance that keeps answering with the same `x-next-page` never raises it
// and the loop never ends. The count of requests is what is bounded, and the
// next page has to be strictly ahead of the current one.
const MAX_PAGES = 40;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class GitLabApiError extends GitIngestionError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A GitLab project, shaped like the GitHub repository the rest of this
 *  package returns, so a consumer can list from either without branching on
 *  which host it came from.
 *
 *  `defaultBranch` is nullable because GitLab reports null for a project with
 *  no commits yet, and a repository that exists but has nothing in it is a
 *  real thing to be shown rather than an error to be thrown. */
export type GitLabRepository = {
  cloneUrl: string;
  defaultBranch: string | null;
  fullName: string;
  id: number;
  namespace: { fullPath: string; id: number };
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
    throw new GitLabApiError(
      `${label} failed with GitLab status ${response.status}`,
      response.status,
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GitIngestionError(`${label} returned invalid JSON`);
  }
};

const gitlabHeaders = (token: string) => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
});

const baseFor = (baseUrl?: string) =>
  (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");

const toRepository = (value: unknown): GitLabRepository => {
  const project = object(value, "GitLab project");
  const namespace = object(project.namespace, "GitLab project namespace");

  return {
    cloneUrl: string(project.http_url_to_repo, "GitLab clone URL"),
    defaultBranch:
      typeof project.default_branch === "string" &&
      project.default_branch.length > 0
        ? project.default_branch
        : null,
    fullName: string(project.path_with_namespace, "GitLab project path"),
    id: integer(project.id, "GitLab project id"),
    namespace: {
      fullPath: string(namespace.full_path, "GitLab namespace path"),
      id: integer(namespace.id, "GitLab namespace id"),
    },
    // GitLab has three visibilities and only one of them is open to the
    // world; "internal" is private as far as anyone outside the instance is
    // concerned, which is the distinction that matters when deciding whether
    // a clone URL alone can reach it.
    private: project.visibility !== "public",
    webUrl: string(project.web_url, "GitLab project web URL"),
  };
};

/** Every project the token's owner is a member of, across all their groups. */
export const listGitLabProjectsForUser = async (options: {
  accessToken: string;
  baseUrl?: string;
  fetch?: Fetch;
}): Promise<GitLabRepository[]> => {
  const base = baseFor(options.baseUrl);
  const call = options.fetch ?? fetch;
  const collected: GitLabRepository[] = [];
  let page = 1;
  for (let request = 0; request < MAX_PAGES && page > 0; request += 1) {
    const response = await call(
      `${base}/api/v4/projects?membership=true&per_page=${PER_PAGE}&page=${page}&order_by=path&sort=asc`,
      { headers: gitlabHeaders(options.accessToken) },
    );
    const payload = await json(response, "GitLab project listing");
    if (!Array.isArray(payload))
      throw new GitIngestionError("GitLab project list is invalid");
    collected.push(...payload.map(toRepository));
    const header = response.headers.get("x-next-page");
    const next = header && header.length > 0 ? Number(header) : 0;
    page = Number.isSafeInteger(next) && next > page ? next : 0;
  }

  return collected;
};

export const getGitLabProject = async (options: {
  accessToken: string;
  baseUrl?: string;
  fetch?: Fetch;
  projectId: number;
}): Promise<GitLabRepository> => {
  const base = baseFor(options.baseUrl);
  const response = await (options.fetch ?? fetch)(
    `${base}/api/v4/projects/${options.projectId}`,
    { headers: gitlabHeaders(options.accessToken) },
  );

  return toRepository(await json(response, "GitLab project"));
};
