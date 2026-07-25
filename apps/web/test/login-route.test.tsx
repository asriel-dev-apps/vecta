// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutesStub } from "react-router";
import Login from "~/routes/login";

// ADR 0012 auth-UX fix — the rendered side of `/login`. Drives the REAL route
// Component through `createRoutesStub` (loader stubbed to the shape the real
// loader returns) and asserts the sign-in control is present and that its trigger
// is a NATIVE `<form method="post">` (not RR's `<Form>`), so the browser does a
// full-document POST and the action's external 302 to Google runs document-side.

afterEach(() => cleanup());

function mount(returnTo: string) {
  const Stub = createRoutesStub([
    { path: "/login", Component: Login, loader: () => ({ returnTo }) },
  ]);
  render(<Stub initialEntries={["/login"]} />);
}

describe("Login page", () => {
  it("renders the VECTA-branded sign-in control", async () => {
    mount("/");
    await waitFor(() => expect(screen.getByTestId("login-screen")).toBeTruthy());
    expect(screen.getByText("VECTA")).toBeTruthy();
    const button = screen.getByTestId("google-sign-in");
    expect(button.textContent).toContain("サインイン");
  });

  it("triggers the flow via a native full-document POST to /login (no RR client submit)", async () => {
    mount("/");
    await waitFor(() => expect(screen.getByTestId("login-form")).toBeTruthy());
    const form = screen.getByTestId("login-form") as HTMLFormElement;
    // A native <form> (RR only enhances its own <Form>), so this is a real
    // document navigation, not a client-side RR submission.
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/login");
  });

  it("carries a validated returnTo into the form action so it survives the round trip", async () => {
    mount("/projects/42");
    await waitFor(() => expect(screen.getByTestId("login-form")).toBeTruthy());
    const form = screen.getByTestId("login-form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/login?returnTo=%2Fprojects%2F42");
  });
});
