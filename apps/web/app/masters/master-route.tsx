import { useCallback, type ReactNode } from "react";
import { useFetcher, type SubmitTarget } from "react-router";
import type { ProjectCommand, ProjectState } from "@vecta/application";
import { fromCommand } from "~/wbs/project-command-contract";
import {
  MasterApp,
  type MasterRenderContext,
  type MasterSaveResult,
} from "./master-app";

// ADR 0012 Step 4c — the router wrapper shared by the masters / members /
// templates routes, mirroring 4b's `ProjectWbs`: it owns the `useFetcher` and the
// dispatch seam (encode the command batch to the wire shape, mint a per-command
// idempotency key, submit ONE JSON action request with the confirmed revision) and
// hands `onExecute` / `saveInFlight` / `saveResult` to the router-free `MasterApp`
// pipeline. Each route supplies its own loader payload, subtitle, and panels; the
// dispatch + pipeline are identical, so they live here once.

export function MasterRoute({
  loaderData,
  subtitle,
  children,
}: {
  readonly loaderData: { readonly revision: string; readonly stateView: ProjectState };
  readonly subtitle: string;
  readonly children: (ctx: MasterRenderContext) => ReactNode;
}) {
  const fetcher = useFetcher();

  // The dispatch seam (identical to `ProjectWbs.onExecute`): encode each domain
  // command to the wire shape, mint a client idempotency key per command (the
  // SPA's per-command `crypto.randomUUID()`), and submit ONE JSON action request.
  // Masters submit a batch of one; the revision chain is walked server-side.
  const onExecute = useCallback(
    (commands: readonly ProjectCommand[], expectedRevision: string) => {
      const body = {
        expectedRevision,
        commands: commands.map((command) => ({
          command: fromCommand(command),
          idempotencyKey: crypto.randomUUID(),
        })),
      };
      // `fromCommand`'s optional fields are typed `T | undefined` under
      // `exactOptionalPropertyTypes`, which the JSON `SubmitTarget` type rejects
      // even though the value is JSON-serializable at runtime (undefined keys are
      // dropped). The action re-validates the parsed body via `CommandBatchSchema`.
      void fetcher.submit(body as unknown as SubmitTarget, {
        method: "post",
        encType: "application/json",
      });
    },
    [fetcher],
  );

  return (
    <MasterApp
      initialState={loaderData.stateView}
      initialRevision={loaderData.revision}
      subtitle={subtitle}
      onExecute={onExecute}
      saveInFlight={fetcher.state !== "idle"}
      saveResult={fetcher.data as MasterSaveResult | undefined}
    >
      {children}
    </MasterApp>
  );
}
