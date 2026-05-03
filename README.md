# 1Patch Backend Node

NestJS data and command plane for 1Patch. Clients communicate with backend nodes over HTTPS polling. Nodes maintain a durable local queue so client data is never lost when the management server is offline.

**Port:** `4200`  
**License:** AGPL-3.0-only


---

## Prerequisites

- Node.js 20 LTS or 22 LTS
- DragonflyDB (Redis-compatible)
- A running 1Patch Management Server
- PowerShell 7.4+

---

## First-Time Setup

### 1. Create a node enrollment on the management server

Run this from any machine that can reach the management server:

```powershell
$enrollment = Invoke-RestMethod `
  -Method Post "https://manage.1patch.local:4100/nodes/enrollments" `
  -Headers @{ "x-1patch-admin-token" = "<ADMIN_API_TOKEN>" } `
  -ContentType "application/json" `
  -Body '{ "name": "node-1", "publicUrl": "https://node-1.1patch.local:4200" }'

$enrollment.nodeId           # copy this
$enrollment.enrollmentToken  # copy this
$enrollment.nodeApiSecret    # copy this (same as management NODE_API_SECRET)
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
  -DragonflyUrl        "redis://localhost:6380" `
  -NodeApiSecret       "<NODE_API_SECRET>"
```

The script writes `.env`.

### 3. Build and start

```powershell
npm run build && npm start
```

On first start the node:
1. Registers with the management server using the enrollment token
2. Receives a Vault-issued EC P-256 mTLS certificate (24-hour TTL)
3. Persists the certificate to `./tls/node.crt` and `./tls/node.key`
4. Uses the certificate as a client certificate on all subsequent management server calls

The certificate is automatically re-issued on every restart (old cert is revoked first).

---

## Environment Variables

All variables are written to `.env` by `setup-backend-node.ps1`. Reference:

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Listening port (default `4200`) |
| `NODE_ID` | yes | UUID assigned by the management server at enrollment |
| `NODE_ENROLLMENT_TOKEN` | yes | One-time token from the management server enrollment |
| `NODE_PUBLIC_URL` | yes | Publicly reachable URL clients use to reach this node |
| `MANAGEMENT_URL` | yes | Management server base URL |
| `NODE_API_SECRET` | yes | Min 32 chars — must match `NODE_API_SECRET` on the management server |
| `DRAGONFLY_URL` | yes | Redis-compatible connection string |
| `SIGNING_SECRET` | yes | Min 32 chars — HMAC-signs node-local payloads |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated origins for browser-facing routes |
| `NODE_TLS_DIR` | no | Directory for mTLS cert files (default `./tls`) |
| `REQUEST_BODY_LIMIT` | no | Max request body size (default `10mb`) |

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
| `POST` | `/node/decommission` | Node secret | Called by management server on node removal |

---

## How the Queue Works

Every event from a client (heartbeat, inventory, task result, alarm) is written to DragonflyDB immediately and acknowledged to the client. A background job flushes the queue to the management server every 60 seconds. If the management server is unreachable, events stay in the queue and are retried on the next flush cycle — no client data is lost.

See [`docs/offline-queue.md`](docs/offline-queue.md) for full details.

---

## mTLS Certificate Lifecycle

| Event | What happens |
|---|---|
| First `npm start` | Node registers, receives cert from Vault, saves to `./tls/` |
| Subsequent `npm start` | Loads cert from `./tls/`, uses immediately; re-registration issues a fresh cert |
| Node decommissioned | Management server revokes cert via Vault CRL; cert stops working within ~10 min |
| Cert approaching expiry | Restart the node — re-registration issues a new 24 h cert automatically |

---

## Development

```powershell
npm install
npm run dev   # ts-node watch mode on port 4200
```

mTLS is not required in development. Without a cert in `./tls/` the node falls back to plain HTTPS with `NODE_API_SECRET` auth only.

```powershell
npm run typecheck  # tsc --noEmit
npm test           # jest
```
