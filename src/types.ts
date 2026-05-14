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

export type NodeCapability =
  | 'windows-patching'
  | 'linux-patching'
  | 'winget-cache'
  | 'chocolatey-cache'
  | 'yara-scan'
  | 'malware-scan'
  | 'file-reputation'
  | 'offline-cache'
  | 'regional-cache'
  | 'bandwidth-optimized';

export interface NodeSignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  nodeId: string;
  payloadType:
    | 'node_health_report'
    | 'node_reachability_probe'
    | 'cross_node_probe_report'
    | 'cache_artifact_attestation'
    | 'node_version_attestation';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash: string;
  payload: T;
  signature: string;
}

export interface NodeHealthComponent {
  name:
    | 'reachability'
    | 'event_queue'
    | 'database'
    | 'certificate'
    | 'scanner'
    | 'disk'
    | 'memory'
    | 'clock'
    | 'update_source'
    | 'cache'
    | 'package_verifier';
  status: 'ok' | 'degraded' | 'unhealthy';
  observedAt: string;
  message?: string;
  value?: number | string | boolean;
}


/** Structured security posture finding for a backend node */
export interface NodeSecurityFinding {
  /** Machine-readable code e.g. SSH_ROOT_LOGIN_PERMITTED, NO_FIREWALL, NODE_AGE_NEW */
  code: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: "os_security" | "ip_reputation" | "node_age" | "configuration" | "health";
  message: string;
  remediationHint?: string;
}

export interface NodeHealthReport {
  nodeId: string;
  reportedAt: string;
  managementUrl?: string;
  publicUrl?: string;
  version?: string;
  region?: string;
  site?: string;
  latencyMs?: number;
  queueSize: number;
  queueLag: 'low' | 'medium' | 'high';
  diskFreeBytes?: number;
  memoryPressurePercent?: number;
  clockSkewMs?: number;
  certExpiresAt?: string;
  scannerHealthy: boolean;
  cacheHealthy: boolean;
  packageVerifierHealthy: boolean;
  updateSourceReachable: boolean;
  components: NodeHealthComponent[];
  capabilities: NodeCapability[];
  /** Platform-specific OS security posture findings self-reported by the node */
  securityFindings?: NodeSecurityFinding[];
  /** Basic OS metadata for server-side context */
  osInfo?: { platform: string; release?: string };
}

export interface CacheArtifactAttestation {
  packageArtifactId: string;
  sha256: string;
  verified: boolean;
  signatureValid?: boolean;
  sizeBytes?: number;
  expiresAt?: string;
  observedAt: string;
  reason?: string;
}

export interface AgentTask {
  id: string;
  nodeId?: string;
  deviceId: string;
  tenantId?: string;
  type: 'update_package' | 'refresh_inventory';
  appName?: string;
  packageArtifactId?: string;
  packageId?: string;
  packageManager?: 'winget' | 'chocolatey' | 'scoop' | 'apt' | 'msi';
  packageScope?: 'system' | 'global' | 'user';
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
  algorithm: 'ES256';
  scope: 'task_ledger';
  issuedAt: string;
  nonce: string;
  payloadHash: string;
  keyId: string;
  signature: string;
  state: 'active' | 'revoked' | 'superseded';
}

export interface SignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  keyId: string;
  scope: SigningScope;
  payloadType: SigningScope;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash: string;
  payload: T;
  signature: string;
}

export interface TaskBundle {
  tasks: AgentTask[];
  /** Signed ledger entry — must be present and active for task to be relayed */
  ledgerEntry: TaskLedgerEntry | null;
  policyMetadata?: {
    tenantId: string;
    requiredCapabilities?: NodeCapability[];
    routingPolicyId?: string;
  };
  targetScope?: {
    deviceIds: string[];
    nodeId?: string;
  };
  integrityHashes?: {
    taskHash?: string;
    ledgerHash?: string;
    packageSha256?: string;
  };
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
