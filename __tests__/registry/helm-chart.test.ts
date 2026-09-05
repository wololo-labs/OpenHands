import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const chart = path.join(repoRoot, "helm", "agent-canvas");

async function hasHelm() {
  try {
    await execFileAsync("helm", ["version", "--short"]);
    return true;
  } catch {
    return false;
  }
}

async function render(sets: string[]) {
  const { stdout } = await execFileAsync("helm", [
    "template",
    "t",
    chart,
    ...sets.flatMap((set) => ["--set", set]),
  ]);
  return stdout;
}

const SESSION_SECRET =
  "secrets.sessionApiKey.existingSecret=canvas-session-key";

// The chart is only rendered where helm is installed; a machine without it
// skips rather than reporting a chart problem it never checked.
describe.skipIf(!(await hasHelm()))("agent-canvas chart", () => {
  it("lints", async () => {
    const { stdout } = await execFileAsync("helm", ["lint", chart]);
    expect(stdout).toContain("0 chart(s) failed");
  });

  it("renders with the registry disabled and mentions none of its wiring", async () => {
    const rendered = await render([]);

    expect(rendered).toContain("kind: StatefulSet");
    expect(rendered).not.toContain("REGISTRY_SESSION_KEY");
    expect(rendered).not.toContain("registry-discovery");
  });

  it("renders the registry's environment when enabled", async () => {
    const rendered = await render([
      "registry.enabled=true",
      SESSION_SECRET,
      "registry.secretProvider=file",
      "registry.preseed={SHA256:aaa,SHA256:bbb}",
    ]);

    expect(rendered).toContain("REGISTRY_SESSION_KEY");
    expect(rendered).toContain('value: "SHA256:aaa,SHA256:bbb"');
    expect(rendered).toContain("name: REGISTRY_SECRET_PROVIDER");
  });

  it("refuses to render a registry with no session secret to authenticate with", async () => {
    await expect(render(["registry.enabled=true"])).rejects.toThrow(
      /registry.enabled requires secrets.sessionApiKey/,
    );
  });

  it("creates only a Services Role for Kubernetes discovery", async () => {
    const rendered = await render([
      "registry.enabled=true",
      SESSION_SECRET,
      "registry.sources.kubernetes.enabled=true",
    ]);

    expect(rendered).toContain("REGISTRY_SOURCE_KUBERNETES");
    expect(rendered).toContain("t-agent-canvas-registry-discovery");
    expect(rendered).toContain('resources: ["services"]');
    // The broad admin binding stays off; discovery does not smuggle it in.
    expect(rendered).not.toContain("name: admin");
    expect(rendered).not.toContain("cluster-admin");
  });

  it("labels an agent pool so discovery finds it, without changing selectors", async () => {
    const rendered = await render([
      "agentPool.enabled=true",
      "agentPool.replicas=3",
    ]);

    expect(rendered).toContain("app.kubernetes.io/name: agent-server");
    expect(rendered).toContain("replicas: 3");
    // Selector labels are immutable on an existing release, so the discovery
    // label must never appear under a selector.
    const selectorBlocks = rendered.split("selector:").slice(1);
    for (const block of selectorBlocks) {
      expect(block.split("\n").slice(0, 4).join("\n")).not.toContain(
        "agent-server",
      );
    }
  });
});
