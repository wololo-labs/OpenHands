#!/usr/bin/env node
/**
 * `agent-canvas enrol`: register this machine with a fleet registry.
 *
 * The fork owns the enrolment protocol so that any deployment method (the
 * fleet-lambda installer, Helm, Ansible, a human at a prompt) invokes one
 * command and never has to know the payload shape, the signature scheme, or
 * the endpoint. Changing the protocol never means editing another repository.
 *
 * The node registers itself rather than the deploy script registering on its
 * behalf: script-side registration needs no keypair, but nothing re-announces
 * after a reboot, an address change or a restore, so the registry drifts from
 * reality.
 */

import { homedir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createSecretProvider,
  SECRET_PROVIDER_NAMES,
} from "../scripts/registry/secrets/interface.mjs";
import { credRefFor } from "../scripts/registry/store.mjs";
import {
  buildRegistrationBody,
  DEFAULT_HOST_KEY_PATH,
  generateKeyPair,
  loadKeyPair,
  postRegistration,
  signRegistration,
} from "../scripts/registry/sign.mjs";

const FALLBACK_KEY_PATH = join(
  homedir(),
  ".openhands",
  "agent-canvas",
  "enrol_ed25519",
);

export function showHelp(log = console.log) {
  log(`
agent-canvas enrol - register this machine with a fleet registry

USAGE:
  agent-canvas enrol --registry <url> --name <name> --host <url> [options]

OPTIONS:
  --registry <url>          Fleet registry to register with (required unless
                            --print-fingerprint is used)
  --name <name>             Name shown in the backend switcher
  --host <url>              URL other machines reach this agent server on
  --secret-provider <name>  Where to publish this machine's session key
                            (${SECRET_PROVIDER_NAMES.join(", ")})
  --secret <value>          Session key to publish; defaults to
                            OH_SESSION_API_KEYS_0 or SESSION_API_KEY
  --cred-ref <ref>          Declare that this machine's session key has been
                            published out of band. The registry derives the
                            reference it stores from this host's fingerprint,
                            so the value passed here is advisory and the
                            derived one is printed for you
  --version <version>       Agent server version to record
  --key <path>              Private key to sign with
                            (default: ${DEFAULT_HOST_KEY_PATH})
  --generate-key            Generate a key when --key is absent, instead of
                            failing (written to ${FALLBACK_KEY_PATH}, and
                            reused by later runs so the fingerprint is stable)
  --print-fingerprint       Print the key's SHA256 fingerprint and exit,
                            for pre-seeding the registry allowlist
  -h, --help                Show this help

NOTES:
  Reuses the host's existing ed25519 SSH key by default, so there is no key to
  generate, distribute or back up, and the fingerprint printed here is the one
  \`ssh-keygen -lf\` already prints for this machine.

  Re-running updates the entry for that fingerprint; it never creates a second.

EXAMPLES:
  # Pre-seed step: print the fingerprint without touching the network
  agent-canvas enrol --print-fingerprint

  # Register after the installer's health check passes
  agent-canvas enrol \\
    --registry https://master.example.ts.net:8443 \\
    --name hetzner \\
    --host https://claude-hetzner.example.ts.net:8443 \\
    --secret-provider op
`);
}

export function parseArgs(argv) {
  const options = {
    registry: null,
    name: null,
    host: null,
    secretProvider: null,
    secret: null,
    credRef: null,
    version: null,
    keyPath: DEFAULT_HOST_KEY_PATH,
    keyPathExplicit: false,
    generateKey: false,
    printFingerprint: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--registry":
        options.registry = argv[++i] ?? null;
        break;
      case "--name":
        options.name = argv[++i] ?? null;
        break;
      case "--host":
        options.host = argv[++i] ?? null;
        break;
      case "--secret-provider":
        options.secretProvider = argv[++i] ?? null;
        break;
      case "--secret":
        options.secret = argv[++i] ?? null;
        break;
      case "--cred-ref":
        options.credRef = argv[++i] ?? null;
        break;
      case "--version":
        options.version = argv[++i] ?? null;
        break;
      case "--key":
        options.keyPath = argv[++i] ?? DEFAULT_HOST_KEY_PATH;
        options.keyPathExplicit = true;
        break;
      case "--generate-key":
        options.generateKey = true;
        break;
      case "--print-fingerprint":
        options.printFingerprint = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

/**
 * Where this machine's session key must be published.
 *
 * Derived from the host key's fingerprint rather than chosen, because the
 * registry derives the same value and ignores whatever a registration asks
 * for: a node that could name its own reference could name one belonging to
 * another machine. Re-exported under the old name so callers keep working.
 */
export function credRefForKeyPair(keyPair) {
  return credRefFor(keyPair.fingerprint);
}

function resolveSecret(options, env) {
  return (
    options.secret || env.OH_SESSION_API_KEYS_0 || env.SESSION_API_KEY || null
  );
}

async function resolveKeyPair(options) {
  try {
    return await loadKeyPair(options.keyPath);
  } catch (error) {
    // An explicitly named key that cannot be read is an operator mistake, not
    // an invitation to invent a different identity.
    if (options.keyPathExplicit || !options.generateKey) {
      throw error;
    }
  }

  // A generated key is this machine's identity, so it has to survive
  // re-enrolment: generating a fresh one on every run would give the machine a
  // new fingerprint each time, and since the entry is keyed by fingerprint the
  // registry would collect one extra `pending` entry per run instead of
  // updating the one that is already there (FR-006).
  try {
    return await loadKeyPair(FALLBACK_KEY_PATH);
  } catch {
    return generateKeyPair(FALLBACK_KEY_PATH);
  }
}

export async function runEnrol(
  argv,
  { env = process.env, log = console.log, fetchImpl = fetch } = {},
) {
  const options = parseArgs(argv);

  if (options.help) {
    showHelp(log);
    return 0;
  }

  const keyPair = await resolveKeyPair(options);

  // Deliberately before any argument validation and before any network call:
  // pre-seeding runs on a machine that does not yet know the registry URL.
  if (options.printFingerprint) {
    log(keyPair.fingerprint);
    return 0;
  }

  if (!options.registry) throw new Error("--registry is required");
  if (!options.name) throw new Error("--name is required");
  if (!options.host) throw new Error("--host is required");

  // The registry derives the stored reference from this machine's fingerprint,
  // so the only thing a registration decides is *whether* there is a credential
  // to resolve at all.
  const derivedCredRef = credRefForKeyPair(keyPair);
  let credRef = null;
  if (options.secretProvider) {
    const provider = createSecretProvider(options.secretProvider);
    const health = await provider.describe();
    if (!health.healthy) {
      throw new Error(
        `secret provider "${options.secretProvider}" is not usable: ${health.detail ?? "unknown reason"}`,
      );
    }

    const secret = resolveSecret(options, env);
    if (!secret) {
      throw new Error(
        "no session key to publish; pass --secret or set OH_SESSION_API_KEYS_0",
      );
    }

    credRef = derivedCredRef;
    await provider.put(credRef, secret);
    log(`Published this machine's session key at: ${credRef}`);
  } else if (options.credRef) {
    // A reference without a provider is legitimate: the operator published the
    // secret out of band. The value they passed is advisory -- the registry
    // stores the derived one -- so say where the secret actually has to live.
    credRef = derivedCredRef;
    if (options.credRef !== derivedCredRef) {
      log(`Publish this machine's session key at: ${derivedCredRef}`);
    }
  }

  const body = buildRegistrationBody({
    name: options.name,
    host: options.host,
    pubkey: keyPair.pubkey,
    credRef,
    version: options.version,
  });

  const result = await postRegistration({
    registryUrl: options.registry,
    body,
    signature: signRegistration(body, keyPair.privateKey),
    fetchImpl,
  });

  log(`${result.state ?? "unknown"} ${result.id ?? ""}`.trim());
  if (result.state === "pending") {
    log(
      `Not connectable until approved. Pre-seed or approve: ${keyPair.fingerprint}`,
    );
  }
  return 0;
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runEnrol(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `enrol failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
