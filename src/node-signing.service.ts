import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { NodeSignedEnvelope } from './types';

const KEY_DIR = process.env.NODE_SIGNING_KEY_DIR ?? join(process.cwd(), 'node-signing');
const PRIVATE_KEY_PATH = join(KEY_DIR, 'node-signing.key');
const PUBLIC_KEY_PATH = join(KEY_DIR, 'node-signing.pub');

@Injectable()
export class NodeSigningService implements OnModuleInit {
  private readonly logger = new Logger(NodeSigningService.name);
  private privateKeyPem = '';
  private publicKeyPem = '';

  async onModuleInit() {
    await this.ensureKeyPair();
  }

  publicKey() {
    return this.publicKeyPem;
  }

  signPayload<T>(payloadType: NodeSignedEnvelope<T>['payloadType'], payload: T, nonce: string, ttlSeconds = 5 * 60): NodeSignedEnvelope<T> {
    if (!process.env.NODE_ID) throw new Error('NODE_ID is required to sign node payloads');
    if (!this.privateKeyPem) throw new Error('Node signing key is not initialised');
    const issuedAt = new Date();
    const unsigned = {
      algorithm: 'ES256' as const,
      nodeId: process.env.NODE_ID,
      payloadType,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
      nonce,
      payloadHash: computePayloadHash(payload),
      payload,
    };
    const signature = sign('sha256', Buffer.from(canonicalJson(unsigned)), {
      key: createPrivateKey(this.privateKeyPem),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { ...unsigned, signature };
  }

  private async ensureKeyPair() {
    await mkdir(KEY_DIR, { recursive: true });
    if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
      this.privateKeyPem = await readFile(PRIVATE_KEY_PATH, 'utf8');
      this.publicKeyPem = await readFile(PUBLIC_KEY_PATH, 'utf8');
      return;
    }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await Promise.all([
      writeFile(PRIVATE_KEY_PATH, this.privateKeyPem, { encoding: 'utf8', mode: 0o600 }),
      writeFile(PUBLIC_KEY_PATH, this.publicKeyPem, { encoding: 'utf8', mode: 0o644 }),
    ]);
    this.logger.warn(`Generated new backend-node application signing key at ${KEY_DIR}. Re-registration will publish the public key.`);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function computePayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
