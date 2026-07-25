import type { LinksFunction } from "react-router";
import type { Route } from "./+types/project.templates";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { MasterRoute } from "~/masters/master-route";
import { TemplateSection } from "~/masters/template-section";
import masterStyles from "~/wbs/styles.css?url";

// ADR 0012 Step 4c-1 — `/projects/:id/templates` = the SPA's サブタスクテンプレート
// master (`TemplateSection`: the template list + the selected template's step
// editor, whole thing), ported byte-faithful.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: masterStyles }];

export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectView(context);
}

export async function action(args: Route.ActionArgs) {
  return runCommandAction(args, "templates-save");
}

export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function ProjectTemplates({ loaderData }: Route.ComponentProps) {
  return (
    <MasterRoute loaderData={loaderData} subtitle="マスタ管理 · サブタスクテンプレート">
      {({ project, editable, executeCommand }) => (
        <TemplateSection
          templates={project.templates}
          editable={editable}
          executeCommand={executeCommand}
        />
      )}
    </MasterRoute>
  );
}
