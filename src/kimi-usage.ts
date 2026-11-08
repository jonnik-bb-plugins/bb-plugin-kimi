// Measures Kimi For Coding quota usage from the local Kimi Code CLI
// credentials. Endpoint and credential shapes come from the MIT-licensed
// kimi-code sources (https://github.com/MoonshotAI/kimi-code).
//
// This module is deliberately free of bb imports so vitest can exercise it
// directly. Never log token values.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
export const GLOBAL_BASE_URL = "https://api.kimi.ai/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const FETCH_TIMEOUT_MS = 8_000;
// Refresh a token this close to expiry instead of racing a request against it.
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const credentialsSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  // Epoch seconds, not milliseconds.
  expires_at: z.number().positive(),
});
export type KimiCredentials = z.infer<typeof credentialsSchema>;

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  // Refresh tokens rotate, but a response without one keeps the old value.
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  expires_at: z.number().positive().optional(),
});

const quotaWindowSchema = z.looseObject({
  used_ratio: z.number().nonnegative(),
  reset_time: z.string().nullable().optional(),
});
export type KimiQuotaWindow = z.infer<typeof quotaWindowSchema>;

const moneySchema = z.looseObject({
  priceInCents: z.number().nonnegative(),
  currency: z.string().optional(),
});

const usageResponseSchema = z.looseObject({
  usages: z.looseObject({
    limit_5h: quotaWindowSchema.nullable().optional(),
    limit_7d: quotaWindowSchema.nullable().optional(),
    limit_month_total: quotaWindowSchema.nullable().optional(),
    limit_month_code: quotaWindowSchema.nullable().optional(),
  }),
  boosterWallet: z.looseObject({
    monthlyChargeLimitEnabled: z.boolean().optional(),
    monthlyUsed: moneySchema.nullable().optional(),
    monthlyChargeLimit: moneySchema.nullable().optional(),
  }).nullable().optional(),
});
export type KimiUsageResponse = z.infer<typeof usageResponseSchema>;

const meResponseSchema = z.looseObject({
  email: z.string().nullable().optional(),
  user_id: z.union([z.string(), z.number()]).nullable().optional(),
  user_level_name: z.string().nullable().optional(),
});

export interface UsageWindowOutput {
  kind: "five-hour" | "daily" | "weekly" | "custom";
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  model: string | null;
  cost: { usedUsdCents: number; limitUsdCents: number } | null;
}

export type KimiUsageResult =
  | {
      status: "ok";
      accountKey: string | null;
      accountEmail: string | null;
      planLabel: string | null;
      windows: UsageWindowOutput[];
    }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | { status: "error"; message: string };

export class TokenExpiredError extends Error {
  constructor() {
    super("Kimi OAuth refresh token was rejected; sign in again with `kimi login`.");
    this.name = "TokenExpiredError";
  }
}

export interface MeasureDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
}

// Newest `kimi-code-*.json` wins: the CLI writes one file per OAuth key and
// keeps the active one fresh.
export function findCredentialsPath(home: string): string | null {
  const directory = join(home, "credentials");
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!/^kimi-code-.*\.json$/.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const { mtimeMs } = statSync(path);
      if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch {
      // A file vanishing mid-scan is not an error.
    }
  }
  return best?.path ?? null;
}

export function readCredentials(path: string): { raw: Record<string, unknown>; credentials: KimiCredentials } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const credentials = credentialsSchema.parse(parsed);
  return { raw: parsed as Record<string, unknown>, credentials };
}

// Minimal TOML reading: only the managed:kimi-code provider section of
// $KIMI_CODE_HOME/config.toml. The CLI is the writer; we never write it here.
export function parseKimiConfigToml(text: string): { baseUrl?: string; oauthHost?: string } {
  const baseUrl = /\[providers\."managed:kimi-code"\]([^[]*?)base_url\s*=\s*"([^"]+)"/.exec(text)?.[2];
  const oauthHost = /\[providers\."managed:kimi-code"\.oauth\]([^[]*?)oauth_host\s*=\s*"([^"]+)"/.exec(text)?.[2];
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(oauthHost !== undefined ? { oauthHost } : {}),
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function deriveOauthHost(baseUrl: string): string {
  try {
    const { protocol, host } = new URL(baseUrl);
    if (host.startsWith("api.")) return `${protocol}//auth.${host.slice("api.".length)}`;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_OAUTH_HOST;
}

export interface KimiEndpoints {
  baseUrl: string;
  /** True when the base URL came from env or config.toml (no 404 fallback). */
  baseUrlConfigured: boolean;
  oauthHost: string;
}

export function resolveKimiEndpoints(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): KimiEndpoints {
  let config: { baseUrl?: string; oauthHost?: string } = {};
  const configPath = join(home, "config.toml");
  if (existsSync(configPath)) {
    try {
      config = parseKimiConfigToml(readFileSync(configPath, "utf8"));
    } catch {
      // An unreadable config must not break usage collection.
    }
  }
  const envBase = env.KIMI_CODE_BASE_URL;
  const baseUrl = stripTrailingSlash(envBase ?? config.baseUrl ?? DEFAULT_BASE_URL);
  const oauthHost = stripTrailingSlash(
    env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST ?? config.oauthHost ?? deriveOauthHost(baseUrl),
  );
  return { baseUrl, baseUrlConfigured: envBase !== undefined || config.baseUrl !== undefined, oauthHost };
}

function writeCredentialsAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Throws TokenExpiredError when the server rejects the refresh grant; any
// other failure (network, 5xx, 429) is a plain Error and retryable later.
async function refreshTokens(
  path: string,
  raw: Record<string, unknown>,
  credentials: KimiCredentials,
  oauthHost: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<KimiCredentials> {
  const response = await fetchWithTimeout(fetchImpl, `${oauthHost}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: KIMI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    }),
  });
  if (response.status === 401 || response.status === 403) throw new TokenExpiredError();
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const grantError = typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
    if (grantError === "invalid_grant") throw new TokenExpiredError();
    throw new Error(`token refresh failed with HTTP ${response.status}`);
  }
  const tokens = tokenResponseSchema.parse(body);
  const next: KimiCredentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? credentials.refresh_token,
    expires_at: tokens.expires_at
      ?? (tokens.expires_in !== undefined
        ? Math.floor(nowMs / 1000) + tokens.expires_in
        : credentials.expires_at),
  };
  // Preserve unrelated fields the CLI stores alongside the tokens.
  writeCredentialsAtomic(path, { ...raw, ...next });
  return next;
}

function toWindow(
  kind: UsageWindowOutput["kind"],
  id: string,
  label: string,
  quota: KimiQuotaWindow | null | undefined,
): UsageWindowOutput | null {
  if (!quota) return null;
  return {
    kind,
    id,
    label,
    usedPercent: Math.round(quota.used_ratio * 1000) / 10,
    resetsAt: quota.reset_time ?? null,
    model: null,
    cost: null,
  };
}

// Maps the Kimi quota payload onto bb usage windows. The booster wallet's
// monthly charge limit is money, not ratio quota, so it becomes the `cost`
// of the monthly window — only when the amounts are explicitly USD.
export function buildWindows(response: KimiUsageResponse): UsageWindowOutput[] {
  const windows = [
    toWindow("five-hour", "5h", "5h", response.usages.limit_5h),
    toWindow("weekly", "7d", "7d", response.usages.limit_7d),
    toWindow("custom", "month-total", "Monthly total", response.usages.limit_month_total),
    toWindow("custom", "month-code", "Monthly code", response.usages.limit_month_code),
  ].filter((window) => window !== null);
  const wallet = response.boosterWallet;
  if (wallet?.monthlyChargeLimitEnabled && wallet.monthlyUsed && wallet.monthlyChargeLimit) {
    const used = wallet.monthlyUsed;
    const limit = wallet.monthlyChargeLimit;
    if (
      limit.priceInCents > 0
      && (used.currency ?? "USD") === "USD"
      && (limit.currency ?? "USD") === "USD"
    ) {
      const monthly = windows.find((window) => window.id === "month-total")
        ?? windows.find((window) => window.id === "month-code");
      if (monthly) {
        monthly.cost = { usedUsdCents: used.priceInCents, limitUsdCents: limit.priceInCents };
      }
    }
  }
  return windows;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export async function measureKimiUsage(deps: MeasureDeps = {}): Promise<KimiUsageResult> {
  const home = deps.home ?? kimiHome(deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();

  const credentialsPath = findCredentialsPath(home);
  if (credentialsPath === null) {
    // No credentials file at all: the CLI was never logged in on this machine.
    return { status: "unauthenticated" };
  }
  let raw: Record<string, unknown>;
  let credentials: KimiCredentials;
  try {
    ({ raw, credentials } = readCredentials(credentialsPath));
  } catch (error) {
    return { status: "error", message: `Could not read Kimi credentials: ${String(error)}` };
  }

  const endpoints = resolveKimiEndpoints(home, deps.env);
  try {
    if (credentials.expires_at * 1000 - nowMs < TOKEN_EXPIRY_SKEW_MS) {
      credentials = await refreshTokens(
        credentialsPath,
        raw,
        credentials,
        endpoints.oauthHost,
        fetchImpl,
        nowMs,
      );
    }
  } catch (error) {
    if (error instanceof TokenExpiredError) return { status: "expired" };
    return { status: "error", message: `Could not refresh the Kimi OAuth token: ${String(error)}` };
  }

  let usage = await fetchJson(fetchImpl, `${endpoints.baseUrl}/usages`, credentials.access_token);
  if (usage.status === 401) {
    // A token the server rejects ahead of its stored expiry: refresh once,
    // retry once, then give up as expired.
    try {
      credentials = await refreshTokens(
        credentialsPath,
        raw,
        credentials,
        endpoints.oauthHost,
        fetchImpl,
        nowMs,
      );
    } catch (error) {
      if (error instanceof TokenExpiredError) return { status: "expired" };
      return { status: "error", message: `Could not refresh the Kimi OAuth token: ${String(error)}` };
    }
    usage = await fetchJson(fetchImpl, `${endpoints.baseUrl}/usages`, credentials.access_token);
    if (usage.status === 401) return { status: "expired" };
  }
  if (usage.status === 404 && !endpoints.baseUrlConfigured && endpoints.baseUrl === DEFAULT_BASE_URL) {
    // Accounts on the global cluster answer on api.kimi.ai; the CN default
    // 404s there. Only fall back when the user did not pick a base URL.
    usage = await fetchJson(fetchImpl, `${GLOBAL_BASE_URL}/usages`, credentials.access_token);
  }
  if (usage.status === 404) {
    return { status: "error", message: "Kimi usage endpoint not available for this account (Kimi For Coding subscription required)." };
  }
  if (usage.status !== 200) {
    return { status: "error", message: `Kimi usage endpoint answered HTTP ${usage.status}.` };
  }

  let parsed: KimiUsageResponse;
  try {
    parsed = usageResponseSchema.parse(usage.json);
  } catch {
    return { status: "error", message: "Kimi usage endpoint returned an unexpected payload." };
  }

  // /me is best-effort: usage numbers matter, identity fields degrade to null.
  let accountKey: string | null = null;
  let accountEmail: string | null = null;
  let planLabel: string | null = null;
  try {
    const me = await fetchJson(fetchImpl, `${endpoints.baseUrl}/me`, credentials.access_token);
    if (me.status === 200) {
      const profile = meResponseSchema.parse(me.json);
      accountEmail = profile.email ?? null;
      planLabel = profile.user_level_name ?? null;
      accountKey = profile.user_id != null ? `kimi-code:${String(profile.user_id)}` : null;
    }
  } catch {
    // Ignore: identity is optional.
  }

  return { status: "ok", accountKey, accountEmail, planLabel, windows: buildWindows(parsed) };
}
