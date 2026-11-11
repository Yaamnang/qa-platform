import { NextResponse, type NextRequest } from "next/server";
import { newEmployeePassword, requireAdmin } from "@/lib/admin/auth";
import { NO_STORE, jsonError } from "@/lib/console/server/http";
import { createEmployee, deleteEmployee, getEmployee } from "@/lib/console/server/store";

/**
 * A lost password: the employee is removed and added again with the same
 * email and name, a new password and a new authenticator, which they set up
 * on their next sign-in. Done as remove-then-add so no store needs a
 * "change password" method. Their open sessions end.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/admin/employees/[id]/reset">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const employee = await getEmployee(id);
  if (!employee) return jsonError(404, "No such employee.");

  await deleteEmployee(employee.id);
  const password = newEmployeePassword();
  await createEmployee({ email: employee.email, displayName: employee.displayName, password });
  return NextResponse.json({ email: employee.email, password }, { headers: NO_STORE });
}
