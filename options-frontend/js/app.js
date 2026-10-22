/* ============================================================
   STATE
============================================================ */
let optionType = 'call';
let charts = {};
let companiesRef = [];          // local sector/lot/name reference (data/nse_companies.json)
let currentChain = null;        // last /api/option-chain response
let currentSymbol = null;
let currentIsIndex = false;

const fmt = (v,dec=2)=> (v===null||v===undefined||isNaN(v)) ? '—' : '₹'+Number(v).toLocaleString('en-IN',{minimumFractionDigits:dec,maximumFractionDigits:dec});
const fmtN = (v,dec=4)=> (v===null||v===undefined||isNaN(v)) ? '—' : Number(v).toFixed(dec);
const fmtPct = (v,dec=2)=> (v===null||v===undefined||isNaN(v)) ? '—' : (v*100).toFixed(dec)+'%';

/* ============================================================
   STATUS / ERROR UI
============================================================ */
function setStatus(text, mode='ok'){
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot' + (mode==='error' ? ' err' : mode==='pending' ? ' pending' : '');
}
function showError(msg){
  const el = document.getElementById('errorBanner');
  el.textContent = msg;
  el.classList.add('show');
}
function clearError(){
  document.getElementById('errorBanner').classList.remove('show');
}

/* ============================================================
   INIT: load local reference data for search
============================================================ */
async function loadCompanies(){
  try{
    const res = await fetch('data/nse_companies.json');
    const json = await res.json();
    companiesRef = json.symbols || [];
  }catch(e){
    companiesRef = [];
  }
}

/* ============================================================
   SEARCH / DROPDOWN
============================================================ */
const searchInput = document.getElementById('searchInput');
const dropdown = document.getElementById('dropdown');

function renderDropdown(list){
  if(list.length===0){ dropdown.classList.remove('open'); dropdown.innerHTML=''; return; }
  dropdown.innerHTML = list.slice(0,12).map(c=>`
    <div class="dropdown-item" data-symbol="${c.symbol}">
      <div><span class="sym">${c.symbol}</span> — <span class="nm">${c.name}</span></div>
      <span class="sec">${c.sector}</span>
    </div>`).join('');
  dropdown.classList.add('open');
  dropdown.querySelectorAll('.dropdown-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      selectSymbol(el.dataset.symbol);
      dropdown.classList.remove('open');
      searchInput.value='';
    });
  });
}

searchInput.addEventListener('input', ()=>{
  const q = searchInput.value.trim().toLowerCase();
  if(!q){ dropdown.classList.remove('open'); return; }
  const list = companiesRef.filter(c=> c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  renderDropdown(list);
});
document.addEventListener('click', (e)=>{ if(!e.target.closest('.search-wrap')) dropdown.classList.remove('open'); });

/* ============================================================
   SYMBOL SELECT -> LOAD LIVE OPTION CHAIN (strikes / expiries)
============================================================ */
async function selectSymbol(symbol){
  clearError();
  const ref = companiesRef.find(c=>c.symbol===symbol);
  currentSymbol = symbol;
  currentIsIndex = ref ? !!ref.isIndex : false;

  document.getElementById('pSymbol').value = symbol;
  document.getElementById('snapSymbol').textContent = symbol;
  document.getElementById('snapSector').textContent = ref ? ref.sector : '—';
  document.getElementById('snapLot').textContent = ref ? ref.lotSize.toLocaleString('en-IN') : '—';

  setStatus('FETCHING LIVE CHAIN — ' + symbol, 'pending');
  const expirySel = document.getElementById('expirySelect');
  const strikeSel = document.getElementById('strikeSelect');
  expirySel.disabled = true; strikeSel.disabled = true;
  expirySel.innerHTML = '<option>loading…</option>';
  strikeSel.innerHTML = '<option>loading…</option>';

  try{
    const chain = await Api.optionChain(symbol);
    if(symbol !== currentSymbol) return;   // user picked another symbol meanwhile
    currentChain = chain;
    document.getElementById('pSpot').value = chain.spot ?? '';

    const expiries = chain.expiries.length ? chain.expiries : Object.keys(chain.chain);
    if(!expiries.length) throw new Error('NSE returned no expiries for this symbol');
    expirySel.innerHTML = expiries.map(e=>`<option value="${e}">${e}</option>`).join('');
    expirySel.disabled = false;
    expirySel.value = expiries[0];
    populateStrikesForExpiry(expiries[0]);

    setStatus('LIVE CHAIN LOADED — ' + symbol, 'ok');
  }catch(err){
    if(symbol !== currentSymbol) return;
    setStatus('LIVE FETCH FAILED — ' + symbol, 'error');
    showError(`Could not load the live NSE option chain for ${symbol}: ${err.message}. Make sure the backend (app.py) is running and reachable at ${API_BASE}, and that NSE isn't rate-limiting this connection.`);
    expirySel.innerHTML = '<option>—</option>';
    strikeSel.innerHTML = '<option>—</option>';
  }
}

function populateStrikesForExpiry(expiry){
  const strikeSel = document.getElementById('strikeSelect');
  if(!currentChain || !currentChain.chain[expiry]){ strikeSel.innerHTML='<option>—</option>'; strikeSel.disabled=true; return; }
  const strikesForExpiry = Object.keys(currentChain.chain[expiry]).map(Number).sort((a,b)=>a-b);
  const spot = currentChain.spot;
  let atmIdx = 0, best = Infinity;
  strikesForExpiry.forEach((s,i)=>{ const d = Math.abs(s-spot); if(d<best){ best=d; atmIdx=i; } });

  strikeSel.innerHTML = strikesForExpiry.map(s=>`<option value="${s}">${s}</option>`).join('');
  strikeSel.disabled = false;
  strikeSel.selectedIndex = atmIdx;
  renderSmile(expiry);
  document.getElementById('pStrike').value = strikesForExpiry[atmIdx];

  document.getElementById('pDays').value = daysToExpiry(expiry);
  renderChainTable(expiry);
}

/* NSE expiry strings look like "28-Aug-2025". Parse them by hand — Safari
   and some Firefox versions return Invalid Date for "28 Aug 2025". Counts
   calendar days settlement-inclusive, matching the backend's _days_to_expiry. */
const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function daysToExpiry(expiry){
  const [dd, mon, yyyy] = String(expiry).split('-');
  const m = MONTHS[(mon||'').slice(0,3).toLowerCase()];
  if(m===undefined) return 1;
  const expiryUTC = Date.UTC(+yyyy, m, +dd);
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(Math.round((expiryUTC - todayUTC)/86400000), 0) + 1;
}

/* NSE's v3 API serves one expiry per request, so switching expiry fetches
   that expiry's strikes if we don't already have them. */
document.getElementById('expirySelect').addEventListener('change', async (e)=>{
  const expiry = e.target.value;
  if(currentChain && currentChain.chain[expiry]){ populateStrikesForExpiry(expiry); return; }
  const symbol = currentSymbol;
  const strikeSel = document.getElementById('strikeSelect');
  strikeSel.disabled = true;
  strikeSel.innerHTML = '<option>loading…</option>';
  setStatus(`FETCHING ${symbol} ${expiry}`, 'pending');
  try{
    const chain = await Api.optionChain(symbol, expiry);
    if(symbol !== currentSymbol) return;
    Object.assign(currentChain.chain, chain.chain);
    if(chain.spot != null){ currentChain.spot = chain.spot; document.getElementById('pSpot').value = chain.spot; }
    populateStrikesForExpiry(expiry);
    setStatus('LIVE CHAIN LOADED — ' + symbol, 'ok');
  }catch(err){
    setStatus('LIVE FETCH FAILED — ' + symbol, 'error');
    showError(`Could not load strikes for ${symbol} ${expiry}: ${err.message}`);
    strikeSel.innerHTML = '<option>—</option>';
  }
});
document.getElementById('strikeSelect').addEventListener('change', (e)=>{
  document.getElementById('pStrike').value = e.target.value;
});

/* ============================================================
   OPTION CHAIN TABLE (strikes x CE/PE for the selected expiry)
============================================================ */
const fmtInt = (v)=> (v===null||v===undefined||isNaN(v)) ? '—' : Number(v).toLocaleString('en-IN');

/* Put-call ratio by open interest, and max pain: the expiry price at which
   option holders (all strikes, calls + puts) would collect the least. */
function chainStats(rows){
  let callOI=0, putOI=0;
  rows.forEach(r=>{ callOI += r.CE?.openInterest||0; putOI += r.PE?.openInterest||0; });
  let maxPain=null, minPayout=Infinity;
  rows.forEach(({strike:settle})=>{
    let payout = 0;
    rows.forEach(r=>{
      payout += Math.max(settle-r.strike,0)*(r.CE?.openInterest||0) + Math.max(r.strike-settle,0)*(r.PE?.openInterest||0);
    });
    if(payout<minPayout){ minPayout=payout; maxPain=settle; }
  });
  return { pcr: callOI ? putOI/callOI : null, maxPain: (callOI||putOI) ? maxPain : null };
}

function renderChainTable(expiry){
  const tbody = document.querySelector('#chainTable tbody');
  const legs = currentChain && currentChain.chain[expiry];
  if(!legs){ tbody.innerHTML = '<tr><td colspan="9" class="empty">No chain data for this expiry.</td></tr>'; return; }
  const spot = currentChain.spot;
  const rows = Object.keys(legs).map(k=>({strike:Number(k), CE:legs[k].CE, PE:legs[k].PE})).sort((a,b)=>a.strike-b.strike);
  let atm = rows[0]?.strike;
  rows.forEach(r=>{ if(Math.abs(r.strike-spot) < Math.abs(atm-spot)) atm = r.strike; });
  const selected = Number(document.getElementById('strikeSelect').value);
  const chgCls = (v)=> v>0 ? 'up' : v<0 ? 'down' : '';
  const ivTxt = (v)=> v ? Number(v).toFixed(1) : '—';
  const ltpTxt = (v)=> v ? Number(v).toFixed(2) : '—';

  tbody.innerHTML = rows.map(r=>{
    const c = r.CE||{}, p = r.PE||{};
    const cItm = r.strike < spot ? ' itm-call' : '', pItm = r.strike > spot ? ' itm-put' : '';
    const cls = [r.strike===atm?'atm':'', r.strike===selected?'selected':''].join(' ');
    return `<tr class="${cls}" data-strike="${r.strike}">
      <td class="${cItm}" data-side="call">${fmtInt(c.openInterest)}</td>
      <td class="${chgCls(c.changeInOpenInterest)}${cItm}" data-side="call">${fmtInt(c.changeInOpenInterest)}</td>
      <td class="${cItm}" data-side="call">${ivTxt(c.impliedVolatility)}</td>
      <td class="ltp${cItm}" data-side="call">${ltpTxt(c.lastPrice)}</td>
      <td class="strike">${r.strike}</td>
      <td class="ltp${pItm}" data-side="put">${ltpTxt(p.lastPrice)}</td>
      <td class="${pItm}" data-side="put">${ivTxt(p.impliedVolatility)}</td>
      <td class="${chgCls(p.changeInOpenInterest)}${pItm}" data-side="put">${fmtInt(p.changeInOpenInterest)}</td>
      <td class="${pItm}" data-side="put">${fmtInt(p.openInterest)}</td>
    </tr>`;
  }).join('');

  const { pcr, maxPain } = chainStats(rows);
  document.getElementById('chainStats').textContent =
    `${expiry} · spot ${fmtInt(spot)} · PCR ${pcr!=null ? pcr.toFixed(2) : '—'} · max pain ${maxPain ?? '—'}`;

  const wrap = tbody.closest('.chain-wrap');
  const atmRow = tbody.querySelector('tr.atm');
  if(atmRow) wrap.scrollTop = atmRow.offsetTop - wrap.clientHeight/2;
}

function highlightChainStrike(strike){
  document.querySelectorAll('#chainTable tbody tr').forEach(tr=>{
    tr.classList.toggle('selected', Number(tr.dataset.strike)===Number(strike));
  });
}

// Click a row to select that strike; clicking the call or put side also picks the option type.
document.querySelector('#chainTable tbody').addEventListener('click', (e)=>{
  const tr = e.target.closest('tr[data-strike]');
  if(!tr) return;
  const strikeSel = document.getElementById('strikeSelect');
  strikeSel.value = tr.dataset.strike;
  document.getElementById('pStrike').value = tr.dataset.strike;
  const side = e.target.closest('td')?.dataset.side;
  if(side){ optionType = side; syncToggle(); }
  highlightChainStrike(tr.dataset.strike);
});
document.getElementById('strikeSelect').addEventListener('change', (e)=> highlightChainStrike(e.target.value));

/* ============================================================
   OPTION TYPE TOGGLE
============================================================ */
document.getElementById('btnCall').addEventListener('click', ()=>{ optionType='call'; syncToggle(); });
document.getElementById('btnPut').addEventListener('click', ()=>{ optionType='put'; syncToggle(); });
function syncToggle(){
  document.getElementById('btnCall').classList.toggle('active', optionType==='call');
  document.getElementById('btnPut').classList.toggle('active', optionType==='put');
}

/* ============================================================
   FETCH LIVE & ANALYZE
============================================================ */
document.getElementById('fetchBtn').addEventListener('click', fetchLiveAndAnalyze);
document.getElementById('recalcBtn').addEventListener('click', recalcLocal);

async function fetchLiveAndAnalyze(){
  clearError();
  if(!currentSymbol){ showError('Search and select a symbol first.'); return; }
  const expiry = document.getElementById('expirySelect').value;
  const strike = document.getElementById('strikeSelect').value;
  if(!expiry || !strike){ showError('Pick an expiry and strike first.'); return; }

  // Backend units: r as a decimal, q as a percentage (it divides q by 100 itself).
  const ratePct = parseFloat(document.getElementById('pRate').value);
  const divPct = parseFloat(document.getElementById('pDiv').value);
  const params = { strike, expiry, type: optionType };
  if(!isNaN(ratePct)) params.r = ratePct/100;
  if(!isNaN(divPct)) params.q = divPct;

  setStatus('RUNNING LIVE ANALYSIS…', 'pending');
  try{
    const data = await Api.analyze(currentSymbol, params);
    applyAnalysis(data);
    setStatus(`LIVE — ${currentSymbol} ${strike} ${optionType.toUpperCase()} · ${expiry}`, 'ok');
  }catch(err){
    setStatus('ANALYSIS FAILED', 'error');
    showError(`Live analysis failed: ${err.message}`);
  }
}

function applyAnalysis(data){
  // Fill param strip from the live response (still editable afterwards)
  document.getElementById('pSpot').value = data.spot;
  document.getElementById('pStrike').value = data.strike;
  document.getElementById('pDays').value = data.daysToExpiry;
  document.getElementById('pRate').value = (data.inputs.r*100).toFixed(2);
  document.getElementById('pVol').value = (data.inputs.sigma*100).toFixed(2);
  document.getElementById('pDiv').value = (data.inputs.q*100).toFixed(2);
  document.getElementById('pMarket').value = data.market.lastPrice ?? '';

  // Live market data card
  document.getElementById('liveLTP').textContent = data.market.lastPrice!=null ? fmt(data.market.lastPrice) : 'n/a';
  document.getElementById('liveIV').textContent = data.market.nseImpliedVolatility!=null ? data.market.nseImpliedVolatility.toFixed(2)+'%' : 'n/a';
  document.getElementById('liveOI').textContent = data.market.openInterest!=null ? data.market.openInterest.toLocaleString('en-IN') : 'n/a';
  document.getElementById('liveVol').textContent = data.market.volume!=null ? data.market.volume.toLocaleString('en-IN') : 'n/a';
  document.getElementById('liveBidAsk').textContent = (data.market.bid!=null && data.market.ask!=null) ? `${data.market.bid} / ${data.market.ask}` : 'n/a';
  document.getElementById('liveFetchedAt').textContent = new Date(data.fetchedAt).toLocaleTimeString('en-IN');
  renderLiquidity(data.liquidity, data.impliedVolatility.solvedFromMid);

  document.getElementById('ctExpiry').textContent = data.expiry;
  document.getElementById('ctDays').textContent = data.daysToExpiry;
  document.getElementById('ctStrike').textContent = data.strike;
  document.getElementById('ctType').textContent = data.optionType.toUpperCase();
  renderProbabilities(data.spot, data.strike, data.daysToExpiry/365, data.inputs.r, data.inputs.sigma, data.inputs.q,
    data.optionType, data.market.lastPrice, data.optionType==='call' ? data.blackScholes.call : data.blackScholes.put);

  // BS / Greeks / CRR / MC / IV cards
  fillResultCards(data.blackScholes, data.greeks, data.crr, data.monteCarlo, data.impliedVolatility, data.inputs.sigma, data.optionType);

  // Suggestion panel (server-computed)
  renderSuggestionFromServer(data.suggestion, data.optionType);

  // Parity check
  const T = data.daysToExpiry/365;
  const lhs = data.blackScholes.call - data.blackScholes.put;
  const rhs = data.spot*Math.exp(-data.inputs.q*T) - data.strike*Math.exp(-data.inputs.r*T);
  document.getElementById('parityLHS').textContent = fmtN(lhs,6);
  document.getElementById('parityRHS').textContent = fmtN(rhs,6);
  document.getElementById('parityDiff').textContent = fmtN(Math.abs(lhs-rhs),8);

  // Charts (client-side, using the live-derived inputs)
  renderCharts({ S:data.spot, K:data.strike, r:data.inputs.r, sigma:data.inputs.sigma, q:data.inputs.q }, data.daysToExpiry/365, data.optionType==='call');
  renderScenarios({ S:data.spot, K:data.strike, r:data.inputs.r, sigma:data.inputs.sigma, q:data.inputs.q }, data.daysToExpiry,
    data.optionType, data.market.lastPrice || (data.optionType==='call' ? data.blackScholes.call : data.blackScholes.put));
}

const LIQUIDITY_LABELS = {
  GOOD:['GOOD','pos'], FAIR:['FAIR',''], POOR:['POOR','neg'], ILLIQUID:['ILLIQUID','neg'], NO_QUOTES:['NO QUOTES','neg']
};
function renderLiquidity(liq, midIV){
  if(!liq) return;
  document.getElementById('liveSpread').textContent = liq.mid!=null
    ? `${fmt(liq.mid)} / ${fmt(liq.spread)} (${liq.spreadPct.toFixed(1)}%)` : 'n/a';
  const [label, cls] = LIQUIDITY_LABELS[liq.rating] || [liq.rating, ''];
  const el = document.getElementById('liveLiquidity');
  el.textContent = label;
  el.className = 'v ' + cls;
  el.title = liq.note || '';
  const chg = liq.changeInOpenInterest;
  document.getElementById('liveOIChange').textContent = chg!=null ? (chg>0?'+':'') + chg.toLocaleString('en-IN') : 'n/a';
  document.getElementById('liveMidIV').textContent = midIV!=null ? fmtPct(midIV) : 'n/a';
}

/* ============================================================
   LOCAL RECALCULATION (what-if, no backend round trip)
============================================================ */
function recalcLocal(){
  clearError();
  const S = parseFloat(document.getElementById('pSpot').value);
  const K = parseFloat(document.getElementById('pStrike').value);
  const days = parseFloat(document.getElementById('pDays').value);
  const r = parseFloat(document.getElementById('pRate').value)/100;
  const sigma = parseFloat(document.getElementById('pVol').value)/100;
  const q = parseFloat(document.getElementById('pDiv').value)/100;
  const market = document.getElementById('pMarket').value ? parseFloat(document.getElementById('pMarket').value) : null;

  if(!S || !K || !days || S<=0 || K<=0 || days<=0 || !(sigma>0) || isNaN(r) || isNaN(q)){ showError('Fill in spot, strike, days, rate, dividend yield and volatility before recalculating.'); return; }
  const T = days/365;
  const isCall = optionType==='call';

  const bs = blackScholes(S,K,T,r,sigma,q);
  const gk = bsGreeks(S,K,T,r,sigma,q);
  const crrEuro = crrPrice(S,K,T,r,sigma,q,150,optionType,false);
  const crrAmerican = crrPrice(S,K,T,r,sigma,q,150,optionType,true);
  const mc = monteCarlo(S,K,T,r,sigma,q,30000,optionType);
  const iv = market ? impliedVol(market,S,K,T,r,q,optionType) : NaN;

  fillResultCards(bs, gk, { european:crrEuro, american:crrAmerican, earlyExercisePremium:crrAmerican-crrEuro },
     { price:mc.price, stdError:mc.se }, { solved:isNaN(iv)?null:iv, nseReported:null }, sigma, optionType);

  const fairValue = isCall ? bs.call : bs.put;
  const sug = buildSuggestionLocal(K, optionType, fairValue, market, gk);
  renderSuggestionFromServer(normalizeLocalSuggestion(sug), optionType);

  const lhs = bs.call - bs.put;
  const rhs = S*Math.exp(-q*T) - K*Math.exp(-r*T);
  document.getElementById('parityLHS').textContent = fmtN(lhs,6);
  document.getElementById('parityRHS').textContent = fmtN(rhs,6);
  document.getElementById('parityDiff').textContent = fmtN(Math.abs(lhs-rhs),8);

  document.getElementById('ctExpiry').textContent = document.getElementById('expirySelect').value || 'custom';
  document.getElementById('ctDays').textContent = days;
  document.getElementById('ctStrike').textContent = K;
  document.getElementById('ctType').textContent = optionType.toUpperCase();
  renderProbabilities(S, K, T, r, sigma, q, optionType, market, fairValue);

  renderCharts({S,K,r,sigma,q}, T, isCall);
  renderScenarios({S,K,r,sigma,q}, days, optionType, market || fairValue);
  setStatus('LOCAL RECALC — no backend call', 'ok');
}

function normalizeLocalSuggestion(sug){
  // Match the shape returned by the backend so one render function handles both.
  return {
    verdict: sug.verdict, headline: sug.headline, fairValue: sug.fairValue,
    marketPrice: sug.marketPrice, mispricingPct: sug.mispricingPct,
    suggestedEntry: sug.suggestedEntry, reasoning: sug.reasoning,
    thetaPerDay: sug.thetaPerDay, thetaFiveDay: sug.thetaFiveDay,
    fairValueZone: { low: sug.zoneLow, high: sug.zoneHigh }
  };
}

/* ============================================================
   RENDER: result cards (shared by live + local paths)
============================================================ */
function fillResultCards(bs, gk, crr, mc, iv, sigmaUsed, type){
  const isCall = type==='call';

  document.getElementById('bsCall').textContent = fmt(bs.call);
  document.getElementById('bsPut').textContent = fmt(bs.put);
  document.getElementById('bsD1').textContent = fmtN(bs.d1);
  document.getElementById('bsD2').textContent = fmtN(bs.d2);
  document.getElementById('bsNd').textContent = (bs.d1==null?'—':fmtN(normCDF(bs.d1),4)) + ' / ' + (bs.d2==null?'—':fmtN(normCDF(bs.d2),4));

  document.getElementById('greeksTag').textContent = isCall ? 'CALL side' : 'PUT side';
  const rows = [
    ['Delta', isCall? gk.callDelta : gk.putDelta, 4],
    ['Gamma', gk.gamma, 6],
    ['Vega (per 1% IV)', gk.vega/100, 4],
    ['Theta (per day)', (isCall? gk.callTheta : gk.putTheta)/365, 4],
    ['Rho (per 1% rate)', (isCall? gk.callRho : gk.putRho)/100, 4],
    ['Vanna (Δ per 1% IV)', gk.vanna/100, 5],
    ['Vomma (vega per 1% IV)', gk.vomma/10000, 5],
    ['Charm (Δ change per day)', (isCall? gk.callCharm : gk.putCharm)/365, 5],
  ];
  document.getElementById('greeksTable').querySelector('tbody').innerHTML =
    rows.map(r=>`<tr><td>${r[0]}</td><td>${fmtN(r[1],r[2])}</td></tr>`).join('');

  document.getElementById('crrTag').textContent = isCall ? 'CALL' : 'PUT';
  document.getElementById('crrEuro').textContent = fmt(crr.european);
  document.getElementById('crrAmerican').textContent = fmt(crr.american);
  document.getElementById('crrPremium').textContent = fmt(crr.earlyExercisePremium);

  document.getElementById('mcTag').textContent = isCall ? 'CALL' : 'PUT';
  document.getElementById('mcPrice').textContent = fmt(mc.price);
  document.getElementById('mcErr').textContent = '± '+fmt(mc.stdError,4);
  document.getElementById('mcCI').textContent = fmt(mc.price-1.96*mc.stdError) + ' to ' + fmt(mc.price+1.96*mc.stdError);
  const bsRef = isCall?bs.call:bs.put;
  document.getElementById('mcVsBS').textContent = fmt(mc.price-bsRef,4)+' diff';

  document.getElementById('ivModel').textContent = fmtPct(sigmaUsed);
  document.getElementById('ivImplied').textContent = iv.solved!=null ? fmtPct(iv.solved) : '—';
  document.getElementById('ivNse').textContent = iv.nseReported!=null ? fmtPct(iv.nseReported) : 'n/a';
  document.getElementById('ivDelta').textContent = iv.solved!=null ? fmtPct(iv.solved-sigmaUsed) : '—';
}

/* ============================================================
   RENDER: probability analysis (shared by live + local paths)
============================================================ */
function renderProbabilities(S, K, T, r, sigma, q, type, marketPrice, fairValue){
  // Price the trade at the live premium when there is one, else at model fair value.
  const premium = marketPrice || fairValue;
  const m = probabilityMetrics(S, K, T, r, sigma, q, type, premium);
  const pct = (v)=> fmtPct(v, 1);
  document.getElementById('probITM').textContent = pct(m.pITM);
  document.getElementById('probProfit').textContent = pct(m.pProfit);
  document.getElementById('probTouch').textContent = pct(m.pTouch);
  document.getElementById('probBEMove').textContent = `${m.breakevenMovePct>=0?'+':''}${pct(m.breakevenMovePct)} → ${fmt(m.breakeven)}`;
  document.getElementById('probMove').textContent = `± ${fmt(m.expectedMove)} (${pct(sigma*Math.sqrt(T))})`;
  document.getElementById('probRange').textContent = `${fmt(m.rangeLow,0)} – ${fmt(m.rangeHigh,0)}`;

  const ref = companiesRef.find(c=>c.symbol===currentSymbol);
  const edgeEl = document.getElementById('probEdge');
  if(marketPrice && ref && ref.lotSize){
    const edge = (fairValue - marketPrice) * ref.lotSize;
    edgeEl.textContent = (edge>=0?'+':'') + fmt(edge) + ` (${ref.lotSize} qty)`;
    edgeEl.style.color = edge>=0 ? 'var(--green)' : 'var(--red)';
  } else {
    edgeEl.textContent = marketPrice ? 'lot size unknown' : 'needs market premium';
    edgeEl.style.color = '';
  }
}

/* ============================================================
   RENDER: suggestion panel (shared shape from server or local)
============================================================ */
function renderSuggestionFromServer(sug, optionType){
  const verdictEl = document.getElementById('sugVerdict');
  const subEl = document.getElementById('sugSub');
  const priceLabelEl = document.getElementById('sugPriceLabel');
  const priceValEl = document.getElementById('sugPriceVal');
  const priceRangeEl = document.getElementById('sugPriceRange');
  const reasoningEl = document.getElementById('sugReasoning');

  document.getElementById('sugFair').textContent = fmt(sug.fairValue);
  document.getElementById('sugTheta').textContent = fmt(sug.thetaPerDay,4);
  document.getElementById('sugTheta5').textContent = fmt(sug.thetaFiveDay,4);
  priceRangeEl.textContent = `Fair-value zone: ${fmt(sug.fairValueZone.low)} to ${fmt(sug.fairValueZone.high)}`;
  priceValEl.textContent = fmt(sug.suggestedEntry);
  reasoningEl.textContent = sug.reasoning;

  const strike = parseFloat(document.getElementById('pStrike').value);
  const isCall = optionType==='call';
  const marketOrFair = sug.marketPrice ?? sug.fairValue;
  const breakeven = isCall ? strike + marketOrFair : strike - marketOrFair;
  document.getElementById('sugBE').textContent = fmt(breakeven);

  if(sug.marketPrice!=null){
    document.getElementById('sugMarket').textContent = fmt(sug.marketPrice);
    const diffEl = document.getElementById('sugDiff');
    diffEl.textContent = (sug.mispricingPct>=0?'+':'')+sug.mispricingPct.toFixed(2)+'%';
    diffEl.className = 'v ' + (sug.mispricingPct>2 ? 'neg' : sug.mispricingPct<-2 ? 'pos' : '');
    document.getElementById('sugIV').textContent = document.getElementById('ivImplied').textContent;
    priceLabelEl.textContent = 'Suggested Entry Price';
  } else {
    document.getElementById('sugMarket').textContent = 'not available';
    document.getElementById('sugDiff').textContent = '—';
    document.getElementById('sugIV').textContent = '—';
    priceLabelEl.textContent = 'Model Fair Value';
  }

  const verdictClass =
    (sug.verdict==='UNDERVALUED' || sug.verdict==='ATTRACTIVE') ? 'buy' :
    (sug.verdict==='OVERPRICED') ? 'avoid' : 'wait';
  verdictEl.className = 'sug-verdict ' + verdictClass;
  verdictEl.textContent = sug.headline;
  subEl.textContent = {
    UNDERVALUED:'Market premium sits well below model fair value.',
    ATTRACTIVE:'Trading modestly below fair value.',
    FAIR:'Market premium is close to model fair value.',
    SLIGHTLY_RICH:'Premium trading above model fair value.',
    OVERPRICED:'Premium is well above model fair value.',
    MODEL_FAIR_VALUE:'No live premium entered yet.'
  }[sug.verdict] || '';
}

/* ============================================================
   SCENARIO P&L (spot move x time elapsed, long position)
============================================================ */
const SCENARIO_MOVES = [-0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10];

// Compact INR for the narrow sidebar: 1.2k, 3.4L (lakh), 1.1Cr.
function fmtCompact(v){
  const a = Math.abs(v), sign = v>0 ? '+' : v<0 ? '−' : '';
  if(a>=1e7) return sign + (a/1e7).toFixed(2) + 'Cr';
  if(a>=1e5) return sign + (a/1e5).toFixed(2) + 'L';
  if(a>=1e3) return sign + (a/1e3).toFixed(1) + 'k';
  return sign + a.toFixed(a<10 ? 2 : 0);
}

function renderScenarios(p, days, type, premium){
  const tbody = document.querySelector('#scenarioTable tbody');
  if(!premium || !days){ tbody.innerHTML = '<tr><td colspan="4" class="empty">Needs a premium and days to expiry.</td></tr>'; return; }
  const ref = companiesRef.find(c=>c.symbol===currentSymbol);
  const qty = ref && ref.lotSize ? ref.lotSize : 1;
  document.getElementById('scenarioUnit').textContent = qty>1 ? `per lot (${qty}) · long` : 'per unit · long';

  // Columns are days elapsed: +1 day, halfway, expiry (or just now / expiry when it's that close).
  const half = Math.floor(days/2);
  const cols = days>=4
    ? [{label:'+1d', left:days-1}, {label:`+${half}d`, left:days-half}, {label:'Expiry', left:0}]
    : [{label:'Now', left:days}, {label:'Expiry', left:0}];
  document.querySelector('#scenarioTable thead').innerHTML =
    `<tr><th>Spot</th>${cols.map(c=>`<th>${c.label}</th>`).join('')}</tr>`;

  const value = (S, d)=>{
    const bs = blackScholes(S, p.K, d/365, p.r, p.sigma, p.q);
    return type==='call' ? bs.call : bs.put;
  };
  tbody.innerHTML = SCENARIO_MOVES.map(m=>{
    const S = p.S*(1+m);
    const cells = cols.map(({left})=>{
      const pnl = (value(S, left) - premium) * qty;
      return `<td class="${pnl>0?'pos':pnl<0?'neg':''}">${fmtCompact(pnl)}</td>`;
    }).join('');
    const label = m===0 ? 'Flat' : `${m>0?'+':''}${(m*100).toFixed(0)}%`;
    return `<tr class="${m===0?'now':''}" title="Spot ${fmt(S)}"><td>${label}</td>${cells}</tr>`;
  }).join('');
}

/* ============================================================
   CHARTS
============================================================ */
const CHART_FONT = { family:'JetBrains Mono', size:9.5 };
const TICK = { color:'#5c5d54', font:CHART_FONT };
const GRID = { color:'#1d1e18' };

// Compact rupee ticks: ₹950, ₹24.5k, ₹1.2L.
function inrTick(v){
  const a = Math.abs(v), sign = v<0 ? '−' : '';
  if(a>=1e5) return sign+'₹'+(a/1e5).toFixed(a>=1e6?0:1)+'L';
  if(a>=1e3) return sign+'₹'+(a/1e3).toFixed(a>=1e4?1:2).replace(/\.?0+$/,'')+'k';
  return sign+'₹'+a.toFixed(a<10?1:0);
}
const inrFull = (v)=> '₹'+Number(v).toLocaleString('en-IN',{minimumFractionDigits:2, maximumFractionDigits:2});

function axisTitle(text){ return { display:true, text, color:'#7d7e72', font:{ family:'JetBrains Mono', size:9.5 } }; }

function baseChartOptions(extra={}){
  return Object.assign({
    responsive:true, maintainAspectRatio:false,
    interaction:{ mode:'index', intersect:false },
    plugins:{
      legend:{ labels:{ color:'#9b9c8f', font:{ family:'JetBrains Mono', size:10 }, boxWidth:12 } },
      tooltip:{
        backgroundColor:'#16170f', borderColor:'#282a22', borderWidth:1, titleColor:'#ffb020', bodyColor:'#eae7dc',
        titleFont:{family:'JetBrains Mono'}, bodyFont:{family:'JetBrains Mono', size:11},
        callbacks:{
          // Datasets can set `fmt` to format their values; rupees with 2 decimals otherwise.
          label:(ctx)=> `${ctx.dataset.label}: ${(ctx.dataset.fmt || inrFull)(ctx.parsed.y)}`
        }
      }
    },
    scales:{
      x:{ ticks:{ ...TICK, maxRotation:0, autoSkip:true, maxTicksLimit:7 }, grid:GRID },
      y:{ ticks:{ ...TICK, callback:inrTick }, grid:GRID }
    }
  }, extra);
}

/* Dashed vertical guide lines (spot, strike, breakeven...). Set per chart via
   options.plugins.markers.lines = [{x, label, color}]; x is in data units
   (or a category index on category axes). */
const markerPlugin = {
  id:'markers',
  afterDatasetsDraw(chart, args, opts){
    const lines = (opts && opts.lines) || [];
    const {ctx, chartArea:{top, bottom, left, right}, scales:{x}} = chart;
    ctx.save();
    ctx.font = '600 9px JetBrains Mono, monospace';
    const rowEnds = [];   // right edge of the last label in each text row
    lines
      .map(m=>({ ...m, px:x.getPixelForValue(m.x) }))
      .filter(m=> isFinite(m.px) && m.px>=left && m.px<=right)
      .sort((a,b)=> a.px-b.px)
      .forEach(m=>{
        ctx.strokeStyle = m.color; ctx.lineWidth = 1; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(m.px, top); ctx.lineTo(m.px, bottom); ctx.stroke();
        ctx.setLineDash([]);
        const w = ctx.measureText(m.label).width;
        const tx = Math.min(Math.max(m.px - w/2, left), right - w);
        // Drop to the next row if this label would collide with one already drawn.
        let row = rowEnds.findIndex(end=> tx > end + 4);
        if(row === -1){ row = rowEnds.length; rowEnds.push(0); }
        rowEnds[row] = tx + w;
        ctx.fillStyle = m.color;
        ctx.fillText(m.label, tx, top + 10 + row*11);
      });
    ctx.restore();
  }
};
if(window.Chart) Chart.register(markerPlugin);

// Plugins block for one chart: the shared tooltip plus an optional title
// formatter and marker lines.
function chartPlugins({ title, label, markers=[], legend }={}){
  const base = baseChartOptions().plugins;
  return {
    ...base,
    ...(legend ? { legend } : {}),
    tooltip:{ ...base.tooltip, callbacks:{ ...base.tooltip.callbacks, ...(title ? {title} : {}), ...(label ? {label} : {}) } },
    markers:{ lines:markers }
  };
}

function makeLineChart(ctxId, labels, datasets, extraOpts={}){
  if(charts[ctxId]) charts[ctxId].destroy();
  const ctx = document.getElementById(ctxId).getContext('2d');
  charts[ctxId] = new Chart(ctx, { type:'line', data:{ labels, datasets }, options: baseChartOptions(extraOpts) });
}

// Spot-axis charts: zoom to where the action is (about ±3 standard deviations
// of the move to expiry, at least ±5%, at most ±50%) instead of a fixed ±50%.
// The window is snapped to a round tick step (e.g. 1,000 or 2,500) so the
// axis reads 21,000 · 23,000 · 25,000 rather than 20,326 · 24,000 · 28,699.
function spotWindow(S, sigma, T){
  const half = Math.min(Math.max(3*sigma*Math.sqrt(T), 0.05), 0.5);
  const raw = S*2*half/5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m=>m*mag).find(st=>st>=raw);
  return [Math.floor(S*(1-half)/step)*step, Math.ceil(S*(1+half)/step)*step, step];
}
function spotAxis(range, title='Price of underlying'){
  return { type:'linear', min:range[0], max:range[1],
    ticks:{ ...TICK, maxRotation:0, stepSize:range[2], callback:(v)=>Math.round(v).toLocaleString('en-IN') },
    grid:GRID, title:axisTitle(title) };
}
const spotTooltipTitle = (items)=> items.length ? 'Spot '+inrFull(items[0].parsed.x) : '';

function renderCharts(p, T, isCall){
  const {S,K,r,sigma,q} = p;
  const side = isCall ? 'Call' : 'Put';
  const bsNow = blackScholes(S,K,T,r,sigma,q);
  const premium = parseFloat(document.getElementById('pMarket').value) || (isCall ? bsNow.call : bsNow.put);
  const breakeven = isCall ? K + premium : K - premium;
  const win = spotWindow(S, sigma, T), [lo, hi] = win;
  const xs = Array.from({length:81}, (_,i)=> lo + (hi-lo)*i/80);
  const markSpot = { x:S, label:'Spot', color:'#7fd4ff' };
  const markStrike = { x:K, label:'Strike', color:'#ffb020' };
  const spotScales = (yTitle)=>({ x:spotAxis(win), y:{ ticks:{ ...TICK, callback:inrTick }, grid:GRID, title:axisTitle(yTitle) } });

  // 1. Payoff: what YOU make or lose at expiry after paying the premium.
  const pnl = xs.map(s=>({ x:s, y:(isCall ? Math.max(s-K,0) : Math.max(K-s,0)) - premium }));
  const gross = xs.map(s=>({ x:s, y: isCall ? Math.max(s-K,0) : Math.max(K-s,0) }));
  makeLineChart('chartPayoff', undefined, [
    { label:`Your P&L (long ${side.toLowerCase()})`, data:pnl, borderColor:isCall?'#3ddc84':'#ff5c5c', borderWidth:2.5, pointRadius:0,
      fill:{ target:'origin', above:'rgba(61,220,132,0.12)', below:'rgba(255,92,92,0.12)' } },
    { label:'Payoff before premium', data:gross, borderColor:'#5c5d54', borderWidth:1, borderDash:[4,3], pointRadius:0 }
  ], { scales:spotScales('Profit / loss per unit'),
       plugins:chartPlugins({ title:spotTooltipTitle, markers:[markSpot, markStrike, { x:breakeven, label:'Breakeven', color:'#3ddc84' }] }) });

  // 2. Value today across spot prices.
  const vsSpot = xs.map(s=>blackScholes(s,K,T,r,sigma,q));
  makeLineChart('chartVsSpot', undefined, [
    { label:'Call', data:vsSpot.map((b,i)=>({x:xs[i], y:b.call})), borderColor:'#3ddc84', pointRadius:0, borderWidth:isCall?2.5:1.2, tension:0.15 },
    { label:'Put', data:vsSpot.map((b,i)=>({x:xs[i], y:b.put})), borderColor:'#ff5c5c', pointRadius:0, borderWidth:isCall?1.2:2.5, tension:0.15 }
  ], { scales:spotScales('Option price today'),
       plugins:chartPlugins({ title:spotTooltipTitle, markers:[markSpot, markStrike] }) });

  // 3. Value across volatility levels, with the σ in use marked.
  const vols = Array.from({length:51}, (_,i)=> 5 + 75*i/50);
  const vsVol = vols.map(v=>blackScholes(S,K,T,r,v/100,q));
  makeLineChart('chartVsVol', undefined, [
    { label:'Call', data:vsVol.map((b,i)=>({x:vols[i], y:b.call})), borderColor:'#3ddc84', pointRadius:0, borderWidth:isCall?2.5:1.2, tension:0.15 },
    { label:'Put', data:vsVol.map((b,i)=>({x:vols[i], y:b.put})), borderColor:'#ff5c5c', pointRadius:0, borderWidth:isCall?1.2:2.5, tension:0.15 }
  ], { scales:{ x:{ type:'linear', min:5, max:80, ticks:{ ...TICK, maxRotation:0, callback:(v)=>v+'%' }, grid:GRID, title:axisTitle('Volatility (σ)') },
                y:{ ticks:{ ...TICK, callback:inrTick }, grid:GRID, title:axisTitle('Option price') } },
       plugins:chartPlugins({ title:(it)=> it.length ? `σ = ${it[0].parsed.x.toFixed(1)}%` : '', markers:[{ x:sigma*100, label:'σ used', color:'#ffb020' }] }) });

  // 4. Decay from today to the actual expiry: x is days remaining, so the
  // curve steepens toward the right as theta accelerates.
  const daysLeft = Math.max(Math.round(T*365), 1);
  const steps = Math.min(daysLeft, 60);
  const timeLabels=[], callVsTime=[], putVsTime=[], intrinsic=[];
  const intrinsicNow = isCall ? Math.max(S-K,0) : Math.max(K-S,0);
  for(let i=0;i<=steps;i++){
    const d = daysLeft*(1 - i/steps);
    const bs = blackScholes(S,K,d/365,r,sigma,q);
    timeLabels.push(Math.round(d)+'d');
    callVsTime.push(bs.call); putVsTime.push(bs.put); intrinsic.push(intrinsicNow);
  }
  makeLineChart('chartVsTime', timeLabels, [
    { label:'Call', data:callVsTime, borderColor:'#3ddc84', pointRadius:0, borderWidth:isCall?2.5:1.2, tension:0.15 },
    { label:'Put', data:putVsTime, borderColor:'#ff5c5c', pointRadius:0, borderWidth:isCall?1.2:2.5, tension:0.15 },
    { label:`${side} intrinsic`, data:intrinsic, borderColor:'#5c5d54', pointRadius:0, borderWidth:1, borderDash:[4,3] }
  ], { scales:{ x:{ ticks:{ ...TICK, maxRotation:0, autoSkip:true, maxTicksLimit:8 }, grid:GRID, title:axisTitle('Days left to expiry') },
                y:{ ticks:{ ...TICK, callback:inrTick }, grid:GRID, title:axisTitle('Option price') } } });

  // 5. Delta & gamma across spot prices.
  const gks = xs.map(s=>bsGreeks(s,K,T,r,sigma,q));
  const num4 = (v)=> Number(v).toFixed(4), num6 = (v)=> Number(v).toFixed(6);
  makeLineChart('chartGreeksSpot', undefined, [
    { label:`${side} delta`, data:gks.map((g,i)=>({x:xs[i], y:isCall?g.callDelta:g.putDelta})), borderColor:'#ffb020', pointRadius:0, borderWidth:2, tension:0.15, yAxisID:'y', fmt:num4 },
    { label:'Gamma', data:gks.map((g,i)=>({x:xs[i], y:g.gamma})), borderColor:'#7fd4ff', pointRadius:0, borderWidth:2, tension:0.15, yAxisID:'y1', fmt:num6 }
  ], { scales:{ x:spotAxis(win),
                y:{ position:'left', ticks:TICK, grid:GRID, title:axisTitle('Delta') },
                y1:{ position:'right', ticks:{ ...TICK, callback:(v)=> v===0 ? '0' : String(Number(v.toPrecision(2))) }, grid:{ display:false }, title:axisTitle('Gamma') } },
       plugins:chartPlugins({ title:spotTooltipTitle, markers:[markSpot, markStrike] }) });

  // 6. Where Monte Carlo paths end up at expiry.
  const samples = sampleTerminalPrices(S,T,r,sigma,q,20000);
  const min=Math.min(...samples), max=Math.max(...samples);
  const bins=40; const width=(max-min)/bins;
  const counts=new Array(bins).fill(0);
  samples.forEach(v=>{ let idx=Math.floor((v-min)/width); if(idx>=bins) idx=bins-1; if(idx<0) idx=0; counts[idx]++; });
  const binLabels = counts.map((_,i)=> Math.round(min+(i+0.5)*width).toLocaleString('en-IN'));
  const binOf = (v)=> Math.min(bins-1, Math.max(0, Math.floor((v-min)/width)));
  const strikeBinIdx = binOf(K);
  const barColors = counts.map((_,i)=> {
    const itm = isCall ? (min+(i+0.5)*width) > K : (min+(i+0.5)*width) < K;
    return itm ? 'rgba(61,220,132,0.55)' : 'rgba(255,176,32,0.3)';
  });
  const pct = (v)=> (v/samples.length*100).toFixed(1)+'% of paths';
  if(charts['chartMC']) charts['chartMC'].destroy();
  charts['chartMC'] = new Chart(document.getElementById('chartMC').getContext('2d'), {
    type:'bar',
    data:{ labels:binLabels, datasets:[{ label:`Paths ending here (green = ${side.toLowerCase()} in the money)`, data:counts, backgroundColor:barColors, borderWidth:0, fmt:pct }] },
    options: baseChartOptions({
      plugins:chartPlugins({ legend:{ display:false }, title:(it)=> it.length ? '≈ ₹'+it[0].label : '', label:(ctx)=> pct(ctx.parsed.y),
                markers:[{ x:binOf(S), label:'Spot', color:'#7fd4ff' }, { x:strikeBinIdx, label:'Strike', color:'#ffb020' }] }),
      scales:{
        x:{ ticks:{ ...TICK, maxRotation:0, autoSkip:true, maxTicksLimit:6 }, grid:{ display:false }, title:axisTitle('Price at expiry') },
        y:{ ticks:{ ...TICK, callback:(v)=> (v/samples.length*100).toFixed(0)+'%' }, grid:GRID, title:axisTitle('Share of paths') }
      }
    })
  });
}

/* ============================================================
   IV SMILE (NSE-reported IV across strikes for one expiry)
============================================================ */
function ivNearest(points, target){
  let best = null;
  points.forEach(p=>{ if(!best || Math.abs(p.x-target) < Math.abs(best.x-target)) best = p; });
  return best;
}

const ivPct = (v)=> Number(v).toFixed(2)+'%';

function renderSmile(expiry){
  const legs = currentChain && currentChain.chain[expiry];
  if(!legs) return;
  const spot = currentChain.spot;
  const strikes = Object.keys(legs).map(Number).sort((a,b)=>a-b);
  // NSE reports IV 0 for strikes that haven't traded; leave those out.
  const callPts = strikes.filter(k=>legs[k].CE?.impliedVolatility>0).map(k=>({x:k, y:legs[k].CE.impliedVolatility}));
  const putPts  = strikes.filter(k=>legs[k].PE?.impliedVolatility>0).map(k=>({x:k, y:legs[k].PE.impliedVolatility}));
  // The usual "OTM smile": put IV below spot, call IV above it.
  const otmPts = [...putPts.filter(p=>p.x<spot), ...callPts.filter(p=>p.x>=spot)];

  const all = [...callPts, ...putPts].map(p=>p.y);
  const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  const spotLine = [{x:spot, y:lo}, {x:spot, y:hi}];

  const atm = ivNearest(otmPts, spot);
  const put95 = ivNearest(putPts, spot*0.95), call105 = ivNearest(callPts, spot*1.05);
  const tag = document.getElementById('smileTag');
  tag.textContent = atm
    ? `ATM IV ${atm.y.toFixed(1)}%` + (put95 && call105 ? ` · skew ${(put95.y-call105.y>=0?'+':'')}${(put95.y-call105.y).toFixed(1)} pts` : '')
    : 'no IV data';
  tag.title = 'Skew = IV of the ~5% OTM put minus IV of the ~5% OTM call';

  if(charts['chartSmile']) charts['chartSmile'].destroy();
  const tick = { color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} };
  charts['chartSmile'] = new Chart(document.getElementById('chartSmile').getContext('2d'), {
    type:'line',
    data:{ datasets:[
      { label:'OTM smile', data:otmPts, fmt:ivPct, borderColor:'#ffb020', pointRadius:2, borderWidth:2, tension:0.25 },
      { label:'Call IV', data:callPts, fmt:ivPct, borderColor:'rgba(61,220,132,0.6)', pointRadius:0, borderWidth:1, borderDash:[4,3], tension:0.25 },
      { label:'Put IV', data:putPts, fmt:ivPct, borderColor:'rgba(255,92,92,0.6)', pointRadius:0, borderWidth:1, borderDash:[4,3], tension:0.25 },
      { label:'Spot', data:spotLine, fmt:ivPct, borderColor:'#7fd4ff', pointRadius:0, borderWidth:1, borderDash:[2,2] }
    ]},
    options: baseChartOptions({
      interaction:{ mode:'nearest', intersect:false },
      scales:{
        x:{ type:'linear', ticks:tick, grid:{ color:'#1d1e18' }, title:{ display:true, text:'Strike', color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} } },
        y:{ ticks:{ ...tick, callback:(v)=>v+'%' }, grid:{ color:'#1d1e18' } }
      }
    })
  });
}

/* ============================================================
   INIT
============================================================ */
(async function init(){
  await loadCompanies();
  // Free Render instances sleep when idle and take ~30-60s to wake, so the
  // first health check often fails. Keep retrying for a while before giving up.
  setStatus('CONNECTING TO BACKEND…', 'pending');
  for(let attempt=1; attempt<=8; attempt++){
    try{
      await Api.health();
      setStatus('BACKEND CONNECTED — SEARCH A SYMBOL');
      return;
    }catch(e){
      setStatus(`WAKING BACKEND… (attempt ${attempt}/8)`, 'pending');
      await new Promise(res=>setTimeout(res, 8000));
    }
  }
  setStatus('BACKEND UNREACHABLE', 'error');
  showError(`Could not reach the backend at ${API_BASE}. Check that it is deployed and running.`);
})();
