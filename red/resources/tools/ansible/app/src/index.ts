import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

interface Input { value: number }
interface Result {
  workflowId: string;
  input: number;
  activityAttempts: number;
  result: number;
  verification: string;
}
interface Status { status: string; activityAttempts: number; result?: Result }

const delaySeconds = Number(process.env.WORKFLOW_DELAY_SECONDS ?? "120");
const failAttempts = Number(process.env.ACTIVITY_FAIL_ATTEMPTS ?? "2");
const maxAttempts = Number(process.env.ACTIVITY_MAX_ATTEMPTS ?? "5");
const stateDir = process.env.ACTIVITY_STATE_DIR ?? "/activity-state";

async function activityAttempt(workflowId: string): Promise<number> {
  await fs.mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, `${encodeURIComponent(workflowId)}.attempts`);
  let attempt = 0;
  try { attempt = Number(await fs.readFile(file, "utf8")); } catch { /* first attempt */ }
  attempt += 1;
  await fs.writeFile(file, `${attempt}\n`, { mode: 0o600 });
  if (attempt <= failAttempts) throw new Error(`intentional retry ${attempt}/${failAttempts}`);
  return attempt;
}

export const referenceWorkflow = restate.workflow({
  name: "ReferenceWorkflow",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: Input): Promise<Result> => {
      if (!Number.isSafeInteger(input?.value)) throw new restate.TerminalError("value must be a safe integer");
      ctx.set("status", "sleeping");
      ctx.set("activityAttempts", 0);
      await ctx.sleep({ seconds: delaySeconds });
      ctx.set("status", "activity-retrying");
      const activityAttempts = await ctx.run(
        "retryable-activity",
        () => activityAttempt(ctx.key),
        { initialRetryInterval: { milliseconds: 500 }, retryIntervalFactor: 2,
          maxRetryInterval: { seconds: 3 }, maxRetryAttempts: maxAttempts });
      const result = input.value * input.value;
      const output: Result = {
        workflowId: ctx.key,
        input: input.value,
        activityAttempts,
        result,
        verification: createHash("sha256").update(`${ctx.key}:${input.value}:${result}`).digest("hex"),
      };
      ctx.set("activityAttempts", activityAttempts);
      ctx.set("result", output);
      ctx.set("status", "completed");
      return output;
    },
    getStatus: async (ctx: restate.WorkflowSharedContext): Promise<Status> => ({
      status: (await ctx.get<string>("status")) ?? "not-started",
      activityAttempts: (await ctx.get<number>("activityAttempts")) ?? 0,
      result: (await ctx.get<Result>("result")) ?? undefined,
    }),
  },
});

restate.serve({ services: [referenceWorkflow], port: 9080 });
const ingress = clients.connect({ url: process.env.RESTATE_INGRESS_URL ?? "http://restate:8080" });

function send(res: http.ServerResponse, code: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { status: "ok", product: "Restate", serverVersion: "1.7.3", sdkVersion: "1.16.6" });
    }
    const match = url.pathname.match(/^\/workflows\/([A-Za-z0-9._~-]{1,128})$/);
    if (!match) return send(res, 404, { error: "not found" });
    const workflowId = match[1];
    const workflow = ingress.workflowClient(referenceWorkflow, workflowId);
    if (req.method === "POST") {
      const input = await body(req) as Input;
      if (!Number.isSafeInteger(input?.value)) return send(res, 400, { error: "value must be a safe integer" });
      let existing = false;
      try { existing = (await workflow.getStatus()).status !== "not-started"; } catch { /* first start */ }
      await workflow.workflowSubmit(input);
      return send(res, existing ? 200 : 202, { workflowId, deduplicated: existing });
    }
    if (req.method === "GET") {
      const status = await workflow.getStatus();
      return send(res, status.status === "not-started" ? 404 : 200, { workflowId, ...status });
    }
    return send(res, 405, { error: "method not allowed" });
  } catch (error) {
    console.error(error);
    return send(res, 503, { error: "service unavailable" });
  }
}).listen(8080, "0.0.0.0");

async function register(): Promise<void> {
  const admin = process.env.RESTATE_ADMIN_URL ?? "http://restate:9070";
  const uri = process.env.RESTATE_SERVICE_URL ?? "http://app:9080";
  for (;;) {
    try {
      const response = await fetch(`${admin}/deployments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri, force: false, metadata: { version: "1.0.0" } }),
      });
      if (response.ok) return;
      console.error("registration failed", response.status, await response.text());
    } catch (error) { console.error("registration waiting", error); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
void register();
