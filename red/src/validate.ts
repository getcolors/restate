// Desired-state and credential validation over ONCE's backend provider
// registry, the port of io.github.getcolors.restate.validate.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.

import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";

export { providers };

export const profilePar = parName("profile");

export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy", "restate-host", "restate-node-name", "restate-image",
  "restate-typescript-sdk-version", "restate-data-dir", "restate-backup-dir",
  "reference-app-delay-seconds", "reference-app-max-activity-attempts",
  "reference-app-fail-activity-attempts", "caddy-image",
  "restate-backup-r2-bucket", "restate-backup-r2-endpoint",
  "restate-backup-r2-region", "restate-backup-oncalendar",
  "restate-backup-retention-days", "digitalocean-name", "digitalocean-region",
  "digitalocean-size", "digitalocean-image", "digitalocean-ssh-keys",
  "digitalocean-ssh-sources", "digitalocean-http-sources",
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

function positiveInt(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (opts["provider-compute"] !== "digitalocean") {
    errors.push(":provider-compute must be digitalocean");
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
  if ("digitalocean-vpc-uuid" in opts) {
    errors.push(":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime");
  }
  if ("digitalocean-vpc-cidr" in opts) {
    errors.push(":digitalocean-vpc-cidr must be absent; this package must not create a VPC");
  }
  return errors;
}

interface ProviderEntry {
  required?: string[];
  secrets?: string[];
  tofuEnv?: Record<string, string>;
}

function backendEntry(opts: Opts): ProviderEntry | undefined {
  return (providers as Record<string, Record<string, ProviderEntry>>)["provider-backend"]?.[
    String(opts["provider-backend"])];
}

export function backendSecrets(opts: Opts): string[] {
  return backendEntry(opts)?.secrets ?? [];
}

export function secretErrors(opts: Opts): string[] {
  const keys = ["do-token", "cloudflare-api-token",
                "restate-backup-r2-access-key-id",
                "restate-backup-r2-secret-access-key",
                ...backendSecrets(opts)];
  return [...new Set(keys)]
    .filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return { "do-token": "DIGITALOCEAN_TOKEN" };
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return backendEntry(opts)?.tofuEnv ?? {};
    default:
      return {};
  }
}
