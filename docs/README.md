# VPN Hub — Project Package

Complete design package for VPN Hub — VPN tunnel service that provides Public IPv4 routing for home/office users behind CGNAT.

**Status:** Design phase complete, ready for implementation  
**Version:** 1.1  
**Last updated:** 19 May 2026

---

## 📦 What's in this package

| File | Size | Purpose |
|---|---|---|
| `DESIGN_DOCUMENT.md` | 37 KB | **Master design document** — read first |
| `vpn_hub_schema.sql` | 17 KB | Complete PostgreSQL schema (15 tables) |
| `vpnhub-api.yaml` | 35 KB | OpenAPI 3.0 — main API (32 endpoints) |
| `vpnhub-agent.yaml` | 15 KB | OpenAPI 3.0 — gateway agent (11 endpoints) |
| `API_README.md` | 5 KB | API usage guide for developers |

---

## 🚀 Quick Start for Claude Code

### 1. Upload this folder to your server

```bash
# Option A: scp from local
scp -r vpnhub-design/ packhuso@10.1.3.249:/opt/vpnhub/docs/

# Option B: git (if you create a private repo)
git clone <your-repo> /opt/vpnhub/docs/
```

### 2. Run Claude Code on the server

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install Claude Code
sudo npm install -g @anthropic-ai/claude-code

# Start in the project directory
cd /opt/vpnhub
claude
```

### 3. Initial prompt to give Claude Code

```
อ่าน /opt/vpnhub/docs/DESIGN_DOCUMENT.md และไฟล์อื่นใน /opt/vpnhub/docs/ ก่อน

Infrastructure ready:
- Debian 13 on Proxmox VM (4 vCPU, 16 GB RAM)
- / (SSD 44G LVM) — OS
- /data/hot (SSD 52G LVM) — hot data
- /data/cold (HDD 492G) — cold data
- IP: 10.1.3.249

Implement in this order, verify after each step:
1. Install Docker + Docker Compose
2. Setup directory structure per design
3. Create docker-compose.yml with all services
4. Configure Caddy + PostgreSQL + Redis
5. Run schema migration from vpn_hub_schema.sql
6. Setup pgBackRest backup to Cloudflare R2
7. Scaffold NestJS API + Next.js portal
```

---

## 📚 Document Reading Order

For new team members, read in this order:

1. **DESIGN_DOCUMENT.md** Section 1-2 — Understand the business
2. **DESIGN_DOCUMENT.md** Section 3-4 — Understand the architecture
3. **vpn_hub_schema.sql** — Understand the data model
4. **DESIGN_DOCUMENT.md** Section 7 — Understand the core flows
5. **vpnhub-api.yaml** — Understand the API surface
6. **DESIGN_DOCUMENT.md** Section 10 — Understand the roadmap

---

## 🔑 Key Design Decisions

Quick reference for common questions:

| Question | Answer |
|---|---|
| What does the money look like? | Integer satang (100฿ = 10000) |
| Routing approach? | Pure routing (not NAT) via WireGuard AllowedIPs |
| Billing cycle? | 31 days per resource, not calendar month |
| Suspension? | Immediate on insufficient credit, delete after 3 days |
| Payment in MVP? | Credit codes only (admin generated) |
| Auth? | Google SSO only (Phase 1) |
| VPN protocols? | WireGuard only in MVP, OpenVPN Phase 2 |
| Gateway location? | Separate provider with BGP support (not same VM as app) |
| Worker → agent security? | Firewall whitelist + mTLS + Bearer token (3 layers) |
| Database? | PostgreSQL 16 + Drizzle ORM |
| Queue? | BullMQ + Redis |
| Frontend? | Next.js 15 + shadcn/ui + Tailwind |
| Backend? | NestJS + Node.js 22 LTS |
| Gateway OS? | Debian 12 (Bookworm) |
| App VM OS? | Debian 13 (Trixie) |

---

## 🏗️ Implementation Phases

15 weeks total (full-time) / 30 weeks (part-time):

- **Phase 0** (Week 1-2): Foundation — VM, domain, IP block submission
- **Phase 1** (Week 3-6): Core backend — auth, credit, code redemption
- **Phase 2** (Week 7-10): Tunnel + gateway agent + provisioning
- **Phase 3** (Week 11-13): UI + admin + billing scheduler
- **Phase 4** (Week 14-15): Beta + launch

See **DESIGN_DOCUMENT.md Section 10** for detailed task breakdown.

---

## ⚠️ Critical Path Reminder

**Start these in parallel from Day 1:**

1. **APNIC IP block + ASN application** — 1-3 months wait time!
2. **Database schema migration** — Blocks all backend work
3. **Google OAuth setup** — Blocks user login

If you don't apply for IP block in Week 1, you can't launch in Week 15.

---

## 🛡️ Security Reminders

- Never commit `.env` files with secrets
- Always use `Idempotency-Key` header for write operations
- Atomic UPDATE...WHERE...RETURNING for counters
- Generic error messages on code redemption (prevent enumeration)
- mTLS + Bearer + firewall for worker → agent
- All money operations in DB transaction with FOR UPDATE lock

---

## 📞 Need to revisit design decisions?

The original design conversation explored:
- Why pure routing vs NAT (performance + protocol support)
- Why Linux-only data plane vs Mikrotik hybrid (WireGuard performance)
- Why hybrid SSD+HDD storage (DB random IO needs SSD)
- Why split worker/gateway provider (BGP availability)

If new requirements emerge that conflict with these decisions, update DESIGN_DOCUMENT.md and add a Change Log entry.

---

## 🎯 Success Metrics

| Milestone | Target |
|---|---|
| Beta launch | 10+ users, 5+ active tunnels, 99%+ uptime |
| Month 1 | 30+ users, MRR > 5K ฿ |
| Month 3 | 100+ users, MRR > 20K ฿, churn < 10% |
| Month 6 | 300+ users, MRR > 60K ฿, break-even |

---

## 📝 Change Log

| Version | Date | Notes |
|---|---|---|
| 1.0 | 18 May 2026 | Initial design |
| 1.1 | 19 May 2026 | Storage strategy refined (hybrid SSD+HDD on Proxmox) |

---

Good luck with the build! 🚀
