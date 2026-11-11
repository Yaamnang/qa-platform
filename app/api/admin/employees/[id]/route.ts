import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";
import { jsonError } from "@/lib/console/server/http";
import { deleteEmployee, getEmployee } from "@/lib/console/server/store";

// Removes an employee and ends their sessions at once. Workspaces and jobs are not tied to employees, so they stay.
export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/admin/employees/[id]">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getEmployee(id))) return jsonError(404, "No such employee.");
  return NextResponse.json(await deleteEmployee(id));
}
