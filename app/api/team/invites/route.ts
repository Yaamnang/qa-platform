import { NextResponse, type NextRequest } from "next/server";
import { addInvite, listInvites, listMembers, toInviteDto } from "@/lib/server/data-store";
import { jsonError, requireAdmin } from "@/lib/server/http";
import type { Role } from "@/lib/server/store-types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: Role[] = ["admin", "viewer"];

// Invite someone to the current organization. Admins only. No email is sent:
// the invite is a pending record shown on the team page.
export async function POST(req: NextRequest) {
  const { auth, denied } = await requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { email?: string; role?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const role = body?.role as Role;

  const fieldErrors: Record<string, string> = {};
  if (!EMAIL.test(email)) fieldErrors.email = "Enter a valid email address.";
  if (!ROLES.includes(role)) fieldErrors.role = "Choose Admin or Viewer.";
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json({ error: "Please fix the highlighted fields.", fieldErrors }, { status: 422 });
  }

  const members = await listMembers(auth.tenant.id);
  if (members.some((m) => m.email.toLowerCase() === email)) {
    return jsonError(409, `${email} is already a member of ${auth.tenant.name}.`, { fieldErrors: { email: "Already a member." } });
  }
  const invites = await listInvites(auth.tenant.id);
  if (invites.some((i) => i.email === email)) {
    return jsonError(409, `${email} has already been invited.`, { fieldErrors: { email: "Already invited." } });
  }

  const invite = await addInvite(auth.tenant.id, auth.user.id, email, role);
  return NextResponse.json({ invite: toInviteDto(invite) }, { status: 201 });
}
