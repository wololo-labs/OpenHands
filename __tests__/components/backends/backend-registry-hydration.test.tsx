import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetActiveStoreForTests } from "#/api/backend-registry/active-store";
import { __resetHealthStoreForTests } from "#/api/backend-registry/health-store";
import { __resetRegistryStatusForTests } from "#/api/backend-registry/registry-source";
import { BACKENDS_STORAGE_KEY } from "#/api/backend-registry/storage";
import { ManageBackendsModal } from "#/components/features/backends/manage-backends-modal";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import {
  resetMockRegistryEntries,
  seedMockRegistryEntries,
} from "#/mocks/registry-handlers";

const getServerInfoMock = vi.fn().mockResolvedValue({ version: "1.44.0" });
const getSettingsMock = vi.fn().mockResolvedValue({});

vi.mock("@openhands/typescript-client/clients", () => ({
  ServerClient: vi.fn(function ServerClientMock() {
    return { getServerInfo: getServerInfoMock };
  }),
  SettingsClient: vi.fn(function SettingsClientMock() {
    return { getSettings: getSettingsMock };
  }),
}));

vi.mock("#/api/cloud/organization-service.api", () => ({
  getCloudOrganizations: vi.fn().mockResolvedValue({
    items: [],
    currentOrgId: null,
  }),
  getCloudOrganizationMe: vi
    .fn()
    .mockResolvedValue({ orgId: "", userId: "", role: null }),
  getCurrentCloudApiKey: vi
    .fn()
    .mockResolvedValue({ orgId: null, isLegacyKey: true }),
}));

vi.mock("#/hooks/query/use-settings", () => ({
  useSettings: () => ({ data: {} }),
}));

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <ManageBackendsModal onClose={vi.fn()} />
      </ActiveBackendProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetActiveStoreForTests();
  __resetHealthStoreForTests();
  __resetRegistryStatusForTests();
});

afterEach(() => {
  // The unreachable-registry test spies on `fetch`; without this the spy
  // leaks and the next test also sees a dead registry.
  vi.restoreAllMocks();
  resetMockRegistryEntries();
  window.localStorage.clear();
  __resetActiveStoreForTests();
  __resetHealthStoreForTests();
  __resetRegistryStatusForTests();
});

describe("registry hydration in the backends UI", () => {
  it("shows a fleet the browser has never seen, with no key pasted", async () => {
    seedMockRegistryEntries([
      {
        id: "abc123",
        name: "hetzner",
        host: "https://claude-hetzner.example.ts.net:8443",
        fingerprint: "SHA256:abc",
        state: "active",
      },
    ]);

    renderModal();

    expect(
      await screen.findByTestId("manage-backends-row-hetzner"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("manage-backends-provenance-hetzner"),
    ).toHaveTextContent("BACKEND$PROVENANCE_REGISTRY");
  });

  it("labels a pending entry and offers approval instead of selection", async () => {
    seedMockRegistryEntries([
      {
        id: "abc123",
        name: "rogue",
        host: "https://rogue.example.ts.net:8443",
        fingerprint: "SHA256:rogue",
        state: "pending",
      },
    ]);

    renderModal();

    const row = await screen.findByTestId("manage-backends-row-rogue");
    expect(
      screen.getByTestId("manage-backends-provenance-rogue"),
    ).toHaveTextContent("BACKEND$TRUST_PENDING");
    // The row's select button is the trust boundary: a pending entry is
    // listed but not connectable.
    expect(row.querySelector("button")).toBeDisabled();
    expect(
      screen.getByTestId("manage-backends-approve-rogue"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("manage-backends-revoke-rogue"),
    ).not.toBeInTheDocument();
  });

  it("approves a pending entry and re-reads the fleet", async () => {
    seedMockRegistryEntries([
      {
        id: "abc123",
        name: "rogue",
        host: "https://rogue.example.ts.net:8443",
        fingerprint: "SHA256:rogue",
        state: "pending",
      },
    ]);

    renderModal();
    await userEvent.click(
      await screen.findByTestId("manage-backends-approve-rogue"),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("manage-backends-provenance-rogue"),
      ).toHaveTextContent("BACKEND$PROVENANCE_REGISTRY"),
    );
    expect(
      screen.getByTestId("manage-backends-revoke-rogue"),
    ).toBeInTheDocument();
  });

  it("drops a revoked entry from the list", async () => {
    seedMockRegistryEntries([
      {
        id: "abc123",
        name: "doomed",
        host: "https://doomed.example.ts.net:8443",
        fingerprint: "SHA256:doomed",
        state: "active",
      },
    ]);

    renderModal();
    await userEvent.click(
      await screen.findByTestId("manage-backends-revoke-doomed"),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("manage-backends-row-doomed"),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders the cached list and says so when the registry is unreachable", async () => {
    window.localStorage.setItem(
      BACKENDS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "registry:abc123",
          name: "cached-host",
          host: "https://cached.example.ts.net:8443",
          apiKey: "",
          kind: "local",
          provenance: "registry",
          registryState: "active",
        },
      ]),
    );
    __resetActiveStoreForTests();
    // No seeded fleet and a transport failure: the registry exists but is down.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    renderModal();

    expect(
      await screen.findByTestId("manage-backends-registry-unverified"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("manage-backends-row-cached-host"),
    ).toBeInTheDocument();
  });

  it("leaves manual entries alone on a deployment with no registry", async () => {
    window.localStorage.setItem(
      BACKENDS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "manual-1",
          name: "my-laptop",
          host: "http://127.0.0.1:8000",
          apiKey: "manual-key",
          kind: "local",
        },
      ]),
    );
    __resetActiveStoreForTests();

    renderModal();

    expect(
      await screen.findByTestId("manage-backends-row-my-laptop"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("manage-backends-provenance-my-laptop"),
    ).toHaveTextContent("BACKEND$PROVENANCE_MANUAL");
    expect(
      screen.queryByTestId("manage-backends-registry-unverified"),
    ).not.toBeInTheDocument();
  });
});
