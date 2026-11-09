import { NextResponse, type NextRequest } from "next/server";
import { listInvites, listMembers, toInviteDto } from "@/lib/server/data-store";
import { requireAuth } from "@/lib/server/http";

// Members and pending invites of the current organization only. Viewers may look too.
export async function GET(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const members = await listMembers(auth.tenant.id);
  const invites = await listInvites(auth.tenant.id);
  return NextResponse.json({ members, invites: invites.map(toInviteDto) });
}
