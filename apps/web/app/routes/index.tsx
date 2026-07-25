import { redirect } from "react-router";

// `/` under the protected layout. There is no separate landing page in this
// step, so a signed-in principal is sent straight to their project list
// (ADR 0012 §Decision 2). The parent layout's auth middleware has already run.
export async function loader() {
  throw redirect("/projects");
}

export default function Index() {
  return null;
}
