/**
 * File-backed secret provider.
 *
 * One file per reference under a root directory, written 0600. It adds no
 * dependency and needs no daemon, which makes it the provider a single-host
 * deployment can use without operating anything else.
 *
 * It is confidential only as far as the filesystem is: anything that can read
 * the root directory can read every secret in it.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { assertValidSecretRef } from "./interface.mjs";

export const DEFAULT_FILE_SECRET_ROOT = join(
  homedir(),
  ".openhands",
  "agent-canvas",
  "secrets",
);

export function createFileSecretProvider({
  root = DEFAULT_FILE_SECRET_ROOT,
} = {}) {
  const rootPath = resolve(root);

  function pathFor(ref) {
    const filePath = resolve(rootPath, assertValidSecretRef(ref));
    // `assertValidSecretRef` already rejects `..`, but an absolute reference
    // would still land outside the root, so the containment check stands on
    // its own rather than on that validation.
    if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
      throw new Error(`secret reference escapes the provider root: ${ref}`);
    }
    return filePath;
  }

  return {
    async get(ref) {
      const filePath = pathFor(ref);
      try {
        return (await readFile(filePath, "utf8")).trim();
      } catch (error) {
        throw new Error(
          `no secret stored at ${ref}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async put(ref, secret) {
      const filePath = pathFor(ref);
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, `${secret}\n`, { mode: 0o600 });
      // `writeFile`'s mode only applies when it creates the file, so an
      // overwrite of a loosely-permissioned file would keep its old mode.
      await chmod(filePath, 0o600);
    },

    async describe() {
      try {
        await mkdir(rootPath, { recursive: true, mode: 0o700 });
        return { name: "file", healthy: true, detail: rootPath };
      } catch (error) {
        return {
          name: "file",
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
