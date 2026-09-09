from pathlib import Path

from blue.scaffold import render_template
from conftest import fixture, keygen
from package_restate_blue import tools

RESOURCES = Path(tools.__file__).parent / "resources"
SOURCE = Path(tools.__file__).read_text()


def resource(name: str) -> str:
    return (RESOURCES / name).read_text()


















def test_ansible_cfg_names_the_private_key_only_in_keygen_mode():
    def render(opts):
        return render_template(tools.template("ansible", "ansible.cfg"),
                               tools.ansible_data(opts), tools.template_opts)
    assert "private_key_file = /k" in render(keygen({"ssh-private-key-path": "/k"}))
    assert "private_key_file = /home/build-placeholder/.ssh/operator-key" in render(fixture())


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
    assert result["blue/exit"] == 1
    assert result["blue/err"] == "compute node unavailable"


async def test_delete_cleanup_targets_the_adopted_address(monkeypatch):
    # When the start step recovered the Droplet address from state, the
    # cleanup playbook runs against it, never the documentation fallback.
    async def fake(opts, _specs, **_kwargs):
        return {**opts, "blue/exit": 0, "ran-against": opts.get("ip")}
    monkeypatch.setattr(tools, "ansible_with_spec", fake)
    result = await tools.ansible_step(
        {**fixture(), "blue/event": "delete", "ip": "203.0.113.7", "user":"root"})
    assert result["ran-against"] == "203.0.113.7"







def test_library_node_identity_and_ingress():
    from package_restate_blue import compute
    node=tools.fallback_params(keygen())
    assert node['node_id']=='0' and node['vpc_ip'] is None and node['name']=='restate-keygen-fixture'
    assert len(compute.requirements(fixture({'restate-http-sources':[]}))['security']['ingress'])==1

async def test_acceptance_uses_owned_login_and_key_for_reboot(monkeypatch):
    from types import SimpleNamespace
    calls=[]
    async def healthy(*args): return True
    async def command(args,**kwargs):
        calls.append(args)
        return SimpleNamespace(exit=0,out='',err='')
    async def json_response(args,timeout):
        return ({'workflowId':'same'} if '-X' in args else {'status':'completed','result':{'activityAttempts':3,'result':49}},None)
    monkeypatch.setattr(tools,'wait_health',healthy)
    monkeypatch.setattr(tools,'run_json',json_response)
    monkeypatch.setattr(tools.runtime,'exec',command)
    result=await tools.acceptance_step({**keygen(),'blue/event':'create','ip':'203.0.113.7','user':'ubuntu','ssh-private-key-path':'/tmp/key'})
    assert result['blue/exit']==0
    assert calls[0][-2:] == ['ubuntu@203.0.113.7','sudo -n -- systemctl reboot']
    assert '/tmp/key' in calls[0]
