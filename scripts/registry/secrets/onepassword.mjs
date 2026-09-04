/**
 * 1Password secret provider, via the installed `op` CLI.
 *
 * A reference maps to an `op://` secret reference. `openhands/hetzner/session-key`
 * becomes `op://<vault>/openhands_hetzner_session-key/password`, so the vault
 * is chosen by configuration rather than encoded in every registry entry.
 *
 * The CLI is spawned with an argument array and never through a shell, so a
 * reference cannot inject a command. `op` must already be signed in; this
 * provider does not prompt.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertValidSecretRef } from "./interface.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_ONEPASSWORD_VAULT = "openhands";
const FIELD = "password";

/** `openhands/hetzner/session-key` -> `op://<vault>/openhands_hetzner_session-key/password` */
export function toOpReference(ref, vault = DEFAULT_ONEPASSWORD_VAULT) {
  const item = assertValidSecretRef(ref).replace(/\//g, "_");
  return `op://${vault}/${item}/${FIELD}`;
}

/**
 * @param {{
 *   vault?: string,
 *   binary?: string,
 *   run?: (file: string, args: string[], options?: object) => Promise<{ stdout: string }>,
 * }} [options]
 */
export function createOnePasswordSecretProvider({
  vault = DEFAULT_ONEPASSWORD_VAULT,
  binary = "op",
  run = execFileAsync,
} = {}) {
  async function op(args) {
    try {
      const { stdout } = await run(binary, args);
      return stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // ENOENT here means the CLI is not installed, which is a configuration
      // problem, not a missing secret. Say which.
      if (error && error.code === "ENOENT") {
        throw new Error(`the "${binary}" CLI is not installed`);
      }
      throw new Error(`${binary} ${args[0]} failed: ${detail}`);
    }
  }

  return {
    async get(ref) {
      const stdout = await op(["read", toOpReference(ref, vault)]);
      return stdout.trim();
    },

    async put(ref, secret) {
      const item = assertValidSecretRef(ref).replace(/\//g, "_");
      // `op item edit` fails when the item does not exist yet, so creation is
      // the fallback rather than the other way round: re-enrolling a host that
      // already has a stored key is the common case.
      try {
        await op([
          "item",
          "edit",
          item,
          `${FIELD}=${secret}`,
          "--vault",
          vault,
        ]);
      } catch {
        await op([
          "item",
          "create",
          "--category",
          "password",
          "--title",
          item,
          "--vault",
          vault,
          `${FIELD}=${secret}`,
        ]);
      }
    },

    async describe() {
      try {
        const stdout = await op(["--version"]);
        return { name: "op", healthy: true, detail: stdout.trim() };
      } catch (error) {
        return {
          name: "op",
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
