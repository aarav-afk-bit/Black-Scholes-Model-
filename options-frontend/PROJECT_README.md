# Options Terminal — NSE Black-Scholes Dashboard

Two independent pieces:

- **`backend/`** — Flask API. Fetches *live* option chain data directly from
  NSE (real strikes, expiries, LTP, OI, NSE's own implied vol) and runs it
  through Black-Scholes, CRR binomial, and Monte Carlo pricing. See
  `backend/README.md`.
- **`frontend/`** — Static dashboard (dense, dark, terminal-style). Search any
  NSE symbol, pick a strike/expiry, and it pulls the real premium and prices
  it. See `frontend/README.md`.

## Quick start

```bash
# Terminal 1 — backend
cd backend
pip install -r requirements.txt
python app.py                 # http://localhost:5000

# Terminal 2 — frontend
cd frontend
python -m http.server 8080    # http://localhost:8080
```

Open `http://localhost:8080`, search a symbol (e.g. `RELIANCE`), pick an
expiry and strike, hit **Fetch Live**.

## What "live" means here

The backend calls NSE's own public option-chain endpoint
(`nseindia.com/api/option-chain-equities` / `-indices`) with a real browser
session handshake — see `backend/nse_client.py` for exactly how. That's the
"code that extracts option data from the actual options available in the
market" piece: no hand-typed prices, the dashboard reads the real chain.

Two things worth knowing:
- NSE can rate-limit or block cloud/datacenter IPs. Run the backend from a
  normal residential connection if you hit persistent errors.
- It's an unofficial, undocumented endpoint NSE could change without notice —
  built to be resilient (session auto-refresh, retries, short cache) but not
  guaranteed to work forever unmodified.

## Suggestion panel

Compares the live NSE premium to the Black-Scholes fair value and returns a
plain-language read (undervalued / fair / overpriced) plus a suggested entry
price, breakeven, and theta decay cost. It's a transparent heuristic on top
of the model — not investment advice — and is labeled as such in the UI.
