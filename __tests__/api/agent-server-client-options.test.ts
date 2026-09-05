import { afterEach, describe, expect, it } from "vitest";

import { getAgentServerClientOptions } from "#/api/agent-server-client-options";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";

/**
 * The credential and the host must be resolved from the same source.
 *
 * A backend whose `apiKey` is empty is not a backend whose key is unknown — it
 * is a backend that is reached without one, which is exactly the shape of a
 * fleet entry proxied through the ingress (`scripts/proxy-backend.mjs` resolves
 * the real key server-side). Falling back to the active backend's key for such
 * a call sends one host's credential to another host.
 */
const ACTIVE: Backend = {
  id: "default-local",
  name: "Local",
  host: "http://127.0.0.1:8000",
  apiKey: "the-active-backends-key",
  kind: "local",
};

const FLEET_ENTRY: Backend = {
  id: "registry:abc123",
  name: "claude-hetzner",
  host: "http://127.0.0.1:8000/backend/abc123",
  apiKey: "",
  kind: "local",
  provenance: "registry",
  registryState: "active",
};

function activate(backends: Backend[], activeId: string) {
  setRegisteredBackends(backends);
  setActiveSelection({ backendId: activeId });
}

describe("getAgentServerClientOptions", () => {
  afterEach(() => {
    __resetActiveStoreForTests();
  });

  it("uses the active backend's host and key when nothing is overridden", () => {
    activate([ACTIVE], ACTIVE.id);

    expect(getAgentServerClientOptions()).toMatchObject({
      host: ACTIVE.host,
      apiKey: ACTIVE.apiKey,
    });
  });

  it("never lends the active backend's key to an explicitly named host", () => {
    activate([ACTIVE, FLEET_ENTRY], ACTIVE.id);

    const options = getAgentServerClientOptions({
      host: FLEET_ENTRY.host,
      sessionApiKey: FLEET_ENTRY.apiKey || null,
    });

    expect(options.host).toBe(FLEET_ENTRY.host);
    expect(options.apiKey).toBeUndefined();
  });

  it("never lends the active backend's key to a named conversation runtime", () => {
    activate([ACTIVE], ACTIVE.id);

    const options = getAgentServerClientOptions({
      conversationUrl: "http://runtime.example:3000",
      sessionApiKey: null,
    });

    expect(options.apiKey).toBeUndefined();
  });

  it("uses the key supplied alongside an explicit host", () => {
    activate([ACTIVE], ACTIVE.id);

    expect(
      getAgentServerClientOptions({
        host: "http://other.example:8000",
        sessionApiKey: "that-hosts-own-key",
      }).apiKey,
    ).toBe("that-hosts-own-key");
  });

  it("still falls back to the active backend when the call names no host", () => {
    // Local file upload resolves `{ conversationUrl: null, sessionApiKey: null }`
    // and relies on this fallback for both halves.
    activate([ACTIVE], ACTIVE.id);

    expect(
      getAgentServerClientOptions({
        conversationUrl: null,
        sessionApiKey: null,
      }),
    ).toMatchObject({ host: ACTIVE.host, apiKey: ACTIVE.apiKey });
  });
});
