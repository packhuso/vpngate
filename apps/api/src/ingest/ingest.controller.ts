import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { recordConnectionEvents, type IngestEvent } from "@vpnhub/provisioning";
import { IngestTokenGuard } from "./ingest.guard";

interface IngestBody {
  events?: IngestEvent[];
}

@Controller("ingest")
@UseGuards(IngestTokenGuard)
export class IngestController {
  // POST /v1/ingest/connection-events — gateways push connect/disconnect/ip_change.
  @Post("connection-events")
  @HttpCode(202)
  async connectionEvents(@Body() body: IngestBody) {
    const events = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return { stored: 0, skipped: 0 };
    // cap a single batch to avoid abuse
    const r = await recordConnectionEvents(events.slice(0, 200));
    return r;
  }
}
