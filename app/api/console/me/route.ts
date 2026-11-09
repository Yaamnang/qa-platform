import { NextResponse, type NextRequest } from "next/server";
import type { Employee } from "@/lib/console/contract";
import { NO_STORE, requireEmployee } from "@/lib/console/server/http";

export async function GET(req: NextRequest) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;
  // Only the public fields. The password hash and TOTP secret never leave the server.
  const body: { employee: Employee } = {
    employee: { id: employee.id, email: employee.email, displayName: employee.displayName },
  };
  return NextResponse.json(body, { headers: NO_STORE });
}
