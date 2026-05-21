import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { SessionGuard } from "./session.guard";

/** Session AND isAdmin. Mounts on admin-only routes. */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly base = new SessionGuard();
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.base.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    if (!req.user?.isAdmin) throw new ForbiddenException("admin only");
    return true;
  }
}
