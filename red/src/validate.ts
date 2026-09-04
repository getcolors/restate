// Desired-state and credential validation, the port of
// io.github.getcolors.restate.validate.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.

import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { compute, providers as onceProviders } from "package-once-red";
import { onceSsh } from "./once.ts";

export const profilePar = parName("profile");

// provider-compute -> what that choice implies.
//
// `required` are the non-secret keys that provider's template interpolates,
// `secrets` the credentials it needs through COLORS_PAR_*, and `tofuEnv` the
// subset OpenTofu reads from the process environment itself. Keeping the three
// together is what stops a provider being validated against one set of keys and
// run with another -- a stage exporting a credential nobody checked for, or a
// check demanding a key no template uses. The keys of this map are the
// advertised providers; a provider without a template directory and a golden
// is not advertised. One entry today: this package puts a provider firewall in
// front of the host, so the sources are required where ONCE's own compute
// templates need none.
//
// Two keys the template reads are deliberately not required. `digitalocean-name`
// is an optional override of the profile (Compute Name Standard), and
// `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
export const computeProviders: compute.Registry = {
  digitalocean: {
    required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
               "digitalocean-ssh-sources", "digitalocean-http-sources"],
    secrets: ["do-token"],
    tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running: the only one it ever offered. A legacy state
// -- `params` without `provider` -- is whatever this value says it is, and
// `restate-digitalocean`'s R2 state may still hold one.
export const defaultComputeProvider = "digitalocean";

// How this package describes itself to ONCE's `compute`, the Compute Provider
// Standard's operations over a package-owned registry. The registry and the
// default are the data above; `sources` names the firewall lists the template
// reads -- SSH must list at least one CIDR, an empty HTTP list means no public
// HTTP. The name rules are ONCE's.
export const spec: compute.ComputeSpec = {
  registry: computeProviders,
  default: defaultComputeProvider,
  sources: { nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] },
};

// Every key desired state must carry whichever provider is selected. The
// provider-scoped keys come from `computeProviders`.
export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy", "restate-host", "restate-node-name", "restate-image",
  "restate-typescript-sdk-version", "restate-data-dir", "restate-backup-dir",
  "reference-app-delay-seconds", "reference-app-max-activity-attempts",
  "reference-app-fail-activity-attempts", "caddy-image",
  "restate-backup-r2-bucket", "restate-backup-r2-endpoint",
  "restate-backup-r2-region", "restate-backup-oncalendar",
  "restate-backup-retention-days",
  "r2-bucket", "r2-endpoint",
];

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*:[^\s:@]+$/;

export function missing(x: unknown): boolean {
  return x == null || (typeof x === "string" && x.trim().length === 0);
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

// `<provider>-<suffix>`: desired state names compute keys after the provider,
// so the shared steps reach them through the selected provider rather than a
// fixed prefix. ONCE's; named here so `tools` reads the same.
export const computeKey = compute.computeKey;

// What this deployment's machine is called: `digitalocean-name` when present,
// else the profile (Compute Name Standard). ONCE's; the template derives the
// Droplet name, the firewall name and `params.name` from this one answer.
export const computeName = compute.computeName;

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// A source list as desired state or an overlay string carries it. ONCE's, so
// the validator and the template can never disagree about what an entry is.
export const cidrs = compute.cidrs;

function positiveInt(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

// Every problem with desired state at once: the missing keys (this package's
// and the selected provider's), the package's own checks, then the Compute
// Provider Standard's -- selection, the network contract and the provider
// rules, DigitalOcean's VPC refusal among them -- which are ONCE's over `spec`.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of [...required, ...compute.requiredKeys(spec, opts)]) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be local, s3, or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  if (!(missing(opts["restate-host"]) || hostRe.test(String(opts["restate-host"])))) {
    errors.push(":restate-host must be a fully qualified hostname");
  }
  for (const key of ["restate-image", "caddy-image"]) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(String(value))) {
      errors.push(`:${key} must carry an explicit image tag`);
    }
  }
  for (const key of ["reference-app-delay-seconds", "reference-app-max-activity-attempts",
                     "reference-app-fail-activity-attempts", "restate-backup-retention-days"]) {
    if (!missing(opts[key]) && !positiveInt(opts[key])) {
      errors.push(`:${key} must be a positive integer`);
    }
  }
  const maxAttempts = opts["reference-app-max-activity-attempts"];
  const failAttempts = opts["reference-app-fail-activity-attempts"];
  if (typeof maxAttempts === "number" && Number.isInteger(maxAttempts) &&
      typeof failAttempts === "number" && Number.isInteger(failAttempts) &&
      maxAttempts <= failAttempts) {
    errors.push(":reference-app-max-activity-attempts must exceed :reference-app-fail-activity-attempts");
  }
  errors.push(...compute.stateErrors(spec, opts));
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return onceProviders["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// Credentials a real create or delete needs: the selected compute provider's,
// Cloudflare's, the backup bucket's, and the backend's.
export function secretErrors(opts: Opts): string[] {
  const keys = [
    ...compute.secrets(spec, opts),
    "cloudflare-api-token",
    "restate-backup-r2-access-key-id",
    "restate-backup-r2-secret-access-key",
    ...backendSecrets(opts),
  ];
  return [...new Set(keys)]
    .filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return compute.tofuEnv(spec, opts);
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return onceProviders["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
