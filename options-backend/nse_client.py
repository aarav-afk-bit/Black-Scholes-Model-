"""
Lightweight client for NSE India's public (unofficial) option-chain API.

NSE serves option chain data as JSON from:
  https://www.nseindia.com/api/option-chain-equities?symbol=RELIANCE
  https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY

These endpoints are only reachable with a browser-like session: you must first
load nseindia.com in the same requests.Session() so it hands you the cookies
(nsit / nseappid / etc.) that the API checks for on every subsequent call.
This client handles that handshake, retries, and a short-lived cache so the
dashboard doesn't hammer NSE on every UI interaction.

Notes / known limitations:
- NSE aggressively rate-limits and sometimes blocks datacenter / cloud IPs.
  If you're deploying this on a cloud VM and getting persistent 403s, run it
  from a residential connection or add your own proxy.
- Cookies expire; this client refreshes the session automatically on failure
  and periodically in the background.
- This talks to a public, undocumented endpoint that NSE can change without
  notice. Treat it as best-effort market data, not a guaranteed feed.
"""

import threading
import time

import requests

NSE_BASE = "https://www.nseindia.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"}


class NSEClient:
    def __init__(self, cache_ttl_seconds=5, session_ttl_seconds=240):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._lock = threading.Lock()
        self._last_refresh = 0.0
        self._cache = {}
        self.cache_ttl = cache_ttl_seconds
        self.session_ttl = session_ttl_seconds
        self._refresh_session()

    def _refresh_session(self):
        try:
            self.session.get(NSE_BASE, timeout=6)
            self.session.get(f"{NSE_BASE}/option-chain", timeout=6)
            self._last_refresh = time.time()
        except requests.RequestException:
            # Will retry on the next actual data call.
            pass

    def _get_json(self, url, params=None, retries=2):
        last_status = None
        for attempt in range(retries + 1):
            if time.time() - self._last_refresh > self.session_ttl:
                self._refresh_session()
            try:
                resp = self.session.get(url, params=params, timeout=8)
            except requests.RequestException as exc:
                last_status = str(exc)
                self._refresh_session()
                time.sleep(0.5)
                continue

            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError:
                    last_status = "invalid JSON in response"
            else:
                last_status = resp.status_code

            # 401/403/429 usually mean the session cookie is stale or NSE is
            # rate-limiting us — refresh and back off before retrying.
            self._refresh_session()
            time.sleep(0.6 * (attempt + 1))

        raise RuntimeError(f"NSE request failed for {url} (last status: {last_status})")

    def get_option_chain(self, symbol, is_index=None):
        symbol = symbol.upper()
        if is_index is None:
            is_index = symbol in INDEX_SYMBOLS

        cache_key = f"chain:{symbol}"
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached and time.time() - cached[0] < self.cache_ttl:
                return cached[1]

        endpoint = "api/option-chain-indices" if is_index else "api/option-chain-equities"
        data = self._get_json(f"{NSE_BASE}/{endpoint}", params={"symbol": symbol})

        with self._lock:
            self._cache[cache_key] = (time.time(), data)
        return data

    def get_quote(self, symbol, is_index=False):
        """Underlying spot price + basic quote info, independent of option chain."""
        symbol = symbol.upper()
        endpoint = "api/equity-stockIndices" if is_index else "api/quote-equity"
        params = {"index": symbol} if is_index else {"symbol": symbol}
        return self._get_json(f"{NSE_BASE}/{endpoint}", params=params)


# Single shared client instance for the whole Flask process.
nse_client = NSEClient()
