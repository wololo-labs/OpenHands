/**
 * Kubernetes pull source.
 *
 * Lists Services labelled `app.kubernetes.io/name=agent-server` in a
 * namespace and feeds them to the registry. In a cluster the Service list is
 * already the membership list, so scaling an agent pool changes the backend
 * switcher with nothing to enrol and no keys to distribute.
 *
 * Reads the in-cluster ServiceAccount credentials; it does not shell out to
 * `kubectl` and needs no kubeconfig.
 */

import { readFile } from "node:fs/promises";

import { probeServerInfo, syncSourceEntries } from "./sync.mjs";

const SA_ROOT = "/var/run/secrets/kubernetes.io/serviceaccount";
export const AGENT_SERVER_LABEL_SELECTOR =
  "app.kubernetes.io/name=agent-server";
export const K8S_SOURCE = "k8s";

/**
 * Reads the in-cluster API server address and ServiceAccount token.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   readFileImpl?: (path: string, encoding: string) => Promise<string>,
 *   root?: string,
 * }} [options]
 */
export async function readInClusterConfig({
  env = process.env,
  readFileImpl = readFile,
  root = SA_ROOT,
} = {}) {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    throw new Error(
      "not running in a cluster: KUBERNETES_SERVICE_HOST is unset",
    );
  }

  const [token, namespace, ca] = await Promise.all([
    readFileImpl(`${root}/token`, "utf8"),
    readFileImpl(`${root}/namespace`, "utf8"),
    readFileImpl(`${root}/ca.crt`, "utf8").catch(() => null),
  ]);

  return {
    apiServer: `https://${host}:${port}`,
    token: token.trim(),
    namespace: namespace.trim(),
    ca,
  };
}

/**
 * A Service's namespaced name is stable for the life of that Service, so it is
 * the identity a discovered entry is keyed by. The `k8s:` prefix keeps it from
 * ever colliding with an SSH fingerprint from signed enrolment.
 */
export function serviceFingerprint(namespace, name) {
  return `k8s:${namespace}/${name}`;
}

function servicePort(service) {
  const ports = service?.spec?.ports ?? [];
  const named = ports.find((port) => port.name === "http");
  return (named ?? ports[0])?.port ?? 80;
}

export function serviceToCandidate(service) {
  const name = service?.metadata?.name;
  const namespace = service?.metadata?.namespace;
  if (!name || !namespace) return null;
  return {
    name,
    // The cluster-internal DNS name, because the registry runs in the cluster
    // too and this is what it will proxy to.
    host: `http://${name}.${namespace}.svc.cluster.local:${servicePort(service)}`,
    fingerprint: serviceFingerprint(namespace, name),
  };
}

export async function listAgentServerServices({
  config,
  fetchImpl = fetch,
  labelSelector = AGENT_SERVER_LABEL_SELECTOR,
}) {
  const url = new URL(
    `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/services`,
    config.apiServer,
  );
  url.searchParams.set("labelSelector", labelSelector);

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    throw new Error(`kubernetes API responded with ${response.status}`);
  }

  const body = await response.json();
  return (body?.items ?? [])
    .map(serviceToCandidate)
    .filter((candidate) => candidate !== null);
}

/**
 * Lists, probes for liveness and version, then writes into the store.
 *
 * @param {{
 *   store: any,
 *   config: { apiServer: string, token: string, namespace: string },
 *   fetchImpl?: typeof globalThis.fetch,
 *   labelSelector?: string,
 *   now?: () => number,
 * }} options
 */
export async function syncKubernetesSource({
  store,
  config,
  fetchImpl = fetch,
  labelSelector = AGENT_SERVER_LABEL_SELECTOR,
  now,
}) {
  const candidates = await listAgentServerServices({
    config,
    fetchImpl,
    labelSelector,
  });

  const entries = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeServerInfo(candidate.host, { fetchImpl });
      return {
        ...candidate,
        version: probe.version,
        reachable: probe.reachable,
      };
    }),
  );

  return syncSourceEntries({ store, source: K8S_SOURCE, entries, now });
}
