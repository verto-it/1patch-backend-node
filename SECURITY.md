# Security Policy

- Backend nodes must run behind HTTPS outside local development.
- Node enrollment tokens are one-time bootstrap secrets and must be rotated after registration.
- Agent task payloads must be allowlisted actions, not arbitrary shell commands.
- Package hashes and signatures must be verified before client execution.
