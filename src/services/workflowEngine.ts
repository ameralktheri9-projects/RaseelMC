import dayjs from "dayjs";
import { db, asRow } from "../db";
import type {
  Workflow,
  WorkflowStep,
  WorkflowConditions,
  Employee,
  Department,
  RequestType,
  ApprovalActionType,
} from "../models/types";

export interface RequestContext {
  leaveTypeId?: number;
  departmentId?: number | null;
  jobGrade?: string | null;
  days?: number;
  amount?: number;
}

function employeeIdToUserId(employeeId: number | null): number | null {
  if (employeeId == null) return null;
  const row = asRow<{ id: number } | undefined>(
    db.prepare("SELECT id FROM users WHERE employee_id = ? AND is_active = 1").get(employeeId)
  );
  return row?.id ?? null;
}

/** WF-05: pick the most specific active workflow matching this request's context; fall back to the default. */
export function resolveWorkflow(requestType: RequestType, ctx: RequestContext): Workflow {
  const workflows = asRow<Workflow[]>(
    db.prepare("SELECT * FROM workflows WHERE request_type = ? AND is_active = 1").all(requestType)
  );

  let best: { workflow: Workflow; score: number } | null = null;

  for (const wf of workflows) {
    const cond: WorkflowConditions = JSON.parse(wf.conditions_json || "{}");
    let matches = true;
    let score = 0;

    if (cond.leaveTypeId != null) {
      if (ctx.leaveTypeId !== cond.leaveTypeId) matches = false;
      else score++;
    }
    if (cond.departmentId != null) {
      if (ctx.departmentId !== cond.departmentId) matches = false;
      else score++;
    }
    if (cond.jobGrade != null) {
      if (ctx.jobGrade !== cond.jobGrade) matches = false;
      else score++;
    }
    if (cond.minDays != null) {
      if (ctx.days == null || ctx.days < cond.minDays) matches = false;
      else score++;
    }
    if (cond.maxDays != null) {
      if (ctx.days == null || ctx.days > cond.maxDays) matches = false;
      else score++;
    }
    if (cond.minAmount != null) {
      if (ctx.amount == null || ctx.amount < cond.minAmount) matches = false;
      else score++;
    }
    if (cond.maxAmount != null) {
      if (ctx.amount == null || ctx.amount > cond.maxAmount) matches = false;
      else score++;
    }

    if (matches && (best === null || score > best.score)) {
      best = { workflow: wf, score };
    }
  }

  if (best) return best.workflow;

  const fallback = asRow<Workflow | undefined>(
    db
      .prepare("SELECT * FROM workflows WHERE request_type = ? AND is_default = 1 AND is_active = 1")
      .get(requestType)
  );
  if (!fallback) {
    throw new Error(`No default workflow configured for request type "${requestType}".`);
  }
  return fallback;
}

export function getWorkflowSteps(workflowId: number): WorkflowStep[] {
  return asRow<WorkflowStep[]>(
    db
      .prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order")
      .all(workflowId)
  );
}

/** Resolve a step's approver_type/value to a concrete user id, honoring an active delegation if present. */
export function resolveStepApproverUserId(
  step: WorkflowStep,
  employee: Employee
): { userId: number | null; delegatedFromUserId: number | null } {
  let resolvedUserId: number | null = null;

  switch (step.approver_type) {
    case "direct_manager":
      resolvedUserId = employeeIdToUserId(employee.direct_manager_id);
      break;
    case "department_head": {
      if (employee.department_id == null) break;
      const dept = asRow<Department | undefined>(
        db.prepare("SELECT * FROM departments WHERE id = ?").get(employee.department_id)
      );
      resolvedUserId = employeeIdToUserId(dept?.head_employee_id ?? null);
      break;
    }
    case "org_role": {
      const assignment = asRow<{ employee_id: number } | undefined>(
        db
          .prepare("SELECT employee_id FROM org_role_assignments WHERE org_role = ?")
          .get(step.approver_org_role)
      );
      resolvedUserId = employeeIdToUserId(assignment?.employee_id ?? null);
      break;
    }
    case "specific_user":
      resolvedUserId = step.approver_user_id;
      break;
  }

  if (resolvedUserId == null) {
    return { userId: null, delegatedFromUserId: null };
  }

  const today = dayjs().format("YYYY-MM-DD");
  const delegation = asRow<{ delegate_user_id: number } | undefined>(
    db
      .prepare(
        `SELECT delegate_user_id FROM delegations
         WHERE approver_user_id = ? AND start_date <= ? AND end_date >= ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(resolvedUserId, today, today)
  );

  if (delegation) {
    return { userId: delegation.delegate_user_id, delegatedFromUserId: resolvedUserId };
  }
  return { userId: resolvedUserId, delegatedFromUserId: null };
}

export interface ResolvedStep {
  stepOrder: number;
  step: WorkflowStep;
  approverUserId: number | null;
  delegatedFromUserId: number | null;
  skipped: boolean;
}

/** Builds the full route for a request, applying the skip-duplicate-approver rule (WF-08). */
export function buildApprovalRoute(workflow: Workflow, employee: Employee): ResolvedStep[] {
  const steps = getWorkflowSteps(workflow.id);
  const requesterUserId = employeeIdToUserId(employee.id);
  const route: ResolvedStep[] = [];
  let previousApproverUserId: number | null = null;

  for (const step of steps) {
    const { userId, delegatedFromUserId } = resolveStepApproverUserId(step, employee);
    let skipped = false;

    if (workflow.skip_duplicate_approver) {
      if (userId != null && (userId === requesterUserId || userId === previousApproverUserId)) {
        skipped = true;
      }
    }

    route.push({ stepOrder: step.step_order, step, approverUserId: userId, delegatedFromUserId, skipped });
    if (!skipped) previousApproverUserId = userId;
  }

  return route;
}

function recordAction(
  requestType: RequestType,
  requestId: number,
  stepOrder: number,
  approverUserId: number | null,
  delegatedFromUserId: number | null,
  action: ApprovalActionType,
  comment: string | null
): void {
  db.prepare(
    `INSERT INTO approval_actions
      (request_type, request_id, step_order, approver_user_id, acted_as_delegate_for_user_id, action, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(requestType, requestId, stepOrder, approverUserId, delegatedFromUserId, action, comment);
}

const TABLE_BY_TYPE: Record<RequestType, string> = {
  leave: "leave_requests",
  loan: "loan_requests",
};

/** Submits a request: attaches the resolved workflow/version, auto-skips steps, lands on the first live step. */
export function submitRequest(
  requestType: RequestType,
  requestId: number,
  employee: Employee,
  ctx: RequestContext
): void {
  const workflow = resolveWorkflow(requestType, ctx);
  const route = buildApprovalRoute(workflow, employee);
  const table = TABLE_BY_TYPE[requestType];

  const firstLive = route.find((r) => !r.skipped);
  const landingStep = firstLive ?? route[route.length - 1];

  db.prepare(
    `UPDATE ${table} SET workflow_id = ?, workflow_version = ?, status = 'pending', current_step_order = ? WHERE id = ?`
  ).run(workflow.id, workflow.version, landingStep?.stepOrder ?? 1, requestId);

  recordAction(requestType, requestId, 0, employeeIdToUserId(employee.id), null, "submitted", null);

  for (const r of route) {
    if (r.skipped) {
      recordAction(requestType, requestId, r.stepOrder, r.approverUserId, r.delegatedFromUserId, "skipped", null);
    }
    if (r === landingStep) break;
  }
}

export interface AdvanceResult {
  newStatus: string;
  finalized: boolean;
}

/** Approver acts on the current step: approve moves to the next live step (or finalizes); reject/return end it. */
export function advanceRequest(
  requestType: RequestType,
  requestId: number,
  employee: Employee,
  actingUserId: number,
  action: "approved" | "rejected" | "returned",
  comment: string | null
): AdvanceResult {
  const table = TABLE_BY_TYPE[requestType];
  const request = asRow<{ workflow_id: number; current_step_order: number } | undefined>(
    db.prepare(`SELECT workflow_id, current_step_order FROM ${table} WHERE id = ?`).get(requestId)
  );
  if (!request || request.workflow_id == null) {
    throw new Error("Request has no workflow attached.");
  }

  const workflow = asRow<Workflow>(
    db.prepare("SELECT * FROM workflows WHERE id = ?").get(request.workflow_id)
  );
  const route = buildApprovalRoute(workflow, employee);
  const currentIndex = route.findIndex((r) => r.stepOrder === request.current_step_order);
  const currentStep = route[currentIndex];

  recordAction(requestType, requestId, request.current_step_order, actingUserId, null, action, comment);

  if (action === "rejected") {
    db.prepare(`UPDATE ${table} SET status = 'rejected' WHERE id = ?`).run(requestId);
    return { newStatus: "rejected", finalized: true };
  }
  if (action === "returned") {
    db.prepare(`UPDATE ${table} SET status = 'returned' WHERE id = ?`).run(requestId);
    return { newStatus: "returned", finalized: true };
  }

  // approved
  if (currentStep?.step.is_final) {
    db.prepare(`UPDATE ${table} SET status = 'approved' WHERE id = ?`).run(requestId);
    return { newStatus: "approved", finalized: true };
  }

  const nextLive = route.slice(currentIndex + 1).find((r) => !r.skipped);
  for (const r of route.slice(currentIndex + 1)) {
    if (r.skipped) {
      recordAction(requestType, requestId, r.stepOrder, r.approverUserId, r.delegatedFromUserId, "skipped", null);
    }
    if (r === nextLive) break;
  }

  if (!nextLive) {
    // No further live steps resolved (shouldn't normally happen if the final step is reachable) -> approve.
    db.prepare(`UPDATE ${table} SET status = 'approved' WHERE id = ?`).run(requestId);
    return { newStatus: "approved", finalized: true };
  }

  db.prepare(`UPDATE ${table} SET status = 'pending', current_step_order = ? WHERE id = ?`).run(
    nextLive.stepOrder,
    requestId
  );
  return { newStatus: "pending", finalized: false };
}

export function getApprovalTrail(requestType: RequestType, requestId: number) {
  return db
    .prepare(
      `SELECT aa.*, u.username as approver_username, e.name_en as approver_name_en, e.name_ar as approver_name_ar
       FROM approval_actions aa
       LEFT JOIN users u ON u.id = aa.approver_user_id
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE aa.request_type = ? AND aa.request_id = ?
       ORDER BY aa.id`
    )
    .all(requestType, requestId);
}

/** Pending-my-approval list for a given user, across leave and loan requests. */
export function getPendingApprovalsForUser(userId: number) {
  const leave = db
    .prepare(
      `SELECT 'leave' as request_type, lr.id, lr.current_step_order, lr.created_at,
              e.name_en, e.name_ar, lt.name_en as sub_type, lr.working_days as amount_or_days
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       JOIN workflow_steps ws ON ws.workflow_id = lr.workflow_id AND ws.step_order = lr.current_step_order
       WHERE lr.status = 'pending'`
    )
    .all() as any[];

  const loan = db
    .prepare(
      `SELECT 'loan' as request_type, lo.id, lo.current_step_order, lo.created_at,
              e.name_en, e.name_ar, 'Loan' as sub_type, lo.amount as amount_or_days
       FROM loan_requests lo
       JOIN employees e ON e.id = lo.employee_id
       WHERE lo.status = 'pending'`
    )
    .all() as any[];

  const all = [...leave, ...loan];
  const result = [];
  for (const r of all) {
    const employee = asRow<Employee>(
      db
        .prepare(
          `SELECT e.* FROM employees e
           JOIN ${r.request_type === "leave" ? "leave_requests" : "loan_requests"} req ON req.employee_id = e.id
           WHERE req.id = ?`
        )
        .get(r.id)
    );
    const workflow = asRow<Workflow | undefined>(
      db
        .prepare(
          `SELECT w.* FROM workflows w
           JOIN ${r.request_type === "leave" ? "leave_requests" : "loan_requests"} req ON req.workflow_id = w.id
           WHERE req.id = ?`
        )
        .get(r.id)
    );
    if (!workflow) continue;
    const route = buildApprovalRoute(workflow, employee);
    const step = route.find((s) => s.stepOrder === r.current_step_order);
    if (step && step.approverUserId === userId) {
      result.push(r);
    }
  }
  return result;
}
