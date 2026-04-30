# Dragonfly Offline Queue

Backend nodes use DragonflyDB for queued client events and pending tasks. This lets nodes keep accepting client data while the management server is offline and survive backend-node process restarts.

Required production backend:

- DragonflyDB, configured by `DRAGONFLY_URL`.

Queued event types:

- Device registration
- Heartbeat
- Inventory
- Task result
- Alarm
