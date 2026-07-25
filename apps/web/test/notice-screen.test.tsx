// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutesStub, data } from "react-router";
import { ErrorBoundary, links } from "~/root";

// The failure these pin: an error used to render as bare markup with no
// stylesheet, so any 404 or unexpected throw dropped the user onto an unstyled
// white page that did not look like the product.

afterEach(cleanup);

function mountFailing(thrown: unknown) {
  const Stub = createRoutesStub([
    {
      path: "/boom",
      Component: () => <div>never rendered</div>,
      loader: () => {
        throw thrown;
      },
      ErrorBoundary,
    },
  ]);
  render(<Stub initialEntries={["/boom"]} />);
}

describe("root error boundary", () => {
  it("links the app stylesheet from the ROOT so the error screen is never unstyled", () => {
    // The fix itself: linking only from each screen left the boundary bare
    // whenever the failure preceded the leaf route's own links. The href is a
    // build artifact, so what is pinned is that root contributes a stylesheet at
    // all — remove this export and the error screen goes back to bare markup.
    expect(links()).toEqual([expect.objectContaining({ rel: "stylesheet" })]);
  });

  it("renders the branded notice surface, not bare markup", async () => {
    mountFailing(data(null, { status: 404 }));

    await waitFor(() => expect(screen.getByTestId("notice-screen")).toBeTruthy());
    // The brand lockup is what makes it read as VECTA rather than a browser error.
    expect(screen.getByText("VECTA")).toBeTruthy();
  });

  it("tells a 404 apart from an unexpected throw, and points each somewhere useful", async () => {
    mountFailing(data(null, { status: 404 }));
    await waitFor(() => expect(screen.getByTestId("notice-status").textContent).toBe("404"));
    expect(screen.getByText("ページが見つかりません")).toBeTruthy();
    expect(screen.getByTestId("notice-action").getAttribute("href")).toBe("/projects");

    cleanup();

    // A non-response throw carries no status to show, and the honest recovery is
    // a full document load rather than another router navigation.
    mountFailing(new Error("boom"));
    await waitFor(() => expect(screen.getByText("予期しないエラーが発生しました")).toBeTruthy());
    expect(screen.queryByTestId("notice-status")).toBeNull();
    expect(screen.getByTestId("notice-action").getAttribute("href")).toBe("/");
  });

  it("never leaks the underlying error text to the page", async () => {
    mountFailing(new Error("connection string is not a valid URL"));

    await waitFor(() => expect(screen.getByTestId("notice-screen")).toBeTruthy());
    expect(document.body.textContent).not.toContain("connection string");
  });
});
