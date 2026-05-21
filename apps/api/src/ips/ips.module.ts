import { Module } from "@nestjs/common";
import { IpsController } from "./ips.controller";

@Module({ controllers: [IpsController] })
export class IpsModule {}
