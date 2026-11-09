import { NextResponse, type NextRequest } from "next/server";
import { listOrganizations, setSessionTenant } from "@/lib/server/auth-store";
import { createOrganization } from "@/lib/server/data-store";
import { jsonError, requireUser } from "@/lib/server/http";

// The organization picker: only organizations this user is a member of.
export async function GET(req: NextRequest) {
  const { auth, denied } = await requireUser(req);
  if (denied) return denied;
  const organizations = (await listOrganizations(auth.user.id)).map((o) => ({ id: o.id, slug: o.slug, name: o.name, role: o.role }));
  return NextResponse.json({
    user: { displayName: auth.user.displayName, email: auth.user.email },
    organizations,
    currentId: auth.tenant?.id ?? null,
  });
}

// Create a new organization. The creator becomes its first Admin and is switched into it.
export async function POST(req: NextRequest) {
  const { auth, denied } = await requireUser(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim().replace(/\s+/g, " ") ?? "";
  if (name.length < 2 || name.length > 60) {
    return NextResponse.json(
      { error: "Please fix the highlighted fields.", fieldErrors: { name: "Organization name must be 2-60 characters." } },
      { status: 422 },
    );
  }
  if ((await listOrganizations(auth.user.id)).some((o) => o.name.toLowerCase() === name.toLowerCase())) {
    return jsonError(409, `You already have an organization called "${name}".`, { fieldErrors: { name: "Pick a different name." } });
  }
  const org = await createOrganization(auth.user.id, name);
  await setSessionTenant(auth.session.id, org.id);
  return NextResponse.json({ organization: { id: org.id, slug: org.slug, name: org.name, role: "admin" } }, { status: 201 });
}
