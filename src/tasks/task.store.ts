import { Injectable, Logger } from "@nestjs/common";
import { DragonflyService } from "../storage/dragonfly.service";
import { KillSwitchState, SignedEnvelope, TaskBundle } from "../types";

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

  constructor(private readonly dragonfly: DragonflyService) {}

  /** Called by ManagementService when it receives an updated kill switch envelope. */
  async setKillSwitchEnvelope(envelope: SignedEnvelope<KillSwitchState>): Promise<void> {
    await this.dragonfly.setJson(`${this.ksPrefix}:${envelope.payload.tenantId}`, envelope);
    this.logger.warn(
      `Kill switch cached: tenantId=${envelope.payload.tenantId} active=${envelope.payload.active}`,
    );
  }

  async isKillSwitchActive(tenantId: string): Promise<boolean> {
    return (await this.getKillSwitchEnvelope(tenantId))?.payload.active === true;
  }

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

  async addMany(envelopes: SignedEnvelope<TaskBundle>[]) {
    let accepted = 0;
    let rejected = 0;
    for (const envelope of envelopes) {
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
      await this.dragonfly.lpushJson(this.key, envelope);
      accepted += bundle.tasks?.length ?? 0;
    }
    if (rejected > 0) {
      this.logger.warn(`Task relay: accepted=${accepted} rejected=${rejected} (missing/revoked/hidden ledger)`);
    }
    return accepted;
  }

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

  async size() {
    return this.dragonfly.llen(this.key);
  }
}
