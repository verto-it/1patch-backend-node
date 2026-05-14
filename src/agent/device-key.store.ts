import { Injectable, Logger } from "@nestjs/common";
import { DragonflyService } from "../storage/dragonfly.service";

/**
 * Caches device public keys on the backend node so that incoming agent
 * requests can be verified before the event is flushed to the management server.
 *
 * The public key is captured from the registration payload the moment a device
 * first calls POST /agent/register, and persisted in Dragonfly for durability.
 */
@Injectable()
export class DeviceKeyStore {
  private readonly logger = new Logger(DeviceKeyStore.name);
  private readonly prefix = "1patch:device-pubkey";
  /** In-process cache to avoid a Dragonfly round-trip on every request. */
  private readonly local = new Map<string, string>();

  /**
   * Creates a DeviceKeyStore instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(private readonly dragonfly: DragonflyService) {}

  /**
   * Sets the set value.
   *
   * @param deviceId Identifier used to locate the target record.
   * @param publicKeyBase64 public key base64 supplied to the function.
   */
  async set(deviceId: string, publicKeyBase64: string): Promise<void> {
    this.local.set(deviceId, publicKeyBase64);
    await this.dragonfly.setJson(`${this.prefix}:${deviceId}`, publicKeyBase64);
    this.logger.debug(`Public key cached for deviceId=${deviceId}`);
  }

  /**
   * Gets the get value.
   *
   * @param deviceId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async get(deviceId: string): Promise<string | undefined> {
    if (this.local.has(deviceId)) return this.local.get(deviceId);
    const fromDragonfly = await this.dragonfly.getJson<string>(`${this.prefix}:${deviceId}`);
    if (fromDragonfly) this.local.set(deviceId, fromDragonfly);
    return fromDragonfly;
  }
}
