"""Second-order Greeks (vanna, vomma, charm) checked against finite differences."""

import pytest

from pricing import greeks

S, K, T, R, SIGMA, Q = 100.0, 105.0, 0.5, 0.06, 0.25, 0.015
H = 1e-4


def _g(**kw):
    args = dict(S=S, K=K, T=T, r=R, sigma=SIGMA, q=Q)
    args.update(kw)
    return greeks(**args)


def test_vanna_is_delta_sensitivity_to_vol():
    fd = (_g(sigma=SIGMA + H)["callDelta"] - _g(sigma=SIGMA - H)["callDelta"]) / (2 * H)
    assert _g()["vanna"] == pytest.approx(fd, rel=1e-5)


def test_vanna_equals_vega_sensitivity_to_spot():
    fd = (_g(S=S + H)["vega"] - _g(S=S - H)["vega"]) / (2 * H)
    assert _g()["vanna"] == pytest.approx(fd, rel=1e-4)


def test_vomma_is_vega_sensitivity_to_vol():
    fd = (_g(sigma=SIGMA + H)["vega"] - _g(sigma=SIGMA - H)["vega"]) / (2 * H)
    assert _g()["vomma"] == pytest.approx(fd, rel=1e-5)


@pytest.mark.parametrize("side", ["call", "put"])
def test_charm_is_delta_drift_as_time_passes(side):
    key = f"{side}Delta"
    fd = -(_g(T=T + H)[key] - _g(T=T - H)[key]) / (2 * H)
    assert _g()[f"{side}Charm"] == pytest.approx(fd, rel=1e-5)
