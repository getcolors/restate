// OpenTofu and Ansible stages plus the acceptance proof, the port of
// io.github.getcolors.restate.tools.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import { compute } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as validate from "./validate.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleCaddyfile from "../resources/tools/ansible/Caddyfile" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleBackup from "../resources/tools/ansible/backup" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCompose from "../resources/tools/ansible/compose.yml" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import appDockerfile from "../resources/tools/ansible/app/Dockerfile" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureDigitaloceanTf from "../resources/tools/infrastructure/digitalocean/main.tf" with { type: "text" };

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
export const ansibleLocalTool = "restate-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "restate" });
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
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
  "infrastructure/digitalocean/main.tf": infrastructureDigitaloceanTf,
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

// The source lists as validate parses them, so the template and the
// validator can never disagree about what an entry is. ONCE's.
export const cidrs = validate.cidrs;

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

// What `build` and `--dry-run` render in place of a compute output: the
// documentation address, shaped like the selected provider's real `params` so
// every later stage sees the same keys either way. ONCE's.
export const fallbackParams = compute.fallbackParams;

// Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
// carries no `ip`. ONCE's; `infrastructureStep` is what wires it.
export const resolvedCompute = compute.resolvedCompute;

// `<provider>-<suffix>`, the selected provider's key. ONCE's, via validate.
export const computeKey = validate.computeKey;

// The machine's name: `digitalocean-name` when present, else the profile.
// ONCE's, via validate; the template derives every label from it.
export const computeName = validate.computeName;

// ---------------------------------------------------------------- compute

// Template values for the compute stage. The name, the keypair mode and the
// source lists are resolved here once, so the template interpolates values and
// never branches on which provider it belongs to.
export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "compute-name": computeName(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, computeKey(opts, "ssh-sources"))),
    "http-sources-hcl": tofu.hclList(cidrs(opts, computeKey(opts, "http-sources"))),
  };
}

// Providers are selected by template directory, not by conditionals inside one
// file: `tools/infrastructure/<provider>/main.tf` renders to the same `main.tf`
// whichever provider produced it.
export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  return [spec(template(`infrastructure.${opts["provider-compute"]}`, "main.tf"),
               `${dir}/main.tf`, infrastructureData(opts))];
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const result = await tofu.tofuWithSpec(opts, infrastructureSpecs(opts),
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return resolvedCompute(result, fallbackParams(opts), compute.outputParams(result));
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

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
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

// Template values for the Ansible stage. `ssh-private-key-path` reaches
// ansible.cfg so convergence uses the deployment's own key in keygen mode,
// where nothing guarantees an agent holds it.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "ssh-keygen": validate.keygen(opts),
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

// `runner` is dependency-injected the way green's tests use with-redefs on
// ansible/ansible-with-spec: ES module exports cannot be rebound from a test.
export async function ansibleStep(
  opts: Opts,
  runner: typeof ansible.ansibleWithSpec = ansible.ansibleWithSpec,
): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to clean up, and the rendered
    // inventory would fall back to 192.0.2.10. Remove the rendered tree the
    // way a completed cleanup would and let the teardown continue.
    return {
      ...scaffold(opts, ansibleSpecs(opts)),
      "red/exit": 0, "restate/cleanup": "skipped-no-compute",
    };
  }
  return runner(opts, {
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
  // The deployment's own key is selected in keygen mode (`ssh.identityArgs`),
  // because nothing guarantees an agent holds it; opt-out mode adds nothing.
  await runtime.exec(
    ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
     ...ssh.identityArgs(opts), `root@${opts.ip}`, "systemctl reboot"], { timeoutMs: 20000 });
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
