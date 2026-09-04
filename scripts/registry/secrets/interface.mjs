/**
 * Secret providers.
 *
 * A backend's session key never transits enrolment and never reaches a
 * browser: the provisioner writes it to a provider, the node enrols with a
 * reference, and the ingress resolves that reference when proxying.
 *
 * A provider implements:
 *
 *   get(ref)         -> Promise<string>   resolve a reference to a secret
 *   put(ref, secret) -> Promise<void>     store a secret under a reference
 *   describe()       -> Promise<{ name, healthy, detail? }>
 *
 * A reference is an opaque, provider-scoped string such as
 * `openhands/hetzner/session-key`. It is safe to store in the registry and to
 * show in a UI; the secret it points at is not.
 */

import { createFileSecretProvider } from "./file.mjs";
import { createOnePasswordSecretProvider } from "./onepassword.mjs";

const FACTORIES = {
  file: createFileSecretProvider,
  op: createOnePasswordSecretProvider,
};

export const SECRET_PROVIDER_NAMES = Object.freeze(Object.keys(FACTORIES));

/** Rejects a reference that could escape its provider's namespace. */
export function assertValidSecretRef(ref) {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new Error("secret reference must be a non-empty string");
  }
  const trimmed = ref.trim();
  if (trimmed.length > 512) {
    throw new Error("secret reference is too long");
  }
  if (!/^[A-Za-z0-9._~:@+/-]+$/.test(trimmed)) {
    throw new Error(`secret reference has unsupported characters: ${trimmed}`);
  }
  if (
    trimmed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`secret reference must not traverse paths: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Builds a provider by name. An unknown name is fatal rather than a silent
 * fallback: quietly degrading to "no credential" is how a fleet ends up
 * unreachable with nothing in the logs to say why.
 */
export function createSecretProvider(name, options = {}) {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `unknown secret provider "${name}"; known providers: ${SECRET_PROVIDER_NAMES.join(", ")}`,
    );
  }
  return factory(options);
}
