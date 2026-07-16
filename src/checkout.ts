import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitIngestionError, parseGitRevision, type GitRevision } from "./index";

const DEFAULT_MAX_BYTES = 536_870_912;
const DEFAULT_MAX_FILES = 100_000;
const ERROR_LIMIT = 1_000;

export type GitCheckout = {
  bytes: number;
  dispose: () => Promise<void>;
  files: number;
  revision: GitRevision;
  sourceRoot: string;
};

type RunOptions = {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

type Run = (
  command: readonly string[],
  options: RunOptions,
) => Promise<{ exitCode: number; stderr: string; stdout: string }>;

const defaultRun: Run = async (command, options) => {
  const process = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { ...processEnv(), ...options.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const abort = () => process.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stderr, stdout] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ]);

    return { exitCode, stderr, stdout };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
};

const processEnv = () =>
  Object.fromEntries(
    Object.entries(Bun.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const runGit = async (
  run: Run,
  args: readonly string[],
  options: RunOptions,
) => {
  options.signal?.throwIfAborted();
  const result = await run(["git", ...args], options);
  if (result.exitCode !== 0)
    throw new GitIngestionError(
      `git ${args[0]} failed (${result.exitCode}): ${result.stderr.slice(0, ERROR_LIMIT)}`,
    );

  return result.stdout.trim();
};

const measureCheckout = async (
  root: string,
  limits: { maxBytes: number; maxFiles: number },
) => {
  let bytes = 0;
  let files = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const target = path.join(directory, entry);
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()))
        throw new GitIngestionError("Git checkout contains an unsafe entry");
      if (stats.isDirectory()) await visit(target);
      else {
        files += 1;
        bytes += stats.size;
        if (files > limits.maxFiles || bytes > limits.maxBytes)
          throw new GitIngestionError("Git checkout exceeds source limits");
      }
    }
  };
  await visit(root);

  return { bytes, files };
};

export const createGitCheckout = async (options: {
  credential?: { token: string; username?: string };
  maxBytes?: number;
  maxFiles?: number;
  revision: GitRevision;
  run?: Run;
  signal?: AbortSignal;
  temporaryRoot?: string;
}): Promise<GitCheckout> => {
  const revision = parseGitRevision(options.revision);
  const root = await mkdtemp(
    path.join(options.temporaryRoot ?? tmpdir(), "absolutejs-git-"),
  );
  const run = options.run ?? defaultRun;
  const environment: Record<string, string> = options.credential
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${new URL(revision.repository.cloneUrl).origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${options.credential.username ?? "x-access-token"}:${options.credential.token}`).toString("base64")}`,
        GIT_TERMINAL_PROMPT: "0",
      }
    : { GIT_TERMINAL_PROMPT: "0" };
  try {
    await runGit(run, ["init", "--quiet"], {
      cwd: root,
      env: environment,
      signal: options.signal,
    });
    await runGit(
      run,
      ["remote", "add", "origin", revision.repository.cloneUrl],
      { cwd: root, env: environment, signal: options.signal },
    );
    await runGit(
      run,
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "origin",
        revision.commitSha,
      ],
      { cwd: root, env: environment, signal: options.signal },
    );
    await runGit(run, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      cwd: root,
      env: environment,
      signal: options.signal,
    });
    const resolved = await runGit(run, ["rev-parse", "HEAD"], {
      cwd: root,
      env: environment,
      signal: options.signal,
    });
    if (resolved.toLowerCase() !== revision.commitSha)
      throw new GitIngestionError(
        "Git checkout did not resolve the requested revision",
      );
    await rm(path.join(root, ".git"), { force: true, recursive: true });
    const measured = await measureCheckout(root, {
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    });

    return {
      ...measured,
      dispose: () => rm(root, { force: true, recursive: true }),
      revision,
      sourceRoot: root,
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};
