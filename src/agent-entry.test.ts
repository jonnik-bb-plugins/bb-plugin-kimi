import { describe, expect, it } from "vitest";
import {
  PROFILE,
  findOwnAgent,
  managedAgent,
  parseCustomAgents,
  removeAgent,
  stringifyCustomAgents,
  upsertAgent,
  type CustomAgent,
} from "./agent-entry.js";

const BINARY = "/Users/test/.kimi-code/bin/kimi";

function otherAgent(id: string): CustomAgent {
  return { id, displayName: id, command: id, args: ["acp"], env: {} };
}

describe("managedAgent", () => {
  it("declares the fields the plugin owns", () => {
    const agent = managedAgent(BINARY);
    expect(agent).toMatchObject({
      id: PROFILE.id,
      displayName: PROFILE.displayName,
      command: BINARY,
      args: ["acp"],
      env: {},
      nativeSkillRoots: {
        user: [".kimi-code/skills", ".agents/skills"],
        project: [".kimi-code/skills", ".agents/skills"],
      },
      supportsManualCompaction: true,
    });
    // Kimi's ACP server ignores launch-time permission flags, so the entry
    // must not carry a permissionCli (see README, Permission modes).
    expect(agent).not.toHaveProperty("permissionCli");
  });

  it("strips a permissionCli written by an earlier build", () => {
    const existing = managedAgent(BINARY, {
      id: PROFILE.id,
      permissionCli: { workspaceWrite: ["--yolo"], full: ["--auto"] },
    });
    expect(existing).not.toHaveProperty("permissionCli");
  });

  it("keeps keys the user added and env they set", () => {
    const existing: CustomAgent = {
      id: PROFILE.id,
      command: "kimi",
      args: ["acp", "--verbose"],
      env: { KIMI_CODE_HOME: "/data/kimi" },
      cwd: "/tmp/workspace",
      dialect: "cursor",
      modelCli: { listArgs: ["model", "list"] },
    };
    const agent = managedAgent(BINARY, existing);
    expect(agent.cwd).toBe("/tmp/workspace");
    expect(agent.dialect).toBe("cursor");
    expect(agent.modelCli).toEqual({ listArgs: ["model", "list"] });
    expect(agent.env).toEqual({ KIMI_CODE_HOME: "/data/kimi" });
    // Fields we manage are rewritten even when the user edited them.
    expect(agent.args).toEqual(["acp"]);
    expect(agent.command).toBe(BINARY);
  });

  it("ignores a non-object env rather than passing it through", () => {
    expect(managedAgent(BINARY, { id: PROFILE.id, env: "nope" }).env).toEqual({});
  });
});

describe("findOwnAgent", () => {
  it("returns our entry and ignores other agents", () => {
    const ours = { ...managedAgent(BINARY), cwd: "/repo" };
    expect(findOwnAgent([otherAgent("droid"), ours])?.cwd).toBe("/repo");
    expect(findOwnAgent([otherAgent("droid")])).toBeUndefined();
  });
});

describe("upsertAgent", () => {
  it("appends the entry and leaves other agents in place", () => {
    const agents = [otherAgent("copilot"), otherAgent("auggie")];
    const result = upsertAgent(agents, managedAgent(BINARY));
    expect(result.changed).toBe(true);
    expect(result.agents.map((agent) => agent.id)).toEqual(["copilot", "auggie", PROFILE.id]);
  });

  it("is idempotent once provisioned", () => {
    const first = upsertAgent([otherAgent("auggie")], managedAgent(BINARY));
    const second = upsertAgent(first.agents, managedAgent(BINARY));
    expect(second.changed).toBe(false);
    expect(second.agents).toEqual(first.agents);
  });

  it("reports a change when the resolved binary moved", () => {
    const provisioned = upsertAgent([], managedAgent("/usr/local/bin/kimi")).agents;
    const result = upsertAgent(provisioned, managedAgent(BINARY));
    expect(result.changed).toBe(true);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.command).toBe(BINARY);
  });

  it("rewrites owned fields without dropping unknown keys already on the entry", () => {
    const existing = managedAgent("/usr/bin/kimi", {
      id: PROFILE.id,
      cwd: "/repo",
      dialect: "opencode",
    });
    const result = upsertAgent([existing, otherAgent("auggie")], managedAgent(BINARY, existing));
    expect(result.changed).toBe(true);
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]).toMatchObject({
      id: PROFILE.id,
      command: BINARY,
      cwd: "/repo",
      dialect: "opencode",
    });
    expect(result.agents[1]).toEqual(otherAgent("auggie"));
  });
});

describe("removeAgent", () => {
  it("removes our entry and nothing else (legacy cleanup)", () => {
    const agents = [otherAgent("auggie"), managedAgent(BINARY), otherAgent("copilot")];
    const result = removeAgent(agents);
    expect(result.changed).toBe(true);
    expect(result.agents).toEqual([otherAgent("auggie"), otherAgent("copilot")]);
  });

  it("reports no change when nothing is registered", () => {
    expect(removeAgent([otherAgent("auggie")]).changed).toBe(false);
  });
});

describe("parseCustomAgents", () => {
  it("treats an unset or blank setting as no agents", () => {
    expect(parseCustomAgents(undefined)).toEqual([]);
    expect(parseCustomAgents(null)).toEqual([]);
    expect(parseCustomAgents("")).toEqual([]);
    expect(parseCustomAgents("   \n")).toEqual([]);
  });

  it("round-trips what stringifyCustomAgents writes", () => {
    const agents = [otherAgent("auggie"), managedAgent(BINARY)];
    expect(parseCustomAgents(stringifyCustomAgents(agents))).toEqual(agents);
  });

  it("refuses a setting it would otherwise clobber", () => {
    expect(() => parseCustomAgents('{"id":"kimi"}')).toThrow(/JSON array/);
    expect(() => parseCustomAgents(["already parsed"])).toThrow(/must be a string/);
    expect(() => parseCustomAgents("[not json")).toThrow();
  });
});
