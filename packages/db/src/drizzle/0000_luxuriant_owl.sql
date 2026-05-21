-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."actor_type" AS ENUM('user', 'admin', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'admin', 'support', 'finance', 'readonly');--> statement-breakpoint
CREATE TYPE "public"."code_batch_status" AS ENUM('active', 'paused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."code_status" AS ENUM('active', 'exhausted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credit_tx_type" AS ENUM('code_redemption', 'payment_topup', 'admin_adjustment', 'subscription_charge', 'ip_charge', 'refund', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."gateway_status" AS ENUM('active', 'draining', 'maintenance', 'offline');--> statement-breakpoint
CREATE TYPE "public"."ip_block_status" AS ENUM('active', 'suspended', 'released');--> statement-breakpoint
CREATE TYPE "public"."ip_status" AS ENUM('available', 'allocated', 'suspended', 'reserved', 'blacklisted');--> statement-breakpoint
CREATE TYPE "public"."speed_tier" AS ENUM('tier_100mb', 'tier_500mb', 'tier_1gb');--> statement-breakpoint
CREATE TYPE "public"."tunnel_status" AS ENUM('provisioning', 'active', 'suspended', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."vpn_protocol" AS ENUM('wireguard', 'openvpn');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"google_sub" varchar(255),
	"role" "admin_role" DEFAULT 'support' NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_key" UNIQUE("email"),
	CONSTRAINT "admin_users_google_sub_key" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_sub" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"phone" varchar(20),
	"avatar_url" text,
	"tax_id" varchar(20),
	"company_name" varchar(255),
	"billing_address" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_login_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_google_sub_key" UNIQUE("google_sub"),
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"user_agent" text,
	"ip_address" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"balance_satang" bigint DEFAULT 0 NOT NULL,
	"lifetime_topup_satang" bigint DEFAULT 0 NOT NULL,
	"lifetime_spent_satang" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_wallets_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "positive_balance" CHECK (balance_satang >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" "credit_tx_type" NOT NULL,
	"amount_satang" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"description" text NOT NULL,
	"code_redemption_id" uuid,
	"invoice_id" uuid,
	"admin_user_id" uuid,
	"related_tx_id" uuid,
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_idempotency_key_key" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "credit_code_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"notes" text,
	"created_by_admin" uuid NOT NULL,
	"credit_value_satang" bigint NOT NULL,
	"max_uses_total" integer DEFAULT 1 NOT NULL,
	"max_uses_per_user" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"code_count" integer DEFAULT 0 NOT NULL,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"total_credit_redeemed_satang" bigint DEFAULT 0 NOT NULL,
	"status" "code_batch_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positive_value" CHECK (credit_value_satang > 0),
	CONSTRAINT "valid_uses" CHECK ((max_uses_total >= 0) AND (max_uses_per_user >= 0))
);
--> statement-breakpoint
CREATE TABLE "credit_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"code_normalized" varchar(32) NOT NULL,
	"credit_value_satang" bigint NOT NULL,
	"max_uses_total" integer NOT NULL,
	"max_uses_per_user" integer NOT NULL,
	"current_uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "code_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_codes_code_key" UNIQUE("code"),
	CONSTRAINT "credit_codes_code_normalized_key" UNIQUE("code_normalized"),
	CONSTRAINT "positive_code_value" CHECK (credit_value_satang > 0),
	CONSTRAINT "valid_uses_code" CHECK ((current_uses >= 0) AND ((max_uses_total = 0) OR (current_uses <= max_uses_total)))
);
--> statement-breakpoint
CREATE TABLE "credit_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"credit_added_satang" bigint NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vpn_gateways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"location" varchar(50) NOT NULL,
	"agent_endpoint" varchar(255) NOT NULL,
	"agent_ca_cert" text NOT NULL,
	"agent_token" text NOT NULL,
	"wg_endpoint" varchar(255) NOT NULL,
	"wg_port" integer DEFAULT 51820 NOT NULL,
	"wg_public_key" text NOT NULL,
	"ovpn_endpoint" varchar(255) NOT NULL,
	"ovpn_port" integer DEFAULT 1194 NOT NULL,
	"private_subnet" "cidr" NOT NULL,
	"max_tunnels" integer DEFAULT 500 NOT NULL,
	"current_tunnels" integer DEFAULT 0 NOT NULL,
	"status" "gateway_status" DEFAULT 'active' NOT NULL,
	"last_health_check" timestamp with time zone,
	"health_status" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vpn_gateways_hostname_key" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "ip_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block" "cidr" NOT NULL,
	"block_size" integer NOT NULL,
	"asn" varchar(20),
	"upstream_provider" varchar(100),
	"available_count" integer NOT NULL,
	"allocated_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"added_by_admin" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_pool_block_key" UNIQUE("block")
);
--> statement-breakpoint
CREATE TABLE "tunnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"gateway_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"protocol" "vpn_protocol" NOT NULL,
	"speed_tier" "speed_tier" NOT NULL,
	"private_ip" "inet" NOT NULL,
	"wg_public_key" text,
	"wg_private_key_encrypted" text,
	"wg_preshared_key" text,
	"ovpn_client_cert" text,
	"ovpn_client_key_encrypted" text,
	"config_blob" text,
	"status" "tunnel_status" DEFAULT 'provisioning' NOT NULL,
	"last_handshake_at" timestamp with time zone,
	"last_endpoint" "inet",
	"bytes_rx" bigint DEFAULT 0 NOT NULL,
	"bytes_tx" bigint DEFAULT 0 NOT NULL,
	"next_billing_at" timestamp with time zone NOT NULL,
	"last_billed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tunnels_gateway_id_private_ip_key" UNIQUE("gateway_id","private_ip"),
	CONSTRAINT "tunnels_gateway_id_wg_public_key_key" UNIQUE("gateway_id","wg_public_key")
);
--> statement-breakpoint
CREATE TABLE "ip_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"block" "cidr" NOT NULL,
	"block_size" integer NOT NULL,
	"price_satang" bigint NOT NULL,
	"status" "ip_block_status" DEFAULT 'active' NOT NULL,
	"next_billing_at" timestamp with time zone NOT NULL,
	"last_billed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valid_block_size" CHECK (block_size = ANY (ARRAY[8, 16, 32, 64, 128, 256]))
);
--> statement-breakpoint
CREATE TABLE "public_ips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_address" "inet" NOT NULL,
	"pool_id" uuid NOT NULL,
	"user_id" uuid,
	"tunnel_id" uuid,
	"block_id" uuid,
	"reverse_dns" varchar(255),
	"status" "ip_status" DEFAULT 'available' NOT NULL,
	"next_billing_at" timestamp with time zone,
	"last_billed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"reputation_status" varchar(20),
	"reputation_checked_at" timestamp with time zone,
	"allocated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_ips_ip_address_key" UNIQUE("ip_address")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"actor_email" varchar(255),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(50),
	"resource_id" uuid,
	"metadata" jsonb,
	"ip_address" "inet",
	"user_agent" text,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"metadata" jsonb,
	"severity" varchar(20) DEFAULT 'info',
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bandwidth_usage" (
	"tunnel_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"rx_bytes" bigint NOT NULL,
	"tx_bytes" bigint NOT NULL,
	CONSTRAINT "bandwidth_usage_pkey" PRIMARY KEY("tunnel_id","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_related_tx_id_fkey" FOREIGN KEY ("related_tx_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_batches" ADD CONSTRAINT "credit_code_batches_created_by_admin_fkey" FOREIGN KEY ("created_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_codes" ADD CONSTRAINT "credit_codes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."credit_code_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "public"."credit_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_pool" ADD CONSTRAINT "ip_pool_added_by_admin_fkey" FOREIGN KEY ("added_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "public"."vpn_gateways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_ips" ADD CONSTRAINT "public_ips_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "public"."ip_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_ips" ADD CONSTRAINT "public_ips_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_ips" ADD CONSTRAINT "public_ips_tunnel_id_fkey" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_ips" ADD CONSTRAINT "public_ips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bandwidth_usage" ADD CONSTRAINT "bandwidth_usage_tunnel_id_fkey" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email" text_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_users_google_sub" ON "users" USING btree ("google_sub" text_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_users_status" ON "users" USING btree ("status" enum_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "user_sessions" USING btree ("expires_at" timestamptz_ops) WHERE (revoked_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "user_sessions" USING btree ("user_id" uuid_ops) WHERE (revoked_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_credit_tx_type" ON "credit_transactions" USING btree ("type" timestamptz_ops,"created_at" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_credit_tx_user_time" ON "credit_transactions" USING btree ("user_id" uuid_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_codes_batch" ON "credit_codes" USING btree ("batch_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_codes_expiry" ON "credit_codes" USING btree ("expires_at" timestamptz_ops) WHERE ((status = 'active'::code_status) AND (expires_at IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_codes_normalized_active" ON "credit_codes" USING btree ("code_normalized" text_ops) WHERE (status = 'active'::code_status);--> statement-breakpoint
CREATE INDEX "idx_redemptions_code" ON "credit_code_redemptions" USING btree ("code_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_redemptions_user" ON "credit_code_redemptions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_redemptions_user_code" ON "credit_code_redemptions" USING btree ("user_id" uuid_ops,"code_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnels_billing_due" ON "tunnels" USING btree ("next_billing_at" timestamptz_ops) WHERE (status = ANY (ARRAY['active'::tunnel_status, 'suspended'::tunnel_status]));--> statement-breakpoint
CREATE INDEX "idx_tunnels_delete_due" ON "tunnels" USING btree ("delete_after" timestamptz_ops) WHERE (status = 'suspended'::tunnel_status);--> statement-breakpoint
CREATE INDEX "idx_tunnels_gateway" ON "tunnels" USING btree ("gateway_id" uuid_ops) WHERE (status = 'active'::tunnel_status);--> statement-breakpoint
CREATE INDEX "idx_tunnels_user" ON "tunnels" USING btree ("user_id" uuid_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_blocks_billing_due" ON "ip_blocks" USING btree ("next_billing_at" timestamptz_ops) WHERE (status = ANY (ARRAY['active'::ip_block_status, 'suspended'::ip_block_status]));--> statement-breakpoint
CREATE INDEX "idx_blocks_user" ON "ip_blocks" USING btree ("user_id" uuid_ops) WHERE (status = 'active'::ip_block_status);--> statement-breakpoint
CREATE INDEX "idx_ips_billing_due" ON "public_ips" USING btree ("next_billing_at" timestamptz_ops) WHERE ((status = ANY (ARRAY['allocated'::ip_status, 'suspended'::ip_status])) AND (block_id IS NULL));--> statement-breakpoint
CREATE INDEX "idx_ips_block" ON "public_ips" USING btree ("block_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ips_status" ON "public_ips" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_ips_tunnel" ON "public_ips" USING btree ("tunnel_id" uuid_ops) WHERE (status = 'allocated'::ip_status);--> statement-breakpoint
CREATE INDEX "idx_ips_user" ON "public_ips" USING btree ("user_id" uuid_ops) WHERE (status = 'allocated'::ip_status);--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "audit_logs" USING btree ("action" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_logs" USING btree ("actor_type" timestamptz_ops,"actor_id" uuid_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_resource" ON "audit_logs" USING btree ("resource_type" text_ops,"resource_id" uuid_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_time" ON "audit_logs" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_notif_user_unread" ON "notifications" USING btree ("user_id" timestamptz_ops,"created_at" timestamptz_ops) WHERE (read_at IS NULL);
*/