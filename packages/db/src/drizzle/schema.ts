import { pgTable, unique, uuid, varchar, text, boolean, timestamp, index, inet, foreignKey, check, bigint, integer, cidr, jsonb, primaryKey, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const actor_type = pgEnum("actor_type", ['user', 'admin', 'system', 'agent'])
export const admin_role = pgEnum("admin_role", ['super_admin', 'admin', 'support', 'finance', 'readonly'])
export const code_batch_status = pgEnum("code_batch_status", ['active', 'paused', 'revoked'])
export const code_status = pgEnum("code_status", ['active', 'exhausted', 'expired', 'revoked'])
export const credit_tx_type = pgEnum("credit_tx_type", ['code_redemption', 'payment_topup', 'admin_adjustment', 'subscription_charge', 'ip_charge', 'refund', 'reversal'])
export const gateway_status = pgEnum("gateway_status", ['active', 'draining', 'maintenance', 'offline'])
export const ip_block_status = pgEnum("ip_block_status", ['active', 'suspended', 'released'])
export const ip_status = pgEnum("ip_status", ['available', 'allocated', 'suspended', 'reserved', 'blacklisted'])
export const speed_tier = pgEnum("speed_tier", ['tier_100mb', 'tier_500mb', 'tier_1gb'])
export const tunnel_status = pgEnum("tunnel_status", ['provisioning', 'active', 'suspended', 'failed', 'deleted'])
export const user_status = pgEnum("user_status", ['active', 'suspended', 'deleted'])
export const vpn_protocol = pgEnum("vpn_protocol", ['wireguard', 'openvpn'])


export const admin_users = pgTable("admin_users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	google_sub: varchar({ length: 255 }),
	role: admin_role().default('support').notNull(),
	totp_secret: text(),
	totp_enabled: boolean().default(false).notNull(),
	active: boolean().default(true).notNull(),
	last_login_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("admin_users_email_key").on(table.email),
	unique("admin_users_google_sub_key").on(table.google_sub),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	google_sub: varchar({ length: 255 }).notNull(),
	email: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }),
	phone: varchar({ length: 20 }),
	avatar_url: text(),
	tax_id: varchar({ length: 20 }),
	company_name: varchar({ length: 255 }),
	billing_address: text(),
	status: user_status().default('active').notNull(),
	email_verified: boolean().default(false).notNull(),
	last_login_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_login_ip: inet(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_users_email").using("btree", table.email.asc().nullsLast().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	index("idx_users_google_sub").using("btree", table.google_sub.asc().nullsLast().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	index("idx_users_status").using("btree", table.status.asc().nullsLast().op("enum_ops")).where(sql`(deleted_at IS NULL)`),
	unique("users_google_sub_key").on(table.google_sub),
	unique("users_email_key").on(table.email),
]);

export const user_sessions = pgTable("user_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	token_hash: varchar({ length: 64 }).notNull(),
	user_agent: text(),
	ip_address: inet(),
	expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revoked_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_sessions_expires").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(revoked_at IS NULL)`),
	index("idx_sessions_user").using("btree", table.user_id.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "user_sessions_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_sessions_token_hash_key").on(table.token_hash),
]);

export const credit_wallets = pgTable("credit_wallets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	balance_satang: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lifetime_topup_satang: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lifetime_spent_satang: bigint({ mode: "number" }).default(0).notNull(),
	version: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "credit_wallets_user_id_fkey"
		}).onDelete("cascade"),
	unique("credit_wallets_user_id_key").on(table.user_id),
	check("positive_balance", sql`balance_satang >= 0`),
]);

export const credit_transactions = pgTable("credit_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	wallet_id: uuid().notNull(),
	type: credit_tx_type().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount_satang: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	balance_after: bigint({ mode: "number" }).notNull(),
	description: text().notNull(),
	code_redemption_id: uuid(),
	invoice_id: uuid(),
	admin_user_id: uuid(),
	related_tx_id: uuid(),
	idempotency_key: varchar({ length: 255 }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_credit_tx_type").using("btree", table.type.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("enum_ops")),
	index("idx_credit_tx_user_time").using("btree", table.user_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "credit_transactions_admin_user_id_fkey"
		}),
	foreignKey({
			columns: [table.related_tx_id],
			foreignColumns: [table.id],
			name: "credit_transactions_related_tx_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "credit_transactions_user_id_fkey"
		}),
	foreignKey({
			columns: [table.wallet_id],
			foreignColumns: [credit_wallets.id],
			name: "credit_transactions_wallet_id_fkey"
		}),
	unique("credit_transactions_idempotency_key_key").on(table.idempotency_key),
]);

export const credit_code_batches = pgTable("credit_code_batches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	notes: text(),
	created_by_admin: uuid().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	credit_value_satang: bigint({ mode: "number" }).notNull(),
	max_uses_total: integer().default(1).notNull(),
	max_uses_per_user: integer().default(1).notNull(),
	expires_at: timestamp({ withTimezone: true, mode: 'string' }),
	code_count: integer().default(0).notNull(),
	redeemed_count: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_credit_redeemed_satang: bigint({ mode: "number" }).default(0).notNull(),
	status: code_batch_status().default('active').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.created_by_admin],
			foreignColumns: [admin_users.id],
			name: "credit_code_batches_created_by_admin_fkey"
		}),
	check("positive_value", sql`credit_value_satang > 0`),
	check("valid_uses", sql`(max_uses_total >= 0) AND (max_uses_per_user >= 0)`),
]);

export const credit_codes = pgTable("credit_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	batch_id: uuid().notNull(),
	code: varchar({ length: 32 }).notNull(),
	code_normalized: varchar({ length: 32 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	credit_value_satang: bigint({ mode: "number" }).notNull(),
	max_uses_total: integer().notNull(),
	max_uses_per_user: integer().notNull(),
	current_uses: integer().default(0).notNull(),
	expires_at: timestamp({ withTimezone: true, mode: 'string' }),
	status: code_status().default('active').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_codes_batch").using("btree", table.batch_id.asc().nullsLast().op("uuid_ops")),
	index("idx_codes_expiry").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = 'active'::code_status) AND (expires_at IS NOT NULL))`),
	index("idx_codes_normalized_active").using("btree", table.code_normalized.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::code_status)`),
	foreignKey({
			columns: [table.batch_id],
			foreignColumns: [credit_code_batches.id],
			name: "credit_codes_batch_id_fkey"
		}),
	unique("credit_codes_code_key").on(table.code),
	unique("credit_codes_code_normalized_key").on(table.code_normalized),
	check("positive_code_value", sql`credit_value_satang > 0`),
	check("valid_uses_code", sql`(current_uses >= 0) AND ((max_uses_total = 0) OR (current_uses <= max_uses_total))`),
]);

export const credit_code_redemptions = pgTable("credit_code_redemptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code_id: uuid().notNull(),
	user_id: uuid().notNull(),
	transaction_id: uuid().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	credit_added_satang: bigint({ mode: "number" }).notNull(),
	ip_address: inet(),
	user_agent: text(),
	redeemed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_redemptions_code").using("btree", table.code_id.asc().nullsLast().op("uuid_ops")),
	index("idx_redemptions_user").using("btree", table.user_id.asc().nullsLast().op("uuid_ops")),
	index("idx_redemptions_user_code").using("btree", table.user_id.asc().nullsLast().op("uuid_ops"), table.code_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.code_id],
			foreignColumns: [credit_codes.id],
			name: "credit_code_redemptions_code_id_fkey"
		}),
	foreignKey({
			columns: [table.transaction_id],
			foreignColumns: [credit_transactions.id],
			name: "credit_code_redemptions_transaction_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "credit_code_redemptions_user_id_fkey"
		}),
]);

export const vpn_gateways = pgTable("vpn_gateways", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	hostname: varchar({ length: 255 }).notNull(),
	location: varchar({ length: 50 }).notNull(),
	agent_endpoint: varchar({ length: 255 }).notNull(),
	agent_ca_cert: text().notNull(),
	agent_token: text().notNull(),
	wg_endpoint: varchar({ length: 255 }).notNull(),
	wg_port: integer().default(51820).notNull(),
	wg_public_key: text().notNull(),
	ovpn_endpoint: varchar({ length: 255 }).notNull(),
	ovpn_port: integer().default(1194).notNull(),
	private_subnet: cidr().notNull(),
	max_tunnels: integer().default(500).notNull(),
	current_tunnels: integer().default(0).notNull(),
	status: gateway_status().default('active').notNull(),
	last_health_check: timestamp({ withTimezone: true, mode: 'string' }),
	health_status: varchar({ length: 20 }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("vpn_gateways_hostname_key").on(table.hostname),
]);

export const ip_pool = pgTable("ip_pool", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	block: cidr().notNull(),
	block_size: integer().notNull(),
	asn: varchar({ length: 20 }),
	upstream_provider: varchar({ length: 100 }),
	available_count: integer().notNull(),
	allocated_count: integer().default(0).notNull(),
	notes: text(),
	added_by_admin: uuid(),
	added_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.added_by_admin],
			foreignColumns: [admin_users.id],
			name: "ip_pool_added_by_admin_fkey"
		}),
	unique("ip_pool_block_key").on(table.block),
]);

export const tunnels = pgTable("tunnels", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	gateway_id: uuid().notNull(),
	name: varchar({ length: 100 }).notNull(),
	protocol: vpn_protocol().notNull(),
	speed_tier: speed_tier().notNull(),
	private_ip: inet().notNull(),
	wg_public_key: text(),
	wg_private_key_encrypted: text(),
	wg_preshared_key: text(),
	ovpn_client_cert: text(),
	ovpn_client_key_encrypted: text(),
	config_blob: text(),
	status: tunnel_status().default('provisioning').notNull(),
	last_handshake_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_endpoint: inet(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes_rx: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes_tx: bigint({ mode: "number" }).default(0).notNull(),
	next_billing_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	last_billed_at: timestamp({ withTimezone: true, mode: 'string' }),
	suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
	delete_after: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_tunnels_billing_due").using("btree", table.next_billing_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['active'::tunnel_status, 'suspended'::tunnel_status]))`),
	index("idx_tunnels_delete_due").using("btree", table.delete_after.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'suspended'::tunnel_status)`),
	index("idx_tunnels_gateway").using("btree", table.gateway_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::tunnel_status)`),
	index("idx_tunnels_user").using("btree", table.user_id.asc().nullsLast().op("uuid_ops")).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.gateway_id],
			foreignColumns: [vpn_gateways.id],
			name: "tunnels_gateway_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "tunnels_user_id_fkey"
		}),
	unique("tunnels_gateway_id_private_ip_key").on(table.gateway_id, table.private_ip),
	unique("tunnels_gateway_id_wg_public_key_key").on(table.gateway_id, table.wg_public_key),
]);

export const ip_blocks = pgTable("ip_blocks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	pool_id: uuid().notNull(),
	block: cidr().notNull(),
	block_size: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	price_satang: bigint({ mode: "number" }).notNull(),
	status: ip_block_status().default('active').notNull(),
	next_billing_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	last_billed_at: timestamp({ withTimezone: true, mode: 'string' }),
	suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
	delete_after: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_blocks_billing_due").using("btree", table.next_billing_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['active'::ip_block_status, 'suspended'::ip_block_status]))`),
	index("idx_blocks_user").using("btree", table.user_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::ip_block_status)`),
	foreignKey({
			columns: [table.pool_id],
			foreignColumns: [ip_pool.id],
			name: "ip_blocks_pool_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "ip_blocks_user_id_fkey"
		}),
	check("valid_block_size", sql`block_size = ANY (ARRAY[8, 16, 32, 64, 128, 256])`),
]);

export const public_ips = pgTable("public_ips", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ip_address: inet().notNull(),
	pool_id: uuid().notNull(),
	user_id: uuid(),
	tunnel_id: uuid(),
	block_id: uuid(),
	reverse_dns: varchar({ length: 255 }),
	status: ip_status().default('available').notNull(),
	next_billing_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_billed_at: timestamp({ withTimezone: true, mode: 'string' }),
	suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
	delete_after: timestamp({ withTimezone: true, mode: 'string' }),
	reputation_status: varchar({ length: 20 }),
	reputation_checked_at: timestamp({ withTimezone: true, mode: 'string' }),
	allocated_at: timestamp({ withTimezone: true, mode: 'string' }),
	released_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_ips_billing_due").using("btree", table.next_billing_at.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = ANY (ARRAY['allocated'::ip_status, 'suspended'::ip_status])) AND (block_id IS NULL))`),
	index("idx_ips_block").using("btree", table.block_id.asc().nullsLast().op("uuid_ops")),
	index("idx_ips_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("idx_ips_tunnel").using("btree", table.tunnel_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'allocated'::ip_status)`),
	index("idx_ips_user").using("btree", table.user_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'allocated'::ip_status)`),
	foreignKey({
			columns: [table.block_id],
			foreignColumns: [ip_blocks.id],
			name: "public_ips_block_id_fkey"
		}),
	foreignKey({
			columns: [table.pool_id],
			foreignColumns: [ip_pool.id],
			name: "public_ips_pool_id_fkey"
		}),
	foreignKey({
			columns: [table.tunnel_id],
			foreignColumns: [tunnels.id],
			name: "public_ips_tunnel_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "public_ips_user_id_fkey"
		}),
	unique("public_ips_ip_address_key").on(table.ip_address),
]);

export const audit_logs = pgTable("audit_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	actor_type: actor_type().notNull(),
	actor_id: uuid(),
	actor_email: varchar({ length: 255 }),
	action: varchar({ length: 100 }).notNull(),
	resource_type: varchar({ length: 50 }),
	resource_id: uuid(),
	metadata: jsonb(),
	ip_address: inet(),
	user_agent: text(),
	success: boolean().default(true).notNull(),
	error_message: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_audit_action").using("btree", table.action.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	index("idx_audit_actor").using("btree", table.actor_type.asc().nullsLast().op("timestamptz_ops"), table.actor_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_audit_resource").using("btree", table.resource_type.asc().nullsLast().op("text_ops"), table.resource_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	index("idx_audit_time").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: uuid().notNull(),
	type: varchar({ length: 50 }).notNull(),
	title: varchar({ length: 255 }).notNull(),
	body: text(),
	metadata: jsonb(),
	severity: varchar({ length: 20 }).default('info'),
	read_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_notif_user_unread").using("btree", table.user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "notifications_user_id_fkey"
		}),
]);

export const bandwidth_usage = pgTable("bandwidth_usage", {
	tunnel_id: uuid().notNull(),
	bucket_start: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rx_bytes: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tx_bytes: bigint({ mode: "number" }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tunnel_id],
			foreignColumns: [tunnels.id],
			name: "bandwidth_usage_tunnel_id_fkey"
		}),
	primaryKey({ columns: [table.tunnel_id, table.bucket_start], name: "bandwidth_usage_pkey"}),
]);
