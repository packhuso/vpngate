// Credit code system (design §7.2). Race-safe atomic UPDATE on credit_codes
// is the heart of correctness — two concurrent redeems of the same code
// serialize on the row, so only one succeeds at the counter step.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { sql } from "@vpnhub/db";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O 1/I to reduce typos

function generateCodeString(len = 16): string {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  // group in 4s for human readability — stored normalized in DB
  return s.match(/.{4}/g)!.join("-");
}

function normalize(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export interface CreateBatchInput {
  name: string;
  valueSatang: number;
  count: number;
  maxUsesPerUser?: number;
  maxUsesTotal?: number;
  expiresAt?: Date | null;
  notes?: string;
}

@Injectable()
export class CodesService {
  /** Admin generates a batch of N codes, all with the same value. */
  async createBatch(adminId: string, input: CreateBatchInput) {
    if (input.valueSatang <= 0) {
      throw new BadRequestException("valueSatang must be > 0");
    }
    if (input.count <= 0 || input.count > 10_000) {
      throw new BadRequestException("count must be 1..10000");
    }
    return sql.begin(async (tx) => {
      const [batch] = await tx<{ id: string }[]>`
        INSERT INTO credit_code_batches (name, notes, created_by_admin,
          credit_value_satang, max_uses_total, max_uses_per_user,
          expires_at, code_count)
        VALUES (${input.name}, ${input.notes ?? null}, ${adminId},
          ${input.valueSatang}, ${input.maxUsesTotal ?? 1},
          ${input.maxUsesPerUser ?? 1},
          ${input.expiresAt ? input.expiresAt.toISOString() : null},
          ${input.count})
        RETURNING id`;

      const codes: string[] = [];
      const seen = new Set<string>();
      while (codes.length < input.count) {
        const c = generateCodeString();
        const n = normalize(c);
        if (seen.has(n)) continue;
        seen.add(n);
        codes.push(c);
      }

      // Bulk insert (postgres.js handles arrays well via unnest)
      const rows = codes.map((c) => ({
        batch_id: batch.id,
        code: c,
        code_normalized: normalize(c),
        credit_value_satang: input.valueSatang,
        max_uses_total: input.maxUsesTotal ?? 1,
        max_uses_per_user: input.maxUsesPerUser ?? 1,
        expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      }));
      await tx`INSERT INTO credit_codes ${tx(rows)}`;

      await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
                 resource_type, resource_id, success, metadata)
               VALUES ('admin', ${adminId}, 'codes.batch_created',
                 'code_batch', ${batch.id}, true,
                 ${JSON.stringify({
                   name: input.name,
                   count: input.count,
                   valueSatang: input.valueSatang,
                 })}::jsonb)`;

      return { batchId: batch.id, codes };
    });
  }

  async listBatches() {
    return sql<
      {
        id: string;
        name: string;
        code_count: number;
        redeemed_count: number;
        credit_value_satang: string;
        total_credit_redeemed_satang: string;
        status: string;
        expires_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, name, code_count, redeemed_count, credit_value_satang,
             total_credit_redeemed_satang, status, expires_at, created_at
      FROM credit_code_batches ORDER BY created_at DESC LIMIT 100`;
  }

  async listCodesInBatch(batchId: string) {
    const codes = await sql<
      {
        id: string;
        code: string;
        current_uses: number;
        max_uses_total: number;
        max_uses_per_user: number;
        status: string;
        created_at: Date;
        expires_at: Date | null;
      }[]
    >`
      SELECT id, code, current_uses, max_uses_total, max_uses_per_user,
             status, created_at, expires_at
      FROM credit_codes WHERE batch_id = ${batchId}
      ORDER BY created_at LIMIT 500`;

    // load all redemptions for the batch in one query
    const reds = await sql<
      {
        code_id: string;
        user_email: string | null;
        amount: string;
        redeemed_at: Date;
      }[]
    >`
      SELECT r.code_id, u.email AS user_email,
             r.credit_added_satang::text AS amount, r.redeemed_at
      FROM credit_code_redemptions r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.code_id IN (
        SELECT id FROM credit_codes WHERE batch_id = ${batchId}
      )
      ORDER BY r.redeemed_at DESC`;

    type RedRow = {
      code_id: string;
      user_email: string | null;
      amount: string;
      redeemed_at: Date;
    };
    const byCode = new Map<string, RedRow[]>();
    for (const r of reds) {
      const list = byCode.get(r.code_id) ?? [];
      list.push(r);
      byCode.set(r.code_id, list);
    }

    return codes.map((c) => ({
      id: c.id,
      code: c.code,
      currentUses: c.current_uses,
      maxUsesTotal: c.max_uses_total,
      maxUsesPerUser: c.max_uses_per_user,
      status: c.status,
      createdAt: c.created_at,
      expiresAt: c.expires_at,
      redemptions: (byCode.get(c.id) ?? []).map((r) => ({
        userEmail: r.user_email,
        amountSatang: Number(r.amount),
        redeemedAt: r.redeemed_at,
      })),
    }));
  }

  /** Admin: change a code's status (active | paused | revoked). */
  async setCodeStatus(codeId: string, status: "active" | "paused" | "revoked") {
    const rows = await sql<{ id: string }[]>`
      UPDATE credit_codes SET status = ${status}, updated_at = NOW()
      WHERE id = ${codeId} RETURNING id`;
    if (rows.length === 0) {
      throw new BadRequestException("code not found");
    }
    await sql`INSERT INTO audit_logs (actor_type, action, resource_type,
      resource_id, success, metadata)
      VALUES ('admin', 'code.status', 'credit_code', ${codeId}, true,
        ${JSON.stringify({ status })}::jsonb)`;
    return { id: codeId, status };
  }

  /** Admin: set/clear a code's expiry. */
  async setCodeExpiry(codeId: string, expiresAt: string | null) {
    const rows = await sql<{ id: string }[]>`
      UPDATE credit_codes
      SET expires_at = ${expiresAt ? new Date(expiresAt).toISOString() : null},
          updated_at = NOW()
      WHERE id = ${codeId} RETURNING id`;
    if (rows.length === 0) throw new BadRequestException("code not found");
    await sql`INSERT INTO audit_logs (actor_type, action, resource_type,
      resource_id, success, metadata)
      VALUES ('admin', 'code.expiry', 'credit_code', ${codeId}, true,
        ${JSON.stringify({ expiresAt })}::jsonb)`;
    return { id: codeId, expiresAt };
  }

  /** Admin: cascade status to ALL codes in a batch. */
  async setBatchCodesStatus(batchId: string, status: "active" | "paused" | "revoked") {
    const rows = await sql<{ id: string }[]>`
      UPDATE credit_codes SET status = ${status}, updated_at = NOW()
      WHERE batch_id = ${batchId} RETURNING id`;
    await sql`INSERT INTO audit_logs (actor_type, action, resource_type,
      resource_id, success, metadata)
      VALUES ('admin', 'codebatch.status', 'credit_code_batch', ${batchId}, true,
        ${JSON.stringify({ status, affected: rows.length })}::jsonb)`;
    return { batchId, status, affected: rows.length };
  }

  /** Admin: cascade expiry to ALL codes in a batch. */
  async setBatchCodesExpiry(batchId: string, expiresAt: string | null) {
    const iso = expiresAt ? new Date(expiresAt).toISOString() : null;
    const rows = await sql<{ id: string }[]>`
      UPDATE credit_codes SET expires_at = ${iso}, updated_at = NOW()
      WHERE batch_id = ${batchId} RETURNING id`;
    await sql`INSERT INTO audit_logs (actor_type, action, resource_type,
      resource_id, success, metadata)
      VALUES ('admin', 'codebatch.expiry', 'credit_code_batch', ${batchId}, true,
        ${JSON.stringify({ expiresAt: iso, affected: rows.length })}::jsonb)`;
    return { batchId, expiresAt: iso, affected: rows.length };
  }

  /** Customer redeems a code (design §7.2 atomic counter). */
  async redeem(userId: string, raw: string, ip?: string, userAgent?: string) {
    if (!userId) throw new UnauthorizedException();
    const norm = normalize(raw ?? "");
    if (norm.length < 4) {
      throw new BadRequestException({
        code: "INVALID_CODE",
        message: "code is invalid",
      });
    }
    return sql.begin(async (tx) => {
      // ATOMIC counter — only one of N concurrent attempts wins.
      const updated = await tx<
        {
          id: string;
          batch_id: string;
          credit_value_satang: string;
          max_uses_total: number;
          max_uses_per_user: number;
        }[]
      >`
        UPDATE credit_codes
        SET current_uses = current_uses + 1
        WHERE code_normalized = ${norm}
          AND status = 'active'
          AND (max_uses_total = 0 OR current_uses < max_uses_total)
          AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id, batch_id, credit_value_satang,
                  max_uses_total, max_uses_per_user`;
      if (updated.length === 0) {
        // Generic to prevent enumeration (design §6.3)
        throw new BadRequestException({
          code: "INVALID_CODE",
          message: "code is invalid, exhausted, or expired",
        });
      }
      const code = updated[0];

      // Per-user limit (NOT generic — design says user already knows code exists)
      const [{ count: usedByUser }] = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM credit_code_redemptions
        WHERE code_id = ${code.id} AND user_id = ${userId}`;
      if (Number(usedByUser) >= code.max_uses_per_user) {
        // rollback counter — design says do this with a compensating UPDATE
        await tx`UPDATE credit_codes SET current_uses = current_uses - 1
                 WHERE id = ${code.id}`;
        throw new ForbiddenException({
          code: "PER_USER_LIMIT",
          message: "you've already redeemed this code the maximum times",
        });
      }

      // Lock wallet + add credit
      const value = Number(code.credit_value_satang);
      const [w] = await tx<{ id: string; balance_satang: string }[]>`
        SELECT id, balance_satang FROM credit_wallets
        WHERE user_id = ${userId} FOR UPDATE`;
      if (!w) throw new BadRequestException("wallet not found");
      const newBalance = Number(w.balance_satang) + value;
      await tx`UPDATE credit_wallets
               SET balance_satang = ${newBalance},
                   lifetime_topup_satang = lifetime_topup_satang + ${value},
                   version = version + 1
               WHERE id = ${w.id}`;

      const [txRow] = await tx<{ id: string }[]>`
        INSERT INTO credit_transactions (user_id, wallet_id, type,
          amount_satang, balance_after, description, code_redemption_id,
          idempotency_key)
        VALUES (${userId}, ${w.id}, 'code_redemption', ${value},
          ${newBalance}, ${"Code redemption (" + norm + ")"},
          NULL, ${"redeem-" + code.id + "-" + userId})
        RETURNING id`;

      const [red] = await tx<{ id: string }[]>`
        INSERT INTO credit_code_redemptions (code_id, user_id, transaction_id,
          credit_added_satang, ip_address, user_agent)
        VALUES (${code.id}, ${userId}, ${txRow.id}, ${value},
          ${ip ?? null}::inet, ${userAgent ?? null})
        RETURNING id`;
      await tx`UPDATE credit_transactions
               SET code_redemption_id = ${red.id} WHERE id = ${txRow.id}`;

      await tx`UPDATE credit_code_batches
               SET redeemed_count = redeemed_count + 1,
                   total_credit_redeemed_satang =
                     total_credit_redeemed_satang + ${value}
               WHERE id = ${code.batch_id}`;

      if (
        code.max_uses_total > 0 &&
        Number(usedByUser) + 1 >= code.max_uses_total
      ) {
        await tx`UPDATE credit_codes SET status = 'exhausted'
                 WHERE id = ${code.id} AND current_uses >= max_uses_total`;
      }

      await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
                 resource_type, resource_id, success, ip_address, user_agent)
               VALUES ('user', ${userId}, 'code.redeem',
                 'credit_code', ${code.id}, true,
                 ${ip ?? null}::inet, ${userAgent ?? null})`;

      await tx`
        INSERT INTO notifications (user_id, type, title, body, severity, metadata)
        VALUES (${userId}, 'wallet.topup', ${"เติมเงินสำเร็จ +฿" + (value / 100).toFixed(2)},
          ${"Redeem code สำเร็จ — ยอดเงินคงเหลือ ฿" + (newBalance / 100).toFixed(2)},
          'info', ${JSON.stringify({ addedSatang: value, balanceAfter: newBalance })}::jsonb)`;

      return { creditAddedSatang: value, newBalanceSatang: newBalance };
    });
  }
}
