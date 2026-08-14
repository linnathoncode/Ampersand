import pytest

from worker.errors import InvalidJobTransitionError
from worker.job_state import (
    ALLOWED_JOB_TRANSITIONS,
    WORKER_OWNED_TRANSITIONS,
    assert_worker_owned_transition,
    assert_valid_job_transition,
    assert_valid_job_status,
    is_terminal_job_status,
)


class TestValidTransitions:
    @pytest.mark.parametrize(
        "next_status", ["succeeded", "failed", "cancelled", "dead"]
    )
    def test_running_can_finish_in_any_terminal_state(self, next_status):
        assert_valid_job_transition("running", next_status)

    def test_queued_can_move_to_running(self):
        assert_valid_job_transition("queued", "running")

    def test_queued_can_move_to_cancelled(self):
        assert_valid_job_transition("queued", "cancelled")


class TestInvalidTransitions:
    @pytest.mark.parametrize(
        ("current", "next_status"),
        [
            ("queued", "succeeded"),
            ("queued", "failed"),
            ("queued", "dead"),
            ("running", "queued"),
            ("running", "running"),
        ],
    )
    def test_disallowed_transitions_are_rejected(self, current, next_status):
        with pytest.raises(InvalidJobTransitionError):
            assert_valid_job_transition(current, next_status)

    @pytest.mark.parametrize("terminal", ["succeeded", "failed", "cancelled", "dead"])
    @pytest.mark.parametrize(
        "next_status", ["queued", "running", "succeeded", "failed", "cancelled", "dead"]
    )
    def test_terminal_states_never_transition(self, terminal, next_status):
        with pytest.raises(InvalidJobTransitionError):
            assert_valid_job_transition(terminal, next_status)

    def test_unknown_status_is_rejected(self):
        with pytest.raises(InvalidJobTransitionError):
            assert_valid_job_status("paused")

    def test_unknown_transition_source_is_rejected(self):
        with pytest.raises(InvalidJobTransitionError):
            assert_valid_job_transition("paused", "running")


class TestWorkerOwnedTransitions:
    @pytest.mark.parametrize(
        ("current", "next_status"),
        [
            ("queued", "running"),
            ("running", "succeeded"),
            ("running", "failed"),
        ],
    )
    def test_worker_owned_transitions_are_allowed(self, current, next_status):
        assert_worker_owned_transition(current, next_status)

    @pytest.mark.parametrize(
        ("current", "next_status"),
        [
            ("queued", "cancelled"),
            ("running", "cancelled"),
            ("running", "dead"),
            ("succeeded", "failed"),
            ("failed", "dead"),
            ("cancelled", "running"),
            ("dead", "queued"),
        ],
    )
    def test_nucleus_owned_and_terminal_transitions_are_rejected(
        self, current, next_status
    ):
        with pytest.raises(InvalidJobTransitionError):
            assert_worker_owned_transition(current, next_status)

    def test_unknown_transition_is_rejected_for_worker(self):
        with pytest.raises(InvalidJobTransitionError):
            assert_worker_owned_transition("paused", "running")


class TestContractParity:
    def test_transition_map_matches_training_contract(self):
        assert ALLOWED_JOB_TRANSITIONS == {
            "queued": frozenset({"running", "cancelled"}),
            "running": frozenset(
                {"succeeded", "failed", "cancelled", "dead"}
            ),
            "succeeded": frozenset(),
            "failed": frozenset(),
            "cancelled": frozenset(),
            "dead": frozenset(),
        }

    def test_worker_owned_transitions_match_transition_owners(self):
        assert WORKER_OWNED_TRANSITIONS == frozenset(
            {
                ("queued", "running"),
                ("running", "succeeded"),
                ("running", "failed"),
            }
        )

    def test_every_worker_owned_transition_is_a_valid_lifecycle_move(self):
        for current, next_status in WORKER_OWNED_TRANSITIONS:
            assert_valid_job_transition(current, next_status)


class TestTerminalStates:
    def test_terminal_states_are_recognized(self):
        assert is_terminal_job_status("succeeded")
        assert is_terminal_job_status("failed")
        assert is_terminal_job_status("cancelled")
        assert is_terminal_job_status("dead")

    def test_non_terminal_states_are_not_terminal(self):
        assert not is_terminal_job_status("queued")
        assert not is_terminal_job_status("running")