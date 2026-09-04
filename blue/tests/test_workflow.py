import pytest
from blue.workflow import StepError
from conftest import fixture, keygen
from package_restate_blue import workflow

# The compute state is read once per run, through `state_output`, on a real
# create or delete. Every lifecycle test stubs it: None is a readable state
# holding no compute, a dict is a recorded `params`, and a raise is a backend
# that cannot be read.

CREDENTIALS = {"do-token": "d", "cloudflare-api-token": "c",
               "r2-access-key-id": "a", "r2-secret-access-key": "s",
               "restate-backup-r2-access-key-id": "k",
               "restate-backup-r2-secret-access-key": "s"}


@pytest.fixture
def state(monkeypatch):
    def install(params):
        async def stub(_opts):
            return params
        monkeypatch.setattr(workflow, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    def install(message="tofu output failed: no backend"):
        async def boom(_opts):
            raise StepError(message)
        monkeypatch.setattr(workflow, "state_output", boom)
    install()
    return install


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Redirect `~/.ssh` for the paths that fill the real key paths."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


async def test_build_and_dry_run_need_no_credentials():
    result = await workflow.start_step({**fixture(), "blue/event": "build"}, env={})
    assert result["blue/exit"] == 0
    result = await workflow.start_step(
        {**fixture(), "blue/event": "create", "blue/dry-run": True}, env={})
    assert result["blue/exit"] == 0


async def test_build_and_dry_run_never_touch_ssh_or_state(unreadable):
    # The standard forbids reading, creating, or requiring anything under
    # ~/.ssh on a build or dry-run: they render from desired state alone. Nor
    # do they read the backend: a raising state read proves nothing on these
    # paths reaches it.
    for opts in [{**keygen(), "blue/event": "build"},
                 {**keygen(), "blue/event": "create", "blue/dry-run": True},
                 {**keygen(), "blue/event": "delete", "blue/dry-run": True}]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert str(result["ssh-public-key-path"]).startswith("/home/build-placeholder"), \
            "a build must not name the operator's home directory"


async def test_real_create_requires_credentials(state):
    state(None)
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY" in result["blue/err"]


async def test_real_delete_requires_credentials(state):
    state(None)
    result = await workflow.start_step(
        {**fixture(), "blue/event": "delete", "compute-prevent-destroy": False}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_delete_is_protected(state):
    state(None)
    result = await workflow.start_step({**fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in result["blue/err"]


# --- provider switching is a rebuild, never an apply


async def test_a_provider_switch_is_refused_on_create_and_delete(state):
    # The state records a provider this package never offered: the refusal
    # names it, before any credential for the selected provider is asked for.
    state({"provider": "vultr", "ip": "203.0.113.9"})
    for event in ["create", "delete"]:
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert result["blue/exit"] == 2, event
        assert ("state holds a vultr machine; set provider-compute back to vultr "
                "and delete first") in result["blue/err"]
        # The validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected.
        assert "required credential is not set" not in result["blue/err"]
        assert "COLORS_PAR_DO_TOKEN" not in result["blue/err"]


async def test_legacy_state_is_accepted_on_the_default_provider(state):
    # A state recorded before this package wrote params.provider is a
    # DigitalOcean machine's -- restate-digitalocean's R2 state may hold one
    # -- and passes straight to the credential check.
    state({"ip": "203.0.113.9"})
    for event in ["create", "delete"]:
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert result["blue/exit"] == 2, event
        assert "state holds" not in result["blue/err"], event
        assert "required credential is not set" in result["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state({"provider": "digitalocean", "ip": "203.0.113.9"})
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # A fresh clone has no readable state and must still be able to create.
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "could not read" not in result["blue/err"]
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # No state stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. The SDK's output read
    # raises its StepError there, which ONCE's `read_state` counts as an
    # unreadable state, so the create reports its credentials.
    result = await workflow.start_step(
        {**fixture(), "workdir": str(tmp_path), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


def deletable_fixture(overrides: dict | None = None) -> dict:
    """A fixture that passes real-delete preflight: guard lifted, secrets
    present."""
    return fixture({"compute-prevent-destroy": False, **CREDENTIALS, **(overrides or {})})


async def test_delete_fails_loudly_when_state_is_unreadable(unreadable):
    # This package used to swallow every exception in `state_output` and merge
    # `or {}`: a stale backend credential would have pointed the cleanup
    # playbook at 192.0.2.10. The failure must surface here, before any
    # playbook runs, with the standard's wording.
    unreadable("Unauthorized")
    result = await workflow.start_step(
        {**deletable_fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in result["blue/err"]
    assert "Unauthorized" in result["blue/err"]


async def test_delete_has_no_address_override(state, home):
    # ONCE's adoption applies no `ip` override and this package adds none:
    # the recorded address wins over anything already in opts, so nothing
    # can point a delete's cleanup at an arbitrary host.
    state({"provider": "digitalocean", "ip": "198.51.100.1", "user": "root"})
    adopted = await workflow.start_step(
        {**deletable_fixture(), "blue/event": "delete", "ip": "203.0.113.7"}, env={})
    assert adopted["blue/exit"] == 0
    assert adopted["ip"] == "198.51.100.1"


async def test_delete_with_empty_state_proceeds_without_an_address(state, home):
    # State readable, no compute recorded: the Droplet is already gone, the
    # cleanup step skips itself, and the rest of the teardown still runs.
    state(None)
    result = await workflow.start_step(
        {**deletable_fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 0
    assert result.get("ip") is None


async def test_a_real_delete_adopts_the_recorded_address(state, home):
    state({"provider": "digitalocean", "ip": "203.0.113.9", "user": "root"})
    adopted = await workflow.start_step(
        {**deletable_fixture(), "blue/event": "delete"}, env={})
    assert adopted["blue/exit"] == 0
    assert adopted["ip"] == "203.0.113.9"


def test_graph_orders_private_stack():
    create = {"blue/event": "create"}
    assert workflow.wire_fn("restate/start", create)[1:] == ("restate/infrastructure",)
    assert workflow.wire_fn("restate/infrastructure", create)[1:] == ("restate/ssh-config",)
    assert workflow.wire_fn("restate/ssh-config", create)[1:] == ("restate/dns",)
    assert workflow.wire_fn("restate/dns", create)[1:] == ("restate/ansible",)
    assert workflow.wire_fn("restate/ansible", create)[1:] == ("restate/acceptance",)
    assert workflow.wire_fn("restate/start", {"blue/event": "delete"})[1:] == \
        ("restate/ansible",)


def test_delete_removes_the_config_block_before_the_destroy():
    # The opposite of the keypair below: a block that outlives its host is
    # stale but harmless, so removing it early costs nothing.
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("restate/ansible", delete)[1:] == ("restate/dns",)
    assert workflow.wire_fn("restate/dns", delete)[1:] == ("restate/ssh-config",)
    assert workflow.wire_fn("restate/ssh-config", delete)[1:] == ("restate/infrastructure",)
    assert "restate/ssh-config" in workflow.side_effecting


def test_delete_removes_the_key_after_the_compute_destroy():
    # The ordering is what makes "key present <=> deployment exists" hold: a
    # failed destroy never reaches the cleanup step, and correctly leaves the
    # key that is still the only credential to whatever survived.
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("restate/infrastructure", delete)[1:] == ("restate/ssh-cleanup",)
    assert workflow.wire_fn("restate/ssh-cleanup", delete)[1:] == ()
    assert "restate/ssh-cleanup" in workflow.side_effecting
