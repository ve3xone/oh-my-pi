"""Graceful shutdown drain + kill behavior on WorkerPool.

These tests poke `WorkerPool` directly: they don't spin up a dispatcher loop
or omp subprocess. The contract under test is `stop()`'s drain-then-kill
sequence and `_run_event`'s shutting-down branch that leaves the DB row in
`running` so `reset_stuck_running()` can requeue it.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

import pytest

from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.queue import WorkerPool


class _StubGitHub:
    """Sentinel; queue tests don't talk to GitHub."""


class _StubSandbox:
    """Sentinel; queue tests don't touch the workspace pool."""


class _StubGitTransport:
    """Sentinel; queue tests don't push."""


def _make_pool(settings: Settings, db: Database) -> WorkerPool:
    return WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
    )


def _row(delivery: str = "d1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.asyncio
async def test_stop_drains_inflight_within_timeout(settings: Settings, db: Database) -> None:
    """A short in-flight task finishes during the drain window; no kill hook needed."""
    pool = _make_pool(settings, db)

    async def short_coro() -> None:
        await asyncio.sleep(0.05)

    task = asyncio.create_task(short_coro())
    pool._inflight_tasks[task] = "d-short"  # noqa: SLF001

    await pool.stop(drain_timeout=1.0, kill_timeout=0.1)

    assert pool._shutting_down is True  # noqa: SLF001
    assert task.done()


@pytest.mark.asyncio
async def test_stop_fires_kill_hook_when_drain_exceeds_timeout(settings: Settings, db: Database) -> None:
    """When drain times out, stop() pops and runs the registered cancel hook.

    The DB row stays `running` because `_run_event` (not exercised here) is
    the only path that mutates state, and even when triggered post-kill the
    shutting_down flag suppresses `mark_event(..., 'failed')`.
    """
    pool = _make_pool(settings, db)
    db.record_event(
        delivery_id="d-blocked",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )

    hook_called = asyncio.Event()
    pool._cancel_hooks["d-blocked"] = hook_called.set  # noqa: SLF001

    never = asyncio.Event()

    async def _park() -> None:
        await never.wait()

    blocked = asyncio.create_task(_park())
    pool._inflight_tasks[blocked] = "d-blocked"  # noqa: SLF001

    await pool.stop(drain_timeout=0.05, kill_timeout=0.05)

    assert hook_called.is_set()
    stored = db.get_event("d-blocked")
    assert stored is not None
    assert stored.state == "running"

    blocked.cancel()
    with suppress(asyncio.CancelledError):
        await blocked


@pytest.mark.asyncio
async def test_run_event_skips_mark_event_when_shutting_down(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """During shutdown, a dispatch exception MUST leave the row untouched."""
    pool = _make_pool(settings, db)
    pool._shutting_down = True  # noqa: SLF001

    db.record_event(
        delivery_id="d-shutdown",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )

    async def fake_dispatch(self: WorkerPool, r: EventRow) -> None:
        raise RuntimeError("omp died")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(_row("d-shutdown"))  # noqa: SLF001

    stored = db.get_event("d-shutdown")
    assert stored is not None
    assert stored.state == "running"
    assert stored.last_error is None
