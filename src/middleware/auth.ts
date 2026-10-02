import type { Request, Response, NextFunction } from "express";
import type { SessionUser, UserRole } from "../models/types";

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    lastActivityAt?: number;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  if (req.session.user.mustChangePassword && req.path !== "/change-password") {
    res.redirect("/change-password");
    return;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user;
    if (!user) {
      res.redirect("/login");
      return;
    }
    const hasRole = roles.some((r) => user.roles.includes(r));
    if (!hasRole) {
      res.status(403).render("errors/403", { title: "Forbidden" });
      return;
    }
    next();
  };
}

export function attachLocals(req: Request, res: Response, next: NextFunction): void {
  res.locals.currentUser = req.session.user ?? null;
  res.locals.lang = req.session.user?.language ?? (req.cookies?.lang as "en" | "ar") ?? "en";
  res.locals.currentPath = req.path;
  next();
}
