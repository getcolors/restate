from conftest import fixture
from package_restate_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_reports_all_errors():
    errors = validate.state_errors(fixture({
        "restate-host": "bad", "restate-image": "floating",
        "reference-app-delay-seconds": -1,
        "provider-dns": "other", "digitalocean-vpc-uuid": "forbidden"}))
    assert len(errors) >= 5
    for part in ["host", "image", "delay", "provider-dns", "vpc-uuid"]:
        assert any(part in e for e in errors), part


def test_forbids_vpc_configuration():
    assert any("must be absent" in e for e in
               validate.state_errors(fixture({"digitalocean-vpc-cidr": "10.0.0.0/16"})))


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert not validate.env_errors({})


def test_names_all_package_secrets():
    errors = "\n".join(validate.secret_errors(fixture()))
    for name in ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY",
                 "COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID",
                 "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY"]:
        assert name in errors, name
