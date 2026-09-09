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
import * as compute from "../src/compute.ts";
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

const resource = (name: string) =>
  readFileSync(join(import.meta.dir, "../resources", name), "utf8");
const source = readFileSync(join(import.meta.dir, "../src/tools.ts"), "utf8");

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(keygen())).toEqual([]);
  });





  test("keys of an unselected provider are ignored", () => {
    expect(validate.stateErrors(fixture({ "vultr-region": "ams", "vultr-os-id": "ubuntu" }))).toEqual([]);
  });



  test("absent machine key selects keygen", () => {
    expect(validate.keygen(keygen())).toBe(true);
    expect(validate.keygen(fixture())).toBe(false);
    // Absence, not a flag, is the switch.
    expect(validate.keygen(fixture({ "digitalocean-ssh-keys": null }))).toBe(true);
  });



  test("a name override is validated against the provider's rules", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-name": "Not Valid!" }))
      .some((e) => e.includes("invalid compute deployment requirements"))).toBe(true);
  });









  test("reports all errors at once", () => {
    const errors = validate.stateErrors(fixture({
      "restate-host": "bad", "restate-image": "floating",
      "reference-app-delay-seconds": -1,
      "provider-dns": "other", "digitalocean-vpc-uuid": "forbidden",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const part of ["host", "image", "delay", "provider-dns", "compute deployment"]) {
      expect(errors.some((e) => e.includes(part))).toBe(true);
    }
  });



  test("profile overlay is refused", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBe(1);
    expect(validate.envErrors({})).toEqual([]);
  });


});

// --- tools -------------------------------------------------------------------

describe("tools", () => {














  test("ansible.cfg names the private key only in keygen mode", () => {
    const render = (opts: Opts) =>
      renderTemplate(tools.template("ansible", "ansible.cfg"), tools.ansibleData(opts), tools.templateOpts);
    expect(render(keygen({ "ssh-private-key-path": "/k" }))).toContain("private_key_file = /k");
    expect(render(fixture())).toContain("private_key_file = /home/build-placeholder/.ssh/operator-key");
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
    expect(result["red/exit"]).toBe(1);
    expect(result["red/err"]).toBe("compute node unavailable");
  });

  test("delete cleanup targets the adopted address", async () => {
    // When the start step recovered the Droplet address from state, the
    // cleanup playbook runs against it, never the documentation fallback.
    const result = await tools.ansibleStep(
      fixture({ "red/event": "delete", ip: "203.0.113.7", user:"root" }),
      async (opts) => ({ ...opts, "red/exit": 0, "ran-against": opts.ip }));
    expect(result["ran-against"]).toBe("203.0.113.7");
  });






});

// --- ssh ---------------------------------------------------------------------

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
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7", user:"root" }));
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


});

// --- workflow ----------------------------------------------------------------

describe("library compute", () => {
  test("all fixtures validate and use one library node", () => {
    for(const f of [keygen,fixture]) expect(validate.stateErrors(f())).toEqual([]);
    expect(compute.topology).toEqual([{role:null,count:1}]);
    expect(compute.requirements(keygen()).legacy_state_keys).toEqual(['restate-keygen-fixture/restate-infrastructure.tfstate']);
  });
  test("invalid compute inputs fail before execution", () => {
    for(const update of [{'provider-compute':'unsupported'},{'digitalocean-size':null},{'digitalocean-ssh-sources':[]},{'digitalocean-http-sources':['bad']}]) expect(validate.stateErrors(keygen(update)).length).toBeGreaterThan(0);
  });
  test("compute credentials are deferred to library state inspection", () => {
    const errors=validate.secretErrors(keygen()).join('\n');
    expect(errors).toContain('COLORS_PAR_CLOUDFLARE_API_TOKEN');
    expect(errors).not.toContain('COLORS_PAR_VULTR_API_KEY');
    expect(validate.tofuEnv(keygen(),'provider-compute')).toEqual({});
  });
  test("failed lifecycle diagnostics and observed node identity survive", () => {
    expect(compute.attach(keygen(),{status:'error',errors:['legacy compute state requires migration']})['red/err']).toBe('legacy compute state requires migration');
    const result=compute.attach(keygen(),{status:'present',cluster:{nodes:[{ip:'203.0.113.7',user:'ubuntu'}]},key:{private_key_path:'/tmp/explicit'}});
    expect(result.user).toBe('ubuntu');expect(result['ssh-private-key-path']).toBe('/tmp/explicit');
    expect(compute.attach(keygen(),{status:'destroyed'})['restate/already-destroyed']).toBe(true);
    expect(()=>compute.node({cluster:{nodes:[]}})).toThrow();
  });
  test("offline start needs no credentials", async()=> {
    for(const f of [keygen,fixture]) expect((await workflow.startStep(f({'red/event':'build'}),{}))['red/exit']).toBe(0);
  });
  test("managed build and external SSH identities are deterministic",()=> {
    expect(ssh.withMachineKey(keygen({'red/event':'build'}))['ssh-private-key-path']).toBe('/home/build-placeholder/.ssh/restate-keygen-fixture');
    expect(ssh.withMachineKey(fixture({'red/event':'build'}))).toEqual(fixture({'red/event':'build'}));
    expect(ssh.identityArgs(fixture())[1]).toBe('/home/build-placeholder/.ssh/operator-key');
  });
});

test('managed identity only in the local SSH block',()=>{
 const render=(opts:Opts)=>renderTemplate(tools.template('ansible-local','main.yml'),tools.ansibleLocalData(opts),tools.templateOpts);
 expect(render(keygen())).toContain('colors_keygen: true');expect(render(fixture())).toContain('colors_keygen: false');expect(render(fixture())).toContain('fcntl.flock');
});
