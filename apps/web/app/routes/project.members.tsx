import type { LinksFunction } from "react-router";
import type { Route } from "./+types/project.members";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { MasterRoute } from "~/masters/master-route";
import { MemberList } from "~/masters/member-list";
import masterStyles from "~/wbs/styles.css?url";

// ADR 0012 Step 4c-1 — `/projects/:id/members` hosts ONLY the SPA's existing
// MemberList (name / 稼働カレンダー / 日次キャパシティ). Option A reserves this route
// to grow into a fuller member-management / permissions screen later, so it is NOT
// overloaded with 工程/プロダクト now (those live on `/masters`). The richer member
// UI is a future feature — deliberately NOT built here (spec-parity).
export const links: LinksFunction = () => [{ rel: "stylesheet", href: masterStyles }];

export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectView(context);
}

export async function action(args: Route.ActionArgs) {
  return runCommandAction(args, "members-save");
}

export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  return (
    <MasterRoute loaderData={loaderData} subtitle="マスタ管理 · メンバー">
      {({ project, editable, executeCommand }) => (
        <div className="master-grid">
          <MemberList
            members={project.members}
            calendars={project.calendars}
            defaultCalendarId={project.defaultCalendarId}
            editable={editable}
            onAdd={(member) => executeCommand({ type: "member.add", member })}
            onUpdate={(memberId, changes) => executeCommand({ type: "member.update", memberId, changes })}
            onDelete={(memberId) => executeCommand({ type: "member.delete", memberId })}
          />
        </div>
      )}
    </MasterRoute>
  );
}
