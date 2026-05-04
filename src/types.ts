export interface QueueEvent {
  id: string;
  type: 'device_registered' | 'heartbeat' | 'inventory' | 'task_result' | 'alarm';
  createdAt: string;
  payload: unknown;
}

export type SigningScope =
  | 'bootstrap_manifest'
  | 'rule_bundle'
  | 'task_bundle'
  | 'task_ledger'
  | 'kill_switch'
  | 'recovery_task';

export interface AgentTask {
  id: string;
  nodeId?: string;
  deviceId: string;
  tenantId?: string;
  type: 'update_package' | 'refresh_inventory';
  appName?: string;
  packageArtifactId?: string;
  packageId?: string;
  productCode?: string;
  sourceUrl?: string;
  sha256?: string;
  installArgs?: string;
  targetVersion?: string;
  taskHash?: string;
  notBefore?: string;
  ledgerEntryId?: string;
  createdAt: string;
}

export interface TaskLedgerEntry {
  ledgerId: string;
  taskId: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  visibleInDashboard: true;
  taskHash: string;
  riskScore: number;
  notBefore: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  state: 'active' | 'revoked' | 'superseded';
}

export interface SignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  keyId: string;
  payloadType: SigningScope;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash?: string;
  payload: T;
  signature: string;
}

export interface TaskBundle {
  tasks: AgentTask[];
  /** Signed ledger entry — must be present and active for task to be relayed */
  ledgerEntry: TaskLedgerEntry | null;
}

export interface KillSwitchState {
  id: string;
  tenantId: string;
  active: boolean;
  activatedAt?: string;
  activatedBy?: string;
  reason?: string;
  signature: string;
  keyId: string;
}
