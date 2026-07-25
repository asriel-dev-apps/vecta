// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import ProjectLayout from "~/routes/project";
import { ThemeToggle, useThemePref } from "~/shell/app-bar";

// ADR 0012 Step 4c-2 — the ported tier-1 app bar in the `/projects/:id` layout.
// Drives the REAL layout Component through `createRoutesStub` (so `NavLink` active
// state, `Form`, and the layout loader run for real) plus a router-free hydration
// check of the theme code path.

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

const DISPLAY_NAME = "山田 太郎";

function mountLayout(entry: string) {
  // Identity-only, exactly as the real layout loader returns: the project row is
  // not part of this payload (nothing rendered here reads it).
  const loader = () => ({ displayName: DISPLAY_NAME });
  const Stub = createRoutesStub([
    {
      path: "/projects/:id",
      Component: ProjectLayout,
      loader,
      children: [
        { path: "wbs", Component: () => <div data-testid="wbs-screen">wbs</div> },
        { path: "masters", Component: () => <div data-testid="masters-screen">masters</div> },
      ],
    },
  ]);
  render(<Stub initialEntries={[entry]} />);
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("auth-bar")).toBeTruthy());
}

describe("ProjectLayout — tier-1 app bar", () => {
  it("renders the brand lockup, theme toggle, identity, sign-out form, and nav", async () => {
    mountLayout("/projects/p1/wbs");
    await ready();

    // Brand lockup wordmark (the Gantt glyph carries the same aria-label).
    expect(screen.getByText("VECTA")).toBeTruthy();

    // Theme toggle radiogroup with the three options and their testids/roles.
    const toggle = screen.getByTestId("theme-toggle");
    expect(toggle.getAttribute("role")).toBe("radiogroup");
    for (const testId of ["theme-system", "theme-light", "theme-dark"]) {
      expect(screen.getByTestId(testId).getAttribute("role")).toBe("radio");
    }

    // Identity shows the principal displayName (not an email — none on the
    // cookie-session principal).
    expect(screen.getByTestId("auth-identity").textContent).toBe(DISPLAY_NAME);

    // Sign out is a POST form to /logout.
    const signOut = screen.getByTestId("google-sign-out");
    expect(signOut.tagName).toBe("BUTTON");
    const form = signOut.closest("form");
    expect(form).not.toBeNull();
    expect(form!.getAttribute("method")).toBe("post");
    expect(form!.getAttribute("action")).toBe("/logout");

    // Nav items are routed links (anchors), not buttons.
    expect(screen.getByTestId("nav-wbs").tagName).toBe("A");
    for (const testId of ["nav-wbs", "nav-masters", "nav-members", "nav-templates", "nav-dashboard"]) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }
  });

  it("offers the way back out of the project, to the project list", async () => {
    mountLayout("/projects/p1/wbs");
    await ready();

    // Without this the project screens are a dead end: every nav tab stays inside
    // the project and the only other exit is Sign out.
    const back = screen.getByTestId("nav-projects");
    expect(back.tagName).toBe("A");
    expect(back.getAttribute("href")).toBe("/projects");
    expect(back.textContent).toContain("プロジェクト一覧");
    // It is an exit, not a sixth destination: no nav-tab underline rail.
    expect(back.className).not.toContain("nav-tab");
  });

  it("marks the current route's nav link active (underline + aria-current)", async () => {
    mountLayout("/projects/p1/masters");
    await ready();

    const masters = screen.getByTestId("nav-masters");
    expect(masters.className).toContain("nav-tab--active");
    expect(masters.getAttribute("aria-current")).toBe("page");

    const wbs = screen.getByTestId("nav-wbs");
    expect(wbs.className).not.toContain("nav-tab--active");
    expect(wbs.getAttribute("aria-current")).toBeNull();
  });

  it("switches data-theme and persists the choice on toggle (effect/handler path)", async () => {
    mountLayout("/projects/p1/wbs");
    await ready();

    fireEvent.click(screen.getByTestId("theme-dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("vecta-theme")).toBe("dark");
    expect(screen.getByTestId("theme-dark").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("theme-system"));
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(window.localStorage.getItem("vecta-theme")).toBe("system");
    expect(screen.getByTestId("theme-system").getAttribute("aria-checked")).toBe("true");
  });

  it("syncs the toggle's selected state from storage after mount (not at module load)", async () => {
    window.localStorage.setItem("vecta-theme", "dark");
    mountLayout("/projects/p1/wbs");
    await ready();

    // The effect reads the stored choice after mount and highlights ダーク.
    await waitFor(() =>
      expect(screen.getByTestId("theme-dark").getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByTestId("theme-system").getAttribute("aria-checked")).toBe("false");
  });
});

// React logs hydration mismatches through console.error with these markers.
const MISMATCH = /hydrat|did not match|server rendered|server HTML|text content does not match/i;

function ThemeHarness() {
  const [theme, setTheme] = useThemePref();
  return <ThemeToggle value={theme} onChange={setTheme} />;
}

describe("theme toggle SSR + hydration", () => {
  it("server-renders 'system' deterministically and hydrates with no mismatch", () => {
    // Even with an explicit stored choice, the SSR render must be the
    // deterministic default so the server and client's first render agree — the
    // stored choice is adopted only in a post-mount effect (the root inline
    // script owns the actual load-time theme; this hook never re-applies it).
    window.localStorage.setItem("vecta-theme", "dark");

    const html = renderToString(<ThemeHarness />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    expect(
      container.querySelector('[data-testid="theme-system"]')!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="theme-dark"]')!.getAttribute("aria-checked"),
    ).toBe("false");

    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    });
    act(() => {
      hydrateRoot(container, <ThemeHarness />);
    });
    spy.mockRestore();

    // No hydration mismatch, and the post-mount effect then adopts the stored choice.
    expect(errors.filter((message) => MISMATCH.test(message))).toEqual([]);
    expect(
      container.querySelector('[data-testid="theme-dark"]')!.getAttribute("aria-checked"),
    ).toBe("true");

    container.remove();
  });
});
