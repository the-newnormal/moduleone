import { redirect } from "next/navigation";

// The portal is the app. Signed-out visitors are sent on to /login by the proxy.
export default function Home() {
  redirect("/portal");
}
