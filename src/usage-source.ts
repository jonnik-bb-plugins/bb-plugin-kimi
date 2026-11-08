// Registers this plugin as a bb provider-usage source (contract copied
// verbatim into src/usage-contract.ts, as bb's plugins/provider-usage
// README prescribes), so Kimi quota shows up in bb's Provider usage panel.
//
// Shape follows bb's own plugins/provider-claude-code/src/usage-source.ts:
// resource IDs are JSON [hostId, providerId] locators, measurements are
// cached for 60s, and concurrent fetches of one resource share a promise.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROFILE } from "./agent-entry.js";
import { measureKimiUsage, type KimiUsageResult } from "./kimi-usage.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-contract.js";

const CACHE_TTL_MS = 60_000;
const GONE = "Usage resource no longer exists.";

const locatorSchema = z.tuple([z.string().min(1), z.literal(PROFILE.providerId)]);

interface UsageHost {
  id: string;
  name: string;
  status: string;
  machineProviderId: string | null;
}

// The Kimi CLI and its OAuth credentials live in this plugin process's home
// directory, so usage is measurable only for the host bb runs on. Host has
// no "local" flag; the server itself is the connected host with no
// machineProviderId (persistent machines carry their provider's id). The
// fallback keeps a single connected host working if bb ever tags the local
// host differently.
export function pickLocalHost(hosts: UsageHost[]): UsageHost | null {
  return hosts.find((host) => host.machineProviderId === null && host.status === "connected")
    ?? hosts.find((host) => host.status === "connected")
    ?? null;
}

function toMeasurement(result: KimiUsageResult, previous: UsageMeasurement | undefined): UsageMeasurement {
  const accountFields = result.status === "ok"
    ? { accountEmail: result.accountEmail, planLabel: result.planLabel }
    : { accountEmail: null, planLabel: null };
  return usageMeasurementSchema.parse({
    accountKey: result.status === "ok" ? result.accountKey : (previous?.accountKey ?? null),
    observedAt: result.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
    usage: result.status === "ok"
      ? { status: "ok", plan: null, ...accountFields, windows: result.windows }
      : result.status === "error"
        ? { status: "error", plan: null, ...accountFields, message: result.message }
        : { status: result.status, plan: null, ...accountFields },
  });
}

export function registerKimiUsageSource(bb: BbPluginApi): void {
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();

  const listHosts = async (): Promise<UsageHost[]> =>
    (await bb.sdk.hosts.list()) as unknown as UsageHost[];

  const load = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const [hostId] = locatorSchema.parse(JSON.parse(resourceId));
    const hosts = await listHosts();
    const host = hosts.find((candidate) => candidate.id === hostId);
    const local = pickLocalHost(hosts);
    if (!host || local?.id !== hostId) throw new Error(GONE);

    const previous = cache.get(resourceId);
    if (host.status !== "connected") {
      return toMeasurement({ status: "error", message: "Machine is disconnected." }, previous);
    }
    if (
      !refresh
      && previous?.usage.status === "ok"
      && previous.observedAt !== null
      && Date.now() - previous.observedAt < CACHE_TTL_MS
    ) {
      return previous;
    }

    const measurement = await measureKimiUsage()
      .then((result) => toMeasurement(result, previous))
      .catch((error: unknown) =>
        toMeasurement(
          { status: "error", message: `Usage could not be collected: ${String(error)}` },
          previous,
        ));
    cache.set(resourceId, measurement);
    return measurement;
  };

  const collect = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const running = pending.get(resourceId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return collect(resourceId, refresh);
    }
    const promise = load(resourceId, refresh).finally(() => pending.delete(resourceId));
    pending.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const host = pickLocalHost(await listHosts());
        if (!host) return { resources: [] };
        const id = JSON.stringify([host.id, PROFILE.providerId]);
        for (const key of [...cache.keys()]) if (key !== id) cache.delete(key);
        return {
          resources: [
            {
              id,
              accountKey: cache.get(id)?.accountKey ?? null,
              providerId: PROFILE.providerId,
              label: PROFILE.displayName,
              scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
            },
          ],
        };
      },
      [usageFetchMethod]: ({ resourceId, refresh }) => collect(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local Kimi For Coding usage, measured from the Kimi Code CLI's OAuth credentials and the Kimi coding API. Inventory reads metadata only; quota is fetched on demand.",
    },
  );
}
