import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  return NextResponse.json({
    email: auth.user.email,
    displayName: auth.user.displayName,
    role: auth.role,
    tenant: { slug: auth.tenant.slug, name: auth.tenant.name },
  });
}
