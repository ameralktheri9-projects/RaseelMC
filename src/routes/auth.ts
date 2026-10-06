import { Router } from "express";
import dayjs from "dayjs";
import { db, asRow } from "../db";
import { config } from "../config";
import { verifyPassword, hashPassword, isPasswordStrongEnough } from "../utils/password";
import { asyncHandler } from "../utils/asyncHandler";
import { t } from "../i18n";
import { requireAuth } from "../middleware/auth";
import type { User, Employee, UserRole, Language } from "../models/types";

export const authRouter = Router();

authRouter.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  const lang = (req.cookies?.lang as Language) ?? "en";
  res.render("login", { title: t(lang, "login.title"), lang, error: null, timeout: req.query.timeout === "1" });
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const lang = (req.cookies?.lang as Language) ?? "en";
    const { username, password } = req.body as { username?: string; password?: string };

    const renderError = (key: string, vars?: Record<string, string | number>) =>
      res.status(401).render("login", {
        title: t(lang, "login.title"),
        lang,
        error: t(lang, key, vars),
        timeout: false,
      });

    if (!username || !password) {
      renderError("login.error.invalid");
      return;
    }

    const user = asRow<User | undefined>(
      await db.prepare("SELECT * FROM users WHERE username = ?").get(username)
    );
    if (!user || !user.is_active) {
      renderError("login.error.invalid");
      return;
    }

    // AUTH-05: lockout check
    if (user.locked_until && dayjs(user.locked_until).isAfter(dayjs())) {
      const minutes = Math.ceil(dayjs(user.locked_until).diff(dayjs(), "second") / 60);
      renderError("login.error.locked", { minutes });
      return;
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const newCount = user.failed_login_count + 1;
      if (newCount >= config.lockoutThreshold) {
        await db.prepare("UPDATE users SET failed_login_count = 0, locked_until = ? WHERE id = ?").run(
          dayjs().add(config.lockoutDurationMs, "millisecond").toISOString(),
          user.id
        );
      } else {
        await db.prepare("UPDATE users SET failed_login_count = ? WHERE id = ?").run(newCount, user.id);
      }
      renderError("login.error.invalid");
      return;
    }

    // Successful login: reset counters, load roles + employee.
    await db.prepare(
      "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"
    ).run(dayjs().toISOString(), user.id);

    const roles = (
      (await db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(user.id)) as { role: UserRole }[]
    ).map((r) => r.role);

    const employee = user.employee_id
      ? asRow<Employee | undefined>(
          await db.prepare("SELECT * FROM employees WHERE id = ?").get(user.employee_id)
        )
      : undefined;

    req.session.user = {
      userId: user.id,
      employeeId: user.employee_id,
      username: user.username,
      nameEn: employee?.name_en ?? "System Admin",
      nameAr: employee?.name_ar ?? "مدير النظام",
      roles,
      language: user.language,
      mustChangePassword: user.must_change_password === 1,
    };
    req.session.lastActivityAt = Date.now();

    res.cookie("lang", user.language, { maxAge: 365 * 24 * 60 * 60 * 1000 });

    if (user.must_change_password) {
      res.redirect("/change-password");
      return;
    }
    res.redirect("/dashboard");
  })
);

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

authRouter.get("/change-password", requireAuth, (req, res) => {
  const lang = req.session.user!.language;
  res.render("change-password", { title: t(lang, "changePassword.title"), lang, error: null });
});

authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user!;
    const lang = sessionUser.language;
    const { currentPassword, newPassword, confirmPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };

    const renderError = (key: string) =>
      res.status(400).render("change-password", {
        title: t(lang, "changePassword.title"),
        lang,
        error: t(lang, key),
      });

    const user = asRow<User>(await db.prepare("SELECT * FROM users WHERE id = ?").get(sessionUser.userId));

    if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
      renderError("login.error.invalid");
      return;
    }
    if (newPassword !== confirmPassword) {
      renderError("changePassword.mismatch");
      return;
    }
    if (!newPassword || !isPasswordStrongEnough(newPassword)) {
      renderError("changePassword.weak");
      return;
    }

    const newHash = await hashPassword(newPassword);
    await db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?"
    ).run(newHash, dayjs().toISOString(), user.id);

    req.session.user!.mustChangePassword = false;
    res.redirect("/dashboard");
  })
);

authRouter.post(
  "/set-language",
  asyncHandler(async (req, res) => {
    const { lang } = req.body as { lang?: Language };
    const chosen: Language = lang === "ar" ? "ar" : "en";
    res.cookie("lang", chosen, { maxAge: 365 * 24 * 60 * 60 * 1000 });
    if (req.session.user) {
      req.session.user.language = chosen;
      await db.prepare("UPDATE users SET language = ? WHERE id = ?").run(chosen, req.session.user.userId);
    }
    const back = (req.headers.referer as string) || "/dashboard";
    res.redirect(back);
  })
);
