import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

/** Shared-token guard for gateway → control-plane ingest endpoints.
 *  Gateways send `Authorization: Bearer <EVENTS_INGEST_TOKEN>`. */
@Injectable()
export class IngestTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.EVENTS_INGEST_TOKEN;
    if (!expected) throw new UnauthorizedException("ingest disabled");
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers?.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== expected) throw new UnauthorizedException("bad ingest token");
    return true;
  }
}
