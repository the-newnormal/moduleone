import type { Metadata } from "next";
import { requireAdminLayout } from "@/lib/admin/session";
import { AdminNav } from "./admin-nav";

export const metadata: Metadata = { title: "Admin · Module One" };

// Only admin-grant holders get past this: signed-out visitors go to /login, everyone else gets a
// 404. Layouts don't re-run on client navigation, so every page under /admin calls
// requireAdminPage itself too (it's cached per request, so this costs nothing extra). If the check
// itself fails, the layout leaves out the nav and lets the page throw, so admin/error.tsx shows.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const admin = await requireAdminLayout("/admin");

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-8 px-4 py-10">
      <header className="grid gap-3 border-b pb-4">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Admin</p>
        {admin && <AdminNav />}
      </header>
      <main className="grid grid-cols-[minmax(0,1fr)] gap-6">{children}</main>
    </div>
  );
}
