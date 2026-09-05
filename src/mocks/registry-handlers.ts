import { http, HttpResponse } from "msw";

/**
 * Mock fleet registry.
 *
 * The default is an empty fleet with no registry at all (`404`), matching a
 * deployment where the ingress was started without a registry session key.
 * That is also what keeps every test that mounts `ActiveBackendProvider` from
 * making a real network call when its hydration effect runs.
 *
 * Tests that need a populated fleet call `seedMockRegistryEntries()`.
 */

export interface MockRegistryEntry {
  id: string;
  name: string;
  host: string;
  fingerprint: string;
  state: "pending" | "active" | "stale" | "revoked";
  credRef?: string | null;
  version?: string | null;
  lastSeen?: string | null;
}

let mockEntries: MockRegistryEntry[] | null = null;

/** Turns the registry on for a test and sets the fleet it serves. */
export function seedMockRegistryEntries(entries: MockRegistryEntry[]): void {
  mockEntries = entries;
}

export function resetMockRegistryEntries(): void {
  mockEntries = null;
}

function findEntry(id: string) {
  return mockEntries?.find((entry) => entry.id === id);
}

export const REGISTRY_HANDLERS = [
  http.get("*/api/registry", () => {
    if (!mockEntries) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ entries: mockEntries });
  }),

  http.post("*/api/registry/:id/:action", async ({ params, request }) => {
    if (!mockEntries) return new HttpResponse(null, { status: 404 });
    const entry = findEntry(String(params.id));
    if (!entry) {
      return HttpResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Mirrors the real route: an approval names the address it approves, and
    // is refused if the entry has moved since. A mock that accepts anything
    // lets the client half of that contract rot untested.
    if (params.action === "approve") {
      const body = (await request.json().catch(() => null)) as {
        host?: string;
      } | null;
      if (!body?.host) {
        return HttpResponse.json({ error: "host_required" }, { status: 400 });
      }
      // Compared the way the route compares it, after normalising, so the
      // mock does not 409 on a trailing slash the real registry accepts.
      const normalise = (value: string) => value.replace(/\/+$/, "");
      if (normalise(body.host) !== normalise(entry.host)) {
        return HttpResponse.json(
          {
            error: "entry_changed",
            message: "moved",
            details: { host: entry.host },
          },
          { status: 409 },
        );
      }
    }

    entry.state = params.action === "approve" ? "active" : "revoked";
    return HttpResponse.json({ entry });
  }),
];
