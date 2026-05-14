import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentController } from './agent/agent.controller';
import { HealthController } from './health.controller';
import { ManagementService } from './management/management.service';
import { NodeControlController } from './node-control.controller';
import { PackageCacheService } from './packages/package-cache.service';
import { NodeSigningService } from './node-signing.service';
import { PackagesController } from './packages/packages.controller';
import { EventQueueService } from './queue/event-queue.service';
import { DragonflyService } from './storage/dragonfly.service';
import { TaskStore } from './tasks/task.store';
import { DeviceKeyStore } from './agent/device-key.store';
import { DeviceAuthGuard } from './agent/device-auth.guard';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot()],
  controllers: [AgentController, HealthController, NodeControlController, PackagesController],
  providers: [DragonflyService, EventQueueService, PackageCacheService, NodeSigningService, ManagementService, TaskStore, DeviceKeyStore, DeviceAuthGuard],
})
export class AppModule {}
