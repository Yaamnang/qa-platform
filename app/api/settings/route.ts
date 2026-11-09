import { NextResponse, type NextRequest } from "next/server";
import { bug } from "@/lib/server/bugs";
import { updateUserSettings } from "@/lib/server/data-store";
import { requireAuth } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  return NextResponse.json({
    displayName: auth.user.displayName,
    notificationEmail: auth.user.notificationEmail,
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    displayName?: string;
    notificationEmail?: string;
  } | null;
  const displayName = body?.displayName?.trim() ?? "";
  const notificationEmail = body?.notificationEmail?.trim() ?? "";

  const fieldErrors: Record<string, string> = {};
  if (displayName.length < 2 || displayName.length > 60) {
    fieldErrors.displayName = "Display name must be 2-60 characters.";
  }
  if (!EMAIL.test(notificationEmail)) {
    fieldErrors.notificationEmail = "Enter a valid email address.";
  }
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json({ error: "Please fix the highlighted fields.", fieldErrors }, { status: 422 });
  }

  if (!bug("settings-not-saved")) {
    await updateUserSettings(auth.user.id, { displayName, notificationEmail });
  }
  return NextResponse.json({ displayName, notificationEmail });
}
