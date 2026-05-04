import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";

import { ApiTags } from "@nestjs/swagger";
import { IsArray, IsString } from "class-validator";
import { ManagementService } from "../management/management.service";
import { EventQueueService } from "../queue/event-queue.service";
import { TaskStore } from "../tasks/task.store";
import { QueueEvent } from "../types";
import { DeviceAuthGuard } from "./device-auth.guard";
import { DeviceKeyStore } from "./device-key.store";

class RegisterDeviceDto {
  @IsString() deviceId!: string;
  @IsString() tenantId!: string;
  @IsString() hostname!: string;
  @IsString() os!: string;
  @IsString() publicKey!: string;
  @IsString() enrollmentToken!: string;
}

class InventoryDto {
  @IsString() deviceId!: string;
  @IsArray() apps!: Array<{ name: string; publisher: string; version: string; productCode?: string; packageId?: string }>;
}

@ApiTags("agent")
@Controller("/agent")
export class AgentController {
  constructor(
    private readonly queue: EventQueueService,
    private readonly tasks: TaskStore,
    private readonly management: ManagementService,
    private readonly deviceKeys: DeviceKeyStore,
  ) {}

  /**
   * Registration is intentionally NOT guarded by DeviceAuthGuard —
   * the device has no stored key yet. The enrollmentToken is the sole credential.
   */
  @Post("/register")
  async register(@Body() dto: RegisterDeviceDto) {
    // Cache the public key immediately so subsequent requests can be verified
    if (dto.publicKey) {
      await this.deviceKeys.set(dto.deviceId, dto.publicKey);
    }
    return this.queue.enqueue("device_registered", dto);
  }

  @UseGuards(DeviceAuthGuard)
  @Post("/heartbeat")
  heartbeat(@Body() dto: { deviceId: string; status?: string }) {
    return this.queue.enqueue("heartbeat", dto);
  }

  @UseGuards(DeviceAuthGuard)
  @Post("/inventory")
  inventory(@Body() dto: InventoryDto) {
    return this.enqueueAndFlush("inventory", dto);
  }

  @UseGuards(DeviceAuthGuard)
  @Get("/tasks/:deviceId")
  async tasksForDevice(@Param("deviceId") deviceId: string) {
    return { tasks: await this.tasks.nextForDevice(deviceId) };
  }

  @UseGuards(DeviceAuthGuard)
  @Get("/kill-switch/:tenantId")
  async killSwitchForTenant(@Param("tenantId") tenantId: string) {
    return { envelope: await this.tasks.getKillSwitchEnvelope(tenantId) };
  }

  @UseGuards(DeviceAuthGuard)
  @Post("/tasks/result")
  taskResult(@Body() dto: { deviceId: string; taskId: string; status: string; output?: string }) {
    return this.enqueueAndFlush("task_result", dto);
  }

  @UseGuards(DeviceAuthGuard)
  @Post("/alarms")
  alarm(@Body() dto: { deviceId: string; severity: string; message: string; metadata?: Record<string, unknown> }) {
    return this.enqueueAndFlush("alarm", dto);
  }

  private async enqueueAndFlush(type: QueueEvent["type"], payload: unknown) {
    const event = await this.queue.enqueue(type, payload);
    this.management.requestFlush();
    return event;
  }
}
