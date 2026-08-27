from conftest import fixture
from package_restate_blue import tools


def test_infrastructure_discovers_default_vpc():
    data = tools.infrastructure_data(fixture())
    assert tools.cidrs(data, "digitalocean-http-sources") == ["0.0.0.0/0", "::/0"]


def test_dns_is_apex_and_proxied():
    json_text = tools.dns_json({**fixture(), "ip": "192.0.2.10"})
    assert "restate.example.com" in json_text
    assert "192.0.2.10" in json_text
    assert "proxied" in json_text


def test_inventory_keeps_one_private_target():
    inventory = tools.inventory({**fixture(), "ip": "192.0.2.10"})
    assert "192.0.2.10" in inventory
    assert "restate-fixture" in inventory
