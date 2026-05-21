# VPN Hub — Design Document

**Version:** 1.1  
**Last updated:** 19 May 2026  
**Status:** Design phase — pre-implementation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Business Model](#2-business-model)
3. [Architecture Overview](#3-architecture-overview)
4. [Infrastructure](#4-infrastructure)
5. [Database Schema](#5-database-schema)
6. [Security Design](#6-security-design)
7. [Core Flows](#7-core-flows)
8. [API Reference](#8-api-reference)
9. [UI Design](#9-ui-design)
10. [MVP Roadmap](#10-mvp-roadmap)
11. [Risks & Mitigation](#11-risks--mitigation)
12. [Appendix](#12-appendix)

---

## 1. Executive Summary

### Problem
บ้านและออฟฟิศในไทยส่วนใหญ่ได้ Private IP จาก ISP (CGNAT) ทำให้ไม่สามารถ host home server, game server, mail server หรือ self-hosted services ที่ต้อง expose service ไปยัง internet ได้

### Solution
ให้บริการ VPN tunnel ที่ลูกค้าสามารถ connect เข้ามา และได้ **Public IPv4** ที่ route trafic ผ่าน tunnel โดยใช้ pure routing (1:1 mapping) ไม่ใช่ NAT — ทำให้ลูกค้าได้ Public IP จริงๆ ใช้ bind service ได้ทันที

### Key Differentiators
- **Pure routing** ไม่ใช่ NAT — performance สูง, ทุก protocol รองรับ
- **Public IP movable** ระหว่าง tunnel ของตัวเอง
- **Speed tier flexible** — แยกค่าเช่า speed กับค่าซื้อ IP
- **31-day cycle** ต่ออายุชัดเจน

### Target Users
- Self-hoster (Plex, NAS, Home Assistant)
- Game server admin
- Indie hosting / mail server
- Network enthusiast

---

## 2. Business Model

### 2.1 Pricing Structure

**Speed Package (Tunnel Subscription)** — รายเดือน:

| Package | ราคา | Speed | Private IP |
|---|---|---|---|
| Tier 100Mb | 100 ฿ | 100 Mbps | 1 (รวมในแพคเก็จ) |
| Tier 500Mb | 200 ฿ | 500 Mbps | 1 (รวมในแพคเก็จ) |
| Tier 1Gbps | 300 ฿ | 1 Gbps | 1 (รวมในแพคเก็จ) |

**สำคัญ:** Private IP ที่ได้รวมแพคเก็จไม่สามารถใช้ออก internet ได้ — เป็นแค่ tunnel routing internal เท่านั้น

**Public IP Add-on:**

| ประเภท | ราคา | จำนวน IPs | บาท/IP |
|---|---|---|---|
| Single IP | 100 ฿ | 1 | 100 ฿ |
| Block 8 | 800 ฿ | 8 | 100 ฿ |
| Block 16 | 1,500 ฿ | 16 | 93.75 ฿ |
| Block 32 | 2,800 ฿ | 32 | 87.50 ฿ |
| Block 64 | 5,200 ฿ | 64 | 81.25 ฿ |
| Block 128 | 9,800 ฿ | 128 | 76.56 ฿ |
| Block 256 | 18,000 ฿ | 256 | 70.31 ฿ |

**Customer ต้องซื้อ Public IP อย่างน้อย 1 ตัว** เพื่อให้ tunnel ใช้งานได้จริง

### 2.2 Billing Cycle

- **31 วัน = 1 รอบ** (ไม่ใช่ปฏิทินเดือน)
- Per-resource billing — แต่ละ tunnel/IP มี `next_billing_at` ของตัวเอง
- เครดิตหักจาก wallet เมื่อถึงรอบ
- ไม่มี pro-rated — คิดเต็มเดือน

### 2.3 Suspension & Deletion

- เครดิตไม่พอ → **suspend ทันที**
- ลูกค้าได้รับ notification วันละครั้ง 3 วัน
- 3 วันไม่เติม → **ลบถาวร** กู้คืนไม่ได้
- Tunnel ถูกลบ → Public IP standalone กลับเข้า pool, IP ใน block ยังเป็นของลูกค้า

### 2.4 Payment Methods (MVP)

- **MVP**: Credit code only (admin generate และขายผ่านช่องทางอื่น)
- **Phase 2**: PromptPay QR auto-verification
- **Phase 3**: TrueMoney + บัตรเครดิต ผ่าน Omise

### 2.5 Auth

- Google SSO เท่านั้น (Phase 1)
- 2FA สำหรับ admin (TOTP)

### 2.6 Tunnel Limit

- ไม่จำกัดจำนวน tunnel ต่อ user
- จ่ายตามที่ใช้

---

## 3. Architecture Overview

### 3.1 System Tiers

```
┌─────────────────────────────────────────────────────────────┐
│  Client side                                                │
│  ├─ Customer browser (portal)                              │
│  └─ Customer device (VPN client — WireGuard/OpenVPN)       │
└─────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────┐
│  Edge tier — Cloudflare                                     │
│  ├─ DNS proxy + DDoS protection (portal)                   │
│  └─ Auto SSL                                                │
└─────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────┐
│  Application tier — VM 4 vCPU + 16 GB RAM (Proxmox or cloud) │
│  ├─ Caddy (reverse proxy + SSL)                            │
│  ├─ Next.js (Customer portal + Admin panel)                │
│  ├─ NestJS API                                             │
│  ├─ Worker (BullMQ jobs)                                   │
│  ├─ PostgreSQL 16                                          │
│  ├─ Redis 7                                                │
│  ├─ PowerDNS (reverse DNS)                                 │
│  ├─ Prometheus + Grafana + Loki                            │
│  └─ pgBackRest → Cloudflare R2                             │
└─────────────────────────────────────────────────────────────┘
                          │  HTTPS + mTLS + Bearer
                          │  (firewall whitelist IP)
┌─────────────────────────────────────────────────────────────┐
│  Network edge — VPN Gateway (separate provider)             │
│  ├─ Linux + WireGuard kernel module                        │
│  ├─ FRR (OSPF/BGP)                                         │
│  ├─ nftables (firewall + rate limit)                       │
│  └─ Custom Go agent (port 9443)                            │
└─────────────────────────────────────────────────────────────┘
                          │  BGP
                          │  announce /24
┌─────────────────────────────────────────────────────────────┐
│  Upstream BGP peers (2 carriers for redundancy)            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Routing Strategy: Pure Routing (Not NAT)

ลูกค้าได้ **Public IP จริงๆ** บน WireGuard interface — ไม่มี NAT translation

WireGuard config ตัวอย่าง (server-side):
```ini
[Peer]
PublicKey = <customer-pubkey>
AllowedIPs = 10.99.0.5/32, 203.0.113.50/32
```

`AllowedIPs` ทำหน้าที่ 2 อย่างพร้อมกัน:
- Cryptokey routing (รับ packet จาก peer)
- Routing table (ส่ง packet ออก interface)

ผลคือ kernel route 203.0.113.50 ไป tunnel ตรงๆ — ไม่ rewrite, no conntrack

**ข้อดี:**
- Performance ดีกว่า NAT มาก (no header rewriting, no state tracking)
- ทุก protocol รองรับ (ICMP, GRE, IPSec, multicast)
- Customer เห็น Public IP จริงเมื่อ `ip addr` หรือ `tcpdump`
- Move IP ระหว่าง tunnel = เปลี่ยน `AllowedIPs` อย่างเดียว

### 3.3 BGP & IP Block

- บริษัทถือ **/24 IPv4 block** (256 IPs) ที่ provision จาก APNIC หรือเช่าจาก IP broker
- ใช้ **ASN ของตัวเอง** peer กับ upstream provider 2 รายขึ้นไป
- Gateway run **FRR** สำหรับ BGP/OSPF
- Announce `/32` per customer IP ขึ้นไป upstream → ลูกค้า reachable จาก internet

---

## 4. Infrastructure

### 4.1 Hosting Decisions

**App / Control Plane — VM 4 vCPU + 16 GB RAM**

Two deployment paths:

**A. Cloud provider (single VM):**
- Oracle Cloud Always Free (ARM 4 vCPU + 24 GB) — ฟรีตลอดชีพ
- Hetzner CAX21 (ARM 4 vCPU + 8 GB) — ~270 ฿/เดือน
- Contabo VPS L (8 vCPU + 30 GB) — ~470 ฿/เดือน
- Vultr High Frequency (4 vCPU + 16 GB SG) — ~1,750 ฿/เดือน

**B. Self-hosted Proxmox (chosen):**
- VM running on Proxmox host with mixed storage
- SSD pool for hot data (DB, cache)
- HDD RAID 3TB pool for cold data (logs, backups, archives)
- Lower long-term cost, full control
- Storage layout detailed in Section 4.3

**App VM OS: Debian 12 (Bookworm)** ⭐ — same as gateway:
- Kernel 6.1 LTS with WireGuard built-in (for testing)
- Excellent stability — no surprise breaking changes
- Docker, PostgreSQL, Redis, all in apt
- Small footprint (~600 MB RAM minimal, ~3 GB disk)
- qemu-guest-agent for Proxmox integration

**VPN Gateway — Separate provider with BGP support**

ต้องเป็น provider ที่ peer BGP customer ได้:
- ในไทย: Internet Thailand, NTT, CAT, CSL
- ต่างประเทศ: Vultr (BYOIP), Hetzner, OVH
- ต้องมี cross-connect + BGP session

**Gateway OS: Debian 12 (Bookworm)** — same rationale as app VM:
- Kernel 6.1 LTS with WireGuard built-in
- FRR, nftables, wireguard-tools, PowerDNS all in apt

Alternatives considered (rejected):
- Ubuntu 24.04 LTS — newer kernel (6.8) but snap overhead
- Rocky/Alma 9 — enterprise-grade but older kernel (5.14)
- Alpine — too minimal, musl libc compatibility issues
- VyOS — too niche, doesn't fit our custom agent

**Gateway VM spec (per gateway):**
- MVP: 2 vCPU + 2 GB RAM + 40 GB SSD + 1 Gbps
- Production: 4 vCPU + 4 GB RAM + 80 GB NVMe + 1-10 Gbps
- WireGuard on 2 vCPU = ~3-5 Gbps single-tunnel throughput
- 1000+ concurrent peers supported per gateway

### 4.2 Memory Budget (16 GB VM)

| Component | RAM | %  |
|---|---|---|
| OS + system | 600 MB | 4% |
| PostgreSQL (shared_buffers 4GB) | 4 GB | 25% |
| Redis | 1 GB | 6% |
| Next.js portal | 1.5 GB | 9% |
| NestJS API | 1.5 GB | 9% |
| Worker (BullMQ) | 1 GB | 6% |
| Caddy | 150 MB | 1% |
| Prometheus + Grafana + Loki | 800 MB | 5% |
| **Used** | **~10.5 GB** | **66%** |
| **Free buffer** | **~5.5 GB** | **34%** |

### 4.3 Storage Strategy (Hybrid SSD + HDD)

VM ใช้ **2 virtual disks** จาก Proxmox host เพื่อแยก hot vs cold workload:

**Disk 1: SSD virtual disk (100 GB)** — Hot path, random I/O critical

| Partition | Mount | Size | Purpose |
|---|---|---|---|
| Root | `/` | 50 GB | OS, Docker, app code, system logs |
| Hot data | `/data/hot` | 50 GB | PostgreSQL, Redis, PowerDNS |

**Disk 2: HDD virtual disk (500 GB)** — Cold path, sequential I/O OK

| Mount | Purpose |
|---|---|
| `/data/cold/loki` | Log aggregation (30 days retention) |
| `/data/cold/prometheus` | Metrics (90 days retention) |
| `/data/cold/grafana` | Dashboard state |
| `/data/cold/backups` | pgBackRest local repo (14 days) |
| `/data/cold/archives` | Old audit logs, exports |

**Why hybrid:**
- PostgreSQL = random I/O → needs SSD (50-100x faster than HDD)
- Loki/Prometheus = sequential append → HDD is fine
- Backups = write once, read rarely → HDD is fine
- DB on HDD = API response degrades 50-100x

**Proxmox VM disk configuration:**

```
Hard Disk 1 (SSD):
  Storage: ssd-thin (LVM-Thin on host SSD)
  Size: 100 GB
  Cache: none           ← critical, prevents data loss
  IO thread: yes
  Discard: yes          ← TRIM support
  SSD emulation: yes

Hard Disk 2 (HDD):
  Storage: hdd-thin (LVM-Thin on HDD RAID pool)
  Size: 500 GB
  Cache: writeback      ← OK for cold data
  IO thread: yes
  Discard: no
```

**Mount options for performance:**
```
LABEL=vpnhub-hot  /data/hot  ext4 defaults,noatime,nodiratime 0 2
LABEL=vpnhub-cold /data/cold ext4 defaults,noatime,nodiratime 0 2
```

`noatime` reduces write overhead 20-30% on DB workloads

### 4.4 Disk Growth Projection

**SSD usage (100 GB total):**

| Stage | Used | Notes |
|---|---|---|
| Day 0 | ~14 GB | OS + Docker + base data |
| Month 6 | ~25 GB | DB grows with users |
| Year 1 | ~40 GB | 1000 users, 3000 tunnels |

Plenty of headroom — 100 GB SSD supports years of growth.

**HDD usage (500 GB total):**

| Stage | Used | Notes |
|---|---|---|
| Day 0 | ~1 GB | Empty observability + backup |
| Month 6 | ~30 GB | Logs + metrics + backups |
| Year 1 | ~80 GB | All observability + 14d local backups |
| Year 2 | ~150 GB | With archives |

500 GB supports 3+ years comfortably.

**Top consumers (in priority order):**
1. PostgreSQL `bandwidth_usage` table (SSD) — mitigated by TimescaleDB compression
2. Loki log chunks (HDD) — 30-day retention
3. Prometheus TSDB (HDD) — 90-day retention with size cap
4. Local pgBackRest repo (HDD) — 14-day cycle
5. Docker layer cache (SSD) — pruned weekly

### 4.5 Backup Strategy (Multi-layer)

Following 3-2-1 rule: **3 copies, 2 media types, 1 offsite**

**Layer 1: Proxmox VM snapshot**
- Daily snapshot of entire VM
- Kept 7 days on host
- RTO: seconds (rollback whole VM)
- RPO: 24 hours
- Use case: failed deploy, config mistake

**Layer 2: pgBackRest on HDD**
- Full backup weekly, incremental daily
- Kept 14 days on `/data/cold/backups`
- RTO: 5-15 minutes
- RPO: down to last second (PITR)
- Use case: data corruption, accidental DELETE

**Layer 3: pgBackRest sync to Cloudflare R2**
- Daily sync to offsite
- Kept 30 days
- RTO: 30-60 minutes (download + restore)
- RPO: 24 hours
- Cost: ~$1.50/month for 100 GB
- Use case: host failure, fire, theft

**Layer 4 (optional): Proxmox Backup Server**
- Weekly to PBS instance on different host
- Deduplication saves disk significantly
- Adds another offsite copy

### 4.6 Cost Summary

| Item | One-time | Monthly |
|---|---|---|
| Domain | 400 ฿/ปี | — |
| Proxmox host hardware (self-hosted) | varies | (own/lease) |
| Or App VM cloud | — | 270-1,750 ฿ |
| Gateway VM | — | 1,500-3,000 ฿ |
| Cloudflare | — | ฟรี |
| Cloudflare R2 (offsite backup) | — | ~50 ฿ (100 GB) |
| Email (Resend free) | — | ฟรี |
| ASN registration (APNIC) | 5,000 ฿ | 3,000 ฿/ปี |
| **IP block /24 (lease)** | 50,000-80,000 ฿ | 3,000-5,000 ฿ |
| **Total** | **~55-85K ฿** | **~5-10K ฿** |

**MVP options:** เริ่มด้วย /28 (16 IPs) — ลด IP cost เหลือ 5-10K ฿/เดือน รองรับลูกค้า 8-12 คน

---

## 5. Database Schema

PostgreSQL 16 + Drizzle ORM. แบ่ง 5 กลุ่มตามหน้าที่:

### 5.1 Schema Groups

| Group | Tables |
|---|---|
| **Users & Auth** | users, admin_users, user_sessions |
| **Credit** | credit_wallets, credit_transactions |
| **Codes** | credit_code_batches, credit_codes, credit_code_redemptions |
| **Network** | vpn_gateways, ip_pool, tunnels, ip_blocks, public_ips |
| **Logging** | audit_logs, bandwidth_usage, notifications |

### 5.2 Key Design Patterns

| Pattern | Rationale |
|---|---|
| `UUID` primary key | Prevent enumeration, multi-master friendly |
| Money as `BIGINT satang` | No floating point errors (100.50 baht = 10050) |
| `TIMESTAMPTZ` (with timezone) | Always UTC, prevents timezone bugs |
| `INET` / `CIDR` types | PostgreSQL native, validates subnet operations |
| `JSONB` for metadata | Flexible schema for audit logs, notifications |
| Soft delete via `deleted_at` | Preserves audit trail |
| `CHECK` constraints | Enforce business rules at DB layer |
| Partial indexes (`WHERE`) | Smaller, faster |
| `idempotency_key` | Prevents duplicate operations on retry |

### 5.3 Critical Constraints

```sql
-- Wallet balance never negative
CONSTRAINT positive_balance CHECK (balance_satang >= 0)

-- Code counter cannot exceed max
CONSTRAINT valid_uses_code CHECK (
  current_uses >= 0 AND (max_uses_total = 0 OR current_uses <= max_uses_total)
)

-- IP block size must be a valid power-of-2 from menu
CONSTRAINT valid_block_size CHECK (block_size IN (8, 16, 32, 64, 128, 256))

-- Tunnel uniqueness: one private IP per gateway
UNIQUE (gateway_id, private_ip)

-- Public IP can only belong to one tunnel at a time
-- (enforced by application + foreign key)
```

### 5.4 Schema File

Full SQL schema available in `vpn_hub_schema.sql`.

15 tables, all enums explicitly defined, triggers for `updated_at`, auto-create wallet on user signup.

### 5.5 Relationship Highlights

**IP allocation hierarchy:**
```
ip_pool (company-owned /24)
   └─ public_ips (individual /32 records)
        ├─ Owned directly by user (single IP purchase)
        └─ Owned via ip_blocks (block purchase 8/16/32/...)
              └─ Block has next_billing_at, individual IPs don't bill separately
```

**Tunnel ↔ Public IP:**
- One-to-many: tunnel has many public_ips
- Movable: change `public_ips.tunnel_id` to reassign

**Credit flow:**
- Every operation creates a row in `credit_transactions` (ledger)
- `credit_wallets.balance_satang` is the running balance
- Wallet updates always include `version += 1` for optimistic locking

---

## 6. Security Design

### 6.1 Layered Defense for Agent Communication

Worker → Gateway Agent traffic ใช้ **3-layer security** (no Tailscale to keep MVP simple):

**Layer 1: Cloud Firewall**
```
Cloud provider firewall (DO, Vultr, Hetzner):
  ALLOW tcp/9443 from <worker-public-ip>/32
  DROP  tcp/9443 from any
```
Packets dropped at provider edge — doesn't touch our VM

**Layer 2: mTLS (Mutual TLS)**
```go
tlsConfig := &tls.Config{
    ClientAuth: tls.RequireAndVerifyClientCert,
    ClientCAs:  privateCAPool,
    MinVersion: tls.VersionTLS13,
}
```
Both client and server present certs signed by our private CA

**Layer 3: Bearer Token**
```
Authorization: Bearer <gateway-specific-token>
```
Token rotated every 30 days, stored encrypted in `vpn_gateways.agent_token`

### 6.2 Customer-Facing Security

- **Google SSO** with `google_sub` as stable identifier
- **Session cookies** stored in Redis with TTL
- **Cloudflare proxy** for portal (DDoS, WAF, SSL)
- **Rate limiting** at multiple levels
- **HTTPS only** with HSTS

### 6.3 Code Redemption Security

**Rate limits:**
- 5 attempts/min per user (Redis sliding window)
- 20 attempts/min per IP

**Anti-enumeration:**
- Generic error message for invalid/expired/exhausted code
- Per-user-limit error allowed (user knows code exists)

**Anti-abuse detection (background job):**
- Multiple users from same IP
- Burst redemptions
- New accounts with high redemption count
- Batch redeemed too quickly (possible leak)

### 6.4 Audit Trail

Every sensitive action logged in `audit_logs`:
- User actions (create, delete, redeem)
- Admin actions (adjust credit, suspend user, blacklist IP)
- System actions (charge, suspend, delete)
- Agent operations (peer create/update/delete)

Indexed by actor, resource, action, time.

### 6.5 Secret Management

- Application secrets in env vars (managed by Doppler or `.env` for MVP)
- Agent tokens stored encrypted in DB
- WireGuard private keys encrypted before storage (libsodium)
- Backup encryption keys offsite

### 6.6 Abuse Handling

- TOS clearly forbids illegal use
- `abuse@vpnhub.example.com` inbox
- Egress rate limit per IP (prevent outbound DDoS)
- Reputation monitoring (Spamhaus, AbuseIPDB)
- Quick admin actions: blacklist IP, suspend user, force release IP

---

## 7. Core Flows

### 7.1 Tunnel Provisioning Flow

```
Customer clicks "Create tunnel"
         ↓
API: BEGIN transaction
  - Lock wallet (FOR UPDATE)
  - Check credit ≥ price
  - Choose gateway with lowest load
  - Allocate private IP from subnet
  - Generate WireGuard keypair
  - Encrypt private key
  - INSERT tunnel (status=provisioning)
  - Deduct credit + INSERT transaction (ledger)
  - Increment gateway counter
  - INSERT audit log
  - INSERT pending_jobs (outbox pattern)
  ↓ COMMIT
  ↓
API: Enqueue BullMQ job (after commit)
API: Return 202 to portal with tunnel_id
         ↓
[ASYNC]
Worker picks job
  ↓
Worker calls Gateway Agent
  POST https://gw1:9443/v1/peers
  Headers: mTLS cert + Bearer + Idempotency-Key
  Body: { peerId, publicKey, privateIp, publicIps }
         ↓
Agent validates input
Agent calls wgctrl to add peer
Agent adds routes via netlink
FRR auto-announces /32 via OSPF/BGP
Agent returns 200 OK
         ↓
Worker updates tunnel status=active
Worker pushes notification to user
         ↓
Portal polls or receives WebSocket
Customer downloads .conf file
Customer connects → tunnel works
```

**Critical patterns:**
- Atomic transaction for credit + tunnel insert
- Outbox pattern (pending_jobs in DB) for job durability
- Idempotency key prevents duplicate provisioning
- Drift detection job reconciles DB ↔ gateway state every 10 minutes
- Auto-refund on permanent failure

### 7.2 Code Redemption Flow

```
User types code, clicks redeem
         ↓
API: Check Redis rate limit
  - User: 5/min limit
  - IP: 20/5min limit
         ↓
API: Normalize code (uppercase, strip dashes/spaces)
         ↓
API: BEGIN transaction
         ↓
ATOMIC UPDATE (the heart of race-condition safety):
  UPDATE credit_codes
  SET current_uses = current_uses + 1
  WHERE code_normalized = ?
    AND status = 'active'
    AND (max_uses_total = 0 OR current_uses < max_uses_total)
    AND (expires_at IS NULL OR expires_at > NOW())
  RETURNING id, batch_id, credit_value_satang, max_uses_per_user;
         ↓
If 0 rows → INVALID_CODE (generic error)
         ↓
Check per-user limit:
  SELECT COUNT(*) FROM credit_code_redemptions
  WHERE code_id = ? AND user_id = ?
         ↓
If count >= max_uses_per_user:
  Rollback counter (UPDATE current_uses - 1)
  Throw PER_USER_LIMIT_EXCEEDED
         ↓
Lock wallet + add credit (UPDATE balance)
INSERT credit_transactions (ledger)
INSERT credit_code_redemptions (audit)
UPDATE batch counters
If counter reached max → mark code as 'exhausted'
INSERT audit_log
         ↓ COMMIT
         ↓
Post-commit hook:
  Try reactivate suspended tunnels/IPs
  Send notification
         ↓
Return 200 { creditAdded, newBalance }
```

**Why race-condition safe:**
PostgreSQL serializes UPDATE on same row. Two concurrent users get serialized — one succeeds, other gets 0 rows.

### 7.3 Daily Billing Scheduler

```
Cron 00:00 BKK
         ↓
Step 1: Permanent deletion
  Find resources where delete_after < NOW()
  For each: remove from gateway, free IPs (if standalone),
            mark deleted, notify user, audit
         ↓
Step 2: Send reminders
  Pre-bill warning (3 days before for insufficient credit)
  Suspension reminder (day 1, day 2 after suspended)
         ↓
Step 3-5: Charge resources due
  Tunnels → IPs (standalone) → IP blocks
  For each: 
    BEGIN tx
    Lock wallet
    Check idempotency (key = "charge-tunnel-{id}-{cycle_date}")
    If balance ≥ price:
      Deduct + INSERT transaction + UPDATE next_billing_at +31 days
      Mark renewed
    Else:
      UPDATE status='suspended', suspended_at=NOW, delete_after=+3 days
      Enqueue gateway suspend job
      Notify + email
      Mark suspended
    COMMIT
         ↓
Step 6: Push metrics to Prometheus
        Audit log of run stats
        Alert on errors
```

**Idempotency:** key includes cycle date, so rerunning scheduler doesn't double-charge

### 7.4 Reactivation Flow (after credit top-up)

```
User redeems code or admin adjusts credit
         ↓
Post-commit hook fires:
  Get all suspended resources (tunnels, IPs)
  Order by suspended_at (oldest first)
  For each:
    If balance ≥ price:
      Charge + reactivate + enqueue gateway resume
      Decrement local balance counter
    Else:
      Break (no more budget)
```

### 7.5 Move IP Between Tunnels

```
User clicks "Move IP" to target tunnel
         ↓
API: BEGIN tx
  Verify IP ownership + tunnel ownership
  UPDATE public_ips SET tunnel_id = new_target
  INSERT 2 pending_jobs:
    - "update-peer-ips" (remove from old tunnel)
    - "update-peer-ips" (add to new tunnel)
  COMMIT
         ↓
Workers process jobs:
  Old tunnel: PATCH agent peer, remove IP from allowed-ips
  New tunnel: PATCH agent peer, add IP to allowed-ips
         ↓
FRR re-announces routes accordingly
```

### 7.6 Reverse DNS Update

```
User sets hostname in portal
         ↓
API validates hostname format
API updates public_ips.reverse_dns
API enqueues "update-ptr" job
         ↓
Worker calls PowerDNS API:
  PATCH zone with new PTR record
         ↓
DNS propagates (TTL 300s)
dig -x 203.0.113.50 now returns hostname
```

---

## 8. API Reference

### 8.1 Main API (`vpnhub-api.yaml`)

**32 endpoints** in OpenAPI 3.0 format. Tags:
- Auth (4)
- Wallet (2)
- Codes (1)
- Tunnels (6)
- Public IPs (6)
- Notifications (3)
- Admin Users (4)
- Admin Codes (5)
- Admin IP Pool (5)
- Admin Gateways (2)

### 8.2 Agent API (`vpnhub-agent.yaml`)

**11 endpoints** for gateway control:
- Peers (6) — CRUD + suspend/resume
- OpenVPN (2) — Phase 2
- Stats (2)
- Health (3)

### 8.3 Conventions

| Convention | Detail |
|---|---|
| Money | `*Satang` suffix, BIGINT |
| Time | ISO 8601 UTC (`2026-05-18T12:34:56Z`) |
| IDs | UUIDv4 |
| Pagination | Cursor-based, `nextCursor` field |
| Idempotency | `Idempotency-Key` header on writes |
| Errors | `{ code, message, details }` |
| Field case | `camelCase` in API, `snake_case` in DB |
| Versioning | URL prefix `/v1/...` |

### 8.4 Common Error Codes

- `UNAUTHORIZED` — Auth required
- `FORBIDDEN` — Not allowed
- `NOT_FOUND` — Resource doesn't exist
- `VALIDATION_ERROR` — Invalid input
- `INSUFFICIENT_CREDIT` — Not enough balance
- `RATE_LIMITED` — Too many requests
- `INVALID_CODE` — Code redemption failed (generic)
- `PER_USER_LIMIT` — Code per-user limit exceeded
- `NO_GATEWAY_AVAILABLE` — All gateways full
- `NO_IP_AVAILABLE` — Pool exhausted

### 8.5 Rate Limits

| Endpoint | Limit | Window |
|---|---|---|
| Default (per user) | 100 | 1 min |
| `POST /codes/redeem` | 5 | 1 min/user |
| `POST /codes/redeem` | 20 | 5 min/IP |
| Admin adjust credit | 10 | 1 min |
| `POST /tunnels` | 5 | 1 min |
| `POST /ips` | 10 | 1 min |
| `PATCH /ips/{id}/reverse-dns` | 10 | 1 hour |

---

## 9. UI Design

### 9.1 Customer Portal Pages

| Page | Purpose | Phase |
|---|---|---|
| Login | Google SSO | MVP |
| Dashboard | Wallet + tunnels + activity | MVP |
| Tunnel List | All tunnels with status | MVP |
| Tunnel Detail | Config download, QR, bandwidth | MVP |
| Public IPs | List + buy modal + rDNS modal | MVP |
| Wallet | Balance + redeem code + transactions | MVP |
| Notifications | List + mark read | MVP |
| Settings | Profile, tax info | Phase 2 |
| Analytics | Bandwidth detailed | Phase 2 |
| Support tickets | Help requests | Phase 2 |

### 9.2 Admin Panel Pages

| Page | Purpose | Phase |
|---|---|---|
| Login + 2FA | Admin auth | MVP |
| Dashboard | KPIs (MRR, users, IP util) | MVP |
| Code Management | List batches, create new | MVP |
| Create Code Form | Single/bulk, auto/custom | MVP |
| User Management | Search, view, suspend | MVP |
| Adjust Credit Modal | Add/deduct with reason | MVP |
| IP Pool | Blocks + IP map + allocations | MVP |
| Audit Log | Filter + search | MVP |
| Gateway Monitoring | Per-gateway health | Phase 2 |
| Reports | Revenue, churn, cohorts | Phase 2 |

### 9.3 Design System

- **Framework:** Next.js 15 + shadcn/ui + Tailwind
- **Typography:** Anthropic Sans-style sans-serif
- **Color semantics:** Green=success, Amber=warning, Red=danger, Blue=info
- **Money display:** Monospace font (`฿ 1,250.00`)
- **Status badges:** Pill shape with color + icon
- **Form validation:** react-hook-form + zod
- **State management:** TanStack Query for server state

### 9.4 Critical UX Patterns

**Dashboard credit display:**
- Show balance prominently
- Show "estimated depletion date" based on burn rate
- Quick "Redeem Code" button

**Tunnel detail:**
- Config block with private key masked
- Download `.conf` button
- QR code for mobile
- Move IP buttons per IP

**Redeem code input:**
- Auto-uppercase on type
- Dashes optional
- Monospace font, letter spacing
- Generic error to prevent enumeration

**Admin adjust credit:**
- Mandatory reason field
- Category dropdown (refund, compensation, etc.)
- Preview new balance before confirm
- Audit log auto-created

---

## 10. MVP Roadmap

### 10.1 Phases (15 weeks total, full-time)

| Phase | Weeks | Focus |
|---|---|---|
| Phase 0 | 1-2 | Foundation: VM setup, DB, repo, IP block submission |
| Phase 1 | 3-6 | Core backend: auth, credit, code redemption |
| Phase 2 | 7-10 | Tunnel + gateway: agent, provisioning, routing |
| Phase 3 | 11-13 | UI + admin + billing scheduler |
| Phase 4 | 14-15 | Beta + launch |

### 10.2 MVP Scope

**IN MVP:**
- Google SSO
- Credit wallet + redeem code system
- Tunnel CRUD (WireGuard only)
- Public IP single + move + basic rDNS
- Daily billing scheduler
- Admin: code mgmt, user adjust, IP pool

**OUT of MVP:**
- OpenVPN (Phase 2)
- IP Block 8/16/32 (Phase 2)
- Payment gateway (Phase 2)
- Multi-gateway (Phase 2)
- Auto-reactivation (manual first)
- Detailed analytics

### 10.3 Critical Path

```
APNIC IP block (1-3 mo wait) ─┐
                              │
Database schema ──────────────┼──→ Beta launch
Credit + code system ─────────┤
Gateway agent ────────────────┤
Tunnel provisioning ──────────┘
```

### 10.4 Week-by-Week Plan

| Week | Output |
|---|---|
| 1 | Domain, Cloudflare, VM, repo, OAuth setup |
| 2 | DB schema migrated, Google SSO works, IP block applied |
| 3 | Credit + wallet API |
| 4 | Code generation + redemption (atomic) |
| 5 | Admin code mgmt + audit log |
| 6 | Gateway setup + BGP peering |
| 7 | Gateway agent (Go) skeleton |
| 8 | Tunnel provisioning E2E |
| 9 | Public IP allocation + move |
| 10 | rDNS + PowerDNS |
| 11 | Customer portal UI |
| 12 | Admin panel UI |
| 13 | Billing scheduler + emails |
| 14 | Monitoring, runbooks, load test |
| 15 | Beta + soft launch |

### 10.5 Success Metrics

| Milestone | Target |
|---|---|
| Beta (Week 15-16) | 10+ users, 5+ active, 0 critical bugs |
| Month 1 | 30+ users, 15+ paying, MRR > 5K ฿ |
| Month 3 | 100+ users, 50+ paying, MRR > 20K ฿, churn < 10% |
| Month 6 | 300+ users, MRR > 60K ฿, break-even |

---

## 11. Risks & Mitigation

### 11.1 High Risk

**APNIC IP/ASN approval slow (1-3 months)**
- Submit application Week 1
- Backup: use IP from gateway provider (Vultr BYOIP, etc.)
- Or start with /28 from IP broker (faster)

### 11.2 Medium Risk

**BGP peering complexity**
- Choose provider with good BGP customer support
- Test peering in staging first
- Have on-call contact at provider

**Race condition bugs in atomic counter**
- Test with concurrent script before production
- Chaos test (kill connections mid-tx)
- Monitor for `current_uses` mismatches

**Gateway agent crash in production**
- Test extensively in staging
- systemd auto-restart on crash
- Health check every 30s
- Alert on first failure

**Customer abuse (DDoS source, spam)**
- TOS clearly forbidden
- Egress rate limit per IP at gateway
- Reputation monitoring
- Quick admin action (suspend within minutes)

### 11.3 Low Risk

**DB disk full**
- Alert at 80% utilization
- TimescaleDB compression for bandwidth_usage
- Log retention 90 days max
- Backup to R2 daily

**DDoS attack**
- Cloudflare for portal
- Provider DDoS protection for gateway
- Rate limits at all layers

---

## 12. Appendix

### 12.1 Tech Stack Reference

**Frontend:**
- Next.js 15 + TypeScript
- shadcn/ui + Tailwind CSS
- TanStack Query
- react-hook-form + zod
- Recharts

**Backend:**
- Node.js 22 LTS
- NestJS
- Drizzle ORM
- Auth.js (Google OAuth)
- BullMQ + Redis
- zod validation

**Data:**
- PostgreSQL 16
- Redis 7
- TimescaleDB (for bandwidth_usage)
- pgBackRest + S3-compatible storage

**Network Gateway:**
- Debian 12
- WireGuard (kernel module)
- OpenVPN (Phase 2)
- FRRouting (OSPF/BGP)
- nftables
- PowerDNS (rDNS)
- Custom Go agent

**Infrastructure:**
- Docker + Docker Compose
- Caddy (reverse proxy)
- GitHub Actions (CI/CD)
- Ansible (gateway provisioning)
- Doppler/Infisical (secrets)

**Observability:**
- Prometheus (metrics)
- Grafana (dashboards)
- Loki + Promtail (logs)
- Sentry (errors)
- Uptime Kuma (uptime)

### 12.2 Project Structure

```
vpn-hub/
├── apps/
│   ├── portal/              # Next.js (customer + admin)
│   ├── api/                 # NestJS REST API
│   ├── worker-internal/     # BullMQ — emails, billing, etc.
│   └── worker-gateway/      # BullMQ — gateway operations
├── packages/
│   ├── db/                  # Drizzle schema + migrations
│   ├── shared/              # Shared types, zod schemas
│   ├── gateway-client/      # mTLS HTTPS client
│   └── billing/             # Billing logic
├── gateway-agent/           # Go binary on gateway
│   ├── cmd/
│   └── internal/
├── infra/
│   ├── ansible/             # Gateway provisioning
│   ├── docker/              # Compose files
│   └── grafana/             # Dashboard JSON
└── docs/
    ├── architecture/
    └── runbooks/
```

### 12.3 Files in This Design Package

| File | Purpose |
|---|---|
| `DESIGN_DOCUMENT.md` | This document |
| `vpn_hub_schema.sql` | Complete DB schema |
| `vpnhub-api.yaml` | Main API OpenAPI spec |
| `vpnhub-agent.yaml` | Gateway agent OpenAPI spec |
| `API_README.md` | API usage guide |

### 12.4 Glossary

| Term | Definition |
|---|---|
| **CGNAT** | Carrier-grade NAT — ISP sharing one Public IP among many customers |
| **PTR record** | DNS record mapping IP → hostname (reverse DNS) |
| **rDNS / FCrDNS** | Reverse DNS / Forward-Confirmed Reverse DNS |
| **mTLS** | Mutual TLS — both client and server present certs |
| **BGP** | Border Gateway Protocol — internet's routing protocol |
| **ASN** | Autonomous System Number — required to BGP peer |
| **AllowedIPs** | WireGuard config that doubles as cryptokey routing + system routing |
| **Idempotency Key** | Client-generated unique ID preventing duplicate ops on retry |
| **Outbox pattern** | Pending jobs in DB ensure delivery even if message broker fails |
| **MRR** | Monthly Recurring Revenue |

### 12.5 References

- WireGuard: https://www.wireguard.com/
- PowerDNS API: https://doc.powerdns.com/authoritative/http-api/
- FRR routing: https://docs.frrouting.org/
- Drizzle ORM: https://orm.drizzle.team/
- NestJS: https://nestjs.com/
- BullMQ: https://docs.bullmq.io/
- APNIC (Asia-Pacific RIR): https://www.apnic.net/
- OpenAPI 3.0: https://spec.openapis.org/oas/v3.0.3

### 12.6 Open Questions / Future Work

These were deferred but should be revisited post-MVP:

- **OpenVPN support**: Required for legacy router compatibility
- **IP Block billing**: Implement 8/16/32/64/128/256 tier
- **Payment gateway**: PromptPay first, then TrueMoney/Omise
- **Multi-region**: Gateway in Singapore, Japan, US
- **Customer API keys**: For automation (resellers, power users)
- **Webhooks**: Notify customers of events
- **Auto top-up**: Save card, charge when low
- **2FA for customers**: Optional TOTP for sensitive actions
- **Referral program**: Earn credit by referring users
- **Reseller tier**: Discount + sub-account management

---

## Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 18 May 2026 | Initial design — full system specification |
| 1.1 | 19 May 2026 | Refined storage strategy: hybrid SSD+HDD on Proxmox host. Added backup layers, App VM OS = Debian 12, mount options, cache modes. |

---

*End of Design Document*
