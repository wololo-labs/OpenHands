import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * `scripts/static-server.mjs` is the front door inside the container the helm
 * chart deploys, and the Dockerfile copies it in file by file rather than
 * shipping the repository. So an import it grows is a file that has to be
 * added to the image by hand, and forgetting one is invisible until a
 * deployment 404s or crashes at boot.
 *
 * That is not hypothetical: the chart offered `registry.enabled`, set the
 * REGISTRY_* environment variables, created the RBAC for the Kubernetes
 * source — and the image contained no registry at all, because nothing ever
 * checked that the two agreed.
 */
function readSource(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** Every repo-relative module reachable from `entry`, transitively. */
function reachableModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    const source = readSource(current);
    const dir = path.dirname(current);
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const resolved = path.posix.normalize(path.posix.join(dir, match[1]));
      queue.push(resolved);
    }
  }

  return seen;
}

/** Packages imported by name, which the image needs under node_modules/. */
function bareImports(modules: Set<string>): Set<string> {
  const packages = new Set<string>();
  for (const module of modules) {
    for (const match of readSource(module).matchAll(/from\s+"([^".][^"]*)"/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      packages.add(
        specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0],
      );
    }
  }
  return packages;
}

describe("the image ships what static-server imports", () => {
  const dockerfile = readSource("docker/Dockerfile");
  const modules = reachableModules("scripts/static-server.mjs");

  /** A file is shipped by its own COPY line, or by a COPY of its directory. */
  function isCopied(module: string) {
    if (dockerfile.includes(`COPY ${module} `)) return true;
    let dir = path.posix.dirname(module);
    while (dir !== "." && dir !== "/") {
      if (dockerfile.includes(`COPY ${dir}/ `)) return true;
      dir = path.posix.dirname(dir);
    }
    return false;
  }

  it("reaches the registry from static-server, so the chart's switch is real", () => {
    expect(modules).toContain("scripts/registry/mount.mjs");
    expect(modules).toContain("scripts/registry/routes.mjs");
    expect(modules).toContain("scripts/registry/sources/k8s.mjs");
    expect(modules).toContain("scripts/proxy-backend.mjs");
  });

  it.each([...reachableModules("scripts/static-server.mjs")])(
    "%s is copied into the image",
    (module) => {
      expect(
        isCopied(module),
        `${module} is imported at runtime but no COPY line puts it in the image`,
      ).toBe(true);
    },
  );

  it.each([...bareImports(reachableModules("scripts/static-server.mjs"))])(
    "node_modules/%s is copied into the image",
    (packageName) => {
      expect(
        dockerfile.includes(`/opt/agent-canvas/node_modules/${packageName}`),
        `${packageName} is imported at runtime but is not in the image's node_modules`,
      ).toBe(true);
    },
  );

  it("declares every runtime package it imports as a dependency", () => {
    const manifest = JSON.parse(readSource("package.json"));
    for (const packageName of bareImports(modules)) {
      expect(
        manifest.dependencies,
        `${packageName} is imported at runtime`,
      ).toHaveProperty(packageName);
    }
  });
});
