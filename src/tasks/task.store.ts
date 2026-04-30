import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { AgentTask } from '../types';

@Injectable()
export class TaskStore {
  private readonly key = '1patch:backend-node:tasks';

  constructor(private readonly dragonfly: DragonflyService) {}

  async create(deviceId: string, type: AgentTask['type'], packageId?: string, targetVersion?: string) {
    const task = { id: uuid(), deviceId, type, packageId, targetVersion, createdAt: new Date().toISOString() };
    await this.dragonfly.lpushJson(this.key, task);
    return task;
  }

  async addMany(tasks: AgentTask[]) {
    const fresh = tasks;
    for (const task of fresh) {
      await this.dragonfly.lpushJson(this.key, task);
    }
    return fresh.length;
  }

  async nextForDevice(deviceId: string) {
    const deferred: AgentTask[] = [];
    const selected: AgentTask[] = [];
    const count = await this.size();
    for (let index = 0; index < count; index += 1) {
      const task = await this.dragonfly.rpopJson<AgentTask>(this.key);
      if (!task) break;
      if (task.deviceId === deviceId) selected.push(task);
      else deferred.push(task);
    }
    for (const task of deferred.reverse()) await this.dragonfly.lpushJson(this.key, task);
    return selected;
  }

  async size() {
    return this.dragonfly.llen(this.key);
  }
}
