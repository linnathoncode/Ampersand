"""Valid training-job lifecycle transitions.

The complete transition map mirrors ``packages/contracts/src/training/
job-lifecycle.ts`` (``TRAINING_JOB_TRANSITIONS``), the source of truth for the
worker boundary. Terminal states are immutable and must never move to another
state.

The worker may only perform the transitions it owns
(``TRAINING_JOB_TRANSITION_OWNERS``); Nucleus-owned transitions such as
``queued -> cancelled``, ``running -> cancelled``, and ``running -> dead`` are
valid in the lifecycle but rejected before any worker SQL runs.
"""

from __future__ import annotations

from typing import Final

from .errors import InvalidJobTransitionError

JOB_STATUSES: Final[frozenset[str]] = frozenset(
    {"queued", "running", "succeeded", "failed", "cancelled", "dead"}
)

TERMINAL_JOB_STATUSES: Final[frozenset[str]] = frozenset(
    {"succeeded", "failed", "cancelled", "dead"}
)

ALLOWED_JOB_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "queued": frozenset({"running", "cancelled"}),
    "running": frozenset({"succeeded", "failed", "cancelled", "dead"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
    "dead": frozenset(),
}

WORKER_OWNED_TRANSITIONS: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("queued", "running"),
        ("running", "succeeded"),
        ("running", "failed"),
    }
)


def is_terminal_job_status(status: str) -> bool:
    """Return True when a job status is terminal and immutable."""
    return status in TERMINAL_JOB_STATUSES


def assert_valid_job_status(status: str) -> None:
    """Raise unless ``status`` is one of the known job states."""
    if status not in JOB_STATUSES:
        raise InvalidJobTransitionError(f"unknown job status '{status}'")


def assert_valid_job_transition(current: str, next_status: str) -> None:
    """Raise unless ``current -> next_status`` is an allowed lifecycle move.

    This validates the complete state machine including Nucleus-owned
    transitions; it does not enforce transition ownership.
    """
    assert_valid_job_status(current)
    assert_valid_job_status(next_status)
    if next_status not in ALLOWED_JOB_TRANSITIONS.get(current, frozenset()):
        raise InvalidJobTransitionError(
            f"job status cannot transition from '{current}' to '{next_status}'"
        )


def assert_worker_owned_transition(current: str, next_status: str) -> None:
    """Raise unless the worker is allowed to perform the transition.

    The transition must be valid in the lifecycle and owned by the worker.
    Nucleus-owned transitions such as ``queued -> cancelled``,
    ``running -> cancelled``, and ``running -> dead`` are rejected even though
    they are part of the documented state machine.
    """
    assert_valid_job_transition(current, next_status)
    if (current, next_status) not in WORKER_OWNED_TRANSITIONS:
        raise InvalidJobTransitionError(
            f"worker cannot transition job from '{current}' to '{next_status}'"
        )