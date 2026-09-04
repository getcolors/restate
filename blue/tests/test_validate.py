from conftest import fixture, keygen
from package_restate_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_keygen_fixture_is_valid():
    assert validate.state_errors(keygen()) == []


# --- the spec handed to ONCE


def test_the_spec_carries_this_packages_registry_sources_and_default():
    # The operations are ONCE's; this is the data they run over. A colour
    # whose registry, sources or default drifts fails here, in that colour.
    assert set(validate.spec["registry"]) == {"digitalocean"}
    assert validate.spec["registry"] is validate.compute_providers
    assert validate.spec["registry"]["digitalocean"] == {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    }
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources"],
                                        "may_be_empty": ["http-sources"]}
    # The default is what a legacy state without params.provider is, and the
    # only provider this package ever offered is DigitalOcean.
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["default"] == validate.default_compute_provider
    assert "name_rules" not in validate.spec, "the name rules are ONCE's"


# --- the compute-provider registry


def test_compute_provider_must_be_one_the_package_has_a_template_for():
    # The registry is the only list; a provider accepted here with no template
    # directory would fail at render time instead of at validation.
    errors = validate.state_errors(fixture({"provider-compute": "vultr"}))
    assert ":provider-compute must be one of digitalocean" in errors


def test_keys_of_an_unselected_provider_are_ignored():
    assert validate.state_errors(fixture({"vultr-region": "ams", "vultr-os-id": "ubuntu"})) == []


def test_name_and_machine_key_are_never_required():
    # `digitalocean-name` is an optional override of the profile and
    # `digitalocean-ssh-keys` is meaningful by its absence, so neither may be
    # in the registry's required list -- a required machine key would make
    # keygen mode unreachable.
    for entry in validate.compute_providers.values():
        for key in entry["required"]:
            assert not key.endswith("-name"), key
            assert not key.endswith("-ssh-keys"), key
    assert validate.state_errors(
        fixture({"digitalocean-name": None, "digitalocean-ssh-keys": None})) == []
    assert any("digitalocean-size" in e
               for e in validate.state_errors(fixture({"digitalocean-size": None})))


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(keygen())
    assert not validate.keygen(fixture())
    # Absence, not a flag, is the switch.
    assert validate.keygen(fixture({"digitalocean-ssh-keys": None}))


def test_compute_name_falls_back_to_the_profile():
    assert validate.compute_name(fixture()) == "restate-fixture"
    assert validate.compute_name(keygen()) == "restate-keygen-fixture"
    assert validate.compute_name(fixture({"digitalocean-name": "custom"})) == "custom"
    assert validate.compute_key(fixture(), "ssh-sources") == "digitalocean-ssh-sources"


def test_a_name_override_is_validated_against_the_providers_rules():
    assert any(":digitalocean-name must be a hostname-like name" in e
               for e in validate.state_errors(fixture({"digitalocean-name": "Not Valid!"})))


def test_compute_credentials_follow_the_provider():
    assert validate.tofu_env(fixture(), "provider-compute") == \
        {"do-token": "DIGITALOCEAN_TOKEN"}
    assert "COLORS_PAR_DO_TOKEN" in "\n".join(validate.secret_errors(fixture()))


# --- the network contract, wired through state_errors with ONCE's messages


def test_ssh_sources_must_not_be_empty():
    # A machine nobody can reach is not a deployment; an empty HTTP list is
    # simply no public HTTP.
    assert ":digitalocean-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": []}))
    assert validate.state_errors(fixture({"digitalocean-http-sources": []})) == []


def test_malformed_sources_are_refused_before_any_provider_call():
    assert ':digitalocean-http-sources entry "203.0.113.0" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-http-sources": ["203.0.113.0"]}))
    assert ':digitalocean-ssh-sources entry "nope" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": ["0.0.0.0/0", "nope"]}))
    assert validate.state_errors(
        fixture({"digitalocean-ssh-sources": ["2001:db8::/32", "203.0.113.4/32"]})) == []


# --- provider checks run only for the selected provider


def test_provider_checks_are_scoped_to_the_selected_provider():
    # DigitalOcean's VPC keys are refused on DigitalOcean, with the same
    # wording as before the delegation.
    assert ":digitalocean-vpc-cidr must be absent; this package must not create a VPC" in \
        validate.state_errors(fixture({"digitalocean-vpc-cidr": "10.0.0.0/16"}))
    assert (":digitalocean-vpc-uuid must be absent; "
            "the default regional VPC is discovered at runtime") in \
        validate.state_errors(fixture({"digitalocean-vpc-uuid": "forbidden"}))


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
