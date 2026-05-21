import { relations } from "drizzle-orm/relations";
import { users, user_sessions, credit_wallets, admin_users, credit_transactions, credit_code_batches, credit_codes, credit_code_redemptions, ip_pool, vpn_gateways, tunnels, ip_blocks, public_ips, notifications, bandwidth_usage } from "./schema";

export const user_sessionsRelations = relations(user_sessions, ({one}) => ({
	user: one(users, {
		fields: [user_sessions.user_id],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	user_sessions: many(user_sessions),
	credit_wallets: many(credit_wallets),
	credit_transactions: many(credit_transactions),
	credit_code_redemptions: many(credit_code_redemptions),
	tunnels: many(tunnels),
	ip_blocks: many(ip_blocks),
	public_ips: many(public_ips),
	notifications: many(notifications),
}));

export const credit_walletsRelations = relations(credit_wallets, ({one, many}) => ({
	user: one(users, {
		fields: [credit_wallets.user_id],
		references: [users.id]
	}),
	credit_transactions: many(credit_transactions),
}));

export const credit_transactionsRelations = relations(credit_transactions, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [credit_transactions.admin_user_id],
		references: [admin_users.id]
	}),
	credit_transaction: one(credit_transactions, {
		fields: [credit_transactions.related_tx_id],
		references: [credit_transactions.id],
		relationName: "credit_transactions_related_tx_id_credit_transactions_id"
	}),
	credit_transactions: many(credit_transactions, {
		relationName: "credit_transactions_related_tx_id_credit_transactions_id"
	}),
	user: one(users, {
		fields: [credit_transactions.user_id],
		references: [users.id]
	}),
	credit_wallet: one(credit_wallets, {
		fields: [credit_transactions.wallet_id],
		references: [credit_wallets.id]
	}),
	credit_code_redemptions: many(credit_code_redemptions),
}));

export const admin_usersRelations = relations(admin_users, ({many}) => ({
	credit_transactions: many(credit_transactions),
	credit_code_batches: many(credit_code_batches),
	ip_pools: many(ip_pool),
}));

export const credit_code_batchesRelations = relations(credit_code_batches, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [credit_code_batches.created_by_admin],
		references: [admin_users.id]
	}),
	credit_codes: many(credit_codes),
}));

export const credit_codesRelations = relations(credit_codes, ({one, many}) => ({
	credit_code_batch: one(credit_code_batches, {
		fields: [credit_codes.batch_id],
		references: [credit_code_batches.id]
	}),
	credit_code_redemptions: many(credit_code_redemptions),
}));

export const credit_code_redemptionsRelations = relations(credit_code_redemptions, ({one}) => ({
	credit_code: one(credit_codes, {
		fields: [credit_code_redemptions.code_id],
		references: [credit_codes.id]
	}),
	credit_transaction: one(credit_transactions, {
		fields: [credit_code_redemptions.transaction_id],
		references: [credit_transactions.id]
	}),
	user: one(users, {
		fields: [credit_code_redemptions.user_id],
		references: [users.id]
	}),
}));

export const ip_poolRelations = relations(ip_pool, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [ip_pool.added_by_admin],
		references: [admin_users.id]
	}),
	ip_blocks: many(ip_blocks),
	public_ips: many(public_ips),
}));

export const tunnelsRelations = relations(tunnels, ({one, many}) => ({
	vpn_gateway: one(vpn_gateways, {
		fields: [tunnels.gateway_id],
		references: [vpn_gateways.id]
	}),
	user: one(users, {
		fields: [tunnels.user_id],
		references: [users.id]
	}),
	public_ips: many(public_ips),
	bandwidth_usages: many(bandwidth_usage),
}));

export const vpn_gatewaysRelations = relations(vpn_gateways, ({many}) => ({
	tunnels: many(tunnels),
}));

export const ip_blocksRelations = relations(ip_blocks, ({one, many}) => ({
	ip_pool: one(ip_pool, {
		fields: [ip_blocks.pool_id],
		references: [ip_pool.id]
	}),
	user: one(users, {
		fields: [ip_blocks.user_id],
		references: [users.id]
	}),
	public_ips: many(public_ips),
}));

export const public_ipsRelations = relations(public_ips, ({one}) => ({
	ip_block: one(ip_blocks, {
		fields: [public_ips.block_id],
		references: [ip_blocks.id]
	}),
	ip_pool: one(ip_pool, {
		fields: [public_ips.pool_id],
		references: [ip_pool.id]
	}),
	tunnel: one(tunnels, {
		fields: [public_ips.tunnel_id],
		references: [tunnels.id]
	}),
	user: one(users, {
		fields: [public_ips.user_id],
		references: [users.id]
	}),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	user: one(users, {
		fields: [notifications.user_id],
		references: [users.id]
	}),
}));

export const bandwidth_usageRelations = relations(bandwidth_usage, ({one}) => ({
	tunnel: one(tunnels, {
		fields: [bandwidth_usage.tunnel_id],
		references: [tunnels.id]
	}),
}));