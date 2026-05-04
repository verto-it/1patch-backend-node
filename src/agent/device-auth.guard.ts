import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, createVerify } from "crypto";
import { DeviceKeyStore } from "./device-key.store";

export const DEVICE_ID_KEY = "verifiedDeviceId";

/**
 * Verifies that the request was signed by the device whose deviceId appears
 * in the request body or URL parameter.
 *
 * Protocol:
 *   The client sets three headers:
 *     x-device-id      — the deviceId (must match body/param)
 *     x-request-ts     — ISO8601 timestamp (must be within 5 minutes)
 *     x-device-sig     — base64url ES256 signature over:
 *                        "<METHOD>|<PATH>|<x-device-id>|<x-request-ts>|<SHA256(body)>"
 *
 * The guard looks up the stored public key for the deviceId and verifies the
 * signature. Requests from unknown devices (not yet registered) pass through
 * to POST /agent/register only; all other authenticated endpoints reject them.
 *
 * The guard is SKIP-safe: if DEVICE_AUTH_DISABLED=true AND NODE_ENV != production
 * it logs a warning and passes through (local dev only).
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  private readonly logger = new Logger(DeviceAuthGuard.name);
  private static readonly CLOCK_SKEW_MS = 5 * 60_000;

  constructor(private readonly keys: DeviceKeyStore) {}

  
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestLike>();

    // Dev bypass — explicit opt-in only
    if (process.env.NODE_ENV !== "production" && process.env.DEVICE_AUTH_DISABLED === "true") {
      this.logger.warn(
        `[DEV] Device auth bypassed (DEVICE_AUTH_DISABLED=true) path=${req.path}. ` +
        `Never set DEVICE_AUTH_DISABLED=true in production.`,
      );
    const devId =
      (req.headers["x-device-id"] as string | undefined) ??
      ((req.body as Record<string, unknown> | undefined)?.deviceId as string | undefined) ??
      (req.params["deviceId"] as string | undefined) ??
      "dev-device";
      (req as unknown as Record<string, unknown>)[DEVICE_ID_KEY] = devId;
      return true;
    }

    const deviceId =
      (req.headers["x-device-id"] as string | undefined) ??
      ((req.body as Record<string, unknown> | undefined)?.deviceId as string | undefined) ??
      (req.params["deviceId"] as string | undefined);

    if (!deviceId) throw new UnauthorizedException("x-device-id header or deviceId body field is required");

    const ts = req.headers["x-request-ts"] as string | undefined;
    const sig = req.headers["x-device-sig"] as string | undefined;

    if (!ts || !sig) throw new UnauthorizedException("x-request-ts and x-device-sig headers are required");

    // Clock-skew check
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > DeviceAuthGuard.CLOCK_SKEW_MS) {
      throw new UnauthorizedException("Request timestamp is missing, malformed, or outside the allowed 5-minute window");
    }

    // Look up stored public key
    const pubKeyBase64 = await this.keys.get(deviceId);
    if (!pubKeyBase64) {
      // Unknown device — only allow the register endpoint through
      if (req.path === "/agent/register" && req.method === "POST") return true;
      throw new UnauthorizedException(`Unknown device ${deviceId} — register first`);
    }

    // Verify signature
    const bodyText = req.body === undefined || req.body === null ? "" : JSON.stringify(req.body);
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    const path = req.originalUrl ?? req.url ?? req.path;
    const canonical = `${req.method}|${path}|${deviceId}|${ts}|${bodyHash}`;

    const sigBytes = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const pubKeyDer = Buffer.from(pubKeyBase64, "base64");

    try {
      const verify = createVerify("SHA256");
      verify.update(canonical);
      const pubKeyPem =
        "-----BEGIN PUBLIC KEY-----\n" +
        pubKeyDer.toString("base64").match(/.{1,64}/g)!.join("\n") +
        "\n-----END PUBLIC KEY-----";
      const ok = verify.verify(
        { key: pubKeyPem, format: "pem", type: "spki", dsaEncoding: "ieee-p1363" },
        sigBytes,
      );
      if (!ok) throw new UnauthorizedException(`Invalid device signature for deviceId=${deviceId}`);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException(`Signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    (req as unknown as Record<string, unknown>)[DEVICE_ID_KEY] = deviceId;
    return true;
  }
}

type RequestLike = {
  method: string;
  path: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  params: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
};
