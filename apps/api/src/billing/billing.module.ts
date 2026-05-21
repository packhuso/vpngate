import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";

@Module({ controllers: [BillingController] })
export class BillingModule {}
