/**
 * Inline storage provider: persists the registry in the local agent server's
 * `misc_settings.fleet_backends`.
 *
 * `misc_settings` is a free-form JSON store the agent does not interpret, and
 * `PATCH /api/settings` deep-merges `misc_settings_diff` while replacing lists
 * wholesale. Keeping the entries in a single `entries` array therefore makes a
 * write a plain replace, and removes the need to operate a second datastore.
 *
 * Every mutation is read-modify-write, so they are serialised through a lock:
 * two concurrent registrations would otherwise each read the same array and
 * the second write would drop the first entry.
 */

import { RegistryError } from "../store.mjs";

const SETTINGS_PATH = "/api/settings";

function settingsUrl(baseUrl) {
  return new URL(SETTINGS_PATH, baseUrl).toString();
}

async function readJson(response, what) {
  if (!response.ok) {
    throw new RegistryError(
      502,
      "store_unavailable",
      `${what} failed with status ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new RegistryError(
      502,
      "store_unavailable",
      `${what} returned a malformed body`,
    );
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   sessionKey: string,
 *   fetchImpl?: typeof globalThis.fetch,
 * }} options
 */
export function createInlineProvider({
  baseUrl,
  sessionKey,
  fetchImpl = fetch,
}) {
  if (!baseUrl) {
    throw new Error("createInlineProvider requires baseUrl");
  }
  if (!sessionKey) {
    throw new Error("createInlineProvider requires sessionKey");
  }

  const url = settingsUrl(baseUrl);
  const headers = {
    "X-Session-API-Key": sessionKey,
    "Content-Type": "application/json",
  };

  async function readEntries() {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
    } catch (error) {
      throw new RegistryError(
        502,
        "store_unavailable",
        `settings read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const settings = await readJson(response, "settings read");
    const stored = settings?.misc_settings?.fleet_backends;
    const entries = stored?.entries;
    return Array.isArray(entries) ? entries : [];
  }

  async function writeEntries(entries) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          misc_settings_diff: { fleet_backends: { entries } },
        }),
      });
    } catch (error) {
      throw new RegistryError(
        502,
        "store_unavailable",
        `settings write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new RegistryError(
        502,
        "store_unavailable",
        `settings write failed with status ${response.status}`,
      );
    }
  }

  // Serialises read-modify-write cycles. `tail` never rejects, so a failed
  // mutation does not wedge the queue for the next caller.
  let tail = Promise.resolve();
  function withLock(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    list() {
      return readEntries();
    },

    upsert(entry) {
      return withLock(async () => {
        const entries = await readEntries();
        const index = entries.findIndex((existing) => existing.id === entry.id);
        if (index === -1) {
          entries.push(entry);
        } else {
          entries[index] = entry;
        }
        await writeEntries(entries);
        return entry;
      });
    },

    remove(id) {
      return withLock(async () => {
        const entries = await readEntries();
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length !== entries.length) {
          await writeEntries(next);
        }
      });
    },

    setState(id, state) {
      return withLock(async () => {
        const entries = await readEntries();
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) {
          throw new RegistryError(404, "not_found", `no entry with id ${id}`);
        }
        const updated = { ...entries[index], state };
        entries[index] = updated;
        await writeEntries(entries);
        return updated;
      });
    },
  };
}
