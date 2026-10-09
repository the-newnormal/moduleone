import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/admin/session";

export default async function AdminPage() {
  await requireAdminPage("/admin");
  redirect("/admin/structure");
}
