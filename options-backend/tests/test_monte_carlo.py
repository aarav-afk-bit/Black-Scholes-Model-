"""Monte Carlo pricer: antithetic variates stay unbiased and cut the standard error."""

import numpy as np
import pytest

from pricing import black_scholes, monte_carlo

S, K, T, R, SIGMA = 100.0, 100.0, 0.5, 0.05, 0.25


def plain_mc_se(option_type, n=30000, seed=42):
    """Standard error of a plain (non-antithetic) estimator with the same path count."""
    Z = np.random.default_rng(seed).standard_normal(n)
    ST = S * np.exp((R - 0.5 * SIGMA ** 2) * T + SIGMA * np.sqrt(T) * Z)
    payoff = np.maximum(ST - K, 0) if option_type == "call" else np.maximum(K - ST, 0)
    return np.exp(-R * T) * payoff.std(ddof=1) / np.sqrt(n)


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_antithetic_estimate_is_close_to_black_scholes(option_type):
    price, se = monte_carlo(S, K, T, R, SIGMA, 0.0, 30000, option_type)
    assert abs(price - black_scholes(S, K, T, R, SIGMA)[option_type]) < 4 * se


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_antithetic_reduces_standard_error(option_type):
    _, se = monte_carlo(S, K, T, R, SIGMA, 0.0, 30000, option_type)
    assert se < 0.8 * plain_mc_se(option_type)


def test_seed_makes_results_reproducible():
    assert monte_carlo(S, K, T, R, SIGMA, seed=7) == monte_carlo(S, K, T, R, SIGMA, seed=7)
