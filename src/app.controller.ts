import { Controller, Get, Post } from '@nestjs/common';
import { ManagementService } from './management/management.service';
import { EventQueueService } from './queue/event-queue.service';
import { TaskStore } from './tasks/task.store';

@Controller()
export class AppController {
  constructor(
    private readonly queue: EventQueueService,
    private readonly management: ManagementService,
    private readonly tasks: TaskStore,
  ) {}

  @Get('/health')
  health() {
    return { status: 'ok', service: '1patch-backend-node' };
  }

  @Get('/ready')
  async ready() {
    return {
      status: 'ready',
      nodeId: process.env.NODE_ID,
      queuedEvents: await this.queue.size(),
      queuedTasks: await this.tasks.size(),
      managementUrl: process.env.MANAGEMENT_URL,
    };
  }

  @Post('/node/register')
  register() {
    return this.management.register();
  }

  @Post('/node/sync')
  sync() {
    return this.management.flushQueue();
  }

  @Post('/node/pull-tasks')
  pullTasks() {
    return this.management.pullTasks();
  }
}
