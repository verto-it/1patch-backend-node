import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PackageCacheService } from './packages/package-cache.service';
import { EventQueueService } from './queue/event-queue.service';
import { DragonflyService } from './storage/dragonfly.service';

@Controller()
export class HealthController {
  /**
   * Creates a HealthController instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   * @param queue queue supplied to the function.
   * @param packages packages supplied to the function.
   */
  constructor(
    private readonly dragonfly: DragonflyService,
    private readonly queue: EventQueueService,
    private readonly packages: PackageCacheService,
  ) {}

  /**
   * Handles the health operation for HealthController.
   * @returns The result produced by the operation.
   */
  @Get('/health')
  async health() {
    const dragonfly = await this.dragonfly.health();
    const body = {
      status: dragonfly.ready ? 'ok' : 'degraded',
      nodeId: process.env.NODE_ID ?? '',
      publicUrl: process.env.NODE_PUBLIC_URL ?? '',
      role: 'backend-node',
      dependencies: {
        dragonfly,
      },
      capacity: {
        queue: await this.queue.size(),
        packageCache: this.packages.status(),
      },
    };

    if (!dragonfly.ready) throw new ServiceUnavailableException(body);
    return body;
  }

  @Get('/live')
  live() {
    return {
      status: 'ok',
      role: 'backend-node',
      nodeId: process.env.NODE_ID ?? '',
      publicUrl: process.env.NODE_PUBLIC_URL ?? '',
    };
  }
}
