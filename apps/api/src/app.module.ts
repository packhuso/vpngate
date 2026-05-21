import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { TunnelsModule } from "./tunnels/tunnels.module";
import { WalletModule } from "./wallet/wallet.module";
import { IpsModule } from "./ips/ips.module";
import { CodesModule } from "./codes/codes.module";
import { AdminModule } from "./admin/admin.module";
import { BillingModule } from "./billing/billing.module";
import { NotificationsModule } from "./notifications/notifications.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Single source of truth: the repo-root .env (design Section 6.5)
      envFilePath: ["/opt/vpnhub-app/.env"],
    }),
    TunnelsModule,
    WalletModule,
    IpsModule,
    CodesModule,
    AdminModule,
    BillingModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
