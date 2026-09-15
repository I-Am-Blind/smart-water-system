import { redirect } from "next/navigation";

/** The dashboard is the landing screen now; keep the old URL working. */
export default function DashboardRedirect() {
  redirect("/");
}
