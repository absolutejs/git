/**
 * Every file the `exports` map promises has to exist in `dist`.
 *
 * Adding two entrypoints once changed how `bun build` laid the output out —
 * the JavaScript moved to `dist/src/*.js` while the declarations stayed at
 * `dist/*.d.ts` — and the package published, installed and typechecked
 * cleanly. It failed only at `import`, in the consumer, after the release.
 * A typecheck cannot catch that: it reads the `.d.ts`, which was exactly
 * where it was supposed to be.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as {
  exports: Record<string, Record<string, string> | string>;
  main?: string;
  module?: string;
  types?: string;
};

const targets = new Set<string>();
for (const key of ["main", "module", "types"] as const) {
  const value = manifest[key];
  if (value) targets.add(value);
}
for (const entry of Object.values(manifest.exports)) {
  if (typeof entry === "string") targets.add(entry);
  else for (const value of Object.values(entry)) targets.add(value);
}

const missing: string[] = [];
for (const target of [...targets].sort()) {
  if (!(await Bun.file(path.join(root, target)).exists())) missing.push(target);
}

if (missing.length > 0) {
  const built = await readdir(path.join(root, "dist"), {
    recursive: true,
  }).catch(() => []);
  console.error(
    `package.json promises ${missing.length} file(s) that the build did not produce:\n` +
      missing.map((file) => `  ${file}`).join("\n") +
      `\n\ndist actually contains:\n` +
      built
        .filter((file) => !file.endsWith(".map"))
        .map((file) => `  dist/${file}`)
        .join("\n"),
  );
  process.exit(1);
}

console.log(`All ${targets.size} exported paths exist.`);
