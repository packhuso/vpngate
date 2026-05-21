import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { sql } from "@vpnhub/db";
import { SessionGuard } from "../auth/session.guard";

@Controller("wallet")
@UseGuards(SessionGuard)
export class WalletController {
  // GET /v1/wallet — balance + lifetime totals + recent transactions
  @Get()
  async get(@Req() req: { user: { userId: string } }) {
    const [w] = await sql<
      {
        balance_satang: string;
        lifetime_topup_satang: string;
        lifetime_spent_satang: string;
      }[]
    >`
      SELECT balance_satang, lifetime_topup_satang, lifetime_spent_satang
      FROM credit_wallets WHERE user_id = ${req.user.userId}`;
    const tx = await sql<
      {
        id: string;
        type: string;
        amount_satang: string;
        balance_after: string;
        description: string;
        created_at: Date;
      }[]
    >`
      SELECT id, type, amount_satang, balance_after, description, created_at
      FROM credit_transactions WHERE user_id = ${req.user.userId}
      ORDER BY created_at DESC LIMIT 20`;
    return {
      balanceSatang: Number(w?.balance_satang ?? 0),
      lifetimeTopupSatang: Number(w?.lifetime_topup_satang ?? 0),
      lifetimeSpentSatang: Number(w?.lifetime_spent_satang ?? 0),
      recentTransactions: tx.map((t) => ({
        id: t.id,
        type: t.type,
        amountSatang: Number(t.amount_satang),
        balanceAfter: Number(t.balance_after),
        description: t.description,
        createdAt: t.created_at,
      })),
    };
  }
}
