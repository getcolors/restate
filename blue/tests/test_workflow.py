from conftest import fixture
from package_restate_blue import workflow


async def test_build_and_dry_run_need_no_credentials():
    result = await workflow.start_step({**fixture(), "blue/event": "build"}, env={})
    assert result["blue/exit"] == 0
    result = await workflow.start_step(
        {**fixture(), "blue/event": "create", "blue/dry-run": True}, env={})
    assert result["blue/exit"] == 0


async def test_real_create_requires_credentials():
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY" in result["blue/err"]


async def test_delete_is_protected():
    result = await workflow.start_step({**fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in result["blue/err"]


def test_graph_orders_private_stack():
    create = {"blue/event": "create"}
    assert workflow.wire_fn("restate/start", create)[1:] == ("restate/infrastructure",)
    assert workflow.wire_fn("restate/infrastructure", create)[1:] == ("restate/dns",)
    assert workflow.wire_fn("restate/start", {"blue/event": "delete"})[1:] == ("restate/ansible",)
