import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { resolveSession, tokenFromCookieHeader } from "@vpnhub/auth";

// Validates the shared `session` cookie against Redis/user_sessions
// (design §6.2). Attaches req.user = { userId, email, isAdmin }.
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = tokenFromCookieHeader(req.headers?.cookie);
    const sess = await resolveSession(token);
    if (!sess) throw new UnauthorizedException("authentication required");
    req.user = sess;
    return true;
  }
}
