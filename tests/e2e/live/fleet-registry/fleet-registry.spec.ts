/**
 * Live end-to-end proof of the fleet registry, against real machines, in two
 * reachability profiles.
 *
 * Every other registry test in this repository uses a fake: a stub provider, a
 * stub `fetch`, an in-memory store. This one runs against a rig that
 * `tests/e2e/live/fleet-registry/rig.mjs` stands up.
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up --profile tailnet
 *   npm run test:e2e:fleet-registry
 *   node tests/e2e/live/fleet-registry/rig.mjs down
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up --profile k8s
 *   npm run test:e2e:fleet-registry
 *   node tests/e2e/live/fleet-registry/rig.mjs down
 *
 * One body, two profiles: reachability is the only difference, which is the
 * claim being made. What changes is how a machine becomes dialable —
 *
 *   tailnet  two real VMs on a private overlay, addressed by the MagicDNS
 *            name each one's `tailscale serve` terminates TLS for. Membership
 *            is push enrolment signed by the node's own SSH host key.
 *   k8s      one real k3s cluster built from nothing, addressed by cluster
 *            DNS. Membership is the Service list: no enrolment, no key
 *            distribution, no pre-seeded fingerprint, no overlay.
 *
 * — and the profile-gated tests say in their skip reason why an assertion
 * cannot be made in the other profile, so a gate is never silent.
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
import { mkdirSync, readFileSync } from "node:fs";
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
// The tailnet profile addresses nodes by MagicDNS name, and this Mac's system
// resolver refuses those; the API-request assertions below dial them directly.
import "./magicdns.mjs";

const rig: RigState = readRigState();
const EVIDENCE_DIR = path.join(rig.dir, "evidence");
const NODE1 = rig.entries.node1.name;
const NODE2 = rig.entries.node2.name;
/** The master's own entry, seeded by the launcher and never registry-owned. */
const MANUAL_BACKEND_NAME = "Local";

/**
 * The profile the running rig was brought up in. Taken from the rig's own
 * state rather than from the environment: `PROFILE=k8s` against a tailnet rig
 * would otherwise skip the assertions that do apply and run the ones that
 * cannot, and report green for a fleet nobody tested.
 */
const PROFILE = rig.profile ?? "tailnet";
const TAILNET = PROFILE === "tailnet";
const K8S = PROFILE === "k8s";

if (process.env.PROFILE && process.env.PROFILE !== PROFILE) {
  throw new Error(
    `PROFILE=${process.env.PROFILE} but the running rig is "${PROFILE}". ` +
      `Bring the rig up in that profile first: ` +
      `node tests/e2e/live/fleet-registry/rig.mjs up --profile ${process.env.PROFILE}`,
  );
}

/**
 * Membership in this profile is push enrolment, so trust starts off and an
 * operator grants it. A pull source has no such step: membership of the
 * directory *is* the authorisation, which is the property the k8s profile
 * exists to prove, so there is nothing to approve and nothing to pre-seed.
 */
const ENROLMENT_ONLY = "enrolment is a push-profile step; k8s discovers";
const CREDENTIALS_ONLY =
  "this profile distributes no keys, so there is no credential to inject";

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
  headers: Record<string, string> = masterAuth,
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
 * Re-runs enrolment for a node, from that node.
 *
 * Both nodes are real machines now, and only the machine holding a host key
 * can sign for itself, so a re-registration has to originate there. The spec
 * shells out to the rig rather than growing SSH knowledge of its own.
 */
function reEnrol(which: "node1" | "node2"): string {
  const output = execFileSync(
    "node",
    ["tests/e2e/live/fleet-registry/rig.mjs", `reenrol-${which}`],
    { encoding: "utf8" },
  );
  const match = output.match(/^(pending|active|stale|revoked) \S+$/m);
  return match ? match[0] : output.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Criterion 1 — two nodes, one fleet, trust decided by the pre-seed list
// ═══════════════════════════════════════════════════════════════════════════

test("the rig starts from the state this spec is written against", async ({
  request,
}) => {
  const entries = await listEntries(request);
  const observed = entries
    .map((entry) => `${entry.name}=${entry.state}`)
    .sort();
  const expected = TAILNET
    ? // One machine is pre-seeded and one is not, which is the whole of the
      // trust decision this profile exercises.
      [`${NODE1}=active`, `${NODE2}=pending`]
    : // Membership of the namespace is the authorisation, so nothing is ever
      // pending: a discovered Service is active as soon as it answers.
      [`${NODE1}=active`, `${NODE2}=active`];

  expect(
    observed,
    `re-run \`node tests/e2e/live/fleet-registry/rig.mjs up --profile ${PROFILE}\` before this spec`,
  ).toEqual(expected.sort());
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
  if (TAILNET) {
    const withNodeKey = await request.get(`${rig.baseUrl}/api/registry`, {
      headers: { "X-Session-API-Key": rig.keys.node1 as string },
      failOnStatusCode: false,
    });
    expect(withNodeKey.status()).toBe(401);
  }

  expect(
    (
      await request.get(`${rig.baseUrl}/api/registry`, { headers: masterAuth })
    ).status(),
  ).toBe(200);
});

test("a pre-seeded fingerprint enrols active, an unknown one lands pending", async ({
  request,
}) => {
  test.skip(!TAILNET, ENROLMENT_ONLY);

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

  // Neither registration carried a key, only a reference to one -- and the
  // reference is derived from the fingerprint, not chosen by the node, so no
  // machine can name one belonging to another.
  expect(node1.credRef).toBe(`openhands/${node1.id}/session-key`);
  expect(node2.credRef).toBe(`openhands/${node2.id}/session-key`);
  expect(node1.credRef).not.toBe(node2.credRef);
  expect(JSON.stringify(node1)).not.toContain(rig.keys.node1);
  expect(JSON.stringify(node2)).not.toContain(rig.keys.node2);
});

test("a pending entry is listed in the switcher but refuses selection", async ({
  page,
}) => {
  test.skip(!TAILNET, ENROLMENT_ONLY);

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
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // @spec FR-013 FR-014
  await openCanvas(page);
  await openManageBackends(page);

  await expect(
    page.getByTestId(`manage-backends-provenance-${NODE1}`),
  ).toHaveText("From the fleet registry");
  await expect(
    page.getByTestId(`manage-backends-provenance-${NODE2}`),
  ).toHaveText("Pending approval");
  await expect(
    page.getByTestId(`manage-backends-provenance-${MANUAL_BACKEND_NAME}`),
  ).toHaveText("Added manually");

  // Fleet entries are server-owned: the browser's copy is a cache.
  await expect(page.getByTestId(`manage-backends-edit-${NODE1}`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId(`manage-backends-remove-${NODE1}`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId(`manage-backends-revoke-${NODE1}`)).toHaveCount(
    1,
  );
  await expect(
    page.getByTestId(`manage-backends-approve-${NODE2}`),
  ).toHaveCount(1);

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
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // @spec FR-020
  expect(
    await proxyStatus(request, rig.entries.node2.id),
    `${NODE2} must be refused while pending`,
  ).toBe(403);

  await openCanvas(page);
  await openManageBackends(page);
  await page.getByTestId(`manage-backends-approve-${NODE2}`).click();

  await expect(
    page.getByTestId(`manage-backends-provenance-${NODE2}`),
  ).toHaveText("From the fleet registry", { timeout: 20_000 });
  await expect(page.getByTestId(`manage-backends-revoke-${NODE2}`)).toHaveCount(
    1,
  );
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
  await expect(page.getByTestId(`manage-backends-status-${NODE1}`)).toHaveText(
    "Connected",
    { timeout: 30_000 },
  );

  const storage = await page.evaluate(() => {
    const dump = (store: Storage) =>
      Object.keys(store)
        .map((key) => `${key}=${store.getItem(key) ?? ""}`)
        .join("\n");
    return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
  });

  expect(
    storage.length,
    "storage should not be empty for this to mean anything",
  ).toBeGreaterThan(0);
  // Only the tailnet profile has node keys to leak. In k8s no key is
  // distributed at all, so the assertion below would pass against `undefined`
  // and prove nothing; what is still asserted in both is that every browser
  // request carries the master's key and no other.
  for (const which of ["node1", "node2"] as const) {
    const nodeKey = rig.keys[which];
    if (!nodeKey) continue;
    expect(
      storage,
      `${rig.entries[which].name}'s session key reached the browser`,
    ).not.toContain(nodeKey);
  }
  // A hydrated entry carries *this origin's* key, which the browser is
  // entitled to and which the ingress requires before it will proxy at all.
  // What it must never carry is a node's own key.
  const backends = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("openhands-backends") ?? "[]"),
  );
  const fleet = (backends as { provenance?: string; apiKey: string }[]).filter(
    (backend) => backend.provenance === "registry",
  );
  expect(fleet).toHaveLength(2);
  expect(fleet.every((backend) => backend.apiKey === rig.keys.master)).toBe(
    true,
  );
  const nodeKeys = [rig.keys.node1, rig.keys.node2].filter(Boolean);
  expect(
    fleet.some((backend) => nodeKeys.includes(backend.apiKey)),
  ).toBe(false);

  expect(
    proxied.length,
    "no request reached the proxy to inspect",
  ).toBeGreaterThan(0);
  for (const request of proxied) {
    const headers = await request.allHeaders();
    const sent = headers["x-session-api-key"];
    const where = `${request.method()} ${request.url()}`;

    // The browser authenticates to the *master* -- the proxy injects fleet
    // credentials, so it cannot be the one route on this origin that asks
    // nothing of its caller. What matters is which key that is.
    expect(sent, `${where} reached the proxy unauthenticated`).toBe(
      rig.keys.master,
    );
    for (const nodeKey of nodeKeys) {
      expect(sent, `${where} carried a node's own key`).not.toBe(nodeKey);
      expect(request.url(), `${where} carried a key in the URL`).not.toContain(
        nodeKey,
      );
    }
  }
  console.log(
    `evidence: ${proxied.length} browser requests to /backend/*, every one ` +
      "authenticated with the master's key and none carrying a node's",
  );
});

test("the proxy injects each entry's own credential, and only its own", async ({
  request,
}) => {
  test.skip(!TAILNET, CREDENTIALS_ONLY);

  // @spec FR-019
  // The differential is the proof. Same method, same path, same absence of a
  // credential: 200 through the proxy, 401 straight at the node. The only
  // difference between the two is the ingress, so the ingress is what
  // attached the key.
  expect(await proxyStatus(request, rig.entries.node1.id)).toBe(200);
  expect(await proxyStatus(request, rig.entries.node2.id)).toBe(200);

  // Node's `fetch`, not Playwright's request context: the nodes are addressed
  // by MagicDNS name, which this Mac's system resolver refuses and
  // `./magicdns.mjs` fixes in this process. Playwright's context resolves in
  // the driver, where that patch does not reach.
  const direct = async (url: string, key?: string) => {
    const response = await fetch(`${url}/api/conversations/search`, {
      headers: key ? { "X-Session-API-Key": key } : {},
    });
    return response.status;
  };

  expect(await direct(rig.node1Url), "node 1 is genuinely protected").toBe(401);
  expect(await direct(rig.node2Url), "node 2 is genuinely protected").toBe(401);
  expect(await direct(rig.node1Url, rig.keys.node1)).toBe(200);
  expect(await direct(rig.node2Url, rig.keys.node2)).toBe(200);

  // Per-entry isolation: each node rejects the other's key, so the 200s above
  // could not have come from the proxy resolving one credential for both.
  expect(await direct(rig.node1Url, rig.keys.node2)).toBe(401);
  expect(await direct(rig.node2Url, rig.keys.node1)).toBe(401);

  // The substitution, stated as a contradiction: the caller presents only the
  // master's key, and the master's key is not accepted by either node. A 200
  // is therefore only explicable by the proxy having swapped in the node's own.
  expect(await direct(rig.node1Url, rig.keys.master)).toBe(401);
  expect(await direct(rig.node2Url, rig.keys.master)).toBe(401);

  // An entry that does not exist never falls back to an uncredentialed proxy.
  expect(await proxyStatus(request, "0".repeat(32))).toBe(404);
});

test("the proxy refuses a caller it cannot authenticate", async ({
  request,
}) => {
  // @spec FR-019a
  // Without this the route is strictly weaker than the `/api/*` it sits beside:
  // there the agent server authenticates for itself, here the proxy does it on
  // the caller's behalf, so an unchecked caller is handed the whole fleet.
  const unauthenticated = { "X-Not-A-Credential": "1" };
  expect(
    await proxyStatus(
      request,
      rig.entries.node1.id,
      "/api/conversations/search",
      unauthenticated,
    ),
  ).toBe(401);
  expect(
    await proxyStatus(
      request,
      rig.entries.node2.id,
      "/api/conversations/search",
      unauthenticated,
    ),
  ).toBe(401);

  // A node's own key authorises that node, never a caller of the fleet.
  if (TAILNET) {
    expect(
      await proxyStatus(
        request,
        rig.entries.node1.id,
        "/api/conversations/search",
        { "X-Session-API-Key": rig.keys.node1 as string },
      ),
    ).toBe(401);
  }

  // An unauthenticated caller cannot even learn which entry ids exist.
  expect(
    await proxyStatus(
      request,
      "0".repeat(32),
      "/api/conversations/search",
      unauthenticated,
    ),
  ).toBe(401);
});

test("a malformed entry id does not take the ingress down", async ({
  request,
}) => {
  // `decodeURIComponent("%")` throws, and this parse runs inside the server's
  // request and upgrade listeners where nothing catches it. One unauthenticated
  // request used to be enough to stop the whole ingress.
  for (const path of ["/backend/%", "/backend/%zz", "/backend/%/api/x"]) {
    const response = await request.get(`${rig.baseUrl}${path}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBeLessThan(500);
  }

  // Still serving afterwards, which is the actual assertion.
  expect(
    (
      await request.get(`${rig.baseUrl}/api/registry`, { headers: masterAuth })
    ).status(),
  ).toBe(200);
  expect(await proxyStatus(request, rig.entries.node1.id)).toBe(200);
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
  await expect(
    page.locator("li").filter({ hasText: NODE1 }).first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator("li").filter({ hasText: NODE2 }).first(),
  ).toBeVisible();

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
  test.skip(!TAILNET, "`claude`/ACP is not installed in-cluster, so no model turn can run there");

  const proxied = `${rig.baseUrl}/backend/${rig.entries.node1.id}`;

  // The remote node's own settings drive the agent; the request carries no
  // credential of any kind.
  const settings = await (
    await request.get(`${proxied}/api/settings`, { headers: masterAuth })
  ).json();
  expect(
    settings.llm_api_key_is_set,
    "this asserts the node runs on its own configuration, so the master must " +
      "not be the one holding the model credential",
  ).toBeFalsy();

  // Launched from the node's active agent profile, which is how the canvas
  // starts a conversation and the only shape that reaches an ACP agent: an
  // inline `agent_settings` dump loses the ACP fields, and the server falls
  // back to the LLM agent, which then fails on a model it cannot resolve.
  const profiles = await (
    await request.get(`${proxied}/api/agent-profiles`, { headers: masterAuth })
  ).json();
  const created = await request.post(`${proxied}/api/conversations`, {
    headers: masterAuth,
    data: {
      workspace: { kind: "LocalWorkspace", working_dir: "workspace/project" },
      ...(profiles.active_agent_profile_id
        ? { agent_profile_id: profiles.active_agent_profile_id }
        : { agent_settings: settings.agent_settings }),
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
  expect(
    await request.get(`${proxied}/api/conversations/${conversation.id}`, {
      headers: masterAuth,
    }),
  ).toBeTruthy();

  // An initial message starts the agent on its own, so this either kicks it off
  // (200) or finds it already running (409). Both mean the remote node accepted
  // the work; anything else means it did not.
  const run = await request.post(
    `${proxied}/api/conversations/${conversation.id}/run`,
    { headers: masterAuth, failOnStatusCode: false },
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
    source?: string;
  }
  // Terminal by name, rather than "anything that is not `running`". State
  // updates also carry ids and objects as their value, and every one of those
  // reads as not-running -- so the poll used to return before the agent had
  // even started, and the run was judged on the first two events.
  const TERMINAL = new Set(["finished", "error", "stopped", "idle"]);
  let events: ConversationEvent[] = [];
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${proxied}/api/conversations/${conversation.id}/events/search?page_size=100`,
          { headers: masterAuth, failOnStatusCode: false },
        );
        if (!response.ok()) return false;
        events = ((await response.json()).items ?? []) as ConversationEvent[];
        return events
          .filter(
            (event: ConversationEvent) =>
              event.kind === "ConversationStateUpdateEvent",
          )
          .some((event: ConversationEvent) =>
            TERMINAL.has(String(event.value ?? "")),
          );
      },
      {
        timeout: 180_000,
        message: "the agent never reached a terminal state",
      },
    )
    .toBe(true);

  // What proves the model actually ran is the agent *acting*, not the absence
  // of one particular error code. Asserting the absence let an `ACPInitError`
  // read as a completed run: the agent never started, and nothing said so.
  const agentActed = events.some(
    (event: ConversationEvent) =>
      event.source === "agent" &&
      (event.kind === "ActionEvent" || event.kind === "MessageEvent"),
  );
  const llmAuthFailure = events.some(
    (event: ConversationEvent) => event.code === "LLMAuthenticationError",
  );
  const errors = events
    .filter((event: ConversationEvent) => event.code)
    .map((event: ConversationEvent) => event.code)
    .join(", ");

  expect(
    events.length,
    "the remote agent produced no events at all",
  ).toBeGreaterThan(2);
  // A node with no usable model credential stops at `LLMAuthenticationError`,
  // which still proves every hop up to the model call and is the documented
  // degraded outcome. Any other way of not acting is a failure.
  expect(
    agentActed || llmAuthFailure,
    `the remote agent never acted; errors: ${errors || "none"}`,
  ).toBe(true);
  console.log(
    agentActed
      ? `${NODE1} ran the conversation to completion, agent acted ` +
          `(${events.length} events).`
      : `PARTIAL: ${NODE1} has no usable model credential, so the run stopped ` +
          `at LLMAuthenticationError. Every hop before the model call is ` +
          `proven: ${events.length} events were written on the remote host.`,
  );

  // The event socket, through the same proxy, for the same conversation.
  //
  // Everything above is HTTP. The canvas watches a conversation over
  // `/sockets/events/<id>`, which is an upgrade — a separate path through the
  // proxy, with its own credential injection and its own access-log record —
  // and the wire record is only complete if that hop appears in it too. A
  // WebSocket cannot carry a header from a browser, so the session key rides
  // in the query, which is exactly why the access log redacts it.
  const socketUrl = `${rig.baseUrl.replace(/^http/, "ws")}/backend/${
    rig.entries.node1.id
  }/sockets/events/${conversation.id}?session_api_key=${encodeURIComponent(
    rig.keys.master,
  )}`;
  const upgraded = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(socketUrl);
    const settle = (value: boolean) => {
      try {
        socket.close();
      } catch {
        // already closing
      }
      resolve(value);
    };
    socket.addEventListener("open", () => settle(true));
    socket.addEventListener("error", () => settle(false));
    setTimeout(() => settle(false), 20_000);
  });
  expect(
    upgraded,
    "the event socket never upgraded through the proxy",
  ).toBe(true);

  // The proxy records what the node answered, so a 101 here is the node
  // accepting the socket, not the master reporting that it dialled.
  await expect
    .poll(
      () =>
        readFileSync(rig.accessLogPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .some(
            (entry) =>
              entry.kind === "upgrade" &&
              entry.outcome === "proxied:101" &&
              entry.entryFingerprint === rig.node1Fingerprint &&
              entry.credential === "injected",
          ),
      { timeout: 20_000, message: "no proxied:101 line for the event socket" },
    )
    .toBe(true);
  console.log(
    `evidence: proxied:101 against ${rig.node1Fingerprint}, credential injected`,
  );

  await request.delete(`${proxied}/api/conversations/${conversation.id}`, {
    headers: masterAuth,
    failOnStatusCode: false,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotent re-enrolment
// ═══════════════════════════════════════════════════════════════════════════

test("re-enrolling updates in place and never escalates trust", async ({
  request,
}) => {
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // @spec FR-006 FR-007
  const before = await listEntries(request);
  expect(before).toHaveLength(2);

  // Both nodes re-register from themselves. `enrol` also prints where the
  // session key must live, so the state line is matched rather than assumed
  // to be first.
  expect(reEnrol("node1")).toMatch(/^active \S+$/);
  expect(reEnrol("node2")).toMatch(/^active \S+$/);

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
// Profile k8s — the enterprise case: membership comes from the cluster
//
// Placed before the revocation section because this file is serial and those
// tests revoke an entry; a stale or revoked entry would make everything here
// assert about a fleet that is already being dismantled.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `kubectl` against the rig's own kubeconfig. The cluster is reached the way
 * any platform engineer reaches one — not over the overlay, which is the
 * point of this profile.
 */
function kubectl(...args: string[]): string {
  return execFileSync(
    "kubectl",
    ["--kubeconfig", rig.kubeconfig as string, "-n", rig.namespace as string, ...args],
    { encoding: "utf8" },
  ).trim();
}

/** Waits out at most two poll cycles for the registry to catch up. */
async function pollForEntries(
  request: APIRequestContext,
  predicate: (entries: RigEntry[]) => boolean,
  what: string,
) {
  await expect
    .poll(async () => predicate(await listEntries(request)), {
      timeout: (rig.sourceIntervalMs ?? 60_000) * 3,
      message: what,
    })
    .toBe(true);
}

test("the cluster's Service list is the fleet, with nothing enrolled", async ({
  request,
}) => {
  test.skip(!K8S, "there is no cluster in the tailnet profile");

  const entries = await listEntries(request);
  expect(entries.length).toBeGreaterThanOrEqual(2);

  for (const entry of entries) {
    // Discovered, not enrolled: the source says so, and so does the absence of
    // everything enrolment produces.
    expect(entry.source, `${entry.name} did not come from the cluster`).toBe(
      "k8s",
    );
    // Membership of the namespace is the authorisation, so there is no
    // pending state to clear and no operator decision to wait for.
    expect(entry.state).toBe("active");
    // No key was distributed, so there is no reference to one.
    expect(entry.credRef).toBeNull();
    // The identity is the Service's namespaced name, prefixed so it can never
    // collide with an SSH fingerprint from signed enrolment.
    expect(entry.fingerprint).toMatch(
      new RegExp(`^k8s:${rig.namespace}/[a-z0-9-]+$`),
    );
    // Addressed by cluster DNS. Not a tunnel, not an overlay address, not a
    // loopback port: the name the registry resolves from inside the cluster.
    expect(entry.host).toMatch(
      new RegExp(
        `^http://[a-z0-9-]+\\.${rig.namespace}\\.svc\\.cluster\\.local:\\d+$`,
      ),
    );
  }

  // One entry per pool member, each individually addressable. An aggregate
  // Service in front of all of them would list one endpoint where the cluster
  // has several machines, and answer a conversation lookup from whichever it
  // picked.
  const services = kubectl(
    "get",
    "svc",
    "-l",
    "app.kubernetes.io/name=agent-server",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  )
    .split(/\s+/)
    .filter(Boolean);
  expect(entries.map((entry) => entry.name).sort()).toEqual(services.sort());
});

test("a discovered entry is reachable through the in-cluster master", async ({
  request,
}) => {
  test.skip(!K8S, "there is no cluster in the tailnet profile");

  // The viewer's only path in is the rig's port-forward, and from there the
  // master proxies to cluster DNS. Nothing on this machine can resolve
  // `.svc.cluster.local`, so a 200 here is the in-cluster hop, not this one.
  for (const entry of await listEntries(request)) {
    expect(
      await proxyStatus(request, entry.id, "/server_info"),
      `${entry.host} was not reachable from inside the cluster`,
    ).toBe(200);
  }
});

test("scaling the pool changes the fleet within one poll, with nothing enrolled", async ({
  request,
}) => {
  test.skip(!K8S, "there is no cluster in the tailnet profile");
  test.setTimeout(600_000);

  const before = await listEntries(request);
  const release = rig.releases?.pool as string;

  // `kubectl scale` moves pods, not Services, and a pool member is a Service
  // — one per member, because members are not interchangeable. So the scale
  // that changes the fleet is the chart's own replica count.
  execFileSync(
    "helm",
    [
      "--kubeconfig",
      rig.kubeconfig as string,
      "upgrade",
      release,
      "helm/agent-canvas",
      "-n",
      rig.namespace as string,
      "--reuse-values",
      "--set",
      "agentPool.replicas=3",
      "--wait",
      "--timeout",
      "10m",
    ],
    { encoding: "utf8" },
  );

  await pollForEntries(
    request,
    (entries) => entries.filter((e) => e.state === "active").length ===
      before.length + 1,
    "the new pool member never reached the registry",
  );

  const after = await listEntries(request);
  const added = after.filter(
    (entry) => !before.some((existing) => existing.id === entry.id),
  );
  expect(added).toHaveLength(1);
  // Nothing was enrolled, no key was distributed, no fingerprint pre-seeded:
  // the machine joined the fleet by existing in the namespace.
  expect(added[0].source).toBe("k8s");
  expect(added[0].credRef).toBeNull();
  expect(added[0].state).toBe("active");
  expect(await proxyStatus(request, added[0].id, "/server_info")).toBe(200);

  console.log(
    `the fleet grew to ${after.length} with no enrolment: ${added[0].name}`,
  );
});

test("a deleted Service goes stale rather than being forgotten", async ({
  request,
}) => {
  test.skip(!K8S, "there is no cluster in the tailnet profile");
  test.setTimeout(300_000);

  // @spec FR-023
  const entries = await listEntries(request);
  const victim = entries[entries.length - 1];

  kubectl("delete", "svc", victim.name);

  await pollForEntries(
    request,
    (current) =>
      current.find((entry) => entry.id === victim.id)?.state === "stale",
    `${victim.name} never went stale`,
  );

  const after = await listEntries(request);
  const same = after.find((entry) => entry.id === victim.id);
  // Deleting rather than staling would also drop an operator's revocation of
  // that machine, and a machine missing from one listing is usually a blip.
  expect(same, "the entry was deleted instead of staled").toBeDefined();
  expect(same?.state).toBe("stale");
  expect(after).toHaveLength(entries.length);
});

test("the registry keeps listing after the ServiceAccount token rotates", async ({
  request,
}) => {
  test.skip(!K8S, "there is no cluster in the tailnet profile");
  // The kubelet rewrites a projected token at about 80% of its life, and the
  // rig asks for the shortest expiry the TokenRequest API allows, so the
  // rotation lands around eight minutes in.
  test.setTimeout(20 * 60_000);

  // A process that reads the token once at boot starts getting 401s when it
  // rotates and never recovers, and the source loop swallows the error — the
  // registry simply stops listing with nothing in the logs to say why. This
  // waits for a real rotation, performed by the kubelet, rather than faking
  // one: a fake proves the test, not the mechanism.
  const pod = kubectl(
    "get",
    "pod",
    "-l",
    `app.kubernetes.io/instance=${rig.releases?.canvas}`,
    "-o",
    "jsonpath={.items[0].metadata.name}",
  );
  const readToken = () =>
    kubectl(
      "exec",
      pod,
      "--",
      "cat",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );

  const before = readToken();
  expect(before.length, "the pod has no ServiceAccount token").toBeGreaterThan(
    0,
  );

  await expect
    .poll(() => readToken() !== before, {
      timeout: 15 * 60_000,
      intervals: [30_000],
      message: "the kubelet never rotated the projected token",
    })
    .toBe(true);
  console.log(`the kubelet rotated ${pod}'s ServiceAccount token`);

  // The assertion: a full fleet is still listed after the source has had to
  // read credentials again, and it is still reachable.
  const entries = await listEntries(request);
  const active = entries.filter((entry) => entry.state === "active");
  expect(
    active.length,
    "the registry stopped listing after the token rotated",
  ).toBeGreaterThan(0);
  expect(await proxyStatus(request, active[0].id, "/server_info")).toBe(200);

  // And nothing in the pod's log says the source failed a cycle — including
  // the TLS failure the CA dispatcher exists to prevent, asserted here
  // against a real API server rather than a stub fetch.
  const logs = execFileSync(
    "kubectl",
    [
      "--kubeconfig",
      rig.kubeconfig as string,
      "-n",
      rig.namespace as string,
      "logs",
      pod,
      "--tail=1000",
    ],
    { encoding: "utf8" },
  );
  for (const signature of [
    "unable to verify the first certificate",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "certificate has expired",
    "self-signed certificate",
  ]) {
    expect(logs, `the pod logged a TLS failure: ${signature}`).not.toContain(
      signature,
    );
  }
  expect(logs, "the source loop reported a failed cycle").not.toContain(
    "[registry:k8s] sync failed",
  );
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
  await expect(page.getByTestId(`manage-backends-row-${NODE1}`)).toHaveCount(
    0,
    {
      timeout: 20_000,
    },
  );
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
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // @spec FR-007
  reEnrol("node1");
  const entries = await listEntries(request);
  expect(entries).toHaveLength(2);
  expect(
    entryNamed(entries, NODE1).state,
    "dropping a host from the allowlist has to be final",
  ).toBe("revoked");
});
