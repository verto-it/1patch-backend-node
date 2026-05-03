export interface QueueEvent {
  id: string;
  type: 'device_registered' | 'heartbeat' | 'inventory' | 'task_result' | 'alarm';
  createdAt: string;
  payload: unknown;
}

export interface AgentTask {
  id: string;
  nodeId?: string;
  deviceId: string;
  type: 'update_package' | 'refresh_inventory';
  appName?: string;
  packageArtifactId?: string;
  packageId?: string;
  productCode?: string;
  sourceUrl?: string;
  sha256?: string;
  installArgs?: string;
  targetVersion?: string;
  createdAt: string;
}

export interface SignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  keyId: string;
  payloadType: 'bootstrap_manifest' | 'rule_bundle' | 'task_bundle';
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payload: T;
  signature: string;
}

export interface TaskBundle {
  tasks: AgentTask[];
}
