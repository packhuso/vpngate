import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix("v1"); // URL versioning (design Section 8.3)
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  new Logger("Bootstrap").log(`VPN Hub API listening on :${port} (prefix /v1)`);
}
void bootstrap();
