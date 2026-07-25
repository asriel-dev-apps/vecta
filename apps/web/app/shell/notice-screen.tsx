import type { ReactNode } from "react";
import { GanttGlyph } from "./brand";

/**
 * The full-page screen the app shows when it has something to say instead of a
 * workspace: an error, a refused sign-in, a page that is not there.
 *
 * These used to render as bare `<main><h1><p><a>` with no stylesheet, so a
 * failure dropped the user onto an unstyled white page that did not look like
 * the product at all — which reads as "the site is broken" even when the message
 * is a routine 404. This carries the same surfaces, type, and brand lockup as
 * the rest of the app, and inherits the light/dark tokens, so it stays part of
 * VECTA.
 *
 * Deliberately router-free: the action is a plain `<a>`, not a `<Link>`. The
 * root error boundary renders in states where navigating through the router is
 * exactly what we should not rely on, and a full document load is the honest
 * recovery from an unexpected error anyway.
 */
export function NoticeScreen({
  title,
  body,
  action,
  status,
}: {
  readonly title: string;
  readonly body: ReactNode;
  readonly action?: { readonly href: string; readonly label: string };
  /** An HTTP status, shown as a quiet caption. Omitted for non-response errors. */
  readonly status?: number;
}) {
  return (
    <main className="notice-screen" data-testid="notice-screen">
      <div className="notice-card">
        <span className="notice-lockup">
          <GanttGlyph className="notice-lockup__mark" />
          <span className="notice-lockup__wordmark">VECTA</span>
        </span>
        {status === undefined ? null : (
          <p className="notice-status" data-testid="notice-status">
            {status}
          </p>
        )}
        <h1 className="notice-title">{title}</h1>
        <p className="notice-body">{body}</p>
        {action === undefined ? null : (
          <a className="notice-action" href={action.href} data-testid="notice-action">
            {action.label}
          </a>
        )}
      </div>
    </main>
  );
}
