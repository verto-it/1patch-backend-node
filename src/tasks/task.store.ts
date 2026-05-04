import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { AgentTask, SignedEnvelope, TaskBundle, TaskLedgerEntry } from '../types';

/**
 * Backend nodes only cache and relay signed task bundles from the management server.
 * They never create, mutate, approve, or sign tasks.
 * Tasks without a valid ledger entry are never returned to agents.
 */
@Injectable()
export class TaskStore {
  private readonly logger = new Logger(TaskStore.name);
  private readonly key = '1patch:backend-node:tasks';

  constructor(private readonly dragonfly: DragonflyService) {}

  async addMany(envelopes: SignedEnvelope<TaskBundle>[]) {
    let accepted = 0;
    let rejected = 0;
    for (const envelope of envelopes) {
      const bundle = envelope.payload;

      // Relay integrity check: refuse bundles missing a ledger entry
      if (!bundle.ledgerEntry) {
        this.logger.warn(
          `Refusing to cache task bundle — missing ledger entry for tasks: ${bundle.tasks.map((t) => t.id).join(', ')}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }

      // Refuse revoked ledger entries
      if (bundle.ledgerEntry.state !== 'active') {
        this.logger.warn(
          `Refusing to cache task bundle — ledger entry ${bundle.ledgerEntry.ledgerId} state=${bundle.ledgerEntry.state}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }

      // Refuse bundles where visibleInDashboard is not explicitly true
      if (bundle.ledgerEntry.visibleInDashboard !== true) {
        this.logger.warn(
          `Refusing to cache task bundle — visibleInDashboard is not true for ledgerId=${bundle.ledgerEntry.ledgerId}`,
        );
        rejected += bundle.tasks?.length ?? 0;
        continue;
      }

      await this.dragonfly.lpushJson(this.key, envelope);
      accepted += bundle.tasks?.length ?? 0;
    }

    if (rejected > 0) {
      this.logger.warn(`Task relay: accepted=${accepted} rejected=${rejected} (missing/revoked/hidden ledger entries)`);
    }
    return accepted;
  }

  async nextForDevice(deviceId: string) {
    const deferred: SignedEnvelope<TaskBundle>[] = [];
    const selected: SignedEnvelope<TaskBundle>[] = [];
    const count = await this.size();

    for (let index = 0; index < count; index += 1) {
      const envelope = await this.dragonfly.rpopJson<SignedEnvelope<TaskBundle>>(this.key);
      if (!envelope) break;

      const bundle = envelope.payload;

      // Final relay guard: skip bundles without an active ledger entry
      if (!bundle.ledgerEntry || bundle.ledgerEntry.state !== 'active') {
        this.logger.warn(`Dropping task envelope at relay — ledger entry missing or inactive`);
        continue;
      }

      if (bundle.tasks.some((task) => task.deviceId === deviceId)) {
        selected.push(envelope);
      } else {
        deferred.push(envelope);
      }
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
