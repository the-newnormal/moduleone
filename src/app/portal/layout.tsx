import { AppBar } from "@/app/_shell/app-bar";
import { portalNav, viewerAccess } from "@/lib/portal/access";
import { createClient } from "@/lib/supabase/server";

// Every portal page (the portal, check-in and Team health) under the app bar. A signed-out visitor
// gets the page alone, which sends them to /login. The nav only offers what the viewer may open;
// each page still checks for itself.
export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  return (
    <>
      {data?.claims && <AppBar nav={portalNav(await viewerAccess())} />}
      {children}
    </>
  );
}
