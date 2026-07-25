import type { LinksFunction } from "react-router";
import type { Route } from "./+types/project.masters";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { MasterRoute } from "~/masters/master-route";
import { MasterList } from "~/masters/master-list";
import masterStyles from "~/wbs/styles.css?url";

// ADR 0012 Step 4c-1 — `/projects/:id/masters` = the project master data 工程 +
// プロダクト (the SPA's two name-only `MasterList`s, side by side). The SPA's
// single マスタ screen had no home for these in the Step-3 route set, so Option A
// (user-confirmed) adds this route; `/members` stays reserved for the existing
// MemberList only. The master stylesheet is linked from the route so the panels
// are styled server-side with no flash-of-unstyled (same pattern as the wbs route).
export const links: LinksFunction = () => [{ rel: "stylesheet", href: masterStyles }];

export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectView(context);
}

export async function action(args: Route.ActionArgs) {
  return runCommandAction(args, "masters-save");
}

export const shouldRevalidate = skipRevalidationOnSelfSave;

// The sort order the next added master takes (max existing + 1), so a new 工程 /
// プロダクト appends after the current list — byte-faithful to the SPA.
const nextSortOrder = (items: readonly { readonly sortOrder: number }[]): number =>
  items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

export default function ProjectMasters({ loaderData }: Route.ComponentProps) {
  return (
    <MasterRoute loaderData={loaderData} subtitle="マスタ管理 · 工程 / プロダクト">
      {({ project, editable, executeCommand }) => (
        <div className="master-grid">
          <MasterList
            title="工程"
            addLabel="工程を追加…"
            items={project.processes}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "process.add",
                process: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.processes) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "process.update", processId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "process.delete", processId: id })}
          />
          <MasterList
            title="プロダクト"
            addLabel="プロダクトを追加…"
            items={project.products}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "product.add",
                product: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.products) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "product.update", productId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "product.delete", productId: id })}
          />
        </div>
      )}
    </MasterRoute>
  );
}
