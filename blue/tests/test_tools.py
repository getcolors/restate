from pathlib import Path

from blue.scaffold import render_template
from conftest import fixture, keygen
from package_restate_blue import tools

RESOURCES = Path(tools.__file__).parent / "resources"
SOURCE = Path(tools.__file__).read_text()


def resource(name: str) -> str:
    return (RESOURCES / name).read_text()


def render_infrastructure(opts: dict) -> str:
    """The compute template for `opts`' provider, rendered as `build` would."""
    return render_template(
        tools.template(f"infrastructure.{opts.get('provider-compute')}", "main.tf"),
        tools.infrastructure_data(opts), tools.template_opts)


def test_infrastructure_discovers_default_vpc():
    data = tools.infrastructure_data(fixture())
    assert tools.cidrs(data, "digitalocean-http-sources") == ["0.0.0.0/0", "::/0"]


def test_compute_keys_follow_the_selected_provider():
    assert "0.0.0.0/0" in tools.infrastructure_data(fixture())["ssh-sources-hcl"]
    assert "0.0.0.0/0" in tools.infrastructure_data(fixture())["http-sources-hcl"]


def test_infrastructure_data_carries_the_name_and_the_keypair_mode():
    # One resolved name and one mode reach the template, so it never branches
    # on the provider or re-derives either.
    optout = tools.infrastructure_data(fixture())
    assert optout["compute-name"] == "restate-fixture"
    assert optout["ssh-keygen"] is False
    generated = tools.infrastructure_data(keygen())
    assert generated["compute-name"] == "restate-keygen-fixture"
    assert generated["ssh-keygen"] is True
    assert tools.ansible_data(keygen())["ssh-keygen"] is True
    assert tools.ansible_data(fixture())["ssh-keygen"] is False


def test_the_template_lives_under_its_provider_directory():
    # Providers are selected by directory (Compute Provider Standard §3); the
    # rendered target is still `<stage>/main.tf`.
    [spec] = tools.infrastructure_specs(fixture())
    assert spec["template"]["name"] == "tools/infrastructure/digitalocean/main.tf"
    assert str(spec["target"]).endswith("restate-infrastructure/main.tf")


def test_templates_name_the_machine_from_one_resolved_value():
    # Every label -- Droplet name, firewall name and params.name --
    # interpolates compute-name, never a provider key or the profile
    # directly, so an override and the fallback land everywhere at once.
    template = resource("tools/infrastructure/digitalocean/main.tf")
    assert "<{ digitalocean-name }>" not in template
    assert 'name     = "<{ compute-name }>"' in template
    assert 'name        = "<{ compute-name }>-firewall"' in template
    assert 'name = "<{ compute-name }>"' in template
    assert 'provider = "digitalocean"' in template
    rendered = render_infrastructure(fixture({"digitalocean-name": "custom-label"}))
    assert 'name     = "custom-label"' in rendered
    assert 'name        = "custom-label-firewall"' in rendered
    assert 'name = "custom-label"' in rendered


def test_keygen_mode_declares_the_profile_named_key_and_opt_out_keeps_the_literal():
    # SSH Keypair Standard §4.3: in keygen mode the template creates the
    # account key, named after the profile, and references it by attribute;
    # in opt-out mode it creates nothing and the historical literal survives.
    generated = render_infrastructure(keygen(
        {"ssh-public-key-path": "/home/build-placeholder/.ssh/restate-keygen-fixture.pub"}))
    assert 'resource "digitalocean_ssh_key" "machine"' in generated
    assert 'name       = "restate-keygen-fixture"' in generated
    assert "ssh_keys = [digitalocean_ssh_key.machine.id]" in generated
    assert "ssh_key_id = digitalocean_ssh_key.machine.id" in generated
    optout = render_infrastructure(fixture())
    assert "digitalocean_ssh_key" not in optout
    assert 'ssh_keys = ["58495393"]' in optout
    assert "ssh_key_id" not in optout


def test_empty_http_sources_renders_no_public_http():
    # An empty `digitalocean-http-sources` is allowed and means no public
    # HTTP: the 80/443 rules are a dynamic block over an empty list, because
    # a DigitalOcean rule with no source is an API error, not a closed port.
    # SSH stays.
    empty = render_infrastructure(fixture({"digitalocean-http-sources": []}))
    assert "length([]) > 0 ? [" in empty
    assert "source_addresses = []" in empty
    assert 'port_range       = "22"' in empty
    assert 'port_range       = "80"' not in empty
    full = render_infrastructure(fixture())
    assert 'length(["0.0.0.0/0", "::/0"]) > 0 ? [' in full
    assert '{ protocol = "tcp", port_range = "443" }' in full
    # TCP 80 and 443, and nothing else.
    assert 'udp", port_range = "443"' not in full


def test_ansible_cfg_names_the_private_key_only_in_keygen_mode():
    def render(opts):
        return render_template(tools.template("ansible", "ansible.cfg"),
                               tools.ansible_data(opts), tools.template_opts)
    assert "private_key_file = /k" in render(keygen({"ssh-private-key-path": "/k"}))
    assert "private_key_file" not in render(fixture())


def test_dns_is_apex_and_proxied():
    json_text = tools.dns_json({**fixture(), "ip": "192.0.2.10"})
    assert "restate.example.com" in json_text
    assert "192.0.2.10" in json_text
    assert "proxied" in json_text


def test_inventory_keeps_one_private_target():
    inventory = tools.inventory({**fixture(), "ip": "192.0.2.10"})
    assert "192.0.2.10" in inventory
    assert "restate-fixture" in inventory


async def test_delete_cleanup_skips_when_state_has_no_compute(monkeypatch):
    # With the Droplet already gone the inventory would render 192.0.2.10;
    # there is no host to reach, so the step must not run the playbook and
    # the teardown must continue past it.
    def boom(*_args, **_kwargs):
        raise AssertionError("playbook must not run")
    monkeypatch.setattr(tools, "ansible_with_spec", boom)
    result = await tools.ansible_step({**fixture(), "blue/event": "delete"})
    assert result["blue/exit"] == 0
    assert result["restate/cleanup"] == "skipped-no-compute"


async def test_delete_cleanup_targets_the_adopted_address(monkeypatch):
    # When the start step recovered the Droplet address from state, the
    # cleanup playbook runs against it, never the documentation fallback.
    async def fake(opts, _specs, **_kwargs):
        return {**opts, "blue/exit": 0, "ran-against": opts.get("ip")}
    monkeypatch.setattr(tools, "ansible_with_spec", fake)
    result = await tools.ansible_step(
        {**fixture(), "blue/event": "delete", "ip": "203.0.113.7"})
    assert result["ran-against"] == "203.0.113.7"


def test_a_missing_compute_output_fails_loudly():
    # The documentation address belongs to build and dry-run. Merging it into
    # a real converge would point Ansible at TEST-NET instead of failing.
    # ONCE's `resolved_compute`, wired by `infrastructure_step`.
    assert tools.resolved_compute({}, {"ip": "192.0.2.10"}, {"ip": "1.2.3.4"})["ip"] \
        == "1.2.3.4"
    assert tools.resolved_compute({}, {"ip": "192.0.2.10"}, None)["blue/exit"] == 1
    assert ("compute produced no ip output; refusing to converge against the "
            "documentation address") in tools.resolved_compute({}, {"ip": "192.0.2.10"}, {})["blue/err"]
    assert tools.resolved_compute(
        {}, {"ip": "192.0.2.10"}, {"ip": "5.6.7.8"}).get("blue/exit") is None


def test_fallback_params_carry_the_provider_and_the_resolved_name():
    assert tools.fallback_params(keygen()) == {
        "provider": "digitalocean", "ip": "192.0.2.10", "user": "root", "sudoer": "root",
        "name": "restate-keygen-fixture"}


def test_the_acceptance_reboot_threads_the_identity_args():
    # In keygen mode nothing guarantees an agent holds the key, so the reboot
    # ssh must select it explicitly.
    assert "*ssh.identity_args(opts), f\"root@{opts.get('ip')}\", \"systemctl reboot\"" in SOURCE
