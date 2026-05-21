-- ============================================================================
-- VPN Hub MVP - Database Schema
-- PostgreSQL 16+
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. USERS & AUTH
-- ============================================================================

CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub      VARCHAR(255) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255),
    phone           VARCHAR(20),
    avatar_url      TEXT,
    
    -- Tax info for invoicing
    tax_id          VARCHAR(20),
    company_name    VARCHAR(255),
    billing_address TEXT,
    
    status          user_status NOT NULL DEFAULT 'active',
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    
    last_login_at   TIMESTAMPTZ,
    last_login_ip   INET,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_users_google_sub ON users(google_sub) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users(status) WHERE deleted_at IS NULL;


CREATE TYPE admin_role AS ENUM ('super_admin', 'admin', 'support', 'finance', 'readonly');

CREATE TABLE admin_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    google_sub      VARCHAR(255) UNIQUE,
    role            admin_role NOT NULL DEFAULT 'support',
    
    totp_secret     TEXT,
    totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE user_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(64) NOT NULL UNIQUE,
    user_agent      TEXT,
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON user_sessions(expires_at) WHERE revoked_at IS NULL;


-- ============================================================================
-- 2. CREDIT & WALLET
-- ============================================================================

CREATE TABLE credit_wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    
    balance_satang  BIGINT NOT NULL DEFAULT 0,
    
    lifetime_topup_satang BIGINT NOT NULL DEFAULT 0,
    lifetime_spent_satang BIGINT NOT NULL DEFAULT 0,
    
    version         INTEGER NOT NULL DEFAULT 0,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT positive_balance CHECK (balance_satang >= 0)
);


CREATE TYPE credit_tx_type AS ENUM (
    'code_redemption',
    'payment_topup',
    'admin_adjustment',
    'subscription_charge',
    'ip_charge',
    'refund',
    'reversal'
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    wallet_id       UUID NOT NULL REFERENCES credit_wallets(id),
    
    type            credit_tx_type NOT NULL,
    amount_satang   BIGINT NOT NULL,
    balance_after   BIGINT NOT NULL,
    
    description     TEXT NOT NULL,
    
    code_redemption_id UUID,
    invoice_id      UUID,
    admin_user_id   UUID REFERENCES admin_users(id),
    related_tx_id   UUID REFERENCES credit_transactions(id),
    
    idempotency_key VARCHAR(255) UNIQUE,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_user_time ON credit_transactions(user_id, created_at DESC);
CREATE INDEX idx_credit_tx_type ON credit_transactions(type, created_at DESC);


-- ============================================================================
-- 3. CREDIT CODES
-- ============================================================================

CREATE TYPE code_batch_status AS ENUM ('active', 'paused', 'revoked');
CREATE TYPE code_status AS ENUM ('active', 'exhausted', 'expired', 'revoked');

CREATE TABLE credit_code_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    notes           TEXT,
    
    created_by_admin UUID NOT NULL REFERENCES admin_users(id),
    
    credit_value_satang BIGINT NOT NULL,
    max_uses_total      INTEGER NOT NULL DEFAULT 1,
    max_uses_per_user   INTEGER NOT NULL DEFAULT 1,
    expires_at          TIMESTAMPTZ,
    
    code_count          INTEGER NOT NULL DEFAULT 0,
    redeemed_count      INTEGER NOT NULL DEFAULT 0,
    total_credit_redeemed_satang BIGINT NOT NULL DEFAULT 0,
    
    status              code_batch_status NOT NULL DEFAULT 'active',
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT positive_value CHECK (credit_value_satang > 0),
    CONSTRAINT valid_uses CHECK (max_uses_total >= 0 AND max_uses_per_user >= 0)
);


CREATE TABLE credit_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id        UUID NOT NULL REFERENCES credit_code_batches(id),
    
    code            VARCHAR(32) NOT NULL UNIQUE,
    code_normalized VARCHAR(32) NOT NULL UNIQUE,
    
    credit_value_satang BIGINT NOT NULL,
    max_uses_total      INTEGER NOT NULL,
    max_uses_per_user   INTEGER NOT NULL,
    current_uses        INTEGER NOT NULL DEFAULT 0,
    expires_at          TIMESTAMPTZ,
    
    status              code_status NOT NULL DEFAULT 'active',
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT positive_code_value CHECK (credit_value_satang > 0),
    CONSTRAINT valid_uses_code CHECK (
        current_uses >= 0 AND (max_uses_total = 0 OR current_uses <= max_uses_total)
    )
);

CREATE INDEX idx_codes_normalized_active ON credit_codes(code_normalized) WHERE status = 'active';
CREATE INDEX idx_codes_batch ON credit_codes(batch_id);
CREATE INDEX idx_codes_expiry ON credit_codes(expires_at) 
    WHERE status = 'active' AND expires_at IS NOT NULL;


CREATE TABLE credit_code_redemptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_id         UUID NOT NULL REFERENCES credit_codes(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    transaction_id  UUID NOT NULL REFERENCES credit_transactions(id),
    
    credit_added_satang BIGINT NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    
    redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_redemptions_code ON credit_code_redemptions(code_id);
CREATE INDEX idx_redemptions_user ON credit_code_redemptions(user_id);
CREATE INDEX idx_redemptions_user_code ON credit_code_redemptions(user_id, code_id);


-- ============================================================================
-- 4. TUNNELS & IPs
-- ============================================================================

CREATE TYPE gateway_status AS ENUM ('active', 'draining', 'maintenance', 'offline');
CREATE TYPE vpn_protocol AS ENUM ('wireguard', 'openvpn');
CREATE TYPE speed_tier AS ENUM ('tier_100mb', 'tier_500mb', 'tier_1gb');
CREATE TYPE tunnel_status AS ENUM ('provisioning', 'active', 'suspended', 'failed', 'deleted');
CREATE TYPE ip_status AS ENUM ('available', 'allocated', 'suspended', 'reserved', 'blacklisted');
CREATE TYPE ip_block_status AS ENUM ('active', 'suspended', 'released');


CREATE TABLE vpn_gateways (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname        VARCHAR(255) NOT NULL UNIQUE,
    location        VARCHAR(50) NOT NULL,
    
    agent_endpoint  VARCHAR(255) NOT NULL,
    agent_ca_cert   TEXT NOT NULL,
    agent_token     TEXT NOT NULL,
    
    wg_endpoint     VARCHAR(255) NOT NULL,
    wg_port         INTEGER NOT NULL DEFAULT 51820,
    wg_public_key   TEXT NOT NULL,
    
    ovpn_endpoint   VARCHAR(255) NOT NULL,
    ovpn_port       INTEGER NOT NULL DEFAULT 1194,
    
    private_subnet  CIDR NOT NULL,
    
    max_tunnels     INTEGER NOT NULL DEFAULT 500,
    current_tunnels INTEGER NOT NULL DEFAULT 0,
    
    status          gateway_status NOT NULL DEFAULT 'active',
    last_health_check TIMESTAMPTZ,
    health_status   VARCHAR(20),
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE ip_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    block           CIDR NOT NULL UNIQUE,
    block_size      INTEGER NOT NULL,
    
    asn             VARCHAR(20),
    upstream_provider VARCHAR(100),
    
    available_count INTEGER NOT NULL,
    allocated_count INTEGER NOT NULL DEFAULT 0,
    
    notes           TEXT,
    added_by_admin  UUID REFERENCES admin_users(id),
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE tunnels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    gateway_id      UUID NOT NULL REFERENCES vpn_gateways(id),
    
    name            VARCHAR(100) NOT NULL,
    protocol        vpn_protocol NOT NULL,
    speed_tier      speed_tier NOT NULL,
    
    private_ip      INET NOT NULL,
    wg_public_key   TEXT,
    wg_private_key_encrypted TEXT,
    wg_preshared_key TEXT,
    ovpn_client_cert TEXT,
    ovpn_client_key_encrypted TEXT,
    
    config_blob     TEXT,
    
    status          tunnel_status NOT NULL DEFAULT 'provisioning',
    
    last_handshake_at TIMESTAMPTZ,
    last_endpoint   INET,
    bytes_rx        BIGINT NOT NULL DEFAULT 0,
    bytes_tx        BIGINT NOT NULL DEFAULT 0,
    
    next_billing_at TIMESTAMPTZ NOT NULL,
    last_billed_at  TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ,
    delete_after    TIMESTAMPTZ,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    
    UNIQUE (gateway_id, private_ip),
    UNIQUE (gateway_id, wg_public_key) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_tunnels_user ON tunnels(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tunnels_gateway ON tunnels(gateway_id) WHERE status = 'active';
CREATE INDEX idx_tunnels_billing_due ON tunnels(next_billing_at) WHERE status IN ('active', 'suspended');
CREATE INDEX idx_tunnels_delete_due ON tunnels(delete_after) WHERE status = 'suspended';


CREATE TABLE ip_blocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    pool_id         UUID NOT NULL REFERENCES ip_pool(id),
    
    block           CIDR NOT NULL,
    block_size      INTEGER NOT NULL,
    price_satang    BIGINT NOT NULL,
    
    status          ip_block_status NOT NULL DEFAULT 'active',
    
    next_billing_at TIMESTAMPTZ NOT NULL,
    last_billed_at  TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ,
    delete_after    TIMESTAMPTZ,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_block_size CHECK (block_size IN (8, 16, 32, 64, 128, 256))
);

CREATE INDEX idx_blocks_user ON ip_blocks(user_id) WHERE status = 'active';
CREATE INDEX idx_blocks_billing_due ON ip_blocks(next_billing_at) WHERE status IN ('active', 'suspended');


CREATE TABLE public_ips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address      INET NOT NULL UNIQUE,
    pool_id         UUID NOT NULL REFERENCES ip_pool(id),
    
    user_id         UUID REFERENCES users(id),
    tunnel_id       UUID REFERENCES tunnels(id),
    block_id        UUID REFERENCES ip_blocks(id),
    
    reverse_dns     VARCHAR(255),
    
    status          ip_status NOT NULL DEFAULT 'available',
    
    next_billing_at TIMESTAMPTZ,
    last_billed_at  TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ,
    delete_after    TIMESTAMPTZ,
    
    reputation_status VARCHAR(20),
    reputation_checked_at TIMESTAMPTZ,
    
    allocated_at    TIMESTAMPTZ,
    released_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ips_user ON public_ips(user_id) WHERE status = 'allocated';
CREATE INDEX idx_ips_tunnel ON public_ips(tunnel_id) WHERE status = 'allocated';
CREATE INDEX idx_ips_block ON public_ips(block_id);
CREATE INDEX idx_ips_status ON public_ips(status);
CREATE INDEX idx_ips_billing_due ON public_ips(next_billing_at) 
    WHERE status IN ('allocated', 'suspended') AND block_id IS NULL;


-- ============================================================================
-- 5. AUDIT & LOGGING
-- ============================================================================

CREATE TYPE actor_type AS ENUM ('user', 'admin', 'system', 'agent');

CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    actor_type      actor_type NOT NULL,
    actor_id        UUID,
    actor_email     VARCHAR(255),
    
    action          VARCHAR(100) NOT NULL,
    resource_type   VARCHAR(50),
    resource_id     UUID,
    
    metadata        JSONB,
    
    ip_address      INET,
    user_agent      TEXT,
    
    success         BOOLEAN NOT NULL DEFAULT TRUE,
    error_message   TEXT,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor ON audit_logs(actor_type, actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_time ON audit_logs(created_at DESC);


CREATE TABLE bandwidth_usage (
    tunnel_id       UUID NOT NULL REFERENCES tunnels(id),
    bucket_start    TIMESTAMPTZ NOT NULL,
    rx_bytes        BIGINT NOT NULL,
    tx_bytes        BIGINT NOT NULL,
    PRIMARY KEY (tunnel_id, bucket_start)
);


CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    
    type            VARCHAR(50) NOT NULL,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    metadata        JSONB,
    
    severity        VARCHAR(20) DEFAULT 'info',
    
    read_at         TIMESTAMPTZ,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;


-- ============================================================================
-- TRIGGERS & FUNCTIONS
-- ============================================================================

-- Auto-update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_admin_users_updated BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_wallets_updated BEFORE UPDATE ON credit_wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_code_batches_updated BEFORE UPDATE ON credit_code_batches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_codes_updated BEFORE UPDATE ON credit_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_gateways_updated BEFORE UPDATE ON vpn_gateways
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tunnels_updated BEFORE UPDATE ON tunnels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_blocks_updated BEFORE UPDATE ON ip_blocks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ips_updated BEFORE UPDATE ON public_ips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Auto-create wallet when user is created
CREATE OR REPLACE FUNCTION create_wallet_for_new_user() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO credit_wallets (user_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_create_wallet AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION create_wallet_for_new_user();
