# Backend Node Source

This folder contains the 1Patch data and command plane node. Backend nodes sit close to clients, accept client traffic, queue events durably, pull signed task bundles from management, and keep working during management outages.

## Runtime Flow

1. `main.ts` starts the Nest app, configures CORS/body limits, and runs interactive setup if required.
2. `console-setup.ts` reads or creates `.env` values such as `NODE_ID`, enrollment token, management URL, public URL, and Dragonfly URL.
3. `management/management.service.ts` registers the node, persists the Vault-issued mTLS certificate, renews it before expiry, sends heartbeat, flushes queued client events, and pulls signed tasks.
4. `agent/agent.controller.ts` receives client registration, heartbeat, inventory, task polling, task results, alarms, and kill-switch reads.
5. `queue/event-queue.service.ts` writes client events to Dragonfly first so outages do not drop data.

## Directory Guide

| Path | Notes |
|---|---|
| `agent/` | Client-facing HTTP endpoints and device key lookup/auth helpers. |
| `management/` | Management-server registration, mTLS agent setup, queue flushing, task pull. |
| `node-control.controller.ts` | Decommission endpoint used by management to clear node config. |
| `packages/` | Package cache and download streaming from management or local cache. |
| `queue/` | Durable event queue helpers. |
| `storage/` | Dragonfly connection, JSON helpers, health status, and graceful shutdown. |
| `tasks/` | Signed task bundle store and per-device dispatch state. |
| `types.ts` | Shared node-side data contracts. |

## Security Boundaries

- First registration uses the one-time enrollment token only.
- All later management calls use the Vault-issued mTLS client certificate.
- Backend nodes relay signed task bundles but do not hold management signing private keys.
- Decommission uses a per-node token hash, not a shared static secret.

## Documentation Notes

TypeScript source functions include JSDoc. Keep future comments focused on queue durability, node identity, mTLS behavior, and client/management boundary assumptions.
