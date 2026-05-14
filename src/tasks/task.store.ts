import { Injectable, Logger } from "@nestjs/common";
import { createPublicKey, verify } from "crypto";
import { DragonflyService } from "../storage/dragonfly.service";
import { KillSwitchState, SignedEnvelope, TaskBundle } from "../types";
import { canonicalJson, computePayloadHash } from "../node-signing.service";

/**
 * Backend nodes only cache and relay signed task bundles from the management server.
 * They never create, mutate, approve, or sign tasks.
 * Tasks without a valid ledger entry are never returned to agents.
 * Tasks are also blocked when the cached kill switch is active for the tenant.
 */
@Injectable()
export class TaskStore {
  private readonly logger = new Logger(TaskStore.name);
  private readonly key = "1patch:backend-node:tasks";
  private readonly ksPrefix = "1patch:backend-node:kill-switch";

  /**
   * Creates a TaskStore instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(private readonly dragonfly: DragonflyService) {}

  /** Called by ManagementService when it receives an updated kill switch envelope. */
  async setKillSwitchEnvelope(envelope: SignedEnvelope<KillSwitchState>): Promise<void> {
    if (envelope.scope !== "kill_switch" || envelope.payloadType !== "kill_switch") {
      this.logger.warn(`Refusing kill-switch envelope with scope=${envelope.scope} payloadType=${envelope.payloadType}`);
      return;
    }
    await this.dragonfly.setJson(`${this.ksPrefix}:${envelope.payload.tenantId}`, envelope);
    this.logger.warn(
      `Kill switch cached: tenantId=${envelope.payload.tenantId} active=${envelope.payload.active}`,
    );
  }

  /**
   * Handles the is kill switch active operation for TaskStore.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async isKillSwitchActive(tenantId: string): Promise<boolean> {
    return (await this.getKillSwitchEnvelope(tenantId))?.payload.active === true;
  }

  /**
   * Gets the kill switch envelope value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async getKillSwitchEnvelope(tenantId: string): Promise<SignedEnvelope<KillSwitchState> | undefined> {
    if (typeof this.dragonfly.getJson !== "function") return undefined;
    let fallback: SignedEnvelope<KillSwitchState> | undefined;
    for (const id of [tenantId, "global"]) {
      const env = await this.dragonfly.getJson<SignedEnvelope<KillSwitchState>>(`${this.ksPrefix}:${id}`);
      if (env?.payload.active === true) return env;
      fallback ??= env;
    }
    return fallback;
  }

  /**
   * Handles the add many operation for TaskStore.
   *
   * @param envelopes envelopes supplied to the function.
   * @returns The result produced by the operation.
   */
  async addMany(envelopes: SignedEnvelope<TaskBundle>[]) {
    let accepted = 0;
    let rejected = 0;
    for (const envelope of envelopes) {
      const integrity = verifyManagementEnvelope(envelope);
      if (!integrity.valid) {
        this.logger.warn(`Refusing task envelope - ${integrity.reason}`);
        rejected += envelope.payload.tasks?.length ?? 0;
        continue;
      }
      const bundle = envelope.payload;
      if (!bundle.ledgerEntry) {
        this.logger.warn(
          `Refusing bundle - missing ledger for: ${bundle.tasks.map((t) => t.id).join(", ")}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      if (bundle.ledgerEntry.state !== "active") {
        this.logger.warn(
          `Refusing bundle - ledger ${bundle.ledgerEntry.ledgerId} state=${bundle.ledgerEntry.state}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      if (bundle.ledgerEntry.visibleInDashboard !== true) {
        this.logger.warn(
          `Refusing bundle - visibleInDashboard false for ledgerId=${bundle.ledgerEntry.ledgerId}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      const requiredCapabilities = bundle.policyMetadata?.requiredCapabilities ?? [];
      const localCapabilities = configuredCapabilities();
      const missing = requiredCapabilities.filter((capability) => !localCapabilities.includes(capability));
      if (missing.length > 0) {
        this.logger.warn(`Refusing bundle - missing local capabilities: ${missing.join(", ")}`);
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      if (bundle.targetScope?.nodeId && process.env.NODE_ID && bundle.targetScope.nodeId !== process.env.NODE_ID) {
        this.logger.warn(`Refusing bundle - target node ${bundle.targetScope.nodeId} does not match local node ${process.env.NODE_ID}`);
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      if (bundle.integrityHashes?.ledgerHash && bundle.ledgerEntry.payloadHash !== bundle.integrityHashes.ledgerHash) {
        this.logger.warn(`Refusing bundle - ledger hash does not match integrity metadata`);
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }
      await this.dragonfly.lpushJson(this.key, envelope);
      accepted += bundle.tasks?.length ?? 0;
    }
    if (rejected > 0) {
      this.logger.warn(`Task relay: accepted=${accepted} rejected=${rejected} (missing/revoked/hidden ledger)`);
    }
    return accepted;
  }

  /**
   * Handles the next for device operation for TaskStore.
   *
   * @param deviceId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async nextForDevice(deviceId: string) {
    const deferred: SignedEnvelope<TaskBundle>[] = [];
    const selected: SignedEnvelope<TaskBundle>[] = [];
    const count = await this.size();

    for (let i = 0; i < count; i++) {
      const envelope = await this.dragonfly.rpopJson<SignedEnvelope<TaskBundle>>(this.key);
      if (!envelope) break;
      const bundle = envelope.payload;

      // Drop bundles with missing or inactive ledger
      if (!bundle.ledgerEntry || bundle.ledgerEntry.state !== "active") {
        this.logger.warn(`Dropping task envelope at relay - ledger missing or inactive`);
        continue;
      }

      if (!bundle.tasks.some((t) => t.deviceId === deviceId)) {
        deferred.push(envelope);
        continue;
      }

      // Kill switch check - blocks pre-cached tasks the moment switch is activated
      const tenantId = bundle.tasks[0]?.tenantId ?? bundle.ledgerEntry.tenantId ?? "default";
      if (await this.isKillSwitchActive(tenantId)) {
        this.logger.warn(
          `Kill switch active for tenant ${tenantId} - blocking cached task for device ${deviceId}`,
        );
        // Requeue so the task is not lost when the switch is cleared
        deferred.push(envelope);
        continue;
      }

      selected.push(envelope);
    }

    for (const envelope of deferred.reverse()) {
      await this.dragonfly.lpushJson(this.key, envelope);
    }
    return selected;
  }

  /**
   * Handles the size operation for TaskStore.
   * @returns The result produced by the operation.
   */
  async size() {
    return this.dragonfly.llen(this.key);
  }
}

function verifyManagementEnvelope(envelope: SignedEnvelope<TaskBundle>): { valid: boolean; reason?: string } {
  if (envelope.scope !== "task_bundle" || envelope.payloadType !== "task_bundle") {
    return { valid: false, reason: `scope=${envelope.scope} payloadType=${envelope.payloadType}` };
  }
  if (Date.parse(envelope.expiresAt) <= Date.now()) return { valid: false, reason: "expired task bundle" };
  if (!envelope.payloadHash || computePayloadHash(envelope.payload) !== envelope.payloadHash) {
    return { valid: false, reason: "payload hash mismatch" };
  }
  const trusted = trustedManagementKeys();
  if (trusted.size === 0) {
    if (process.env.NODE_ENV === "production") return { valid: false, reason: "no trusted management signing keys configured" };
    return { valid: true };
  }
  const pem = trusted.get(envelope.keyId);
  if (!pem) return { valid: false, reason: `unknown management signing key ${envelope.keyId}` };
  const { signature, ...unsigned } = envelope;
  const ok = verify("sha256", Buffer.from(canonicalJson(unsigned)), {
    key: createPublicKey(pem),
    dsaEncoding: "ieee-p1363",
  }, Buffer.from(signature, "base64url"));
  return ok ? { valid: true } : { valid: false, reason: "invalid management signature" };
}

function trustedManagementKeys() {
  const out = new Map<string, string>();
  const raw = process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON ?? process.env.TRUSTED_MANAGEMENT_SIGNING_KEYS_JSON;
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, string | { publicKeyPem?: string; scope?: string; status?: string }>;
    for (const [keyId, value] of Object.entries(parsed)) {
      const publicKeyPem = typeof value === "string" ? value : value.publicKeyPem;
      const scope = typeof value === "string" ? "task_bundle" : value.scope;
      const status = typeof value === "string" ? "active" : value.status ?? "active";
      if (publicKeyPem && (scope === "task_bundle" || scope === "*") && status !== "revoked") out.set(keyId, publicKeyPem.replace(/\\n/g, "\n"));
    }
  } catch {
    return out;
  }
  return out;
}

function configuredCapabilities() {
  const configured = (process.env.NODE_CAPABILITIES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return process.platform === "win32"
    ? ["windows-patching", "winget-cache", "chocolatey-cache", "regional-cache"]
    : ["linux-patching", "regional-cache"];
}
