from conftest import fixture, keygen
from package_restate_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_keygen_fixture_is_valid():
    assert validate.state_errors(keygen()) == []


# --- the spec handed to ONCE




# --- the compute-provider registry




def test_keys_of_an_unselected_provider_are_ignored():
    assert validate.state_errors(fixture({"vultr-region": "ams", "vultr-os-id": "ubuntu"})) == []




def test_absent_machine_key_selects_keygen():
    assert validate.keygen(keygen())
    assert not validate.keygen(fixture())
    # Absence, not a flag, is the switch.
    assert validate.keygen(fixture({"digitalocean-ssh-keys": None}))




def test_a_name_override_is_validated_against_the_providers_rules():
    assert any("invalid compute deployment requirements" in e
               for e in validate.state_errors(fixture({"digitalocean-name": "Not Valid!"})))




# --- the network contract, wired through state_errors with ONCE's messages






# --- provider checks run only for the selected provider




def test_reports_all_errors():
    errors = validate.state_errors(fixture({
        "restate-host": "bad", "restate-image": "floating",
        "reference-app-delay-seconds": -1,
        "provider-dns": "other", "digitalocean-vpc-uuid": "forbidden"}))
    assert len(errors) >= 5
    for part in ["host", "image", "delay", "provider-dns", "compute deployment"]:
        assert any(part in e for e in errors), part




def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert not validate.env_errors({})
