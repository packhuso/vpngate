# VPN Hub API Specifications

OpenAPI 3.0 specs for VPN Hub services.

## Files

| File | Purpose | Endpoints |
|---|---|---|
| `vpnhub-api.yaml` | Main backend API (customer portal + admin panel) | 32 paths |
| `vpnhub-agent.yaml` | Gateway agent API (internal) | 11 paths |

## How to use

### View interactively

Use [Swagger Editor](https://editor.swagger.io/) — paste YAML and explore endpoints:

```bash
# Or run locally
docker run -p 8080:8080 -v $(pwd):/spec swaggerapi/swagger-editor
# Open http://localhost:8080
```

### Generate client SDKs

```bash
# Install openapi-generator
npm install -g @openapitools/openapi-generator-cli

# TypeScript fetch client
openapi-generator-cli generate \
  -i vpnhub-api.yaml \
  -g typescript-fetch \
  -o ./generated/ts-client

# Go client for agent
openapi-generator-cli generate \
  -i vpnhub-agent.yaml \
  -g go \
  -o ./generated/go-client

# Python client
openapi-generator-cli generate \
  -i vpnhub-api.yaml \
  -g python \
  -o ./generated/python-client
```

### Generate server stubs

NestJS doesn't have direct generation but you can use:

```bash
# Generate types only (recommended for NestJS)
openapi-generator-cli generate \
  -i vpnhub-api.yaml \
  -g typescript \
  -o ./generated/types
```

### Validate spec

```bash
npm install -g @apidevtools/swagger-cli
swagger-cli validate vpnhub-api.yaml
swagger-cli validate vpnhub-agent.yaml
```

### Mock server (for frontend dev before backend done)

```bash
npm install -g @stoplight/prism-cli
prism mock vpnhub-api.yaml
# API now available at http://localhost:4010
```

## Conventions used

### Money
All monetary values in **satang** (1/100 baht) as integers.
- `100.50 baht` = `10050` satang
- This avoids floating point bugs in financial calculations
- Field names use `*Satang` suffix to make this explicit

### Identifiers
- All IDs are UUIDv4
- Generated server-side
- Use in URL paths: `/tunnels/{tunnelId}`

### Timestamps
- All in ISO 8601 with timezone (`2026-05-18T12:34:56Z`)
- Stored as `TIMESTAMPTZ` in DB
- Frontend converts to local time for display

### Pagination
- Cursor-based using `nextCursor` field
- Limit defaults to 50, max 200
- Use `limit` + `cursor` query params

### Idempotency
- `Idempotency-Key` header on all write operations
- Client generates unique key (UUID recommended)
- Same key within 24h returns cached result
- Critical for retries to not cause duplicates

### Errors
Standard error format:
```json
{
  "code": "INSUFFICIENT_CREDIT",
  "message": "เครดิตไม่พอสำหรับการสร้าง tunnel",
  "details": {
    "requiredSatang": 30000,
    "currentSatang": 5000
  }
}
```

Common error codes:
- `UNAUTHORIZED` — Auth required
- `FORBIDDEN` — Not allowed (admin check, ownership)
- `NOT_FOUND` — Resource doesn't exist
- `VALIDATION_ERROR` — Invalid input
- `INSUFFICIENT_CREDIT` — Not enough balance
- `RATE_LIMITED` — Too many requests
- `INVALID_CODE` — Code redemption failed (generic, prevents enumeration)
- `PER_USER_LIMIT` — Code per-user limit exceeded
- `NO_GATEWAY_AVAILABLE` — All gateways full
- `NO_IP_AVAILABLE` — Pool exhausted

### Authentication

#### Customer + Admin API (`vpnhub-api.yaml`)
- Cookie-based session after Google OAuth
- Session cookie name: `session`
- Session stored in Redis with TTL
- Admin endpoints additionally check `role` claim

#### Agent API (`vpnhub-agent.yaml`)
- **Layered security:**
  1. Cloud firewall whitelist (worker IP only)
  2. mTLS client cert (signed by private CA)
  3. Bearer token in header
- All 3 must pass

## Rate Limits

| Endpoint | Limit | Window |
|---|---|---|
| Default (per user) | 100 req | 1 min |
| `POST /codes/redeem` | 5 attempts | 1 min per user |
| `POST /codes/redeem` | 20 attempts | 5 min per IP |
| Admin adjust credit | 10 req | 1 min |
| `POST /tunnels` (create) | 5 req | 1 min |
| `POST /ips` (buy) | 10 req | 1 min |

Returns `429 Too Many Requests` with `Retry-After` header.

## Versioning

- URL versioning: `/v1/...`
- Breaking changes get new version (`/v2/...`)
- Non-breaking changes (new fields, new endpoints) stay in same version
- Deprecation: notify 90 days before removal

## Webhooks (Phase 2)

Not in MVP. Future endpoint for customers to receive events:
- `tunnel.online` / `tunnel.offline`
- `tunnel.suspended` / `tunnel.deleted`
- `ip.reputation_changed`
- `credit.low_balance`

## Notes for implementers

### Drizzle ORM mapping
The schemas in this spec map roughly 1:1 to Drizzle tables in `packages/db`.
Field naming convention:
- DB: `snake_case` (e.g. `balance_satang`)
- API: `camelCase` (e.g. `balanceSatang`)
- Use Drizzle's column aliasing or transform layer

### NestJS controller mapping
Each tag in the spec corresponds to one NestJS module:
- `Auth` → `AuthModule` + `AuthController`
- `Wallet` → `WalletModule` + `WalletController`
- `Tunnels` → `TunnelsModule` + `TunnelsController`
- etc.

### Worker job mapping
Operations that enqueue jobs:
- `POST /tunnels` → enqueue `provision-tunnel`
- `POST /tunnels/{id}/regenerate-keys` → enqueue `regenerate-tunnel-keys`
- `DELETE /tunnels/{id}` → enqueue `remove-tunnel`
- `POST /ips/{id}/move` → enqueue `update-peer-ips` (×2 for both tunnels)
- `PATCH /ips/{id}/reverse-dns` → enqueue `update-ptr`

Jobs use BullMQ queue names matching their purpose.
