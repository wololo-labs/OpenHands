import React from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { getLockedCloudHost } from "#/api/agent-server-config";
import {
  approveRegistryEntry,
  getRegistryStatus,
  revokeRegistryEntry,
  subscribeRegistryStatus,
} from "#/api/backend-registry/registry-source";
import { type Backend } from "#/api/backend-registry/types";
import { BrandButton } from "#/components/features/settings/brand-button";
import { ConfirmationModal } from "#/components/shared/modals/confirmation-modal";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import {
  MODAL_MAX_WIDTH_VIEWPORT,
  modalWidthClassName,
} from "#/components/shared/modals/modal-body";
import { ModalCloseButton } from "#/components/shared/modals/modal-close-button";
import { useActiveBackendContext } from "#/contexts/active-backend-context";
import { useBackendsHealth } from "#/hooks/query/use-backends-health";
import { useAllCloudOrganizations } from "#/hooks/query/use-cloud-organizations";
import { useCloudCurrentUserId } from "#/hooks/query/use-cloud-current-user-id";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import { modalTitleLgClassName } from "#/utils/modal-classes";
import { BackendFormModal } from "./backend-form-modal";
import { BackendRow } from "./backend-row";
import { DeviceFlowAuth } from "./device-flow-auth";

interface ManageBackendsModalProps {
  onClose: () => void;
  /**
   * Recovery mode is used by the root unavailable-backend gate. There is no
   * app shell behind the modal, so dismiss controls would be misleading.
   */
  recoveryMode?: boolean;
}

interface PendingRemoval {
  id: string;
  name: string;
}

/**
 * Resolve the connected organization label for a backend row, mirroring the
 * per-org labelling used by the backend selector. Cloud API keys are bound to
 * a single org (legacy keys may expose several, joined here); local backends
 * and unresolved/errored lookups yield no label.
 */
function resolveBackendOrgLabel(
  backend: Backend,
  cloudOrgs: ReturnType<typeof useAllCloudOrganizations>,
  currentUserIds: ReturnType<typeof useCloudCurrentUserId>,
  personalWorkspaceLabel: string,
): string | undefined {
  if (backend.kind !== "cloud") return undefined;
  const entry = cloudOrgs[backend.id];
  if (!entry || entry.orgs.length === 0) return undefined;
  const userId = currentUserIds[backend.id]?.userId ?? null;
  return entry.orgs
    .map((org) =>
      !!userId && userId === org.id ? personalWorkspaceLabel : org.name,
    )
    .join(", ");
}

export function ManageBackendsModal({
  onClose,
  recoveryMode = false,
}: ManageBackendsModalProps) {
  const { t } = useTranslation("openhands");
  const { backends, active, removeBackend, setActive, updateBackend } =
    useActiveBackendContext();
  const healthByBackendId = useBackendsHealth(backends, {
    probeDisabledOnce: true,
  });
  const cloudOrgs = useAllCloudOrganizations();
  const currentUserIds = useCloudCurrentUserId();
  const personalWorkspaceLabel = t(I18nKey.BACKEND$PERSONAL_WORKSPACE);
  const lockedCloudHost = getLockedCloudHost();
  const isLockedToCloud = lockedCloudHost !== null;
  // Cookie-auth (OHE-hosted) backends have no API key to refresh — re-auth is
  // the main-app login, so the device-flow reconnect controls don't apply.
  const isCookieAuthBackend = active.backend.authMode === "cookie";
  const lockedCloudBackend =
    isLockedToCloud && !isCookieAuthBackend && active.backend.kind === "cloud"
      ? active.backend
      : null;
  const lockedCloudReconnectHost =
    lockedCloudHost ?? lockedCloudBackend?.host ?? "";
  const modalTitle =
    isLockedToCloud && !isCookieAuthBackend
      ? t(I18nKey.BACKEND$RECONNECT_CLOUD_TITLE)
      : t(I18nKey.BACKEND$MANAGE_TITLE);
  const [pendingRemoval, setPendingRemoval] =
    React.useState<PendingRemoval | null>(null);
  const [editingBackend, setEditingBackend] = React.useState<Backend | null>(
    null,
  );
  const [showAddForm, setShowAddForm] = React.useState(false);
  const registryStatus = React.useSyncExternalStore(
    subscribeRegistryStatus,
    getRegistryStatus,
    getRegistryStatus,
  );

  const handleConfirmRemoval = () => {
    if (!pendingRemoval) return;
    removeBackend(pendingRemoval.id);
    setPendingRemoval(null);
  };

  const handleSelectBackend = React.useCallback(
    (backend: Backend) => {
      if (active.backend.id !== backend.id || active.orgId !== null) {
        setActive(backend.id);
      }
      onClose();
    },
    [active.backend.id, active.orgId, onClose, setActive],
  );

  // Approve/revoke go to the registry, not to the browser's copy: the entry
  // is server-owned, and the list re-hydrates from the response.
  //
  // A failure has to be visible. Revocation is how an operator cuts a machine
  // off; if it silently does nothing the row simply stays as it was, and they
  // walk away believing a host was disconnected when it is still reachable.
  const [registryError, setRegistryError] = React.useState<string | null>(null);

  const runRegistryAction = React.useCallback(
    async (action: () => Promise<void>, failureMessage: string) => {
      setRegistryError(null);
      try {
        await action();
      } catch {
        setRegistryError(failureMessage);
      }
    },
    [],
  );

  const handleApprove = React.useCallback(
    (backend: Backend) => {
      void runRegistryAction(
        () => approveRegistryEntry(backend),
        t(I18nKey.BACKEND$APPROVE_FAILED),
      );
    },
    [runRegistryAction, t],
  );

  const handleRevoke = React.useCallback(
    (backend: Backend) => {
      void runRegistryAction(
        () => revokeRegistryEntry(backend),
        t(I18nKey.BACKEND$REVOKE_FAILED),
      );
    },
    [runRegistryAction, t],
  );

  const handleCloudLogin = React.useCallback(
    (backend: Backend, apiKey: string) => {
      updateBackend(backend.id, { apiKey });
    },
    [updateBackend],
  );

  const handleLockedCloudReconnect = React.useCallback(
    (apiKey: string) => {
      if (!lockedCloudBackend) return;
      updateBackend(lockedCloudBackend.id, { apiKey });
    },
    [lockedCloudBackend, updateBackend],
  );

  return (
    <>
      <ModalBackdrop
        onClose={recoveryMode ? undefined : onClose}
        closeOnEscape={!recoveryMode}
        closeOnBackdropClick={!recoveryMode}
        aria-label={modalTitle}
      >
        <div
          data-testid="manage-backends-modal"
          className={cn(
            "relative flex flex-col bg-[var(--oh-surface)] border border-[var(--oh-border)] rounded-xl",
            modalWidthClassName("lg"),
            MODAL_MAX_WIDTH_VIEWPORT,
            "max-h-[70vh]",
          )}
        >
          {recoveryMode ? null : (
            <ModalCloseButton
              onClose={onClose}
              testId="close-manage-backends-modal"
            />
          )}
          <div className={cn("p-5", !recoveryMode && "pr-12")}>
            <h2 className={modalTitleLgClassName}>{modalTitle}</h2>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-5">
            {registryError ? (
              <p
                data-testid="manage-backends-registry-error"
                role="alert"
                className="mb-2 rounded-md border border-red-500/40 px-3 py-2 text-xs text-red-300"
              >
                {registryError}
              </p>
            ) : null}
            {registryStatus === "unreachable" ? (
              <p
                data-testid="manage-backends-registry-unverified"
                className="mb-2 rounded-md border border-[var(--oh-border)] px-3 py-2 text-xs text-[var(--oh-text-secondary)]"
              >
                {t(I18nKey.BACKEND$REGISTRY_UNVERIFIED)}
              </p>
            ) : null}
            <div
              className="flex-1 overflow-auto rounded-md border border-[var(--oh-border)] bg-surface-raised custom-scrollbar-always"
              data-testid="manage-backends-list"
            >
              {backends.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-[var(--oh-text-secondary)]">
                  {t(I18nKey.BACKEND$MANAGE_EMPTY)}
                </p>
              ) : (
                <ul className="divide-y divide-[var(--oh-border)]">
                  {backends.map((backend) => (
                    <BackendRow
                      key={backend.id}
                      backend={backend}
                      health={healthByBackendId[backend.id]}
                      orgLabel={resolveBackendOrgLabel(
                        backend,
                        cloudOrgs,
                        currentUserIds,
                        personalWorkspaceLabel,
                      )}
                      onSelect={() => handleSelectBackend(backend)}
                      onEdit={() => setEditingBackend(backend)}
                      onRemove={() =>
                        setPendingRemoval({
                          id: backend.id,
                          name: backend.name,
                        })
                      }
                      onLogin={
                        backend.authMode === "cookie"
                          ? undefined
                          : (apiKey) => handleCloudLogin(backend, apiKey)
                      }
                      onApprove={
                        backend.provenance === "registry" &&
                        backend.registryState === "pending"
                          ? () => handleApprove(backend)
                          : undefined
                      }
                      onRevoke={
                        backend.provenance === "registry" &&
                        backend.registryState !== "pending"
                          ? () => handleRevoke(backend)
                          : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 p-5">
            {isLockedToCloud ? (
              lockedCloudBackend ? (
                <DeviceFlowAuth
                  host={lockedCloudReconnectHost}
                  onSuccess={handleLockedCloudReconnect}
                  testIdRoot="manage-backends-reconnect-cloud"
                  idleButtonLabel={t(I18nKey.BACKEND$RECONNECT_CLOUD)}
                  className="w-full sm:w-auto"
                  buttonClassName="w-full sm:w-auto"
                  statusDisplay="modal"
                />
              ) : null
            ) : (
              <BrandButton
                type="button"
                variant={recoveryMode ? "primary" : "secondary"}
                onClick={() => setShowAddForm(true)}
                testId="manage-backends-add"
                startContent={<Plus width={14} height={14} />}
              >
                {t(I18nKey.BACKEND$ADD)}
              </BrandButton>
            )}
            {recoveryMode ? null : (
              <BrandButton
                type="button"
                variant="primary"
                onClick={onClose}
                testId="manage-backends-done"
              >
                {t(I18nKey.HOME$DONE)}
              </BrandButton>
            )}
          </div>
        </div>
      </ModalBackdrop>

      {showAddForm ? (
        <BackendFormModal
          mode="add"
          source="manage_backends_modal"
          onClose={() => setShowAddForm(false)}
        />
      ) : null}

      {editingBackend ? (
        <BackendFormModal
          mode="edit"
          backend={editingBackend}
          onClose={() => setEditingBackend(null)}
        />
      ) : null}

      {pendingRemoval ? (
        <ConfirmationModal
          text={t(I18nKey.BACKEND$REMOVE_CONFIRMATION, {
            name: pendingRemoval.name,
          })}
          onConfirm={handleConfirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      ) : null}
    </>
  );
}
