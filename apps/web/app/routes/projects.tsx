import type { ProjectRole } from "@vecta/application";
import { Link, useNavigation, type LinksFunction } from "react-router";
import type { Route } from "./+types/projects";
import { requirePrincipal } from "~/server/auth/require-principal";
import { loadProjectList } from "~/server/project/project-list.server";
import { skipRevalidationOnSelfSave } from "~/routing/self-save-revalidation";
import { AppBar } from "~/shell/app-bar";
import styles from "~/wbs/styles.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export function meta() {
  return [{ title: "プロジェクト | VECTA" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  // The list and the signed-in identity for the header. `requirePrincipal` reads
  // the memoised auth-middleware principal (the same one `loadProjectList` uses),
  // so surfacing `displayName` here adds no DB round trip — it just gives the
  // list its own brand+account chrome (the app bar mounts only inside
  // `/projects/:id`, so the list had no header, hence no visible Sign out).
  const { projects } = await loadProjectList(context);
  const { principal } = await requirePrincipal(context);
  return { projects, displayName: principal.displayName };
}

// ADR 0012 Step 4b — the project list shares the revalidation economy: a WBS
// self-save on `/projects/:id/wbs` never triggers a workspace-wide list re-read.
export const shouldRevalidate = skipRevalidationOnSelfSave;

const ROLE_LABEL: Record<ProjectRole, string> = {
  OWNER: "オーナー",
  EDITOR: "編集者",
  VIEWER: "閲覧者",
};

/**
 * VECTA's signature motif at rest: faint staggered schedule bars (the Gantt
 * lockup) under an earned-value curve that rises into a vector arrowhead — the
 * "vector" the product is named for, read from EV / cost / timeline. Pure
 * branding: identical on every card, carrying no project data (the list loader
 * ships none), so it decorates without ever implying a metric. Colour comes from
 * `currentColor`; opacity/scale are set by the surface that renders it.
 */
function VectorMotif({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 132 96"
      fill="none"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="6" y="20" width="42" height="6" rx="3" fill="currentColor" opacity="0.5" />
      <rect x="18" y="34" width="46" height="6" rx="3" fill="currentColor" opacity="0.36" />
      <rect x="30" y="48" width="42" height="6" rx="3" fill="currentColor" opacity="0.24" />
      <path
        d="M6 88 C42 84 62 66 84 44 C98 30 110 20 120 12"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <polygon points="126,7 112,9.5 119.5,19" fill="currentColor" />
    </svg>
  );
}

/** One project the person can open — the whole card is the link to its WBS. */
function ProjectCard({
  id,
  name,
  role,
}: {
  readonly id: string;
  readonly name: string;
  readonly role: ProjectRole;
}) {
  const to = `/projects/${id}`;
  // Opening a project is the heaviest navigation in the app, so say which card is
  // opening rather than leaving the list looking inert. `Link` has no `isPending`
  // of its own (that is a `NavLink` affordance), so it comes off the pending
  // location — which is the card's own path, or a route beneath it once the index
  // route redirects on to `/wbs`.
  const navigation = useNavigation();
  const pendingPath = navigation.location?.pathname;
  const opening =
    pendingPath !== undefined && (pendingPath === to || pendingPath.startsWith(`${to}/`));
  return (
    <Link
      to={to}
      // Spend the hover that already precedes the click on fetching the payload.
      prefetch="intent"
      className={`project-card${opening ? " project-card--opening" : ""}`}
      aria-busy={opening || undefined}
      data-testid="project-card"
    >
      <VectorMotif className="project-card__motif" />
      <span className="project-card__role">{ROLE_LABEL[role]}</span>
      <h2 className="project-card__name">{name}</h2>
      <span className="project-card__open">
        開く
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M3 8h9M8.5 4l4 4-4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </Link>
  );
}

/** No accessible projects yet — a directional invitation, not a blank page. */
function EmptyState() {
  return (
    <div className="projects-empty" data-testid="projects-empty">
      <VectorMotif className="projects-empty__mark" />
      <h2 className="projects-empty__title">表示できるプロジェクトがありません</h2>
      <p className="projects-empty__body">
        参加しているプロジェクトがここに並びます。追加は管理者に依頼してください。
      </p>
    </div>
  );
}

export default function Projects({ loaderData }: Route.ComponentProps) {
  const { projects, displayName } = loaderData;
  return (
    <div className="projects-frame">
      <AppBar displayName={displayName} nav={false} />
      <main className="projects-screen" data-testid="projects-screen">
        <header className="projects-head">
          <span className="projects-eyebrow">ワークスペース</span>
          <h1 className="projects-title">プロジェクト</h1>
          {projects.length > 0 ? (
            <p className="projects-count">
              <span className="projects-count__num">{projects.length}</span> 件のプロジェクト
            </p>
          ) : null}
        </header>
        {projects.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="projects-grid">
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard id={project.id} name={project.name} role={project.role} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
