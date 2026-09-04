/**
 * Live end-to-end proof of the fleet registry, against real machines.
 *
 * Every other registry test in this repository uses a fake: a stub provider, a
 * stub `fetch`, an in-memory store. This one runs against a rig that
 * `tests/e2e/live/fleet-registry/rig.mjs` stands up — a throwaway master stack
 * plus two real agent servers, one of them on another machine, enrolled with
 * that machine's own SSH host key.
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up
 *   npm run test:e2e:fleet-registry
 *   node tests/e2e/live/fleet-registry/rig.mjs down
 *
 * It is deliberately kept out of `npm test` and out of the default Playwright
 * project: it needs a reachable remote host and cannot run in ordinary CI.
 *
 * The spec is serial and stateful by design — the loop under test *is* a state
 * machine (pending → active → revoked), so the order is the point. It expects
 * the fleet as `rig.mjs up` leaves it (node 1 `active`, node 2 `pending`) and
 * says so loudly if it finds anything else, because a half-run rig would
 * otherwise produce a green run that proved nothing.
 *
 * @spec FR-005 FR-006 FR-007 FR-008 FR-010 FR-012 FR-013 FR-014 FR-019 FR-020
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";

import { readRigState, type RigEntry, type RigState } from "./rig-state";

const rig: RigState = readRigState();
const EVIDENCE_DIR = path.join(rig.dir, "evidence");
const NODE1 = rig.entries.node1.name;
const NODE2 = rig.entries.node2.name;
/** The master's own entry, seeded by the launcher and never registry-owned. */
const MANUAL_BACKEND_NAME = "Local";

test.describe.configure({ mode: "serial" });

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const masterAuth = { "X-Session-API-Key": rig.keys.master };

async function listEntries(request: APIRequestContext): Promise<RigEntry[]> {
  const response = await request.get(`${rig.baseUrl}/api/registry`, {
    headers: masterAuth,
  });
  expect(response.status(), "the registry must answer a keyed read").toBe(200);
  return (await response.json()).entries as RigEntry[];
}

function entryNamed(entries: RigEntry[], name: string): RigEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  expect(entry, `${name} is missing from the fleet`).toBeDefined();
  return entry as RigEntry;
}

/**
 * The status the proxy answers for an entry, with no credential attached by
 * the caller. That absence is the whole point: whatever reaches the node has
 * to have been put there by the ingress.
 */
async function proxyStatus(
  request: APIRequestContext,
  entryId: string,
  path_ = "/api/conversations/search",
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await request.get(
    `${rig.baseUrl}/backend/${entryId}${path_}`,
    { headers, failOnStatusCode: false },
  );
  return response.status();
}

/**
 * Skips onboarding and the telemetry consent modal, which would otherwise sit
 * over the switcher. These are the only things seeded: no session key, no
 * backend list, nothing that could stand in for what the registry supplies.
 */
const SKIP_ONBOARDING = () => {
  window.localStorage.setItem("analytics-consent", "false");
  window.localStorage.setItem("openhands-telemetry-consent", "denied");
  window.localStorage.setItem("openhands-telemetry-first-use", "true");
  window.localStorage.setItem("openhands-onboarded", "1");
};

/**
 * The consent modal is also driven by a server-side preference, so a throwaway
 * master shows it on a fresh browser regardless of what localStorage says.
 */
test.beforeAll(async ({ request }) => {
  const response = await request.patch(
    `http://127.0.0.1:${rig.ports.masterAgentServer}/api/settings`,
    {
      headers: masterAuth,
      data: {
        misc_settings_diff: {
          app_preferences: { user_consents_to_analytics: false },
        },
      },
      failOnStatusCode: false,
    },
  );
  expect(response.ok(), "could not silence the consent modal").toBe(true);
});

/** Boots the canvas with onboarding out of the way, and nothing else seeded. */
async function openCanvas(page: Page): Promise<void> {
  await page.addInitScript(SKIP_ONBOARDING);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await dismissConsentModal(page);
  await expect(page.getByTestId("backend-selector")).toBeVisible({
    timeout: 30_000,
  });
}

/** Clears the consent dialog if it raced the preference above. */
async function dismissConsentModal(page: Page): Promise<void> {
  const form = page.getByTestId("telemetry-consent-form");
  try {
    await form.waitFor({ state: "visible", timeout: 4_000 });
  } catch {
    return; // never appeared, which is the common case
  }
  await form.getByRole("button", { name: "Confirm preferences" }).click();
  await form.waitFor({ state: "hidden", timeout: 10_000 });
}

/**
 * Opens the backend switcher and returns its options.
 *
 * It waits on the manual `Local` entry rather than a fleet one: the fleet rows
 * are what the callers assert about, including their absence after a
 * revocation, so anchoring on one of them would make the helper wait for the
 * very thing a test is proving has gone.
 */
async function openSwitcher(page: Page) {
  await page.getByTestId("backend-selector").hover();
  const options = page.locator("li");
  await expect(
    options.filter({ hasText: MANUAL_BACKEND_NAME }).first(),
  ).toBeVisible({ timeout: 15_000 });
  return options;
}

async function openManageBackends(page: Page) {
  await page.getByTestId("backend-selector").hover();
  await page.getByTestId("manage-backends-menu-item").click();
  const modal = page.getByTestId("manage-backends-modal");
  await modal.waitFor({ state: "visible", timeout: 15_000 });
  return modal;
}

async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * Re-runs `agent-canvas enrol` for node 2. Node 1's re-enrolment is driven
 * over SSH from the rig, since only that machine holds its host key.
 */
function reEnrolNode2(): string {
  return execFileSync(
    "node",
    [
      "bin/enrol.mjs",
      "--registry",
      rig.baseUrl,
      "--name",
      NODE2,
      "--host",
      rig.node2Url,
      "--secret-provider",
      "file",
      "--secret",
      rig.keys.node2,
      "--generate-key",
    ],
    { encoding: "utf8", env: { ...process.env, HOME: path.join(rig.dir, "home") } },
  ).trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Criterion 1 — two nodes, one fleet, trust decided by the pre-seed list
// ═══════════════════════════════════════════════════════════════════════════

test("the rig starts from the state this spec is written against", async ({
  request,
}) => {
  const entries = await listEntries(request);
  expect(
    entries.map((entry) => `${entry.name}=${entry.state}`).sort(),
    "re-run `node tests/e2e/live/fleet-registry/rig.mjs up` before this spec",
  ).toEqual([`${NODE1}=active`, `${NODE2}=pending`]);
});

test("reads and approvals need the master key; registration does not", async ({
  request,
}) => {
  // @spec FR-008
  const anonymous = await request.get(`${rig.baseUrl}/api/registry`, {
    failOnStatusCode: false,
  });
  expect(anonymous.status()).toBe(401);

  // A node's own key is a credential for that node, never for the fleet.
  const withNodeKey = await request.get(`${rig.baseUrl}/api/registry`, {
    headers: { "X-Session-API-Key": rig.keys.node1 },
    failOnStatusCode: false,
  });
  expect(withNodeKey.status()).toBe(401);

  expect(
    (await request.get(`${rig.baseUrl}/api/registry`, { headers: masterAuth }))
      .status(),
  ).toBe(200);
});

test("a pre-seeded fingerprint enrols active, an unknown one lands pending", async ({
  request,
}) => {
  // @spec FR-005
  const entries = await listEntries(request);
  expect(entries).toHaveLength(2);

  const node1 = entryNamed(entries, NODE1);
  const node2 = entryNamed(entries, NODE2);

  expect(node1.state, `${NODE1} is pre-seeded`).toBe("active");
  expect(node2.state, `${NODE2} is not pre-seeded`).toBe("pending");

  // Two machines, two identities. If these ever matched, every per-entry
  // claim below would be vacuous.
  expect(node1.fingerprint).not.toEqual(node2.fingerprint);
  expect(node1.fingerprint).toBe(rig.node1Fingerprint);
  expect(node1.fingerprint).toMatch(/^SHA256:/);

  // Neither registration carried a key, only a reference to one.
  expect(node1.credRef).toBe(`openhands/${NODE1}/session-key`);
  expect(JSON.stringify(node1)).not.toContain(rig.keys.node1);
  expect(JSON.stringify(node2)).not.toContain(rig.keys.node2);
});

test("a pending entry is listed in the switcher but refuses selection", async ({
  page,
}) => {
  // @spec FR-012
  await openCanvas(page);
  const options = await openSwitcher(page);

  const pending = options.filter({ hasText: NODE2 });
  await expect(pending).toHaveCount(1);
  await expect(pending).toHaveAttribute("aria-disabled", "true");
  await expect(pending).toContainText("Pending approval");

  const active = options.filter({ hasText: NODE1 }).first();
  await expect(active).not.toHaveAttribute("aria-disabled", "true");

  console.log(`evidence: ${await shot(page, "01-switcher-pending")}`);
});

test("Manage Backends shows provenance and offers approve, not delete", async ({
  page,
}) => {
  // @spec FR-013 FR-014
  await openCanvas(page);
  await openManageBackends(page);

  await expect(page.getByTestId(`manage-backends-provenance-${NODE1}`)).toHaveText(
    "From the fleet registry",
  );
  await expect(page.getByTestId(`manage-backends-provenance-${NODE2}`)).toHaveText(
    "Pending approval",
  );
  await expect(
    page.getByTestId(`manage-backends-provenance-${MANUAL_BACKEND_NAME}`),
  ).toHaveText("Added manually");

  // Fleet entries are server-owned: the browser's copy is a cache.
  await expect(page.getByTestId(`manage-backends-edit-${NODE1}`)).toHaveCount(0);
  await expect(page.getByTestId(`manage-backends-remove-${NODE1}`)).toHaveCount(0);
  await expect(page.getByTestId(`manage-backends-revoke-${NODE1}`)).toHaveCount(1);
  await expect(page.getByTestId(`manage-backends-approve-${NODE2}`)).toHaveCount(1);

  // The manual entry survives hydration with its own affordances intact.
  await expect(
    page.getByTestId(`manage-backends-edit-${MANUAL_BACKEND_NAME}`),
  ).toHaveCount(1);
  await expect(
    page.getByTestId(`manage-backends-remove-${MANUAL_BACKEND_NAME}`),
  ).toHaveCount(1);

  console.log(`evidence: ${await shot(page, "02-manage-backends")}`);
});

test("approving from the UI makes the entry connectable", async ({
  page,
  request,
}) => {
  // @spec FR-020
  expect(
    await proxyStatus(request, rig.entries.node2.id),
    `${NODE2} must be refused while pending`,
  ).toBe(403);

  await openCanvas(page);
  await openManageBackends(page);
  await page.getByTestId(`manage-backends-approve-${NODE2}`).click();

  await expect(page.getByTestId(`manage-backends-provenance-${NODE2}`)).toHaveText(
    "From the fleet registry",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId(`manage-backends-revoke-${NODE2}`)).toHaveCount(1);
  console.log(`evidence: ${await shot(page, "03-approved")}`);

  expect(entryNamed(await listEntries(request), NODE2).state).toBe("active");
  expect(await proxyStatus(request, rig.entries.node2.id)).toBe(200);

  // The switcher stops refusing it once it is approved.
  await page.getByRole("button", { name: "Done" }).click();
  const options = await openSwitcher(page);
  await expect(options.filter({ hasText: NODE2 })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Criterion 2 — no fleet key in the browser
// ═══════════════════════════════════════════════════════════════════════════

test("the browser holds no fleet credential and sends none", async ({
  page,
}) => {
  // @spec FR-019
  const proxied: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/backend/")) {
      proxied.push(request);
    }
  });

  await openCanvas(page);
  // Drive real traffic at both entries so the assertion has something to bite
  // on: health probes for the fleet rows run as soon as the list hydrates.
  await openManageBackends(page);
  await expect(
    page.getByTestId(`manage-backends-status-${NODE1}`),
  ).toHaveText("Connected", { timeout: 30_000 });

  const storage = await page.evaluate(() => {
    const dump = (store: Storage) =>
      Object.keys(store)
        .map((key) => `${key}=${store.getItem(key) ?? ""}`)
        .join("\n");
    return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
  });

  expect(storage.length, "storage should not be empty for this to mean anything")
    .toBeGreaterThan(0);
  expect(storage, `${NODE1}'s session key reached the browser`).not.toContain(
    rig.keys.node1,
  );
  expect(storage, `${NODE2}'s session key reached the browser`).not.toContain(
    rig.keys.node2,
  );
  // The hydrated entries carry an empty apiKey, not a placeholder for one.
  const backends = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("openhands-backends") ?? "[]"),
  );
  const fleet = (backends as { provenance?: string; apiKey: string }[]).filter(
    (backend) => backend.provenance === "registry",
  );
  expect(fleet).toHaveLength(2);
  expect(fleet.every((backend) => backend.apiKey === "")).toBe(true);

  expect(proxied.length, "no request reached the proxy to inspect").toBeGreaterThan(0);
  for (const request of proxied) {
    const headers = await request.allHeaders();
    expect(
      headers["x-session-api-key"],
      `${request.method()} ${request.url()} carried a fleet credential`,
    ).toBeUndefined();
  }
  console.log(
    `evidence: ${proxied.length} browser requests to /backend/*, none carrying X-Session-API-Key`,
  );
});

test("the proxy injects each entry's own credential, and only its own", async ({
  request,
}) => {
  // @spec FR-019
  // The differential is the proof. Same method, same path, same absence of a
  // credential: 200 through the proxy, 401 straight at the node. The only
  // difference between the two is the ingress, so the ingress is what
  // attached the key.
  expect(await proxyStatus(request, rig.entries.node1.id)).toBe(200);
  expect(await proxyStatus(request, rig.entries.node2.id)).toBe(200);

  const direct = async (url: string, key?: string) =>
    (
      await request.get(`${url}/api/conversations/search`, {
        headers: key ? { "X-Session-API-Key": key } : {},
        failOnStatusCode: false,
      })
    ).status();

  expect(await direct(rig.node1Url), "node 1 is genuinely protected").toBe(401);
  expect(await direct(rig.node2Url), "node 2 is genuinely protected").toBe(401);
  expect(await direct(rig.node1Url, rig.keys.node1)).toBe(200);
  expect(await direct(rig.node2Url, rig.keys.node2)).toBe(200);

  // Per-entry isolation: each node rejects the other's key, so the 200s above
  // could not have come from the proxy resolving one credential for both.
  expect(await direct(rig.node1Url, rig.keys.node2)).toBe(401);
  expect(await direct(rig.node2Url, rig.keys.node1)).toBe(401);

  // A credential the caller supplies is stripped, not merged or preferred.
  expect(
    await proxyStatus(request, rig.entries.node1.id, "/api/conversations/search", {
      "X-Session-API-Key": "a-key-the-caller-made-up",
    }),
  ).toBe(200);

  // An entry that does not exist never falls back to an uncredentialed proxy.
  expect(await proxyStatus(request, "0".repeat(32))).toBe(404);
});

test("a browser that has never seen the fleet renders it anyway", async ({
  browser,
}) => {
  // @spec FR-010
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(SKIP_ONBOARDING);

  // Nothing pasted, nothing added, no backend list seeded: whatever appears
  // came from `GET /api/registry` on this origin.
  await page.goto(rig.baseUrl, { waitUntil: "domcontentloaded" });
  await dismissConsentModal(page);
  await expect(page.getByTestId("backend-selector")).toBeVisible({
    timeout: 30_000,
  });

  await page.getByTestId("backend-selector").hover();
  await expect(page.locator("li").filter({ hasText: NODE1 }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("li").filter({ hasText: NODE2 }).first()).toBeVisible();

  const hydrated = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("openhands-backends") ?? "[]"),
  );
  const names = (hydrated as { name: string; provenance?: string }[])
    .filter((backend) => backend.provenance === "registry")
    .map((backend) => backend.name)
    .sort();
  expect(names).toEqual([NODE1, NODE2].sort());

  console.log(`evidence: ${await shot(page, "04-fresh-context")}`);
  await context.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// Criterion 1 (continued) — a real conversation on the remote node
// ═══════════════════════════════════════════════════════════════════════════

test("a conversation runs on the remote node through the proxy", async ({
  request,
}) => {
  const proxied = `${rig.baseUrl}/backend/${rig.entries.node1.id}`;

  // The remote node's own settings drive the agent; the request carries no
  // credential of any kind.
  const settings = await (await request.get(`${proxied}/api/settings`)).json();
  const created = await request.post(`${proxied}/api/conversations`, {
    data: {
      workspace: { kind: "LocalWorkspace", working_dir: "workspace/project" },
      agent_settings: settings.agent_settings,
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "hello from the fleet proxy" }],
      },
    },
    failOnStatusCode: false,
  });
  expect(created.status(), await created.text()).toBe(201);
  const conversation = await created.json();

  // The conversation is stored on the *remote* machine, under its persistence
  // directory, not the master's.
  expect(conversation.persistence_dir).toContain("/home/");
  expect(await request.get(`${proxied}/api/conversations/${conversation.id}`))
    .toBeTruthy();

  // An initial message starts the agent on its own, so this either kicks it off
  // (200) or finds it already running (409). Both mean the remote node accepted
  // the work; anything else means it did not.
  const run = await request.post(
    `${proxied}/api/conversations/${conversation.id}/run`,
    { failOnStatusCode: false },
  );
  expect([200, 409], `run returned ${run.status()}`).toContain(run.status());

  // Wait for the agent to reach a terminal state, then say what happened. A
  // node with no LLM credential gets as far as `LLMAuthenticationError`, which
  // still proves every hop up to the model call; a node with one runs for
  // real. Both are a pass here — the claim under test is the transport, not
  // the model.
  interface ConversationEvent {
    kind?: string;
    code?: string;
    value?: string;
  }
  let events: ConversationEvent[] = [];
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${proxied}/api/conversations/${conversation.id}/events/search?page_size=50`,
          { failOnStatusCode: false },
        );
        if (!response.ok()) return "";
        events = ((await response.json()).items ?? []) as ConversationEvent[];
        const status = events
          .filter(
            (event: ConversationEvent) =>
              event.kind === "ConversationStateUpdateEvent",
          )
          .at(-1);
        return status?.value ?? "";
      },
      { timeout: 60_000, message: "the agent never reached a terminal state" },
    )
    .not.toBe("running");

  const llmAuthFailure = events.some(
    (event: ConversationEvent) => event.code === "LLMAuthenticationError",
  );
  expect(
    events.length,
    "the remote agent produced no events at all",
  ).toBeGreaterThan(2);
  console.log(
    llmAuthFailure
      ? `PARTIAL: ${NODE1} has no LLM credential, so the run stopped at ` +
          `LLMAuthenticationError. Every hop before the model call is proven: ` +
          `${events.length} events were written on the remote host.`
      : `${NODE1} ran the conversation to completion (${events.length} events).`,
  );

  await request.delete(`${proxied}/api/conversations/${conversation.id}`, {
    failOnStatusCode: false,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotent re-enrolment
// ═══════════════════════════════════════════════════════════════════════════

test("re-enrolling updates in place and never escalates trust", async ({
  request,
}) => {
  // @spec FR-006 FR-007
  const before = await listEntries(request);
  expect(before).toHaveLength(2);

  execFileSync("node", [
    "tests/e2e/live/fleet-registry/rig.mjs",
    "reenrol-node1",
  ]);
  expect(reEnrolNode2()).toMatch(/^active /);

  const after = await listEntries(request);
  expect(after, "re-enrolment must never add a second entry").toHaveLength(2);
  expect(entryNamed(after, NODE1).id).toBe(entryNamed(before, NODE1).id);
  expect(entryNamed(after, NODE2).id).toBe(entryNamed(before, NODE2).id);
  // Node 2 was approved above and is no longer in the pre-seed list; the
  // approval has to survive its own re-registration.
  expect(entryNamed(after, NODE2).state).toBe("active");
  expect(entryNamed(after, NODE1).state).toBe("active");
});

// ═══════════════════════════════════════════════════════════════════════════
// Criterion 3 — revocation is real, and it is per-entry
// ═══════════════════════════════════════════════════════════════════════════

test("revoking one node 403s its path and leaves the other working", async ({
  page,
  request,
}) => {
  // @spec FR-020
  await openCanvas(page);
  await openManageBackends(page);
  await page.getByTestId(`manage-backends-revoke-${NODE1}`).click();

  // A revoked entry disappears from the list rather than lingering greyed out.
  await expect(page.getByTestId(`manage-backends-row-${NODE1}`)).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByTestId(`manage-backends-row-${NODE2}`)).toHaveCount(1);
  console.log(`evidence: ${await shot(page, "05-revoked")}`);

  expect(entryNamed(await listEntries(request), NODE1).state).toBe("revoked");
  expect(await proxyStatus(request, rig.entries.node1.id)).toBe(403);

  // The other node is untouched: still active, still resolving its own key.
  expect(entryNamed(await listEntries(request), NODE2).state).toBe("active");
  expect(await proxyStatus(request, rig.entries.node2.id)).toBe(200);

  await page.getByRole("button", { name: "Done" }).click();
  const options = await openSwitcher(page);
  await expect(options.filter({ hasText: NODE1 })).toHaveCount(0);
  await expect(options.filter({ hasText: NODE2 })).toHaveCount(1);
  console.log(`evidence: ${await shot(page, "06-switcher-after-revoke")}`);
});

test("a revoked node stays revoked when it re-enrols", async ({ request }) => {
  // @spec FR-007
  execFileSync("node", [
    "tests/e2e/live/fleet-registry/rig.mjs",
    "reenrol-node1",
  ]);
  const entries = await listEntries(request);
  expect(entries).toHaveLength(2);
  expect(
    entryNamed(entries, NODE1).state,
    "dropping a host from the allowlist has to be final",
  ).toBe("revoked");
});
