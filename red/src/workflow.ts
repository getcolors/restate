// Lifecycle graph and backend advice, the port of
// io.github.getcolors.restate.workflow.

import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "digitalocean", "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// The compute stage's applied `params`, or undefined when no state is
// readable. Delete overlays this best-effort read so cleanup knows the
// address; an unreadable state (a fresh clone, a missing backend) is simply
// absent.
export async function stateOutput(opts: Opts): Promise<Record<string, unknown> | undefined> {
  try {
    const outputs = await tofu.outputs(
      tools.toolDir(opts, tools.infrastructureTool),
      tools.backendCredentialEnv(opts),
    );
    const params = outputs.params;
    return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && (event === "create" || event === "delete")
          ? validate.secretErrors(current)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") {
        return { ...current, ...(await stateOutput(current) ?? {}), "red/exit": 0 };
      }
      return { ...current, "red/exit": 0 };
    },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "restate/start": [startStep, "restate/ansible"],
      "restate/ansible": [tools.ansibleStep, "restate/dns"],
      "restate/dns": [tools.dnsStep, "restate/infrastructure"],
      "restate/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "restate/start": [startStep, "restate/infrastructure"],
    "restate/infrastructure": [tools.infrastructureStep, "restate/dns"],
    "restate/dns": [tools.dnsStep, "restate/ansible"],
    "restate/ansible": [tools.ansibleStep, "restate/acceptance"],
    "restate/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "restate/infrastructure", "restate/dns", "restate/ansible", "restate/acceptance",
];

function create() {
  let wf = workflow({ start: "restate/start", wireFn });
  wf = adviceAdd(wf, "restate/infrastructure", "before", "restate.workflow/backend",
    backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "restate/dns", "before", "restate.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const restateWorkflow = create();
