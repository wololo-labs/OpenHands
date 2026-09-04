import { buildHttpBaseUrl } from "#/utils/websocket-url";
import { getAgentServerWorkingDir } from "./agent-server-config";
import { getEffectiveLocalBackend } from "./backend-registry/active-store";
import type { Backend } from "./backend-registry/types";

export interface AgentServerClientOverrides {
  host?: string;
  apiKey?: string | null;
  sessionApiKey?: string | null;
  workingDir?: string;
  conversationUrl?: string | null;
  timeout?: number;
}

export interface AgentServerClientOptions {
  host: string;
  apiKey?: string;
  workingDir: string;
  timeout?: number;
}

export class NoBackendAvailableError extends Error {
  constructor() {
    super("No backend is configured.");
    this.name = "NoBackendAvailableError";
  }
}

export const isNoBackendAvailableError = (
  error: unknown,
): error is NoBackendAvailableError =>
  error instanceof NoBackendAvailableError ||
  (typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NoBackendAvailableError");

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

/**
 * Resolves the host and the credential *together*, from the same source.
 *
 * A call that names its own host carries its own key or none at all; only a
 * call that falls back to the active backend for its host falls back to that
 * backend for its key. Resolving the two independently is a credential leak:
 * an override of `{ host, sessionApiKey: null }` means "this host has no key",
 * and `??` reads that `null` as "unspecified", so the active backend's key
 * would be sent to a host it does not belong to. A fleet entry reached through
 * the injecting proxy is exactly that shape — its `apiKey` is empty because
 * the ingress attaches the real one server-side (see `scripts/proxy-backend.mjs`).
 */
function resolveTarget(
  overrides: AgentServerClientOverrides,
  backend: Backend | null,
): { host: string; apiKey: string | undefined } {
  const overriddenKey =
    overrides.sessionApiKey ?? overrides.apiKey ?? undefined;

  if (overrides.host) {
    return { host: normalizeHost(overrides.host), apiKey: overriddenKey };
  }
  if (overrides.conversationUrl) {
    return {
      host: normalizeHost(buildHttpBaseUrl(overrides.conversationUrl)),
      apiKey: overriddenKey,
    };
  }
  return {
    host: normalizeHost(backend?.host ?? ""),
    apiKey: overriddenKey ?? backend?.apiKey ?? undefined,
  };
}

export function getAgentServerClientOptions(
  overrides: AgentServerClientOverrides = {},
): AgentServerClientOptions {
  const backend = getEffectiveLocalBackend();
  if (!backend && !overrides.host && !overrides.conversationUrl) {
    throw new NoBackendAvailableError();
  }

  const { host, apiKey } = resolveTarget(overrides, backend);

  return {
    host,
    ...(apiKey ? { apiKey } : {}),
    workingDir: overrides.workingDir ?? getAgentServerWorkingDir(),
    ...(overrides.timeout !== undefined ? { timeout: overrides.timeout } : {}),
  };
}

export function getAgentServerHttpClientOptions(
  overrides?: AgentServerClientOverrides,
) {
  const { host, apiKey, timeout } = getAgentServerClientOptions(overrides);
  return {
    baseUrl: host,
    ...(apiKey ? { apiKey } : {}),
    timeout: timeout ?? 60000,
  };
}
