// One-shot self test: boot the app on an ephemeral port, hit /v1/health,
// print the JSON, shut down. Deterministic — no lingering server.
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("v1");
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  const res = await fetch(`${url}/v1/health`);
  const body = await res.json();
  console.log("HTTP", res.status);
  console.log(JSON.stringify(body, null, 2));
  await app.close();
  const ok =
    res.status === 200 &&
    body?.checks?.postgres?.status === "ok" &&
    body?.checks?.redis?.status === "ok";
  console.log(ok ? "API SELFTEST: PASS" : "API SELFTEST: FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error("API SELFTEST: ERROR", e);
  process.exit(1);
});
