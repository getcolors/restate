import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate } from "red/scaffold";
import { StepError, type Opts } from "red/workflow";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const keygenFile = join(import.meta.dir, "../../test/fixtures/keygen.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

// DigitalOcean in opt-out mode (an explicit key id, a name equal to the
// profile — the shape of the restate-digitalocean deployment), and the same
// provider in keygen mode (no `digitalocean-ssh-keys`, no `digitalocean-name`).
const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const keygen = (overrides: Opts = {}) => readFixture(keygenFile, overrides);

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home. Nothing here may touch the real one.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "restate-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The compute template for `opts`' provider, rendered as `build` would.
function renderInfrastructure(opts: Opts): string {
  return renderTemplate(tools.template(`infrastructure.${opts["provider-compute"]}`, "main.tf"),
    tools.infrastructureData(opts), tools.templateOpts);
}

const resource = (name: string) =>
  readFileSync(join(import.meta.dir, "../resources", name), "utf8");
const source = readFileSync(join(import.meta.dir, "../src/tools.ts"), "utf8");

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(keygen())).toEqual([]);
  });

  test("the spec carries this package's registry, sources and default", () => {
    // The operations are ONCE's; this is the data they run over. A colour
    // whose registry, sources or default drifts fails here, in that colour.
    expect(Object.keys(validate.spec.registry)).toEqual(["digitalocean"]);
    expect(validate.spec.registry).toBe(validate.computeProviders);
    expect(validate.spec.registry.digitalocean).toEqual({
      required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                 "digitalocean-ssh-sources", "digitalocean-http-sources"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    });
    expect(validate.spec.sources).toEqual({ nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] });
    // The default is what a legacy state without params.provider is, and the
    // only provider this package ever offered is DigitalOcean.
    expect(validate.spec.default).toBe("digitalocean");
    expect(validate.spec.default).toBe(validate.defaultComputeProvider);
    expect("nameRules" in validate.spec).toBe(false);
  });

  test("compute provider must be one the package has a template for", () => {
    // The registry is the only list; a provider accepted here with no template
    // directory would fail at render time instead of at validation.
    expect(validate.stateErrors(fixture({ "provider-compute": "vultr" })))
      .toContain(":provider-compute must be one of digitalocean");
  });

  test("keys of an unselected provider are ignored", () => {
    expect(validate.stateErrors(fixture({ "vultr-region": "ams", "vultr-os-id": "ubuntu" }))).toEqual([]);
  });

  test("name and machine key are never required", () => {
    // `digitalocean-name` is an optional override of the profile and
    // `digitalocean-ssh-keys` is meaningful by its absence, so neither may be
    // in the registry's required list -- a required machine key would make
    // keygen mode unreachable.
    for (const entry of Object.values(validate.computeProviders)) {
      for (const key of entry.required) {
        expect(key.endsWith("-name")).toBe(false);
        expect(key.endsWith("-ssh-keys")).toBe(false);
      }
    }
    expect(validate.stateErrors(fixture({ "digitalocean-name": null, "digitalocean-ssh-keys": null }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "digitalocean-size": null }))
      .some((e) => e.includes("digitalocean-size"))).toBe(true);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(keygen())).toBe(true);
    expect(validate.keygen(fixture())).toBe(false);
    // Absence, not a flag, is the switch.
    expect(validate.keygen(fixture({ "digitalocean-ssh-keys": null }))).toBe(true);
  });

  test("compute name falls back to the profile", () => {
    expect(validate.computeName(fixture())).toBe("restate-fixture");
    expect(validate.computeName(keygen())).toBe("restate-keygen-fixture");
    expect(validate.computeName(fixture({ "digitalocean-name": "custom" }))).toBe("custom");
    expect(validate.computeKey(fixture(), "ssh-sources")).toBe("digitalocean-ssh-sources");
  });

  test("a name override is validated against the provider's rules", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-name": "Not Valid!" }))
      .some((e) => e.includes(":digitalocean-name must be a hostname-like name"))).toBe(true);
  });

  test("ssh sources must not be empty; no public HTTP is fine", () => {
    // A machine nobody can reach is not a deployment; an empty HTTP list is
    // simply no public HTTP.
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })))
      .toContain(":digitalocean-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": [] }))).toEqual([]);
  });

  test("malformed sources are refused before any provider call", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": ["203.0.113.0"] })))
      .toContain(':digitalocean-http-sources entry "203.0.113.0" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": ["0.0.0.0/0", "nope"] })))
      .toContain(':digitalocean-ssh-sources entry "nope" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": ["2001:db8::/32", "203.0.113.4/32"] })))
      .toEqual([]);
  });

  test("provider checks are scoped to the selected provider", () => {
    // DigitalOcean's VPC keys are refused on DigitalOcean, with the same
    // wording as before the delegation.
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-cidr": "10.0.0.0/16" })))
      .toContain(":digitalocean-vpc-cidr must be absent; this package must not create a VPC");
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "forbidden" })))
      .toContain(":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime");
  });

  test("compute credentials follow the provider", () => {
    expect(validate.tofuEnv(fixture(), "provider-compute"))
      .toEqual({ "do-token": "DIGITALOCEAN_TOKEN" });
    expect(validate.secretErrors(fixture()).join("\n")).toContain("COLORS_PAR_DO_TOKEN");
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

  test("compute keys follow the selected provider", () => {
    expect(String(tools.infrastructureData(fixture())["ssh-sources-hcl"])).toContain("0.0.0.0/0");
    expect(String(tools.infrastructureData(fixture())["http-sources-hcl"])).toContain("0.0.0.0/0");
  });

  test("infrastructure data carries the name and the keypair mode", () => {
    // One resolved name and one mode reach the template, so it never branches
    // on the provider or re-derives either.
    const optout = tools.infrastructureData(fixture());
    expect(optout["compute-name"]).toBe("restate-fixture");
    expect(optout["ssh-keygen"]).toBe(false);
    const generated = tools.infrastructureData(keygen());
    expect(generated["compute-name"]).toBe("restate-keygen-fixture");
    expect(generated["ssh-keygen"]).toBe(true);
    expect(tools.ansibleData(keygen())["ssh-keygen"]).toBe(true);
    expect(tools.ansibleData(fixture())["ssh-keygen"]).toBe(false);
  });

  test("the template lives under its provider directory", () => {
    // Providers are selected by directory (Compute Provider Standard §3); the
    // rendered target is still `<stage>/main.tf`.
    const [spec] = tools.infrastructureSpecs(fixture());
    expect((spec!.template as { name: string }).name).toBe("infrastructure/digitalocean/main.tf");
    expect(String(spec!.target)).toEndWith("restate-infrastructure/main.tf");
  });

  test("templates name the machine from one resolved value", () => {
    // Every label -- Droplet name, firewall name and params.name --
    // interpolates compute-name, never a provider key or the profile
    // directly, so an override and the fallback land everywhere at once.
    const template = resource("tools/infrastructure/digitalocean/main.tf");
    expect(template).not.toContain("<{ digitalocean-name }>");
    expect(template).toContain('name     = "<{ compute-name }>"');
    expect(template).toContain('name        = "<{ compute-name }>-firewall"');
    expect(template).toContain('name = "<{ compute-name }>"');
    expect(template).toContain('provider = "digitalocean"');
    const rendered = renderInfrastructure(fixture({ "digitalocean-name": "custom-label" }));
    expect(rendered).toContain('name     = "custom-label"');
    expect(rendered).toContain('name        = "custom-label-firewall"');
    expect(rendered).toContain('name = "custom-label"');
  });

  test("keygen mode declares the profile-named key; opt-out keeps the literal", () => {
    // SSH Keypair Standard §4.3: in keygen mode the template creates the
    // account key, named after the profile, and references it by attribute;
    // in opt-out mode it creates nothing and the historical literal survives.
    const generated = renderInfrastructure(keygen({
      "ssh-public-key-path": "/home/build-placeholder/.ssh/restate-keygen-fixture.pub" }));
    expect(generated).toContain('resource "digitalocean_ssh_key" "machine"');
    expect(generated).toContain('name       = "restate-keygen-fixture"');
    expect(generated).toContain("ssh_keys = [digitalocean_ssh_key.machine.id]");
    expect(generated).toContain("ssh_key_id = digitalocean_ssh_key.machine.id");
    const optout = renderInfrastructure(fixture());
    expect(optout).not.toContain("digitalocean_ssh_key");
    expect(optout).toContain('ssh_keys = ["58495393"]');
    expect(optout).not.toContain("ssh_key_id");
  });

  test("empty http sources render no public HTTP", () => {
    // An empty `digitalocean-http-sources` is allowed and means no public
    // HTTP: the 80/443 rules are a dynamic block over an empty list, because
    // a DigitalOcean rule with no source is an API error, not a closed port.
    // SSH stays.
    const empty = renderInfrastructure(fixture({ "digitalocean-http-sources": [] }));
    expect(empty).toContain("length([]) > 0 ? [");
    expect(empty).toContain("source_addresses = []");
    expect(empty).toContain('port_range       = "22"');
    expect(empty).not.toContain('port_range       = "80"');
    const full = renderInfrastructure(fixture());
    expect(full).toContain('length(["0.0.0.0/0", "::/0"]) > 0 ? [');
    expect(full).toContain('{ protocol = "tcp", port_range = "443" }');
    // TCP 80 and 443, and nothing else.
    expect(full).not.toContain('udp", port_range = "443"');
  });

  test("ansible.cfg names the private key only in keygen mode", () => {
    const render = (opts: Opts) =>
      renderTemplate(tools.template("ansible", "ansible.cfg"), tools.ansibleData(opts), tools.templateOpts);
    expect(render(keygen({ "ssh-private-key-path": "/k" }))).toContain("private_key_file = /k");
    expect(render(fixture())).not.toContain("private_key_file");
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

  test("delete cleanup skips when state has no compute", async () => {
    // With the Droplet already gone the inventory would render 192.0.2.10;
    // there is no host to reach, so the step must not run the playbook and
    // the teardown must continue past it.
    const result = await tools.ansibleStep(fixture({ "red/event": "delete" }),
      () => { throw new Error("playbook must not run"); });
    expect(result["red/exit"]).toBe(0);
    expect(result["restate/cleanup"]).toBe("skipped-no-compute");
  });

  test("delete cleanup targets the adopted address", async () => {
    // When the start step recovered the Droplet address from state, the
    // cleanup playbook runs against it, never the documentation fallback.
    const result = await tools.ansibleStep(
      fixture({ "red/event": "delete", ip: "203.0.113.7" }),
      async (opts) => ({ ...opts, "red/exit": 0, "ran-against": opts.ip }));
    expect(result["ran-against"]).toBe("203.0.113.7");
  });

  test("a missing compute output fails loudly", () => {
    // The documentation address belongs to build and dry-run. Merging it into
    // a real converge would point Ansible at TEST-NET instead of failing.
    // ONCE's `resolvedCompute`, wired by `infrastructureStep`.
    expect(tools.resolvedCompute({}, { ip: "192.0.2.10" }, { ip: "1.2.3.4" }).ip).toBe("1.2.3.4");
    expect(tools.resolvedCompute({}, { ip: "192.0.2.10" }, undefined)["red/exit"]).toBe(1);
    expect(String(tools.resolvedCompute({}, { ip: "192.0.2.10" }, {})["red/err"]))
      .toContain("compute produced no ip output; refusing to converge against the documentation address");
    expect(tools.resolvedCompute({}, { ip: "192.0.2.10" }, { ip: "5.6.7.8" })["red/exit"]).toBeUndefined();
  });

  test("fallback params carry the provider and the resolved name", () => {
    expect(tools.fallbackParams(keygen())).toEqual({
      provider: "digitalocean", ip: "192.0.2.10", user: "root", sudoer: "root",
      name: "restate-keygen-fixture",
    });
  });

  test("the acceptance reboot threads the identity args", () => {
    // In keygen mode nothing guarantees an agent holds the key, so the reboot
    // ssh must select it explicitly.
    expect(source).toContain("...ssh.identityArgs(opts), `root@${opts.ip}`, \"systemctl reboot\"");
  });
});

// --- ssh ---------------------------------------------------------------------

describe("ssh", () => {
  // The matrix itself is ONCE's and tested there; these prove the delegation
  // with this package's fixtures: absence of `digitalocean-ssh-keys` selects
  // keygen, a build renders the placeholder path and never names $HOME,
  // opt-out passes through untouched, and the create matrix, the preflight
  // and the cleanup reach ONCE.
  test("build renders a stable placeholder path", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "build" }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    expect(opts["digitalocean-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect(String(opts["ssh-private-key-path"])).not.toContain(home);
    const optedOut = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(optedOut["digitalocean-ssh-keys"]).toBe("58495393");
    expect(optedOut["ssh-public-key-path"]).toBeUndefined();
  });

  test("a dry-run renders the placeholder too", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create", "red/dry-run": true }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
  });

  test("real events render the real path", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(opts["ssh-private-key-path"]).toBe(join(home, ".ssh", "restate-keygen-fixture"));
    expect(opts["ssh-public-key-path"]).toBe(join(home, ".ssh", "restate-keygen-fixture.pub"));
  });

  test("opt-out passes through untouched", () => {
    for (const event of ["build", "create", "delete"]) {
      const opts = ssh.withMachineKey(fixture({ "red/event": event }));
      expect(opts["digitalocean-ssh-keys"]).toBe("58495393");
      expect(opts["ssh-public-key-path"]).toBeUndefined();
      expect(opts["ssh-keygen"]).toBeUndefined();
    }
  });

  test("identity args select the generated key only in keygen mode", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(ssh.identityArgs(opts)).toEqual(["-o", "IdentitiesOnly=yes", "-i", String(opts["ssh-private-key-path"])]);
    expect(ssh.identityArgs(ssh.withMachineKey(fixture({ "red/event": "create" })))).toEqual([]);
  });

  test("first create generates the keypair", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    const prv = join(home, ".ssh", "restate-keygen-fixture");
    const pub = `${prv}.pub`;
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(prv)).toBe(true);
    expect(existsSync(pub)).toBe(true);
    // ed25519, no passphrase, profile-named comment
    expect(readFileSync(pub, "utf8")).toContain("ssh-ed25519");
    expect(readFileSync(pub, "utf8")).toContain("restate-keygen-fixture managed by Colors");
    // 600 on the private key, 700 on ~/.ssh
    expect(statSync(prv).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  test("a key without state is never overwritten", async () => {
    const prv = join(home, ".ssh", "restate-keygen-fixture");
    write(prv, "irreplaceable");
    write(`${prv}.pub`, "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("no compute state is readable");
    expect(String(opts["red/err"])).toContain("survives");
    expect(readFileSync(prv, "utf8")).toBe("irreplaceable");
  });

  test("state without a key is an error", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }),
      async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("does not hold the machine key");
  });

  test("opt-out generates nothing", async () => {
    const result = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(result["red/err"]).toBeUndefined();
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  test("preflight lists keys with the DigitalOcean token", async () => {
    // ONCE selects the REST API and the token by provider; this proves the
    // delegation hands DigitalOcean its own credential.
    const seen: Array<[string, string]> = [];
    const capture = async (provider: string, token: string) => { seen.push([provider, token]); return []; };
    await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create", "do-token": "do-secret" })), capture);
    expect(seen).toEqual([["digitalocean", "do-secret"]]);
  });

  test("preflight refuses a foreign key and says do not delete it", async () => {
    write(join(home, ".ssh", "restate-keygen-fixture.pub"), "ssh-ed25519 OURS comment");
    const opts = await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create" })),
      async () => [{ id: "abc", name: "restate-keygen-fixture", public: "ssh-ed25519 THEIRS" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("Do not delete it");
  });

  test("preflight is skipped in opt-out mode", async () => {
    const opts = await ssh.preflight(fixture({ "red/event": "create" }),
      async () => { throw new Error("must not be called"); });
    expect(opts["red/err"]).toBeUndefined();
  });

  test("delete removes the keypair; ~/.ssh itself survives", () => {
    write(join(home, ".ssh", "restate-keygen-fixture"), "private");
    write(join(home, ".ssh", "restate-keygen-fixture.pub"), "public");
    ssh.cleanupStep(keygen({ "red/event": "delete", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "restate-keygen-fixture"))).toBe(false);
    expect(existsSync(join(home, ".ssh", "restate-keygen-fixture.pub"))).toBe(false);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
  });

  test("cleanup is inert on create and in opt-out mode", () => {
    write(join(home, ".ssh", "restate-keygen-fixture"), "private");
    ssh.cleanupStep(keygen({ "red/event": "create", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "restate-keygen-fixture"))).toBe(true);
    ssh.cleanupStep(fixture({ "red/event": "delete" }));
    expect(existsSync(join(home, ".ssh", "restate-keygen-fixture"))).toBe(true);
  });
});

// --- ssh-config --------------------------------------------------------------

describe("ssh-config", () => {
  const configFile = () => join(home, ".ssh", "config");

  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("restate-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/restate-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone, and owned-markers holds only it", () => {
    expect(sshConfig.beginMarker("restate-digitalocean")).toBe("# BEGIN restate-digitalocean ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("restate-digitalocean")).toBe("# END restate-digitalocean ANSIBLE MANAGED BLOCK");
    // Born conforming: no marker migration is in flight.
    const owned = sshConfig.ownedMarkers("restate-digitalocean");
    expect([...owned.begin]).toEqual(["# BEGIN restate-digitalocean ANSIBLE MANAGED BLOCK"]);
    expect([...owned.end]).toEqual(["# END restate-digitalocean ANSIBLE MANAGED BLOCK"]);
  });

  test("host patterns are read from a Host line", () => {
    expect(sshConfig.hostPatterns("Host restate-fixture")).toEqual(["restate-fixture"]);
    expect(sshConfig.hostPatterns("  host   web restate-fixture  db ")).toEqual(["web", "restate-fixture", "db"]);
    expect(sshConfig.hostPatterns("    HostName 192.0.2.1")).toBeUndefined();
    expect(sshConfig.hostPatterns("Match host restate-fixture")).toBeUndefined();
  });

  test("a foreign stanza is found; our own block is not foreign", () => {
    expect(sshConfig.foreignStanzaLine(
      ["Host other", "    HostName 192.0.2.1", "", "Host restate-fixture"],
      "restate-fixture")).toBe(4);
    const alias = "restate-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1",
       sshConfig.endMarker(alias)], alias)).toBeUndefined();
  });

  test("a stanza after our block is still foreign", () => {
    const alias = "restate-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias),
       `Host ${alias}`], alias)).toBe(4);
  });

  test("a block under a package-prefixed marker is foreign", () => {
    // This package never wrote a `# BEGIN restate <alias>` marker, so a block
    // carrying one belongs to nobody this package knows.
    const alias = "restate-digitalocean";
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN restate ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`,
       `# END restate ${alias} ANSIBLE MANAGED BLOCK`], alias)).toBe(2);
  });

  test("multi-pattern host lines count; unrelated files are left alone", () => {
    expect(sshConfig.foreignStanzaLine(["Host web restate-fixture db"], "restate-fixture")).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host restate-other"], "restate-fixture"))
      .toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt error names the file and the line; our own block and a missing file pass", () => {
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
    write(configFile(), "Host other\n    HostName 192.0.2.1\n\nHost restate-fixture\n    User root\n");
    const error = String(sshConfig.adoptError(fixture()));
    expect(error).toContain(configFile());
    expect(error).toContain("`Host restate-fixture` at line 4");
    expect(error).toContain("will not overwrite it");
    const alias = "restate-fixture";
    write(configFile(), `${sshConfig.beginMarker(alias)}\nHost ${alias}\n    HostName 192.0.2.1\n${sshConfig.endMarker(alias)}\n`);
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
  });

  test("placement error names the file and the line and mentions the recovery", () => {
    write(configFile(), "# comment\n\n\nIdentitiesOnly yes\nHost a\n");
    const error = String(sshConfig.placementError(fixture()));
    expect(error).toContain(configFile());
    expect(error).toContain("line 4");
    expect(error).toContain("Host *");
  });

  test("preflight reads the redirected file end to end", () => {
    write(configFile(), "Host restate-fixture\n    HostName 192.0.2.1\n");
    const refused = sshConfig.preflight(fixture());
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    write(configFile(), "ServerAliveInterval 60\nHost a\n");
    const placed = sshConfig.preflight(fixture());
    expect(placed["red/exit"]).toBe(1);
    expect(String(placed["red/err"])).toContain("line 1");
    write(configFile(), "Host a\n    User root\n");
    expect(sshConfig.preflight(fixture())["red/exit"]).toBeUndefined();
  });

  test("build and dry-run never read the config", async () => {
    // The only readers are adoptError and placementError; a real create is
    // the one event that reaches them. A leading-option file that would
    // refuse a real create must not disturb a build or a dry-run.
    write(configFile(), "ServerAliveInterval 60\nHost restate-fixture\n");
    for (const opts of [fixture({ "red/event": "build" }),
                        keygen({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true })]) {
      expect((await workflow.startStep(opts, {}))["red/exit"]).toBe(0);
    }
  });

  test("the local play renders no address and follows keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/restate-fixture");
    expect(data["ssh-keygen"]).toBe(false);
    expect(tools.ansibleLocalData(keygen())["ssh-keygen"]).toBe(true);
  });

  test("the local stage renders three files", () => {
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("restate-ansible-local"))).toBe(true);
  });

  test("the rendered play carries the IdentityFile pair only in keygen mode", () => {
    const render = (opts: Opts) =>
      renderTemplate(tools.template("ansible-local", "main.yml"), tools.ansibleLocalData(opts), tools.templateOpts);
    const keygenPlay = render(keygen());
    expect(keygenPlay).toContain("IdentityFile ~/.ssh/restate-keygen-fixture");
    expect(keygenPlay).toContain("IdentitiesOnly yes");
    // The header comment names the pair; the rendered option lines must not.
    const optoutPlay = render(fixture());
    expect(optoutPlay).not.toContain("IdentityFile ~/.ssh/");
    expect(optoutPlay).not.toContain("IdentitiesOnly yes");
    // Address, user and alias are Ansible's, never Selmer's.
    for (const play of [keygenPlay, optoutPlay]) {
      expect(play).toContain("insertbefore: BOF");
      expect(play).toContain("HostName {{ ip }}");
      expect(play).toContain("Host {{ host_alias }}");
      expect(play).toContain("StrictHostKeyChecking accept-new");
      expect(play).not.toMatch(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
    }
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  // The compute state is read once per run, through the injectable reader,
  // on a real create or delete. Every lifecycle test stubs it: undefined is a
  // readable state holding no compute, a map is a recorded `params`, and a
  // throw is a backend that cannot be read.
  const start = (opts: Opts, state: Record<string, unknown> | undefined) =>
    workflow.startStep(opts, {}, async () => state);
  // The shape `red/tofu` throws: the SDK's StepError. Only that is an
  // unreadable backend; anything else propagates as a defect.
  const startUnreadable = (opts: Opts, message = "tofu output failed: no backend") =>
    workflow.startStep(opts, {}, async () => { throw new StepError(message); });
  const credentials = { "do-token": "d", "cloudflare-api-token": "c",
    "r2-access-key-id": "a", "r2-secret-access-key": "s",
    "restate-backup-r2-access-key-id": "k", "restate-backup-r2-secret-access-key": "s" };

  test("build and dry-run need no credentials", async () => {
    expect((await workflow.startStep(fixture({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {}))["red/exit"]).toBe(0);
  });

  test("build and dry-run never touch ~/.ssh or the state", async () => {
    // The standard forbids reading, creating, or requiring anything under
    // ~/.ssh on a build or dry-run: they render from desired state alone. Nor
    // do they read the backend: a throwing reader proves nothing on these
    // paths reaches it.
    for (const opts of [keygen({ "red/event": "build" }),
                        keygen({ "red/event": "create", "red/dry-run": true }),
                        keygen({ "red/event": "delete", "red/dry-run": true })]) {
      const result = await startUnreadable(opts);
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("a real create requires credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY");
  });

  test("a real delete requires credentials", async () => {
    const result = await start(fixture({ "red/event": "delete", "compute-prevent-destroy": false }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("delete is protected", async () => {
    const result = await start(fixture({ "red/event": "delete" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
  });

  // --- provider switching is a rebuild, never an apply

  test("a provider switch is refused on create and delete", async () => {
    // The state records a provider this package never offered: the refusal
    // names it, before any credential for the selected provider is asked for.
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "vultr", ip: "203.0.113.9" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"]))
        .toContain("state holds a vultr machine; set provider-compute back to vultr and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(result["red/err"])).not.toContain("required credential is not set");
      expect(String(result["red/err"])).not.toContain("COLORS_PAR_DO_TOKEN");
    }
  });

  test("legacy state is accepted on the default provider", async () => {
    // A state recorded before this package wrote params.provider is a
    // DigitalOcean machine's -- restate-digitalocean's R2 state may hold one
    // -- and passes straight to the credential check.
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { ip: "203.0.113.9" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).not.toContain("state holds");
      expect(String(result["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), { provider: "digitalocean", ip: "203.0.113.9" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // A fresh clone has no readable state and must still be able to create.
    const result = await startUnreadable(fixture({ "red/event": "create" }));
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("could not read");
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. The SDK's output read
    // throws its StepError there, which ONCE's `readState` counts as an
    // unreadable state, so the create reports its credentials.
    const work = mkdtempSync(join(tmpdir(), "restate-red-fresh"));
    try {
      const result = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }), {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  // A fixture that passes real-delete preflight: guard lifted, secrets present.
  const deletableFixture = (overrides: Opts = {}) => fixture({
    "compute-prevent-destroy": false, ...credentials, ...overrides,
  });

  test("delete fails loudly when state is unreadable", async () => {
    // This package used to swallow every exception in `stateOutput` and merge
    // `?? {}`: a stale backend credential would have pointed the cleanup
    // playbook at 192.0.2.10. The failure must surface here, before any
    // playbook runs, with the standard's wording.
    const result = await startUnreadable(deletableFixture({ "red/event": "delete" }), "Unauthorized");
    expect(result["red/exit"]).toBe(1);
    expect(String(result["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(result["red/err"])).toContain("Unauthorized");
  });

  test("delete has no address override", async () => {
    // ONCE's adoption applies no `ip` override and this package adds none:
    // the recorded address wins over anything already in opts, so nothing
    // can point a delete's cleanup at an arbitrary host.
    const adopted = await start(deletableFixture({ "red/event": "delete", ip: "203.0.113.7" }),
      { provider: "digitalocean", ip: "198.51.100.1", user: "root" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("198.51.100.1");
  });

  test("delete with empty state proceeds without an address", async () => {
    // State readable, no compute recorded: the Droplet is already gone, the
    // cleanup step skips itself, and the rest of the teardown still runs.
    const result = await start(deletableFixture({ "red/event": "delete" }), undefined);
    expect(result["red/exit"]).toBe(0);
    expect(result.ip).toBeUndefined();
  });

  test("a real delete adopts the recorded address", async () => {
    const adopted = await start(deletableFixture({ "red/event": "delete" }),
      { provider: "digitalocean", ip: "203.0.113.9", user: "root" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("203.0.113.9");
  });

  test("the graph orders the private stack", () => {
    const next = (step: string, event: string) =>
      (workflow.wireFn(step, { "red/event": event }) ?? []).slice(1);
    expect(next("restate/start", "create")).toEqual(["restate/infrastructure"]);
    expect(next("restate/infrastructure", "create")).toEqual(["restate/ssh-config"]);
    expect(next("restate/ssh-config", "create")).toEqual(["restate/dns"]);
    expect(next("restate/dns", "create")).toEqual(["restate/ansible"]);
    expect(next("restate/ansible", "create")).toEqual(["restate/acceptance"]);
    expect(next("restate/start", "delete")).toEqual(["restate/ansible"]);
  });

  test("delete removes the config block before the destroy", () => {
    // The opposite of the keypair below: a block that outlives its host is
    // stale but harmless, so removing it early costs nothing.
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("restate/ansible")).toEqual(["restate/dns"]);
    expect(next("restate/dns")).toEqual(["restate/ssh-config"]);
    expect(next("restate/ssh-config")).toEqual(["restate/infrastructure"]);
    expect(workflow.sideEffecting).toContain("restate/ssh-config");
  });

  test("delete removes the key after the compute destroy", () => {
    // The ordering is what makes "key present <=> deployment exists" hold: a
    // failed destroy never reaches the cleanup step, and correctly leaves the
    // key that is still the only credential to whatever survived.
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("restate/infrastructure")).toEqual(["restate/ssh-cleanup"]);
    expect(next("restate/ssh-cleanup")).toEqual([]);
    expect(workflow.sideEffecting).toContain("restate/ssh-cleanup");
  });
});
