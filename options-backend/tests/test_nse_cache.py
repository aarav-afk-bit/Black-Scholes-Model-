"""NSEClient's response cache: freshness, expiry and the size bound."""

import nse_client


def make_client(monkeypatch, ttl=5, max_entries=3):
    clock = {"now": 1000.0}
    monkeypatch.setattr(nse_client.time, "time", lambda: clock["now"])
    monkeypatch.setattr(nse_client.NSEClient, "_refresh_session", lambda self: None)  # stay offline
    client = nse_client.NSEClient(cache_ttl_seconds=ttl, max_cache_entries=max_entries)
    return client, clock


def counting_fetch(calls, value):
    def fetch():
        calls.append(value)
        return value
    return fetch


def test_fresh_entries_are_served_from_cache(monkeypatch):
    client, clock = make_client(monkeypatch)
    calls = []
    assert client._cached("a", counting_fetch(calls, 1)) == 1
    clock["now"] += 4
    assert client._cached("a", counting_fetch(calls, 2)) == 1
    assert calls == [1]


def test_expired_entries_are_refetched(monkeypatch):
    client, clock = make_client(monkeypatch)
    calls = []
    client._cached("a", counting_fetch(calls, 1))
    clock["now"] += 5
    assert client._cached("a", counting_fetch(calls, 2)) == 2
    assert calls == [1, 2]


def test_expired_entries_are_pruned_on_write(monkeypatch):
    client, clock = make_client(monkeypatch)
    client._cached("old1", lambda: 1)
    client._cached("old2", lambda: 2)
    clock["now"] += 10
    client._cached("new", lambda: 3)
    assert list(client._cache) == ["new"]


def test_size_is_bounded_and_least_recently_used_goes_first(monkeypatch):
    client, clock = make_client(monkeypatch, ttl=60, max_entries=3)
    for key in ("a", "b", "c"):
        client._cached(key, lambda k=key: k)
    client._cached("a", lambda: "unused")  # touch "a" so "b" is now the oldest
    client._cached("d", lambda: "d")
    assert list(client._cache) == ["c", "a", "d"]
    assert len(client._cache) == 3
