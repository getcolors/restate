// OpenTofu and Ansible stages plus the acceptance proof, the port of
// io.github.getcolors.restate.tools.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import * as validate from "./validate.ts";

import ansibleCaddyfile from "../resources/tools/ansible/Caddyfile" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleBackup from "../resources/tools/ansible/backup" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCompose from "../resources/tools/ansible/compose.yml" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import appDockerfile from "../resources/tools/ansible/app/Dockerfile" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

// The reference application's manifests are JSON and its entry point is
// TypeScript, so a `with { type: "text" }` import would be type-checked as a
// parsed module rather than carried as bytes; they are read from the packaged
// resource tree instead.
const appResource = (name: string): string =>
  readFileSync(join(import.meta.dir, "../resources/tools/ansible/app", name), "utf8");
const appPackageJson = appResource("package.json");
const appPackageLockJson = appResource("package-lock.json");
const appTsconfigJson = appResource("tsconfig.json");
const appIndexTs = appResource("src/index.ts");

export const infrastructureTool = "restate-infrastructure";
export const dnsTool = "restate-dns";
export const ansibleTool = "restate-ansible";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "restate" });
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible/Caddyfile": ansibleCaddyfile,
  "ansible/ansible.cfg": ansibleCfg,
  "ansible/backup": ansibleBackup,
  "ansible/cleanup.yml": ansibleCleanup,
  "ansible/compose.yml": ansibleCompose,
  "ansible/main.yml": ansibleMain,
  "ansible/app/Dockerfile": appDockerfile,
  "ansible/app/package.json": appPackageJson,
  "ansible/app/package-lock.json": appPackageLockJson,
  "ansible/app/tsconfig.json": appTsconfigJson,
  "ansible/app/src/index.ts": appIndexTs,
  "dns/main.tf": dnsMainTf,
  "infrastructure/main.tf": infrastructureMainTf,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new StepError(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

export function fallbackParams(opts: Opts): Record<string, unknown> {
  return { ip: "192.0.2.10", user: "root", sudoer: "root", name: opts.profile };
}

export function outputParams(result: Opts): Record<string, unknown> | undefined {
  const params = (result["tofu/outputs"] as Record<string, unknown> | undefined)?.params;
  return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
}

// ---------------------------------------------------------------- compute

export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-ssh-sources")),
    "http-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-http-sources")),
  };
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const specs = [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`,
                      infrastructureData(opts))];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return { ...result, ...fallbackParams(opts), ...outputParams(result) };
}

// -------------------------------------------------------------------- dns

export function dnsJson(opts: Opts): string {
  return tofu.constructsJson([
    tofu.construct("resource", "cloudflare_dns_record", "restate", {
      zone_id: "${data.cloudflare_zone.zone.id}",
      name: opts["restate-host"], content: opts.ip, type: "A",
      proxied: true, ttl: 1,
    }),
  ]);
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const data: Opts = { ...opts, ip: opts.ip ?? fallbackParams(opts).ip };
  const specs = [
    spec(template("dns", "main.tf"), `${dir}/main.tf`, data),
    rawSpec(`${dir}/record.tf.json`, dnsJson(data)),
  ];
  return tofu.tofuWithSpec(opts, specs, { dir, env: credentialEnv(opts, "provider-dns") });
}

// ---------------------------------------------------------------- ansible

// Java's Double.toString, which is what Cheshire renders floats through and
// therefore what green's committed bytes would carry. Integral numbers print
// as longs. JS's shortest-round-trip digits are the same digits Java chooses;
// only the layout differs.
function javaNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const negative = value < 0;
  const [mantissa, exponentPart] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa!.replace(".", "");
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const intPart = digits.padEnd(exponent + 1, "0").slice(0, exponent + 1);
      const fracPart = digits.slice(exponent + 1);
      body = `${intPart}.${fracPart.length > 0 ? fracPart : "0"}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}.${rest.length > 0 ? rest : "0"}E${exponent}`;
  }
  return negative ? `-${body}` : body;
}

// Cheshire's pretty printer, byte for byte: spaces around colons, arrays
// inline, nested objects newline-indented, floats in Java notation.
function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        restate: {
          hosts: {
            [String(opts.profile)]: {
              ansible_host: opts.ip ?? "192.0.2.10",
              ansible_user: "root",
            },
          },
        },
      },
    },
  });
}

export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "app-files": ["Dockerfile", "package.json", "package-lock.json", "tsconfig.json", "src/index.ts"],
    "restate-backup-access-key": "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID') }}",
    "restate-backup-secret-key": "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY') }}",
  };
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  return [
    spec(template("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible", "main.yml"), `${dir}/main.yml`, data),
    spec(template("ansible", "cleanup.yml"), `${dir}/cleanup.yml`, data),
    spec(template("ansible", "compose.yml"), `${dir}/compose.yml`, data),
    spec(template("ansible", "Caddyfile"), `${dir}/Caddyfile`, data),
    spec(template("ansible", "backup"), `${dir}/backup`, data),
    spec(template("ansible.app", "Dockerfile"), `${dir}/app/Dockerfile`, data),
    spec(template("ansible.app", "package.json"), `${dir}/app/package.json`, data),
    spec(template("ansible.app", "package-lock.json"), `${dir}/app/package-lock.json`, data),
    spec(template("ansible.app", "tsconfig.json"), `${dir}/app/tsconfig.json`, data),
    spec(template("ansible.app.src", "index.ts"), `${dir}/app/src/index.ts`, data),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

export async function runJson(args: string[], timeoutMs: number): Promise<[unknown, string | null]> {
  const result = await runtime.exec(args, { timeoutMs });
  if (result.exit === 0) {
    try {
      return [JSON.parse(String(result.out ?? "")), null];
    } catch {
      return [null, null];
    }
  }
  return [null, `${result.err ?? ""}${result.out ?? ""}`];
}

export async function waitHealth(url: string, attempts: number): Promise<boolean> {
  for (let remaining = attempts; ; remaining -= 1) {
    const result = await runtime.exec(["curl", "-fsS", `${url}/health`], { timeoutMs: 10000 });
    if (result.exit === 0) return true;
    if (remaining <= 0) return false;
    await Bun.sleep(5000);
  }
}

// The end-to-end proof of the reference workflow: exactly-once duplicate
// starts, a full Droplet reboot during the durable sleep, and the retried
// activity's final result after recovery.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const base = `https://${opts["restate-host"]}`;
  const id = `acceptance-${Date.now()}`;
  if (!(await waitHealth(base, 60))) {
    return { ...opts, "red/exit": 1, "red/err": "HTTPS health did not become ready" };
  }
  const startArgs = ["curl", "-fsS", "-X", "POST",
                     "-H", "content-type: application/json",
                     "--data", '{"value":7}', `${base}/workflows/${id}`];
  const [started, startErr] = await runJson(startArgs, 15000);
  const [duplicate, duplicateErr] = await runJson(startArgs, 15000);
  await runtime.exec(
    ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
     `root@${opts.ip}`, "systemctl reboot"], { timeoutMs: 20000 });
  if (startErr) {
    return { ...opts, "red/exit": 1, "red/err": `workflow start failed: ${startErr}` };
  }
  if (duplicateErr) {
    return { ...opts, "red/exit": 1, "red/err": `duplicate start failed: ${duplicateErr}` };
  }
  if ((started as Opts)?.workflowId !== (duplicate as Opts)?.workflowId) {
    return { ...opts, "red/exit": 1,
      "red/err": "duplicate start did not return the same workflow ID" };
  }
  if (!(await waitHealth(base, 90))) {
    return { ...opts, "red/exit": 1,
      "red/err": "HTTPS did not recover after Droplet restart" };
  }
  for (let remaining = 90; ; remaining -= 1) {
    const [status, err] = await runJson(["curl", "-fsS", `${base}/workflows/${id}`], 10000);
    const outcome = status as Opts | null;
    const result = (outcome?.result ?? {}) as Opts;
    if (outcome && outcome.status === "completed" &&
        result.activityAttempts === 3 && result.result === 7 * 7) {
      return { ...opts, "red/exit": 0, "restate/acceptance": outcome };
    }
    if (remaining <= 0) {
      return { ...opts, "red/exit": 1,
        "red/err": `workflow did not complete after restart: ${err ?? JSON.stringify(outcome)}` };
    }
    await Bun.sleep(3000);
  }
}
