import type { BrowserContext, Page } from "@playwright/test";
export const PORT: number;
export const BASE: string;
export const FIXTURE_ID: string;
export function assertServerIdentity(base?: string): Promise<void>;
export function openPerfPage(
  context: BrowserContext,
  base: string,
  cols: number,
  rows?: number,
): Promise<{ page: Page; firstRowMs: number; renderMs: number; meta: Record<string, unknown>; errors: string[] }>;
export function runEdit(
  page: Page,
  cols: 45 | 500,
): Promise<{ ms: number; failures: string[]; before: { bac: string | null; hours: string | null }; after: { bac: string | null; hours: string | null } }>;
