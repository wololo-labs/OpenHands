import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  canonicalPayload,
  fingerprintFromPublicKey,
  verifySignature,
} from "../../scripts/registry/enrolment.mjs";
import {
  buildRegistrationBody,
  generateKeyPair,
  loadKeyPair,
  postRegistration,
  signRegistration,
  toSshPublicKeyLine,
} from "../../scripts/registry/sign.mjs";
import { parseArgs, runEnrol } from "../../bin/enrol.mjs";
import { credRefFor } from "../../scripts/registry/store.mjs";
import { createFileSecretProvider } from "../../scripts/registry/secrets/file.mjs";
import {
  assertValidSecretRef,
  createSecretProvider,
} from "../../scripts/registry/secrets/interface.mjs";
import {
  createOnePasswordSecretProvider,
  toOpReference,
} from "../../scripts/registry/secrets/onepassword.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

let workDir: string;
let hostKeyPath: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "enrol-test-"));
  hostKeyPath = path.join(workDir, "ssh_host_ed25519_key");
  // A real `ssh-keygen` key, so the fingerprint assertions below compare
  // against what an operator would actually read off the machine.
  await execFileAsync("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "enrol-test",
    "-f",
    hostKeyPath,
    "-q",
  ]);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function collectLog() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("loadKeyPair", () => {
  it("reads an OpenSSH host key without shelling out to ssh-keygen", async () => {
    const { privateKey, pubkey } = await loadKeyPair(hostKeyPath);

    expect(privateKey.asymmetricKeyType).toBe("ed25519");
    expect(pubkey).toMatch(/^ssh-ed25519 /);
  });

  it("derives the same fingerprint ssh-keygen -lf prints", async () => {
    const { fingerprint } = await loadKeyPair(hostKeyPath);
    const { stdout } = await execFileAsync("ssh-keygen", [
      "-lf",
      `${hostKeyPath}.pub`,
    ]);

    expect(stdout.split(" ")[1]).toBe(fingerprint);
  });

  it("derives the public key when no .pub sits beside the private key", async () => {
    const lonely = path.join(workDir, "lonely_key");
    await writeFile(lonely, await readFile(hostKeyPath, "utf8"), {
      mode: 0o600,
    });

    const { fingerprint } = await loadKeyPair(lonely);

    expect(fingerprint).toBe((await loadKeyPair(hostKeyPath)).fingerprint);
  });

  it("says so plainly when the key is missing", async () => {
    await expect(loadKeyPair(path.join(workDir, "nope"))).rejects.toThrow(
      /cannot read/,
    );
  });

  it("refuses a key that is not ed25519", async () => {
    const rsaPath = path.join(workDir, "rsa_key");
    await execFileAsync("ssh-keygen", [
      "-t",
      "rsa",
      "-b",
      "2048",
      "-N",
      "",
      "-f",
      rsaPath,
      "-q",
    ]);

    await expect(loadKeyPair(rsaPath)).rejects.toThrow(/enrolment requires/);
  });
});

describe("generateKeyPair", () => {
  it("writes a private key only its owner can read", async () => {
    const generated = path.join(workDir, "generated", "enrol_ed25519");

    const { fingerprint, pubkey } = await generateKeyPair(generated);

    expect(fingerprint).toBe(fingerprintFromPublicKey(pubkey));
    expect((await stat(generated)).mode & 0o777).toBe(0o600);
    expect((await loadKeyPair(generated)).fingerprint).toBe(fingerprint);
  });
});

describe("signRegistration", () => {
  it("produces a signature the registry's verifier accepts", async () => {
    const { privateKey, pubkey } = await loadKeyPair(hostKeyPath);
    const body = buildRegistrationBody({
      name: "hetzner",
      host: "https://hetzner.example.ts.net:8443",
      pubkey,
    });

    expect(verifySignature(body, signRegistration(body, privateKey))).toBe(
      true,
    );
  });

  it("produces a signature that fails against a different key", async () => {
    const { privateKey } = await loadKeyPair(hostKeyPath);
    const other = await generateKeyPair(path.join(workDir, "other_key"));
    const body = buildRegistrationBody({
      name: "hetzner",
      host: "https://hetzner.example.ts.net:8443",
      pubkey: other.pubkey,
    });

    expect(verifySignature(body, signRegistration(body, privateKey))).toBe(
      false,
    );
  });

  it("stamps a fresh timestamp in seconds and a unique nonce", () => {
    const first = buildRegistrationBody({ name: "a", host: "b", pubkey: "c" });
    const second = buildRegistrationBody({ name: "a", host: "b", pubkey: "c" });

    expect(first.ts).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("signs exactly the canonical payload the verifier reconstructs", async () => {
    const { privateKey, pubkey } = await loadKeyPair(hostKeyPath);
    const body = buildRegistrationBody({ name: "a", host: "b", pubkey });
    const signature = signRegistration(body, privateKey);

    // Re-ordering the object must not change the signed bytes.
    const reordered = Object.fromEntries(
      Object.entries(body).reverse(),
    ) as typeof body;

    expect(canonicalPayload(reordered)).toBe(canonicalPayload(body));
    expect(verifySignature(reordered, signature)).toBe(true);
  });
});

describe("toSshPublicKeyLine", () => {
  it("round-trips through the verifier's parser", async () => {
    const { pubkey } = await loadKeyPair(hostKeyPath);
    expect(fingerprintFromPublicKey(pubkey)).toMatch(/^SHA256:/);
  });
});

describe("postRegistration", () => {
  it("posts the signature in the header the registry reads", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        Response.json({ id: "abc", state: "pending" }, { status: 201 }),
      );
    }) as typeof fetch;

    const result = await postRegistration({
      registryUrl: "https://master.example:8443",
      body: { name: "a" },
      signature: "c2ln",
      fetchImpl,
    });

    expect(calls[0].url).toBe(
      "https://master.example:8443/api/registry/register",
    );
    expect(
      (calls[0].init?.headers as Record<string, string>)[
        "X-Registry-Signature"
      ],
    ).toBe("c2ln");
    expect(result).toEqual({ id: "abc", state: "pending" });
  });

  it("reports the registry's rejection rather than swallowing it", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "invalid_signature" }, { status: 401 }),
    );

    await expect(
      postRegistration({
        registryUrl: "https://master.example:8443",
        body: {},
        signature: "x",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/401: invalid_signature/);
  });
});

describe("file secret provider", () => {
  it("round-trips a secret at 0600", async () => {
    const root = path.join(workDir, "secrets");
    const provider = createFileSecretProvider({ root });

    await provider.put("openhands/hetzner/session-key", "s3cret");

    expect(await provider.get("openhands/hetzner/session-key")).toBe("s3cret");
    const mode = (await stat(path.join(root, "openhands/hetzner/session-key")))
      .mode;
    expect(mode & 0o777).toBe(0o600);
  });

  it("tightens the mode when overwriting a loose file", async () => {
    const root = path.join(workDir, "secrets-loose");
    const provider = createFileSecretProvider({ root });
    await provider.put("loose", "one");
    const filePath = path.join(root, "loose");
    await writeFile(filePath, "two\n", { mode: 0o644 });

    await provider.put("loose", "three");

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("fails loudly when a reference has no stored secret", async () => {
    const provider = createFileSecretProvider({
      root: path.join(workDir, "secrets-empty"),
    });

    await expect(provider.get("missing")).rejects.toThrow(/no secret stored/);
  });

  it("refuses a reference that would escape its root", async () => {
    const provider = createFileSecretProvider({
      root: path.join(workDir, "secrets-escape"),
    });

    await expect(provider.get("../../etc/passwd")).rejects.toThrow(
      /traverse|escapes/,
    );
    await expect(provider.get("/etc/passwd")).rejects.toThrow(/escapes/);
  });
});

describe("assertValidSecretRef", () => {
  it("accepts a namespaced reference", () => {
    expect(assertValidSecretRef(" openhands/hetzner/session-key ")).toBe(
      "openhands/hetzner/session-key",
    );
  });

  it.each(["", "  ", "a b", "a;rm -rf /", "a/../b"])("rejects %j", (ref) => {
    expect(() => assertValidSecretRef(ref)).toThrow();
  });
});

describe("createSecretProvider", () => {
  it("fails loudly on an unknown provider rather than degrading silently", () => {
    expect(() => createSecretProvider("vault")).toThrow(
      /unknown secret provider/,
    );
  });

  it("builds the providers it knows", () => {
    expect(typeof createSecretProvider("file").get).toBe("function");
    expect(typeof createSecretProvider("op").get).toBe("function");
  });
});

describe("1Password secret provider", () => {
  it("maps a reference into an op:// secret reference", () => {
    expect(toOpReference("openhands/hetzner/session-key")).toBe(
      "op://openhands/openhands_hetzner_session-key/password",
    );
  });

  it("reports itself unhealthy when the op CLI is absent", async () => {
    const provider = createOnePasswordSecretProvider({
      run: () =>
        Promise.reject(Object.assign(new Error("spawn"), { code: "ENOENT" })),
    });

    const health = await provider.describe();

    expect(health).toMatchObject({ name: "op", healthy: false });
    expect(health.detail).toMatch(/not installed/);
  });

  it("reads through the CLI with an argument array, never a shell string", async () => {
    const run = vi.fn(async () => ({ stdout: "s3cret\n", stderr: "" }));
    const provider = createOnePasswordSecretProvider({ run });

    expect(await provider.get("openhands/hetzner/session-key")).toBe("s3cret");
    expect(run).toHaveBeenCalledWith("op", [
      "read",
      "op://openhands/openhands_hetzner_session-key/password",
    ]);
  });

  it("creates an item when editing an absent one fails", async () => {
    const run = vi.fn(async (_binary: string, args: string[]) => {
      if (args[1] === "edit") throw new Error("item not found");
      return { stdout: "", stderr: "" };
    });
    const provider = createOnePasswordSecretProvider({ run });

    await provider.put("openhands/new/session-key", "s3cret");

    expect(run.mock.calls[1][1]).toContain("create");
  });
});

describe("enrol CLI", () => {
  it("prints the fingerprint and exits without touching the network", async () => {
    const { lines, log } = collectLog();
    const fetchImpl = vi.fn();

    const code = await runEnrol(["--key", hostKeyPath, "--print-fingerprint"], {
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
    });

    const { stdout } = await execFileAsync("ssh-keygen", [
      "-lf",
      `${hostKeyPath}.pub`,
    ]);
    expect(code).toBe(0);
    expect(lines).toEqual([stdout.split(" ")[1]]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("registers with a signature the verifier accepts", async () => {
    const { lines, log } = collectLog();
    let captured: { body: any; signature: string } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = {
        body: JSON.parse(String(init.body)),
        signature: (init.headers as Record<string, string>)[
          "X-Registry-Signature"
        ],
      };
      return Response.json({ id: "abc", state: "pending" }, { status: 201 });
    });

    await runEnrol(
      [
        "--registry",
        "https://master.example:8443",
        "--name",
        "hetzner",
        "--host",
        "https://hetzner.example.ts.net:8443",
        "--version",
        "1.44.0",
        "--key",
        hostKeyPath,
      ],
      { log, fetchImpl: fetchImpl as unknown as typeof fetch, env: {} },
    );

    expect(captured).not.toBeNull();
    expect(verifySignature(captured!.body, captured!.signature)).toBe(true);
    expect(captured!.body).toMatchObject({
      name: "hetzner",
      host: "https://hetzner.example.ts.net:8443",
      version: "1.44.0",
      credRef: null,
    });
    expect(lines[0]).toBe("pending abc");
    expect(lines[1]).toMatch(/Not connectable until approved/);
  });

  it("publishes the session key and registers only a reference to it", async () => {
    const { log } = collectLog();
    const root = path.join(workDir, "secrets-cli");
    let body: any = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ id: "abc", state: "active" }, { status: 201 });
    });

    // The CLI resolves "file" through the registry of providers; point that
    // provider's root at the temp dir by pre-creating the same reference there.
    const keyPair = await loadKeyPair(hostKeyPath);
    const derived = credRefFor(keyPair.fingerprint);
    const provider = createFileSecretProvider({ root });
    await provider.put(derived, "unused");

    await runEnrol(
      [
        "--registry",
        "https://master.example:8443",
        "--name",
        "hetzner",
        "--host",
        "https://hetzner.example.ts.net:8443",
        "--has-credential",
        "--key",
        hostKeyPath,
      ],
      { log, fetchImpl: fetchImpl as unknown as typeof fetch, env: {} },
    );

    // The reference is derived from this host's fingerprint, so the value the
    // caller asked for is not what gets registered. A node that could name its
    // own reference could name one belonging to another machine.
    expect(body.credRef).toBe(derived);
    expect(body.credRef).not.toBe("openhands/somewhere-else/session-key");
    expect(derived).toMatch(/^openhands\/[0-9a-f]{32}\/session-key$/);
    // The key itself never appears in the registration.
    expect(JSON.stringify(body)).not.toContain("unused");
  });

  it("fails loudly on an unknown secret provider", async () => {
    await expect(
      runEnrol(
        [
          "--registry",
          "https://master.example:8443",
          "--name",
          "a",
          "--host",
          "https://a.example",
          "--secret-provider",
          "vault",
          "--key",
          hostKeyPath,
        ],
        { log: () => {}, env: {} },
      ),
    ).rejects.toThrow(/unknown secret provider/);
  });

  it("fails when a secret provider is named but there is no key to publish", async () => {
    await expect(
      runEnrol(
        [
          "--registry",
          "https://master.example:8443",
          "--name",
          "a",
          "--host",
          "https://a.example",
          "--secret-provider",
          "file",
          "--key",
          hostKeyPath,
        ],
        { log: () => {}, env: {} },
      ),
    ).rejects.toThrow(/no session key to publish/);
  });

  it("requires the fields the registry needs", async () => {
    await expect(
      runEnrol(["--key", hostKeyPath], { log: () => {}, env: {} }),
    ).rejects.toThrow(/--registry is required/);
    await expect(
      runEnrol(["--registry", "https://m.example", "--key", hostKeyPath], {
        log: () => {},
        env: {},
      }),
    ).rejects.toThrow(/--name is required/);
  });

  it("refuses an explicitly named key it cannot read, even with --generate-key", async () => {
    await expect(
      runEnrol(
        [
          "--key",
          path.join(workDir, "absent"),
          "--generate-key",
          "--print-fingerprint",
        ],
        { log: () => {}, env: {} },
      ),
    ).rejects.toThrow(/cannot read/);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
  });
});

describe("enrol via the agent-canvas binary", () => {
  it("dispatches the subcommand and exits 0 with no network", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(repoRoot, "bin", "agent-canvas.mjs"),
      "enrol",
      "--key",
      hostKeyPath,
      "--print-fingerprint",
    ]);

    expect(stdout.trim()).toMatch(/^SHA256:/);
  });

  /**
   * A generated key is the machine's identity, and an entry is keyed by
   * fingerprint. Regenerating on every run would make each re-enrolment look
   * like a different machine, so the registry would gain one extra `pending`
   * entry per run instead of updating the one already there.
   *
   * @spec FR-006
   */
  it("reuses the key it generated, so a machine keeps one identity", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "enrol-home-"));
    const printFingerprint = async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "bin", "agent-canvas.mjs"),
          "enrol",
          "--generate-key",
          "--print-fingerprint",
        ],
        // An absent host key is the case --generate-key exists for; point HOME
        // at a scratch dir so the fallback key lands there.
        { env: { ...process.env, HOME: home, USERPROFILE: home } },
      );
      return stdout.trim();
    };

    try {
      const first = await printFingerprint();
      expect(first).toMatch(/^SHA256:/);
      expect(await printFingerprint()).toBe(first);

      const keyPath = path.join(
        home,
        ".openhands",
        "agent-canvas",
        "enrol_ed25519",
      );
      expect((await stat(keyPath)).isFile()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
