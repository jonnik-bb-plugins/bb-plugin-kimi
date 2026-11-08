import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  GLOBAL_BASE_URL,
  buildWindows,
  findCredentialsPath,
  measureKimiUsage,
  parseKimiConfigToml,
  resolveKimiEndpoints,
  type KimiUsageResponse,
} from "./kimi-usage.js";

const CONFIG_TOML = `
default_model = "kimi-code/k3.1-pro"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
oauth_host = "https://auth.kimi.ai"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`;

const NOW = 1_800_000_000_000; // fixed "now", well after any fixture expiry

function futureCredentials(): Record<string, unknown> {
  return {
    access_token: "access-old",
    refresh_token: "refresh-old",
    expires_at: Math.floor(NOW / 1000) + 3600,
    scope: "kimi-code",
    token_type: "Bearer",
  };
}

function usagePayload(): KimiUsageResponse {
  return {
    usages: {
      limit_5h: { used_ratio: 0.425, reset_time: "2027-01-15T18:00:00Z" },
      limit_7d: { used_ratio: 0.1, reset_time: "2027-01-20T00:00:00Z" },
      limit_month_total: { used_ratio: 0.5 },
      limit_month_code: { used_ratio: 1.25, reset_time: null },
    },
    boosterWallet: {
      monthlyChargeLimitEnabled: true,
      monthlyUsed: { priceInCents: 1234, currency: "USD" },
      monthlyChargeLimit: { priceInCents: 5000, currency: "USD" },
    },
  };
}

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: FetchHandler): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseKimiConfigToml", () => {
  it("reads base_url and oauth_host from the managed provider section", () => {
    expect(parseKimiConfigToml(CONFIG_TOML)).toEqual({
      baseUrl: "https://api.kimi.ai/coding/v1",
      oauthHost: "https://auth.kimi.ai",
    });
  });

  it("returns nothing when the sections are absent", () => {
    expect(parseKimiConfigToml('default_model = "x"\n')).toEqual({});
  });
});

describe("resolveKimiEndpoints", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kimi-usage-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("defaults to the CN endpoints", () => {
    expect(resolveKimiEndpoints(home, {})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      baseUrlConfigured: false,
      oauthHost: "https://auth.kimi.com",
    });
  });

  it("prefers config.toml values", () => {
    writeFileSync(join(home, "config.toml"), CONFIG_TOML);
    expect(resolveKimiEndpoints(home, {})).toEqual({
      baseUrl: GLOBAL_BASE_URL,
      baseUrlConfigured: true,
      oauthHost: "https://auth.kimi.ai",
    });
  });

  it("lets env override the config base URL; the config oauth host still wins", () => {
    writeFileSync(join(home, "config.toml"), CONFIG_TOML);
    expect(resolveKimiEndpoints(home, { KIMI_CODE_BASE_URL: "https://api.example.com/coding/v1/" })).toEqual({
      baseUrl: "https://api.example.com/coding/v1",
      baseUrlConfigured: true,
      oauthHost: "https://auth.kimi.ai",
    });
  });

  it("derives the oauth host from an env base URL when nothing else sets it", () => {
    expect(resolveKimiEndpoints(home, { KIMI_CODE_BASE_URL: "https://api.example.com/coding/v1" }).oauthHost)
      .toBe("https://auth.example.com");
  });
});

describe("findCredentialsPath", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kimi-usage-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when the credentials directory is missing", () => {
    expect(findCredentialsPath(home)).toBeNull();
  });

  it("picks the newest kimi-code-*.json and ignores other files", async () => {
    const directory = join(home, "credentials");
    mkdirSync(directory, { recursive: true });
    const older = join(directory, "kimi-code-env-aaa.json");
    const newer = join(directory, "kimi-code-env-bbb.json");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    writeFileSync(join(directory, "notes.txt"), "x");
    // Ensure a deterministic mtime order.
    const past = new Date("2020-01-01T00:00:00Z");
    const { utimesSync } = await import("node:fs");
    utimesSync(older, past, past);
    expect(findCredentialsPath(home)).toBe(newer);
  });
});

describe("buildWindows", () => {
  it("maps every quota window and attaches USD cost to the monthly window", () => {
    const windows = buildWindows(usagePayload());
    expect(windows).toHaveLength(4);
    expect(windows[0]).toEqual({
      kind: "five-hour",
      id: "5h",
      label: "5h",
      usedPercent: 42.5,
      resetsAt: "2027-01-15T18:00:00Z",
      model: null,
      cost: null,
    });
    expect(windows[1]).toMatchObject({ kind: "weekly", id: "7d", usedPercent: 10 });
    expect(windows[2]).toMatchObject({
      kind: "custom",
      id: "month-total",
      usedPercent: 50,
      resetsAt: null,
      cost: { usedUsdCents: 1234, limitUsdCents: 5000 },
    });
    // Overage above 100% is preserved, not clamped.
    expect(windows[3]).toMatchObject({ id: "month-code", usedPercent: 125 });
  });

  it("omits cost when the charge limit is disabled or non-USD", () => {
    const payload = usagePayload();
    const disabled = buildWindows({
      ...payload,
      boosterWallet: { ...payload.boosterWallet!, monthlyChargeLimitEnabled: false },
    });
    expect(disabled.find((window) => window.id === "month-total")?.cost).toBeNull();
    const eur = buildWindows({
      ...payload,
      boosterWallet: {
        ...payload.boosterWallet!,
        monthlyUsed: { priceInCents: 1234, currency: "EUR" },
      },
    });
    expect(eur.find((window) => window.id === "month-total")?.cost).toBeNull();
  });

  it("tolerates missing windows", () => {
    expect(buildWindows({ usages: {} })).toEqual([]);
  });
});

describe("measureKimiUsage", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kimi-usage-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeCredentials(contents: Record<string, unknown>): string {
    const directory = join(home, "credentials");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "kimi-code-env-test.json");
    writeFileSync(path, JSON.stringify(contents));
    return path;
  }

  it("reports unauthenticated without a credentials file", async () => {
    const result = await measureKimiUsage({ home, env: {}, nowMs: NOW });
    expect(result).toEqual({ status: "unauthenticated" });
  });

  it("reports expired when the refresh grant is rejected", async () => {
    writeCredentials({
      ...futureCredentials(),
      expires_at: Math.floor(NOW / 1000) - 10, // forces a refresh
    });
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { error: "invalid_grant" } }));
    const result = await measureKimiUsage({ home, env: {}, fetchImpl, nowMs: NOW });
    expect(result).toEqual({ status: "expired" });
  });

  it("refreshes an expired token, fetches usage and identity, and writes the tokens back", async () => {
    const path = writeCredentials({
      ...futureCredentials(),
      expires_at: Math.floor(NOW / 1000) - 10,
    });
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === "https://auth.kimi.com/api/oauth/token") {
        return { status: 200, body: { access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 } };
      }
      if (url === `${DEFAULT_BASE_URL}/usages`) return { status: 200, body: usagePayload() };
      if (url === `${DEFAULT_BASE_URL}/me`) {
        return { status: 200, body: { email: "user@example.com", user_id: "u123", user_level_name: "Vivace" } };
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const result = await measureKimiUsage({ home, env: {}, fetchImpl, nowMs: NOW });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.accountKey).toBe("kimi-code:u123");
    expect(result.accountEmail).toBe("user@example.com");
    expect(result.planLabel).toBe("Vivace");
    expect(result.windows.map((window) => window.id)).toEqual(["5h", "7d", "month-total", "month-code"]);
    expect(calls[0]).toBe("https://auth.kimi.com/api/oauth/token");
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.access_token).toBe("access-new");
    expect(written.refresh_token).toBe("refresh-new");
    expect(written.expires_at).toBe(Math.floor(NOW / 1000) + 900);
    expect(written.scope).toBe("kimi-code");
  });

  it("falls back to the global base URL when the default CN endpoint 404s", async () => {
    writeCredentials(futureCredentials());
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === `${DEFAULT_BASE_URL}/usages`) return { status: 404, body: {} };
      if (url === `${GLOBAL_BASE_URL}/usages`) return { status: 200, body: usagePayload() };
      if (url === `${GLOBAL_BASE_URL}/me`) return { status: 404, body: {} };
      throw new Error(`unexpected URL ${url}`);
    });
    const result = await measureKimiUsage({ home, env: {}, fetchImpl, nowMs: NOW });
    expect(result.status).toBe("ok");
    expect(calls).toContain(`${GLOBAL_BASE_URL}/usages`);
    // /me is best-effort: its failure degrades identity to null, not the status.
    if (result.status === "ok") expect(result.accountKey).toBeNull();
  });

  it("reports an error when usage is unavailable on both endpoints", async () => {
    writeCredentials(futureCredentials());
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: {} }));
    const result = await measureKimiUsage({ home, env: {}, fetchImpl, nowMs: NOW });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("Kimi For Coding");
  });
});
