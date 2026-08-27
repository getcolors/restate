import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "red/workflow";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");

function fixture(overrides: Opts = {}): Opts {
  const text = readFileSync(fixtureFile, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("the fixture is valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
  });

  test("reports all errors at once", () => {
    const errors = validate.stateErrors(fixture({
      "restate-host": "bad", "restate-image": "floating",
      "reference-app-delay-seconds": -1,
      "provider-dns": "other", "digitalocean-vpc-uuid": "forbidden",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const part of ["host", "image", "delay", "provider-dns", "vpc-uuid"]) {
      expect(errors.some((e) => e.includes(part))).toBe(true);
    }
  });

  test("forbids VPC configuration", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-cidr": "10.0.0.0/16" }))
      .some((e) => e.includes("must be absent"))).toBe(true);
  });

  test("profile overlay is refused", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBe(1);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("names all package secrets", () => {
    const errors = validate.secretErrors(fixture()).join("\n");
    for (const name of ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY",
                        "COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID",
                        "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY"]) {
      expect(errors).toContain(name);
    }
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("infrastructure discovers the default VPC", () => {
    const data = tools.infrastructureData(fixture());
    expect(tools.cidrs(data, "digitalocean-http-sources")).toEqual(["0.0.0.0/0", "::/0"]);
  });

  test("dns is the apex, proxied", () => {
    const json = tools.dnsJson(fixture({ ip: "192.0.2.10" }));
    expect(json).toContain("restate.example.com");
    expect(json).toContain("192.0.2.10");
    expect(json).toContain("proxied");
  });

  test("the inventory keeps one private target", () => {
    const inventory = tools.inventory(fixture({ ip: "192.0.2.10" }));
    expect(inventory).toContain("192.0.2.10");
    expect(inventory).toContain("restate-fixture");
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  test("build and dry-run need no credentials", async () => {
    expect((await workflow.startStep(fixture({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {}))["red/exit"]).toBe(0);
  });

  test("a real create requires credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(result["red/err"]).toContain("COLORS_PAR_DO_TOKEN");
    expect(result["red/err"]).toContain("COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY");
  });

  test("delete is protected", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "delete" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(result["red/err"]).toContain("COMPUTE_PREVENT_DESTROY");
  });

  test("the graph orders the private stack", () => {
    expect(workflow.wireFn("restate/start", { "red/event": "create" })!.slice(1))
      .toEqual(["restate/infrastructure"]);
    expect(workflow.wireFn("restate/infrastructure", { "red/event": "create" })!.slice(1))
      .toEqual(["restate/dns"]);
    expect(workflow.wireFn("restate/start", { "red/event": "delete" })!.slice(1))
      .toEqual(["restate/ansible"]);
  });
});
