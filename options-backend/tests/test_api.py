"""
Flask API tests with NSE mocked out — no network access needed.

Run from options-backend/:
    pip install -r requirements-dev.txt
    python -m pytest
"""

import pytest
import requests


def _offline(*args, **kwargs):
    raise requests.RequestException("network disabled in tests")


# The shared NSEClient warms up a session at import time; keep that offline.
_real_get = requests.Session.get
requests.Session.get = _offline
import nse_client  # noqa: E402
from app import app  # noqa: E402
requests.Session.get = _real_get

EXPIRIES = ["30-Dec-2099", "27-Jan-2100"]
SPOT = 24500
STRIKES = (24000, 24500, 25000)


def _leg(strike, expiry, ltp, iv):
    return {
        "strikePrice": strike, "expiryDate": expiry, "lastPrice": ltp,
        "impliedVolatility": iv, "openInterest": 1200, "changeinOpenInterest": 40,
        "totalTradedVolume": 900, "bidprice": ltp - 0.5, "bidQty": 75,
        "askPrice": ltp + 0.5, "askQty": 50, "change": 1.5, "underlyingValue": SPOT,
    }


def _v3_chain(expiry):
    return {"records": {"underlyingValue": SPOT, "data": [
        {"expiryDates": expiry, "strikePrice": k,
         "CE": _leg(k, expiry, max(SPOT - k, 0) + 150, 14.2),
         "PE": _leg(k, expiry, max(k - SPOT, 0) + 140, 15.1)}
        for k in STRIKES
    ]}}


@pytest.fixture
def client(monkeypatch):
    calls = []

    def fake_get_json(self, url, params=None, retries=2):
        calls.append((url.rsplit("/", 1)[-1], dict(params or {})))
        if url.endswith("option-chain-contract-info"):
            return {"expiryDates": EXPIRIES}
        if url.endswith("option-chain-v3"):
            return _v3_chain(params["expiry"])
        return {}

    monkeypatch.setattr(nse_client.NSEClient, "_get_json", fake_get_json)
    nse_client.nse_client._cache.clear()
    test_client = app.test_client()
    test_client.nse_calls = calls
    return test_client


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"


def test_symbols(client):
    body = client.get("/api/symbols").get_json()
    assert any(s["symbol"] == "NIFTY" for s in body["symbols"])


def test_option_chain_defaults_to_nearest_expiry(client):
    body = client.get("/api/option-chain/nifty").get_json()
    assert body["symbol"] == "NIFTY"
    assert body["isIndex"] is True
    assert body["spot"] == SPOT
    assert body["expiries"] == EXPIRIES
    assert body["strikes"] == list(STRIKES)
    assert list(body["chain"]) == [EXPIRIES[0]]
    assert body["chain"][EXPIRIES[0]]["24500"]["CE"]["lastPrice"] == 150
    assert ("option-chain-v3", {"type": "Indices", "symbol": "NIFTY", "expiry": EXPIRIES[0]}) in client.nse_calls


def test_option_chain_for_specific_expiry(client):
    body = client.get(f"/api/option-chain/NIFTY?expiry={EXPIRIES[1]}").get_json()
    assert list(body["chain"]) == [EXPIRIES[1]]


def test_equity_symbols_use_equity_type(client):
    client.get("/api/option-chain/RELIANCE")
    assert any(p.get("type") == "Equity" for _, p in client.nse_calls)


def test_analyze_returns_full_workup(client):
    resp = client.get(f"/api/analyze/NIFTY?strike=24500&expiry={EXPIRIES[0]}&type=put&r=0.065&q=1.5")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["optionType"] == "put"
    assert body["inputs"] == {"r": 0.065, "sigma": pytest.approx(0.151), "q": pytest.approx(0.015)}
    assert body["market"]["lastPrice"] == 140
    for key in ("blackScholes", "greeks", "crr", "monteCarlo", "impliedVolatility", "suggestion"):
        assert key in body
    assert body["fetchedAt"].endswith("+00:00")


def test_analyze_sigma_override(client):
    body = client.get(f"/api/analyze/NIFTY?strike=24500&expiry={EXPIRIES[0]}&sigma=30").get_json()
    assert body["inputs"]["sigma"] == pytest.approx(0.30)


@pytest.mark.parametrize("query, status", [
    ("strike=24500", 400),                                   # missing expiry
    ("strike=24500&expiry=not-a-date", 400),
    (f"strike=abc&expiry={EXPIRIES[0]}", 400),
    (f"strike=24500&expiry={EXPIRIES[0]}&type=straddle", 400),
    (f"strike=24500&expiry={EXPIRIES[0]}&r=nan", 400),
    (f"strike=24500&expiry={EXPIRIES[0]}&sigma=-5", 400),
    (f"strike=99999&expiry={EXPIRIES[0]}", 404),             # strike not in chain
])
def test_analyze_rejects_bad_input(client, query, status):
    resp = client.get(f"/api/analyze/NIFTY?{query}")
    assert resp.status_code == status
    assert "error" in resp.get_json()


def test_nse_failure_returns_502(client, monkeypatch):
    def boom(self, url, params=None, retries=2):
        raise RuntimeError("blocked")

    monkeypatch.setattr(nse_client.NSEClient, "_get_json", boom)
    resp = client.get("/api/option-chain/NIFTY")
    assert resp.status_code == 502
    assert "error" in resp.get_json()
