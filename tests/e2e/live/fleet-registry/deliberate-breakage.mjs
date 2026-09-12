#!/usr/bin/env node
/**
 * Layer 3: revert each gating fix, and watch a NAMED assertion go red.
 *
 *   node tests/e2e/live/fleet-registry/deliberate-breakage.mjs
 *   node tests/e2e/live/fleet-registry/deliberate-breakage.mjs --only bind-host
 *
 * A green suite is worth what its ability to go red is worth. Layer 2
 * (negative controls) and layer 4 (forgery) live in `falsification.spec.ts`
 * and run with every suite; this layer cannot, because it edits the source the
 * run is using. So it is a separate pass, run deliberately, that for each fix:
 *
 *   1  reverts it in the working tree, exactly as it was before,
 *   2  runs the one test that is supposed to notice, and requires it to FAIL,
 *   3  restores the file and requires the same test to pass again.
 *
 * A fix whose test still passes while the fix is reverted is reported as
 * UNPROVEN and exits non-zero: it means the assertion is decorative and the
 * green run it appears in proved nothing about that fix.
 *
 * Every edit is a literal string replacement with an assert that the string
 * was found, and every file is restored from the copy taken before the edit —
 * including when a run is interrupted.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const log = (...parts) => console.log("[breakage]", ...parts);

/**
 * The four fixes this run gates on, each with the edit that undoes it and the
 * assertion that must then go red.
 *
 * `test` is a vitest name filter, `spec` a Playwright one; a fix is proven by
 * whichever it names. The live profiles cannot prove the bind or the CA fix
 * from a spec — a rig that cannot start produces no assertions — so those are
 * proven by the unit assertions written for exactly that purpose.
 */
const FIXES = [
  {
    name: "url-guard-registry",
    what: "the registry's request check parses an unguarded URL",
    file: "scripts/registry/routes.mjs",
    from: `  const pathname = requestPathname(req);
  if (pathname === null) return false;`,
    to: `  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;`,
    vitest: {
      file: "__tests__/scripts/ingress.test.ts",
      test: "survives GET //[ with the registry mounted",
    },
  },
  {
    name: "url-guard-server-info",
    what: "the /server_info interception parses an unguarded URL",
    file: "scripts/proxy-utils.mjs",
    from: `export function isServerInfoRequest(req) {
  return requestPathname(req) === SERVER_INFO_PATH;
}`,
    to: `export function isServerInfoRequest(req) {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  return pathname === SERVER_INFO_PATH;
}`,
    vitest: {
      file: "__tests__/scripts/ingress.test.ts",
      test: "survives GET //[ with /server_info interception on",
    },
  },
  {
    name: "bind-host",
    what: "the master binds every interface again",
    file: "scripts/ingress.mjs",
    from: `  server.listen(config.port, config.host ?? DEFAULT_HOST, () => {`,
    to: `  server.listen(config.port, () => {`,
    vitest: {
      file: "__tests__/scripts/ingress.test.ts",
      test: "binds loopback only by default",
    },
  },
  {
    name: "cluster-ca",
    what: "the Kubernetes source drops the CA dispatcher",
    file: "scripts/registry/sources/k8s.mjs",
    from: `    // Dropping this makes every call fail TLS against a real cluster while
    // every mocked test stays green, so it is asserted on directly.
    ...(dispatcher ? { dispatcher } : {}),
`,
    to: "",
    vitest: {
      file: "__tests__/registry/sources.test.ts",
      test: "dials the API server through a dispatcher built from the cluster CA",
    },
  },
  {
    name: "sa-token-reread",
    what: "the ServiceAccount token is cached for the process lifetime",
    file: "scripts/registry/mount.mjs",
    from: `        sync: async () => {
          const config = await readConfig();
          await syncKubernetes({ store, config });
        },`,
    to: `        sync: async () => {
          cached = cached ?? (await readConfig());
          await syncKubernetes({ store, config: cached });
        },`,
    // The cached binding the reverted version needs, declared where the
    // original had no need of one.
    extra: {
      from: `  const stops = [];
  const intervalMs = registryConfig.sourceIntervalMs ?? undefined;`,
      to: `  const stops = [];
  let cached = null;
  const intervalMs = registryConfig.sourceIntervalMs ?? undefined;`,
    },
    vitest: {
      file: "__tests__/registry/mount.test.ts",
      test: "re-reads the ServiceAccount credentials on every cycle",
    },
  },
  {
    name: "proxy-outcome-status",
    what: "the access log says a request was proxied, not what the node answered",
    file: "scripts/proxy-backend.mjs",
    from: `            outcome: res.writableFinished
              ? \`proxied:\${res.statusCode}\`
              : \`aborted:\${res.statusCode}\`,`,
    to: `            outcome: res.writableFinished ? "proxied" : "aborted",`,
    vitest: {
      file: "__tests__/registry/proxy-backend.test.ts",
      test: "records the status the node answered with, not that a dial was made",
    },
  },
];

/**
 * Runs one vitest test by name and says whether it passed.
 *
 * `-t` is a regular expression matched against the full name, describe blocks
 * included, and two of these names contain `//[` — an unterminated character
 * class, which makes vitest die with a SyntaxError that reads exactly like the
 * test failing. So the name is escaped, and not anchored: anchoring would
 * exclude the describe prefix and match nothing.
 *
 * A filter that matches nothing exits 0 with every test skipped, which reads
 * as a pass and would make every fix look proven. That is the failure mode
 * this whole file exists to catch, so it is checked for explicitly.
 */
function runVitest({ file, test }) {
  const pattern = test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = spawnSync("npx", ["vitest", "run", file, "-t", pattern], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  const ran = /Tests\s+(\d+)\s+(passed|failed)/.exec(output);
  if (!ran || Number(ran[1]) === 0) {
    throw new Error(
      `"${test}" matched no test in ${file}; a filter that matches nothing ` +
        `exits 0 and would read as a pass.\n${output.slice(-600)}`,
    );
  }
  return { passed: result.status === 0, output };
}

function edit(filePath, from, to) {
  const absolute = path.join(REPO_ROOT, filePath);
  const source = readFileSync(absolute, "utf8");
  if (!source.includes(from)) {
    throw new Error(
      `${filePath}: the text this revert expects is not there any more. ` +
        `The fix has been rewritten, so this breakage entry has to be too.`,
    );
  }
  writeFileSync(absolute, source.replace(from, to), "utf8");
}

async function main() {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : null;

  // Nothing here may run against a tree that already has changes in the files
  // it edits: a failure would then be ambiguous, and a restore would throw
  // away work.
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const fixes = FIXES.filter((fix) => fix.from !== null).filter(
    (fix) => !only || fix.name === only,
  );
  const conflicts = fixes.filter((fix) => dirty.includes(fix.file));
  if (conflicts.length > 0) {
    throw new Error(
      `commit or revert these first, they are what this run edits: ${conflicts
        .map((fix) => fix.file)
        .join(", ")}`,
    );
  }

  const backups = mkdtempSync(path.join(tmpdir(), "fleet-breakage-"));
  const results = [];

  for (const fix of fixes) {
    const absolute = path.join(REPO_ROOT, fix.file);
    const backup = path.join(backups, fix.name);
    copyFileSync(absolute, backup);

    try {
      log(`── ${fix.name}: ${fix.what}`);

      // Green before, or the rest of this proves nothing.
      const before = runVitest(fix.vitest);
      if (!before.passed) {
        results.push({
          ...fix,
          verdict: "BROKEN ALREADY",
          detail: `"${fix.vitest.test}" fails before anything is reverted`,
        });
        continue;
      }

      edit(fix.file, fix.from, fix.to);
      if (fix.extra) edit(fix.file, fix.extra.from, fix.extra.to);

      const during = runVitest(fix.vitest);
      copyFileSync(backup, absolute);
      const after = runVitest(fix.vitest);

      if (during.passed) {
        results.push({
          ...fix,
          verdict: "UNPROVEN",
          detail:
            `"${fix.vitest.test}" still passed with the fix reverted. ` +
            "The assertion is decorative.",
        });
      } else if (!after.passed) {
        results.push({
          ...fix,
          verdict: "NOT RESTORED",
          detail: "the file was restored but the test did not go green again",
        });
      } else {
        results.push({
          ...fix,
          verdict: "PROVEN",
          detail: `"${fix.vitest.test}" went red, then green again`,
        });
      }
    } finally {
      // Always, including on an interrupt: the working tree is not a place to
      // leave a deliberately broken fix.
      copyFileSync(backup, absolute);
    }
  }

  console.log("");
  console.log("Deliberate breakage");
  console.log("═".repeat(72));
  for (const result of results) {
    console.log(`${result.verdict.padEnd(15)} ${result.name}`);
    console.log(`${" ".repeat(15)} ${result.detail}`);
  }
  console.log("═".repeat(72));

  const unproven = results.filter((result) => result.verdict !== "PROVEN");
  if (unproven.length > 0) {
    console.error(
      `\n${unproven.length} fix(es) are not proven by any assertion.`,
    );
    process.exit(1);
  }
  console.log(`\nall ${results.length} fixes are proven by a named assertion.`);
}

main().catch((error) => {
  console.error(`[breakage] ${error instanceof Error ? error.stack : error}`);
  process.exit(2);
});
