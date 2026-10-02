import cron from "node-cron";
import dayjs from "dayjs";
import { db, asRow } from "../db";
import { notify } from "../services/notificationService";
import { employeeIdToUserId } from "../services/workflowEngine";
import { computeCarryOver } from "../services/leaveCalculationService";
import type { Employee, LeaveBalance, CarryOverSetting, Workflow } from "../models/types";

/** CO-06: on each employee's joining anniversary, close the old leave year and carry over unused days. */
export function runLeaveYearClosing(): void {
  const today = dayjs().format("YYYY-MM-DD");
  const setting = asRow<CarryOverSetting | undefined>(
    db.prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1").get()
  );
  if (!setting) return;

  const expiredBalances = asRow<LeaveBalance[]>(
    db
      .prepare(
        `SELECT lb.* FROM leave_balances lb
         JOIN leave_types lt ON lt.id = lb.leave_type_id
         WHERE lt.name_en = 'Annual leave' AND lb.leave_year_end < ?`
      )
      .all(today)
  );

  for (const bal of expiredBalances) {
    const alreadyClosed = db
      .prepare(
        `SELECT COUNT(*) as n FROM leave_balances
         WHERE employee_id = ? AND leave_type_id = ? AND leave_year_start > ?`
      )
      .get(bal.employee_id, bal.leave_type_id, bal.leave_year_start) as { n: number };
    if (alreadyClosed.n > 0) continue; // next year's row already exists

    const unused = Math.max(0, bal.entitlement + bal.carried_over + bal.manual_adjustment - bal.taken);
    const { carried, lapsed } = computeCarryOver(unused, setting);

    const nextStart = dayjs(bal.leave_year_end).add(1, "day").format("YYYY-MM-DD");
    const nextEnd = dayjs(nextStart).add(1, "year").subtract(1, "day").format("YYYY-MM-DD");
    const expiresOn = setting.expiry_months
      ? dayjs(nextStart).add(setting.expiry_months, "month").format("YYYY-MM-DD")
      : null;

    db.prepare(
      `INSERT INTO leave_balances
        (employee_id, leave_type_id, leave_year_start, leave_year_end, entitlement, carried_over, carry_over_expires_on, taken, manual_adjustment)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(bal.employee_id, bal.leave_type_id, nextStart, nextEnd, bal.entitlement, carried, expiresOn);

    const userId = employeeIdToUserId(bal.employee_id);
    if (userId != null) {
      notify(
        userId,
        "leave_year_closed",
        `Your leave year closed: ${carried} days carried over, ${lapsed} days lapsed.`,
        `أُغلقت سنة إجازتك: تم ترحيل ${carried} يوم، وسقط ${lapsed} يوم.`,
        "/dashboard"
      );
    }
  }
}

/** WF-06: remind the current approver (and escalate) when a step's SLA is exceeded. */
export function runSlaEscalationCheck(): void {
  for (const type of ["leave", "loan"] as const) {
    const table = type === "leave" ? "leave_requests" : "loan_requests";
    const pending = db
      .prepare(`SELECT * FROM ${table} WHERE status = 'pending'`)
      .all() as any[];

    for (const req of pending) {
      if (req.workflow_id == null) continue;
      const step = db
        .prepare(
          "SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order = ?"
        )
        .get(req.workflow_id, req.current_step_order) as any;
      if (!step) continue;

      const lastAction = db
        .prepare(
          `SELECT created_at FROM approval_actions
           WHERE request_type = ? AND request_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(type, req.id) as { created_at: string } | undefined;
      if (!lastAction) continue;

      const waitingDays = dayjs().diff(dayjs(lastAction.created_at), "day");
      if (waitingDays < step.sla_days) continue;

      const workflow = asRow<Workflow>(
        db.prepare("SELECT * FROM workflows WHERE id = ?").get(req.workflow_id)
      );
      const employee = asRow<Employee>(
        db.prepare("SELECT * FROM employees WHERE id = ?").get(req.employee_id)
      );
      const approverUserId = resolveCurrentApprover(employee, step);
      const link = "/approvals";

      if (approverUserId != null) {
        notify(
          approverUserId,
          "sla_breached",
          `A ${type} request has been waiting ${waitingDays} day(s), past its ${step.sla_days}-day SLA.`,
          `طلب ${type === "leave" ? "إجازة" : "سلفة"} بانتظارك منذ ${waitingDays} يوم، تجاوز مدة ${step.sla_days} أيام.`,
          link
        );
      }
      if (workflow.sla_escalate_to_employee_id) {
        const escalateUserId = employeeIdToUserId(workflow.sla_escalate_to_employee_id);
        if (escalateUserId != null) {
          notify(
            escalateUserId,
            "sla_breached_escalation",
            `Escalation: a ${type} request has exceeded its SLA and needs attention.`,
            `تصعيد: طلب ${type === "leave" ? "إجازة" : "سلفة"} تجاوز مدة الموافقة المحددة.`,
            link
          );
        }
      }
    }
  }
}

function resolveCurrentApprover(employee: Employee, step: any): number | null {
  if (step.approver_type === "direct_manager") return employeeIdToUserId(employee.direct_manager_id);
  if (step.approver_type === "department_head") {
    if (employee.department_id == null) return null;
    const dept = db.prepare("SELECT head_employee_id FROM departments WHERE id = ?").get(employee.department_id) as any;
    return employeeIdToUserId(dept?.head_employee_id ?? null);
  }
  if (step.approver_type === "org_role") {
    const assignment = db
      .prepare("SELECT employee_id FROM org_role_assignments WHERE org_role = ?")
      .get(step.approver_org_role) as any;
    return employeeIdToUserId(assignment?.employee_id ?? null);
  }
  return step.approver_user_id ?? null;
}

/** 6.5: "Upcoming leave tomorrow" -> employee's manager. */
export function runLeaveTomorrowReminder(): void {
  const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD");
  const starting = db
    .prepare(
      `SELECT lr.*, e.direct_manager_id, e.name_en, e.name_ar
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
       WHERE lr.status = 'approved' AND lr.start_date = ?`
    )
    .all(tomorrow) as any[];

  for (const lr of starting) {
    const managerUserId = employeeIdToUserId(lr.direct_manager_id);
    if (managerUserId != null) {
      notify(
        managerUserId,
        "leave_tomorrow",
        `${lr.name_en} starts leave tomorrow (${tomorrow}).`,
        `${lr.name_ar} يبدأ إجازته غداً (${tomorrow}).`,
        "/approvals"
      );
    }
  }
}

export function runDailyJobs(): void {
  runLeaveYearClosing();
  runSlaEscalationCheck();
  runLeaveTomorrowReminder();
}

export function scheduleJobs(): void {
  // Daily at 01:00 server time.
  cron.schedule("0 1 * * *", runDailyJobs);
}
