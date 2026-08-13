import pytest

from worker.database import Database
from worker.errors import DatabaseConnectionError

CONNECTION_STRING = "postgresql://ampersand:s3cret@localhost:5432/ampersand"


class FakeConnection:
    """Minimal psycopg-like connection that records operations."""

    def __init__(self, execute_error=None):
        self.events = []
        self.in_transaction = False
        self.execute_error = execute_error
        self.closed = False

    def transaction(self):
        return _FakeTransaction(self)

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        self.closed = True


class _FakeTransaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("transaction_begin")
        self.connection.in_transaction = True
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("transaction_exit")
        self.connection.in_transaction = False
        return False


class _FakeCursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql):
        self.connection.events.append(("execute", sql))
        if self.connection.execute_error is not None:
            raise self.connection.execute_error


def make_database(connection=None):
    database = Database(CONNECTION_STRING, application_name="worker-test")
    database._connection = connection
    return database


class TestConnect:
    def test_unreachable_database_raises_structured_error(self):
        database = Database(
            "postgresql://u:p@127.0.0.1:1/unused", application_name="worker-test"
        )
        with pytest.raises(DatabaseConnectionError):
            database.connect()

    def test_connection_string_is_never_leaked(self):
        database = Database(
            "postgresql://u:p@127.0.0.1:1/unused", application_name="worker-test"
        )
        with pytest.raises(DatabaseConnectionError) as excinfo:
            database.connect()
        assert "u:p@127.0.0.1:1" not in str(excinfo.value)


class TestPing:
    def test_ping_runs_select_1_inside_a_transaction(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.ping()

        assert connection.events == [
            "transaction_begin",
            ("execute", "SELECT 1"),
            "transaction_exit",
        ]

    def test_ping_leaves_no_open_transaction(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.ping()

        assert connection.in_transaction is False

    def test_ping_failure_exits_transaction_and_raises(self):
        connection = FakeConnection(execute_error=RuntimeError("boom"))
        database = make_database(connection)

        with pytest.raises(DatabaseConnectionError):
            database.ping()

        assert connection.events[0] == "transaction_begin"
        assert connection.events[-1] == "transaction_exit"
        assert connection.in_transaction is False

    def test_ping_without_connection_raises(self):
        database = make_database(None)
        with pytest.raises(DatabaseConnectionError):
            database.ping()


class TestClose:
    def test_close_is_idempotent(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.close()
        database.close()

        assert connection.closed is True

    def test_close_without_connection_is_safe(self):
        database = make_database(None)
        database.close()