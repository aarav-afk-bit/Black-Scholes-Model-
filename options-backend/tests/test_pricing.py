"""
Unit tests for the pricing engine (pricing.py).

Run from options-backend/:
    pip install pytest
    python -m pytest
"""

import math

import pytest

from pricing import (
    black_scholes,
    build_suggestion,
    crr_price,
    greeks,
    implied_volatility,
    monte_carlo,
)

# A standard textbook contract: S=K=100, 1 year, r=5%, sigma=20%.
S, K, T, R, SIGMA = 100.0, 100.0, 1.0, 0.05, 0.20


def test_black_scholes_matches_textbook_values():
    bs = black_scholes(S, K, T, R, SIGMA)
    assert bs["call"] == pytest.approx(10.4506, abs=1e-4)
    assert bs["put"] == pytest.approx(5.5735, abs=1e-4)


@pytest.mark.parametrize("q", [0.0, 0.02])
@pytest.mark.parametrize("strike", [80.0, 100.0, 120.0])
def test_put_call_parity(strike, q):
    bs = black_scholes(S, strike, T, R, SIGMA, q)
    lhs = bs["call"] - bs["put"]
    rhs = S * math.exp(-q * T) - strike * math.exp(-R * T)
    assert lhs == pytest.approx(rhs, abs=1e-9)


def test_expired_option_is_intrinsic_value():
    bs = black_scholes(110.0, 100.0, 0.0, R, SIGMA)
    assert bs["call"] == 10.0
    assert bs["put"] == 0.0


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_crr_european_converges_to_black_scholes(option_type):
    bs = black_scholes(S, K, T, R, SIGMA)[option_type]
    crr = crr_price(S, K, T, R, SIGMA, 0.0, 150, option_type, american=False)
    assert crr == pytest.approx(bs, abs=0.05)


def test_american_put_carries_early_exercise_premium():
    euro = crr_price(S, K, T, R, SIGMA, 0.0, 150, "put", american=False)
    amer = crr_price(S, K, T, R, SIGMA, 0.0, 150, "put", american=True)
    assert amer > euro


def test_american_call_without_dividends_equals_european():
    euro = crr_price(S, K, T, R, SIGMA, 0.0, 150, "call", american=False)
    amer = crr_price(S, K, T, R, SIGMA, 0.0, 150, "call", american=True)
    assert amer == pytest.approx(euro, abs=1e-9)


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_monte_carlo_agrees_with_black_scholes(option_type):
    bs = black_scholes(S, K, T, R, SIGMA)[option_type]
    price, se = monte_carlo(S, K, T, R, SIGMA, 0.0, 30000, option_type)
    assert se > 0
    assert abs(price - bs) < 4 * se


@pytest.mark.parametrize("option_type", ["call", "put"])
@pytest.mark.parametrize("vol", [0.08, 0.25, 0.9])
def test_implied_volatility_round_trip(option_type, vol):
    price = black_scholes(S, 105.0, 0.25, R, vol)[option_type]
    assert implied_volatility(price, S, 105.0, 0.25, R, 0.0, option_type) == pytest.approx(vol, abs=1e-6)


def test_implied_volatility_rejects_missing_or_impossible_prices():
    assert implied_volatility(None, S, K, T, R) is None
    assert implied_volatility(0, S, K, T, R) is None
    # A call can never be worth more than the stock itself.
    assert implied_volatility(150.0, S, K, T, R) is None


def test_greeks_match_finite_differences():
    q = 0.01
    g = greeks(S, K, T, R, SIGMA, q)

    def call(s=S, t=T, r=R, vol=SIGMA):
        return black_scholes(s, K, t, r, vol, q)["call"]

    def put(s=S, t=T, r=R, vol=SIGMA):
        return black_scholes(s, K, t, r, vol, q)["put"]

    h = 1e-3
    assert g["callDelta"] == pytest.approx((call(s=S + h) - call(s=S - h)) / (2 * h), abs=1e-6)
    assert g["putDelta"] == pytest.approx((put(s=S + h) - put(s=S - h)) / (2 * h), abs=1e-6)
    assert g["gamma"] == pytest.approx((call(s=S + h) - 2 * call() + call(s=S - h)) / h ** 2, abs=1e-4)
    assert g["vega"] == pytest.approx((call(vol=SIGMA + h) - call(vol=SIGMA - h)) / (2 * h), abs=1e-4)
    # Theta is the change in value as calendar time passes, i.e. -dV/dT.
    assert g["callTheta"] == pytest.approx(-(call(t=T + h) - call(t=T - h)) / (2 * h), abs=1e-4)
    assert g["putTheta"] == pytest.approx(-(put(t=T + h) - put(t=T - h)) / (2 * h), abs=1e-4)
    assert g["callRho"] == pytest.approx((call(r=R + h) - call(r=R - h)) / (2 * h), abs=1e-4)
    assert g["putRho"] == pytest.approx((put(r=R + h) - put(r=R - h)) / (2 * h), abs=1e-4)


@pytest.mark.parametrize(
    "market_price, verdict",
    [
        (90.0, "UNDERVALUED"),     # -10%
        (96.0, "ATTRACTIVE"),      # -4%
        (100.5, "FAIR"),           # +0.5%
        (105.0, "SLIGHTLY_RICH"),  # +5%
        (115.0, "OVERPRICED"),     # +15%
        (None, "MODEL_FAIR_VALUE"),
    ],
)
def test_suggestion_verdict_thresholds(market_price, verdict):
    g = greeks(S, K, T, R, SIGMA)
    assert build_suggestion(K, "call", 100.0, market_price, g)["verdict"] == verdict


def test_suggestion_handles_zero_fair_value():
    g = greeks(S, 400.0, 0.01, R, SIGMA)
    assert build_suggestion(400.0, "call", 0.0, 0.05, g)["verdict"] == "MODEL_FAIR_VALUE"
