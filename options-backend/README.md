# Options Terminal — Backend

Flask API that pulls **live option chain data directly from NSE** (strikes,
expiries, last traded price, open interest, NSE's own implied volatility) and
runs it through a Black-Scholes / CRR binomial / Monte Carlo pricing engine.

No manual data entry is required for the market side — point it at a symbol
and a strike/expiry, and it fetches the real thing.

## Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Runs on `http://localhost:5000`.

## How the NSE fetch works

`nse_client.py` opens a `requests.Session()`, first loads `nseindia.com` and
`nseindia.com/option-chain` (this is what hands you the cookies NSE's API
checks for), then calls the real endpoints:

- `https://www.nseindia.com/api/option-chain-equities?symbol=RELIANCE`
- `https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY`

Responses are cached in-memory for 5 seconds (configurable) so rapid UI
interaction doesn't hammer NSE, and the session auto-refreshes if a request
fails or every 4 minutes.

**Things to know:**
- NSE rate-limits and sometimes blocks datacenter/cloud IPs. If you deploy
  this on AWS/GCP/a VPS and get persistent `502`s, try running it from a
  residential connection, or put it behind a proxy with a residential exit IP.
- This is NSE's public but *unofficial* endpoint — it can change shape or
  block scripted access without notice. Treat it as best-effort, not a
  guaranteed feed, and don't hit it faster than a real user would.
- Index option chains (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`) use a
  different endpoint (`option-chain-indices`) than single-stock options
  (`option-chain-equities`) — the client picks the right one automatically.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/symbols` | Static reference list (sector, lot size) for the search box |
| GET | `/api/option-chain/<symbol>` | Full live chain: spot, expiries, strikes, CE/PE LTP/IV/OI |
| GET | `/api/analyze/<symbol>?strike=&expiry=&type=call\|put&r=&q=&sigma=` | Black-Scholes, Greeks, CRR, Monte Carlo, implied vol and the buy/sell suggestion for one live contract |

`expiry` must be passed exactly as returned by `/api/option-chain` (NSE's own
`DD-Mon-YYYY` format, e.g. `28-Aug-2025`).

### Example

```bash
curl "http://localhost:5000/api/option-chain/RELIANCE"
curl "http://localhost:5000/api/analyze/RELIANCE?strike=1340&expiry=28-Aug-2025&type=call"
```
