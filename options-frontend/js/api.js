/* Points at the Flask backend. Override before app.js loads if needed:
   <script>window.OPTIONS_API_BASE = "https://your-backend.example.com";</script> */
const API_BASE = (window.OPTIONS_API_BASE || 'http://localhost:5000').replace(/\/+$/, '');

async function apiGet(path){
  const res = await fetch(`${API_BASE}${path}`);
  const body = await res.json().catch(()=>({}));
  if(!res.ok){
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

const Api = {
  health: () => apiGet('/api/health'),
  optionChain: (symbol, expiry) => apiGet(`/api/option-chain/${encodeURIComponent(symbol)}` + (expiry ? `?expiry=${encodeURIComponent(expiry)}` : '')),
  analyze: (symbol, params) => {
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/analyze/${encodeURIComponent(symbol)}?${qs}`);
  }
};
