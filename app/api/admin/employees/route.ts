import { NextResponse, type NextRequest } from "next/server";
import { newEmployeePassword, requireAdmin } from "@/lib/admin/auth";
import { NO_STORE, jsonError } from "@/lib/console/server/http";
import { normalizeEmail } from "@/lib/console/server/records";
import { createEmployee, findEmployeeByEmail, listEmployees } from "@/lib/console/server/store";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every console employee, oldest first. No password hashes or authenticator secrets.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return NextResponse.json({ employees: await listEmployees() }, { headers: NO_STORE });
}

// Adds an employee. The password is in this one response and never again; only its hash is stored.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { email?: unknown; name?: unknown } | null;
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : "");
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!EMAIL.test(email)) return jsonError(400, "Enter a valid email address.", { fieldErrors: { email: "Enter a valid email address." } });
  if (!name) return jsonError(400, "Enter a name.", { fieldErrors: { name: "Enter a name." } });
  if (await findEmployeeByEmail(email)) return jsonError(409, `${email} is already an employee.`, { fieldErrors: { email: "Already an employee." } });

  const password = newEmployeePassword();
  const employee = await createEmployee({ email, displayName: name, password });
  return NextResponse.json({ email: employee.email, password }, { status: 201, headers: NO_STORE });
}
