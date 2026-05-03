import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { AgentTask, SignedEnvelope, TaskBundle } from '../types';

@Injectable()
export class TaskStore {
  private readonly key = '1patch:backend-node:tasks';

  constructor(private readonly dragonfly: DragonflyService) {}

  async create(deviceId: string, type: AgentTask['type'], packageId?: string, targetVersion?: string) {
    const task = { id: uuid(), deviceId, type, packageId, targetVersion, createdAt: new Date().toISOString() };
    await this.dragonfly.lpushJson(this.key, task);
    return task;
  }

  async addMany(envelopes: SignedEnvelope<TaskBundle>[]) {
    for (const envelope of envelopes) {
      await this.dragonfly.lpushJson(this.key, envelope);
    }
    return envelopes.reduce((total, envelope) => total + (envelope.payload.tasks?.length ?? 0), 0);
  }

  async nextForDevice(deviceId: string) {
    const deferred: SignedEnvelope<TaskBundle>[] = [];
    const selected: SignedEnvelope<TaskBundle>[] = [];
    const count = await this.size();
    for (let index = 0; index < count; index += 1) {
      const envelope = await this.dragonfly.rpopJson<SignedEnvelope<TaskBundle>>(this.key);
      if (!envelope) break;
      if (envelope.payload.tasks.some((task) => task.deviceId === deviceId)) selected.push(envelope);
      else deferred.push(envelope);
    }
    for (const envelope of deferred.reverse()) await this.dragonfly.lpushJson(this.key, envelope);
    return selected;
  }

  async size() {
    return this.dragonfly.llen(this.key);
  }
}
