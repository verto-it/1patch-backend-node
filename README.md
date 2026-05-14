# 1Patch Backend Node


NestJS data and command plane for 1Patch. Clients communicate with backend nodes over HTTPS polling. Nodes maintain a durable local queue so client data is never lost when the management server is offline.

**Port:** `4200`
**License:** AGPL-3.0-only

---

## Source Map

For implementation details, see [`src/README.md`](src/README.md).

| Path | Responsibility |
|---|---|
| `src/agent/` | Client registration, heartbeat, inventory, task polling, task result intake |
| `src/management/` | Node registration, mTLS client certificate persistence, management sync |
| `src/queue/` | Durable Dragonfly-backed event queue |
| `src/tasks/` | Signed task bundle storage and per-device dispatch |
| `src/packages/` | Package cache status and streaming downloads |
| `src/node-control.controller.ts` | Decommission endpoint called by management |

---

## Prerequisites

- Node.js 20 LTS or 22 LTS
- DragonflyDB (Redis-compatible)
- A running 1Patch Management Server
- PowerShell 7.4+

---

## First-Time Setup

### 1. Create a node enrollment on the management server

```powershell
$enrollment = Invoke-RestMethod `
  -Method Post "https://manage.1patch.local:4100/nodes/enrollments" `
  -Headers @{ "Authorization" = "Bearer <admin-jwt>" } `
  -ContentType "application/json" `
  -Body '{ "name": "node-1", "publicUrl": "https://node-1.1patch.local:4200" }'

$enrollment.nodeId           # copy this
$enrollment.enrollmentToken  # copy this — one-time use, valid for 24 hours
```

### 2. Install dependencies and run setup

```powershell
cd 1patch-backend-node
npm install

.\scripts\setup-backend-node.ps1 `
  -ManagementUrl       "https://manage.1patch.local:4100" `
  -NodeId              "<nodeId from enrollment>" `
  -NodeEnrollmentToken "<enrollmentToken from enrollment>" `
  -NodePublicUrl       "https://node-1.1patch.local:4200" `
  -DragonflyUrl        "redis://localhost:6380"
```

The script writes `.env`. No shared secret is required — authentication is mTLS-only.

### 3. Build and start

```powershell
npm run build && npm start
```

On first start the node:
1. Registers with the management server using the enrollment token (one-time, 24 h TTL)
2. Receives a Vault-issued EC P-256 mTLS certificate (24-hour TTL) and a per-node decommission token
3. Persists the certificate to `./tls/node.crt` and `./tls/node.key`
4. Persists the decommission token hash to `.env` as `NODE_DECOMMISSION_TOKEN_HASH`
5. Uses the certificate as a client certificate on all subsequent management server calls

The certificate is renewed automatically 2 hours before expiry by a background cron job — no manual restart is required.

---

## Environment Variables

All variables are written to `.env` by `setup-backend-node.ps1`. Reference:

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Listening port (default `4200`) |
| `NODE_ID` | yes | UUID assigned by the management server at enrollment |
| `NODE_ENROLLMENT_TOKEN` | yes | One-time token from the management server enrollment (24 h TTL) |
| `NODE_PUBLIC_URL` | yes | Publicly reachable URL clients use to reach this node |
| `MANAGEMENT_URL` | yes | Management server base URL |
| `DRAGONFLY_URL` | yes | Redis-compatible connection string |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated origins for browser-facing routes |
| `NODE_TLS_DIR` | no | Directory for mTLS cert files (default `./tls`) |
| `NODE_DECOMMISSION_TOKEN_HASH` | auto | Written by the node after first registration. Do not set manually. |
| `REQUEST_BODY_LIMIT` | no | Max request body size (default `10mb`) |

> **`NODE_API_SECRET` has been removed.** All management server communication is authenticated via the Vault-issued mTLS client certificate. No shared secret is needed or accepted.

---

## Key API Routes

### Agent (client-facing, no auth — rate limited)
| Method | Path | Description |
|---|---|---|
| `POST` | `/agent/register` | Device enrollment |
| `POST` | `/agent/heartbeat` | Device liveness |
| `POST` | `/agent/inventory` | Installed app inventory upload |
| `GET`  | `/agent/tasks/:deviceId` | Poll pending tasks |
| `POST` | `/agent/tasks/result` | Report task result |

### Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — returns queue size and capacity |

### Node control (internal)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/node/decommission` | Per-node decommission token hash | Called by management server on node removal |

---

## How the Queue Works

Every event from a client (heartbeat, inventory, task result, alarm) is written to DragonflyDB immediately and acknowledged to the client. A background job flushes the queue to the management server every 60 seconds using the mTLS certificate. If the management server is unreachable, events stay in the queue and are retried — no client data is lost.

Task bundles pulled from management are ES256-signed and relayed to clients unchanged. Backend nodes do not hold management private signing keys.

See [`docs/offline-queue.md`](docs/offline-queue.md) for full details.

---

## mTLS Certificate Lifecycle

| Event | What happens |
|---|---|
| First `npm start` | Node registers with enrollment token, receives cert from Vault, saves to `./tls/` |
| Cert within 2 hours of expiry | Background cron calls `POST /nodes/renew-cert`, swaps cert atomically |
| Subsequent `npm start` | Loads cert from `./tls/`, uses immediately; re-registration issues a fresh cert and revokes the old one |
| Node decommissioned | Management revokes cert via Vault CRL; `NODE_DECOMMISSION_TOKEN_HASH` verified before config is cleared |

---

## Development

```powershell
npm install
npm run dev   # ts-node watch mode on port 4200
```

mTLS is not required in development. Without a cert in `./tls/` the node falls back to plain HTTP. `MtlsNodeGuard` on the management server accepts a `nodeId` from the request body in dev mode.

```powershell
npm run typecheck  # tsc --noEmit
npm test           # jest
```
