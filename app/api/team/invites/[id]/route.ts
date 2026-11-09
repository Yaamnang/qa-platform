import { NextResponse, type NextRequest } from "next/server";
import { cancelInvite } from "@/lib/server/data-store";
import { jsonError, requireAdmin } from "@/lib/server/http";

// Cancel a pending invite. Admins only, and only invites of the current organization.
export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/team/invites/[id]">) {
  const { auth, denied } = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  // 404 (not 403) for other organizations' invites so IDs can't be probed.
  if (!(await cancelInvite(auth.tenant.id, id))) return jsonError(404, "Invite not found.");
  return NextResponse.json({ ok: true });
}
