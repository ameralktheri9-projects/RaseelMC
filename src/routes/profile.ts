import { Router } from "express";
import { db, asRow } from "../db";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { t } from "../i18n";
import type { Employee } from "../models/types";

export const profileRouter = Router();

profileRouter.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const sessionUser = req.session.user!;

    if (sessionUser.employeeId == null) {
      res.render("profile", { title: t(lang, "nav.profile"), lang, employee: null, department: null, manager: null, saved: req.query.saved === "1" });
      return;
    }

    const employee = asRow<Employee>(
      await db.prepare("SELECT * FROM employees WHERE id = ?").get(sessionUser.employeeId)
    );
    const department = employee.department_id
      ? await db.prepare("SELECT name_en, name_ar FROM departments WHERE id = ?").get(employee.department_id)
      : null;
    const manager = employee.direct_manager_id
      ? await db.prepare("SELECT name_en, name_ar FROM employees WHERE id = ?").get(employee.direct_manager_id)
      : null;

    res.render("profile", {
      title: t(lang, "nav.profile"),
      lang,
      employee,
      department,
      manager,
      saved: req.query.saved === "1",
    });
  })
);

profileRouter.post(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user!;
    if (sessionUser.employeeId == null) {
      res.redirect("/profile");
      return;
    }
    const { personalEmail, phone, dateOfBirth } = req.body as Record<string, string>;
    await db.prepare("UPDATE employees SET personal_email = ?, phone = ?, date_of_birth = ? WHERE id = ?").run(
      personalEmail || null,
      phone || null,
      dateOfBirth || null,
      sessionUser.employeeId
    );
    res.redirect("/profile?saved=1");
  })
);
