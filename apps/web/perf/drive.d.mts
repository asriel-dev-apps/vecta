import type { Browser, BrowserContext, Page } from "@playwright/test";
export const PORT: number;
export const BASE: string;
export const FIXTURE_ID: string;
export function assertServerIdentity(base?: string): Promise<string>;
export function launchBrowser(options?: { smooth?: boolean }): Promise<Browser>;
export function taskTimer(page: Page): Promise<{ now(): Promise<number>; detach(): Promise<void> }>;
export function openControlPage(
  context: BrowserContext,
  dims: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number },
): Promise<Page>;
export function wheelRun(
  page: Page,
  laneId: string,
  options?: { selector?: string; move?: boolean; timed?: boolean; observe?: boolean; direct?: boolean },
): Promise<{ stepMs: number[]; start: { top: number; left: number }; end: { top: number; left: number }; wheelEvents: number; failures: string[] }>;
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
