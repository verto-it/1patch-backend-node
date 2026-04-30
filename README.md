# 1Patch Backend Node

AGPLv3 data and command plane for 1Patch. Agents communicate with backend nodes over HTTPS polling. Nodes keep a durable local queue so client data is not lost when the management server is offline.

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

## First Setup

Create a node enrollment in the management server, then open `/setup` on this backend node or run:

```powershell
./scripts/setup-backend-node.ps1 -ManagementUrl "https://manage.1patch.local" -NodeId "<node-id>" -NodeEnrollmentToken "<token>" -NodePublicUrl "https://node-1.1patch.local" -DragonflyUrl "redis://localhost:6380"
```

DragonflyDB is required for node queues and pending tasks so client data survives management outages and backend-node process restarts.

## Responsibilities

- Register against a management server with a node enrollment token.
- Pull signed rules and configuration from management.
- Accept client enrollment, heartbeat, inventory, task result, and alarm uploads.
- Queue events locally and replay them to management.
- Expose health and capacity for node routing.
