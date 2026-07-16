import { createHmac, timingSafeEqual } from "node:crypto";
import {
  GitIngestionError,
  parseGitPushEvent,
  type GitPushEvent,
} from "./index";

type HeaderSource = Headers | Record<string, string | undefined>;

const header = (headers: HeaderSource, name: string) => {
  if (headers instanceof Headers) return headers.get(name);
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );

  return match?.[1] ?? null;
};

const bodyBytes = (body: string | Uint8Array) =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

const verifySignature = (
  body: Uint8Array,
  signature: string,
  secret: string,
) => {
  if (!signature.startsWith("sha256=")) return false;
  const suppliedHex = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/.test(suppliedHex)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(suppliedHex, "hex");

  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
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

export const verifyGitHubPushWebhook = (options: {
  body: string | Uint8Array;
  headers: HeaderSource;
  now?: () => Date;
  secret: string;
}): GitPushEvent => {
  if (options.secret.length < 16)
    throw new GitIngestionError("GitHub webhook secret is too short");
  const eventName = header(options.headers, "x-github-event");
  if (eventName !== "push")
    throw new GitIngestionError("GitHub webhook is not a push event");
  const deliveryId = header(options.headers, "x-github-delivery");
  if (!deliveryId)
    throw new GitIngestionError("GitHub webhook delivery id is missing");
  const signature = header(options.headers, "x-hub-signature-256");
  const bytes = bodyBytes(options.body);
  if (!signature || !verifySignature(bytes, signature, options.secret))
    throw new GitIngestionError("GitHub webhook signature is invalid");

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GitIngestionError("GitHub webhook body is invalid JSON");
  }
  const payload = object(decoded, "GitHub push payload");
  const repository = object(payload.repository, "GitHub repository");
  const pusher = object(payload.pusher, "GitHub pusher");
  const fullName = string(repository.full_name, "GitHub repository full name");
  const [owner, name, extra] = fullName.split("/");
  if (!owner || !name || extra)
    throw new GitIngestionError("GitHub repository full name is invalid");
  const ref = string(payload.ref, "GitHub push ref");
  const after = string(payload.after, "GitHub push revision").toLowerCase();
  const before = string(payload.before, "GitHub prior revision").toLowerCase();
  const deleted = payload.deleted === true;
  if (deleted)
    throw new GitIngestionError("Deleted GitHub refs cannot be deployed");

  return parseGitPushEvent({
    after,
    before,
    deleted,
    deliveryId,
    forced: payload.forced === true,
    pusher: {
      ...(typeof pusher.email === "string" ? { email: pusher.email } : {}),
      name: string(pusher.name, "GitHub pusher name"),
    },
    receivedAt: (options.now ?? (() => new Date()))().toISOString(),
    revision: {
      commitSha: after,
      ref,
      repository: {
        cloneUrl: `https://github.com/${owner}/${name}.git`,
        ...(typeof repository.default_branch === "string"
          ? { defaultBranch: repository.default_branch }
          : {}),
        fullName,
        provider: "github",
        webUrl: `https://github.com/${owner}/${name}`,
      },
    },
  });
};
