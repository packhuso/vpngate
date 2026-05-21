import { Module } from "@nestjs/common";
import { TunnelsController } from "./tunnels.controller";
import { TunnelsService } from "./tunnels.service";

@Module({
  controllers: [TunnelsController],
  providers: [TunnelsService],
})
export class TunnelsModule {}
