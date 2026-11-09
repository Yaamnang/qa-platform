import { NextResponse, type NextRequest } from "next/server";
import { findMembership, setSessionTenant } from "@/lib/server/auth-store";
import { jsonError, requireUser } from "@/lib/server/http";

// Switch the session into one of the user's organizations.
export async function POST(req: NextRequest) {
  const { auth, denied } = await requireUser(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { organizationId?: string } | null;
  const membership = body?.organizationId ? await findMembership(auth.user.id, body.organizationId) : undefined;
  // Same answer for "does not exist" and "not yours": no probing for other organizations.
  if (!membership) return jsonError(404, "Organization not found.");
  await setSessionTenant(auth.session.id, membership.tenantId);
  return NextResponse.json({ ok: true });
}
