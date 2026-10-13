"""Tests for the bid-ask spread / liquidity read-out."""

import pytest

from liquidity import liquidity_summary


def leg(bid, ask, oi=5000, volume=1200):
    return {"bidprice": bid, "askPrice": ask, "openInterest": oi, "totalTradedVolume": volume,
            "bidQty": 50, "askQty": 75, "changeinOpenInterest": -30}


def test_mid_and_spread():
    liq = liquidity_summary(leg(99.0, 101.0))
    assert liq["mid"] == 100.0
    assert liq["spread"] == 2.0
    assert liq["spreadPct"] == 2.0
    assert liq["changeInOpenInterest"] == -30


@pytest.mark.parametrize("bid, ask, rating", [
    (99.5, 100.5, "GOOD"),     # 1%
    (98.0, 102.0, "FAIR"),     # 4%
    (95.0, 105.0, "POOR"),     # 10%
    (80.0, 120.0, "ILLIQUID"), # 40%
])
def test_rating_follows_spread(bid, ask, rating):
    assert liquidity_summary(leg(bid, ask))["rating"] == rating


def test_no_trading_caps_rating_at_poor():
    assert liquidity_summary(leg(99.5, 100.5, volume=0))["rating"] == "POOR"
    assert liquidity_summary(leg(99.5, 100.5, oi=0))["rating"] == "POOR"


@pytest.mark.parametrize("bid, ask", [(0, 101.0), (99.0, 0), (None, None), (101.0, 99.0)])
def test_missing_or_crossed_quotes(bid, ask):
    liq = liquidity_summary(leg(bid, ask))
    assert liq["rating"] == "NO_QUOTES"
    assert liq["mid"] is None


@pytest.mark.parametrize("fair, position", [
    (98.0, "BELOW_BID"), (100.0, "INSIDE_SPREAD"), (102.0, "ABOVE_ASK"), (None, None),
])
def test_fair_value_position_against_quote(fair, position):
    assert liquidity_summary(leg(99.0, 101.0), fair)["fairValueVsQuote"] == position
