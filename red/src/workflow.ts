// Lifecycle graph, preflight and backend advice, the port of
// io.github.getcolors.restate.workflow.

import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider, "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// Compute params recorded in the infrastructure state; undefined when the
// state holds none. An unreadable backend throws the SDK's `StepError`, which
// `compute.readState` turns into `{ error }` — create and delete treat the two
// differently. Kept local, and injectable into `startStep`, so tests never
// shell out to tofu.
export async function stateOutput(opts: Opts): Promise<compute.Params | undefined> {
  const outputs = await tofu.outputs(
    tools.toolDir(opts, tools.infrastructureTool),
    tools.backendCredentialEnv(opts),
  );
  const params = outputs.params;
  return params && typeof params === "object" ? params as compute.Params : undefined;
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = stateOutput,
): Promise<Opts> {
  // The state is read once, up front, on the same defaulted and overlaid opts
  // the validators see — the overlay is what carries the backend credentials —
  // and only for the two events that touch a provider. The validator and the
  // after-validate share the one read; the reader is injectable so tests never
  // shell out to tofu.
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead = compute.lifecycleEvent(context)
    ? await compute.readState(overlaid, reader) : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected.
      (current, _environment, ctx) => (compute.lifecycleEvent(ctx)
        ? compute.providerValidator(validate.spec, current, state.params, () => validate.secretErrors(current))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    // The machine key's create matrix and the provider preflight run before
    // any template is rendered: an unowned key on disk or at the provider
    // stops the run while stopping is still free. Delete fills the same
    // template values — a destroy renders before it destroys — and adopts the
    // recorded address (ONCE's `adoptState`, fail-closed on an unreadable
    // backend, no address override), but checks no key, because its key
    // cleanup runs after the compute destroy.
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") return compute.adoptState(current, "delete", state);
      if (real && event === "create") {
        let next = await ssh.ensureKey(current, async () => state.params);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(current), "red/exit": 0 };
    },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "restate/start": [startStep, "restate/ansible"],
      "restate/ansible": [tools.ansibleStep, "restate/dns"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "restate/dns": [tools.dnsStep, "restate/ssh-config"],
      "restate/ssh-config": [tools.ansibleLocalStep, "restate/infrastructure"],
      // The keypair goes strictly after the compute destroy: a key that
      // predeceases its host locks the operator out of a machine that still
      // exists (SSH Keypair Standard §3.3).
      "restate/infrastructure": [tools.infrastructureStep, "restate/ssh-cleanup"],
      "restate/ssh-cleanup": [ssh.cleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "restate/start": [startStep, "restate/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine.
    "restate/infrastructure": [tools.infrastructureStep, "restate/ssh-config"],
    "restate/ssh-config": [tools.ansibleLocalStep, "restate/dns"],
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
  "restate/infrastructure", "restate/dns", "restate/ssh-config",
  "restate/ansible", "restate/acceptance", "restate/ssh-cleanup",
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
