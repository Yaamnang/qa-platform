import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LoadingScreen } from "@/components/ui";
import { adminEnabled } from "@/lib/admin/auth";
import { AdminPortal } from "./portal";

/**
 * The admin portal, only when ADMIN_EMAIL and ADMIN_PASSWORD are set
 * (lib/admin/auth.ts). connection() makes the check run on each request,
 * against the running server's environment, not the build machine's.
 */
async function Gate() {
  await connection();
  if (!adminEnabled()) notFound();
  return <AdminPortal />;
}

export default function AdminPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Gate />
    </Suspense>
  );
}
