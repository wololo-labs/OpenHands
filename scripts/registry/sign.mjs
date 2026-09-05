/**
 * Signing side of the enrolment contract.
 *
 * A node signs its registration with the ed25519 host key every Linux and
 * macOS box already has at `/etc/ssh/ssh_host_ed25519_key`. Nothing needs
 * generating, distributing or backing up, and the fingerprint an operator
 * pre-seeds is the one `ssh-keygen -lf` already prints for that host.
 *
 * The signature is a raw ed25519 signature over `canonicalPayload(body)`, the
 * same function the verifier uses (`scripts/registry/enrolment.mjs`), so the
 * two ends cannot drift.
 *
 * Node's OpenSSL decoder cannot read the `OPENSSH PRIVATE KEY` container, so
 * the unencrypted form of it is unwrapped here and handed to `node:crypto` as
 * PKCS#8. That still adds no crypto library and no dependency on `ssh-keygen`
 * being installed on the node. Encrypted host keys are not supported; host
 * keys are unencrypted by construction, since sshd has to read them
 * unattended at boot.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signEd25519,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalPayload, fingerprintFromPublicKey } from "./enrolment.mjs";

export const DEFAULT_HOST_KEY_PATH = "/etc/ssh/ssh_host_ed25519_key";
const SSH_ED25519 = "ssh-ed25519";
const OPENSSH_PEM_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_MAGIC = "openssh-key-v1\0";
// DER PKCS#8 header for an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** Sequential reader for the SSH wire format: uint32 length, then bytes. */
function createSshReader(buffer) {
  let offset = 0;
  return {
    uint32() {
      if (offset + 4 > buffer.length) throw new Error("truncated key");
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    string() {
      const length = this.uint32();
      if (offset + length > buffer.length) throw new Error("truncated key");
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    take(length) {
      if (offset + length > buffer.length) throw new Error("truncated key");
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
  };
}

/**
 * Unwraps an unencrypted `OPENSSH PRIVATE KEY` container and returns the
 * ed25519 seed. The format is: magic, cipher, kdf, kdf options, key count,
 * the public key, then a private section holding two matching check integers,
 * the key type, the public key again, and the 64-byte secret (seed || public).
 */
export function extractOpenSshEd25519Seed(pem) {
  const base64 = pem
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
  const reader = createSshReader(Buffer.from(base64, "base64"));

  if (reader.take(OPENSSH_MAGIC.length).toString("binary") !== OPENSSH_MAGIC) {
    throw new Error("not an OpenSSH private key");
  }

  const cipher = reader.string().toString("utf8");
  reader.string(); // kdfname, meaningless while the cipher is "none"
  reader.string(); // kdfoptions
  if (cipher !== "none") {
    throw new Error(
      `the key is encrypted with ${cipher}; enrolment needs an unencrypted host key`,
    );
  }

  if (reader.uint32() !== 1) {
    throw new Error("expected exactly one key in the container");
  }
  reader.string(); // public key blob, re-read from the private section below

  const priv = createSshReader(reader.string());
  if (priv.uint32() !== priv.uint32()) {
    // Mismatched check integers mean the section did not decrypt, which for an
    // unencrypted key means the file is corrupt.
    throw new Error("private key section is corrupt");
  }

  const keyType = priv.string().toString("utf8");
  if (keyType !== SSH_ED25519) {
    throw new Error(`the key is ${keyType}; enrolment requires ${SSH_ED25519}`);
  }

  priv.string(); // public key
  const secret = priv.string();
  if (secret.length !== 64) {
    throw new Error("unexpected ed25519 secret length");
  }
  return secret.subarray(0, 32);
}

function readPrivateKey(pem, keyPath) {
  try {
    if (pem.includes(OPENSSH_PEM_HEADER)) {
      return createPrivateKey({
        key: Buffer.concat([
          PKCS8_ED25519_PREFIX,
          extractOpenSshEd25519Seed(pem),
        ]),
        format: "der",
        type: "pkcs8",
      });
    }
    return createPrivateKey(pem);
  } catch (error) {
    throw new Error(
      `${keyPath} is not a usable unencrypted ed25519 private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Renders a public key object as an `ssh-ed25519 AAAA...` line. */
export function toSshPublicKeyLine(publicKey, comment = "") {
  // SPKI DER for Ed25519 is a fixed 12-byte header followed by the raw key.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const type = Buffer.from(SSH_ED25519, "utf8");
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, raw.length]),
    raw,
  ]);
  const line = `${SSH_ED25519} ${blob.toString("base64")}`;
  return comment ? `${line} ${comment}` : line;
}

/**
 * Loads a private key and the public key line that goes with it. A sibling
 * `.pub` is preferred when present so the operator sees the same comment
 * `ssh-keygen` shows; otherwise the public key is derived from the private one.
 */
export async function loadKeyPair(keyPath) {
  let pem;
  try {
    pem = await readFile(keyPath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${keyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKey = readPrivateKey(pem, keyPath);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `${keyPath} is a ${privateKey.asymmetricKeyType} key; enrolment requires ed25519`,
    );
  }

  let pubkey;
  try {
    pubkey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  } catch {
    pubkey = toSshPublicKeyLine(createPublicKey(privateKey));
  }

  return { privateKey, pubkey, fingerprint: fingerprintFromPublicKey(pubkey) };
}

/**
 * Writes a new ed25519 keypair, used only when the host has no key to reuse.
 * The private key is PKCS#8 PEM rather than OpenSSH format, which Node cannot
 * emit; both read back the same way.
 */
export async function generateKeyPair(keyPath, comment = "agent-canvas-enrol") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubkey = toSshPublicKeyLine(publicKey, comment);

  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(
    keyPath,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await chmod(keyPath, 0o600);
  await writeFile(`${keyPath}.pub`, `${pubkey}\n`, { mode: 0o644 });

  return { privateKey, pubkey, fingerprint: fingerprintFromPublicKey(pubkey) };
}

/** The registration body, minus the signature. */
export function buildRegistrationBody({
  name,
  host,
  pubkey,
  credRef = null,
  version = null,
  now = () => Date.now(),
  nonce = randomBytes(16).toString("hex"),
}) {
  return {
    name,
    host,
    pubkey,
    credRef,
    version,
    nonce,
    // Epoch seconds, matching the verifier's freshness window.
    ts: Math.floor(now() / 1000),
  };
}

export function signRegistration(body, privateKey) {
  return signEd25519(
    null,
    Buffer.from(canonicalPayload(body), "utf8"),
    privateKey,
  ).toString("base64");
}

/** POSTs a signed registration and returns the registry's `{id, state}`. */
export async function postRegistration({
  registryUrl,
  body,
  signature,
  fetchImpl = fetch,
}) {
  const url = new URL("/api/registry/register", registryUrl).toString();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Registry-Signature": signature,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.error ?? text.slice(0, 200) ?? "";
    throw new Error(
      `registration rejected with ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return parsed ?? {};
}
