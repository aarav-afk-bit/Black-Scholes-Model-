"""
Bid-ask spread and liquidity read-out for one option leg from the NSE chain.

A wide spread or thin open interest means the LTP may be stale and the
round-trip cost of trading eats into any model edge, so the analysis
reports both alongside the fair-value comparison.
"""

# Spread as a % of mid -> rating. Checked in order; anything wider is ILLIQUID.
SPREAD_RATINGS = [(2.0, "GOOD"), (5.0, "FAIR"), (15.0, "POOR")]
RATING_ORDER = ["GOOD", "FAIR", "POOR", "ILLIQUID"]


def liquidity_summary(leg, fair_value=None):
    bid = leg.get("bidprice") or 0
    ask = leg.get("askPrice") or 0
    oi = leg.get("openInterest") or 0
    volume = leg.get("totalTradedVolume") or 0

    result = {
        "bid": bid or None,
        "ask": ask or None,
        "bidQty": leg.get("bidQty"),
        "askQty": leg.get("askQty"),
        "openInterest": oi,
        "changeInOpenInterest": leg.get("changeinOpenInterest"),
        "volume": volume,
        "mid": None,
        "spread": None,
        "spreadPct": None,
        "fairValueVsQuote": None,
    }

    if bid <= 0 or ask <= 0 or ask < bid:
        result.update({
            "rating": "NO_QUOTES",
            "note": "No two-sided quote right now — the LTP may be stale and hard to trade at.",
        })
        return result

    mid = (bid + ask) / 2
    spread = ask - bid
    spread_pct = spread / mid * 100
    rating = next((r for limit, r in SPREAD_RATINGS if spread_pct <= limit), "ILLIQUID")
    # No trades or no open interest today: never call it better than POOR.
    if (volume == 0 or oi == 0) and RATING_ORDER.index(rating) < RATING_ORDER.index("POOR"):
        rating = "POOR"

    position = None
    if fair_value is not None:
        if fair_value < bid:
            position = "BELOW_BID"      # even selling at the bid beats the model
        elif fair_value > ask:
            position = "ABOVE_ASK"      # even buying at the ask is below the model
        else:
            position = "INSIDE_SPREAD"  # no edge once you cross the spread

    notes = {
        "GOOD": "Tight spread — the LTP is a reliable price.",
        "FAIR": "Moderate spread — use limit orders near the mid.",
        "POOR": "Wide spread or little activity — the round-trip cost is significant.",
        "ILLIQUID": "Very wide spread — model edge is unlikely to survive execution.",
    }
    result.update({
        "mid": round(mid, 4),
        "spread": round(spread, 4),
        "spreadPct": round(spread_pct, 2),
        "fairValueVsQuote": position,
        "rating": rating,
        "note": notes[rating],
    })
    return result
