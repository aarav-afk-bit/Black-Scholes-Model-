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

  document.getElementById('ctExpiry').textContent = data.expiry;
  document.getElementById('ctDays').textContent = data.daysToExpiry;
  document.getElementById('ctStrike').textContent = data.strike;
  document.getElementById('ctType').textContent = data.optionType.toUpperCase();

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

  fillResultCards(bs, {
    callDelta:gk.callDelta, putDelta:gk.putDelta, gamma:gk.gamma, vega:gk.vega,
    callTheta:gk.callTheta, putTheta:gk.putTheta, callRho:gk.callRho, putRho:gk.putRho
  }, { european:crrEuro, american:crrAmerican, earlyExercisePremium:crrAmerican-crrEuro },
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

  renderCharts({S,K,r,sigma,q}, T, isCall);
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
   CHARTS
============================================================ */
function baseChartOptions(extra={}){
  return Object.assign({
    responsive:true, maintainAspectRatio:false,
    interaction:{ mode:'index', intersect:false },
    plugins:{
      legend:{ labels:{ color:'#9b9c8f', font:{ family:'JetBrains Mono', size:10 }, boxWidth:12 } },
      tooltip:{ backgroundColor:'#16170f', borderColor:'#282a22', borderWidth:1, titleColor:'#ffb020', bodyColor:'#eae7dc', titleFont:{family:'JetBrains Mono'}, bodyFont:{family:'JetBrains Mono', size:11} }
    },
    scales:{
      x:{ ticks:{ color:'#5c5d54', font:{ family:'JetBrains Mono', size:9.5 } }, grid:{ color:'#1d1e18' } },
      y:{ ticks:{ color:'#5c5d54', font:{ family:'JetBrains Mono', size:9.5 } }, grid:{ color:'#1d1e18' } }
    }
  }, extra);
}
function makeLineChart(ctxId, labels, datasets, extraOpts={}){
  if(charts[ctxId]) charts[ctxId].destroy();
  const ctx = document.getElementById(ctxId).getContext('2d');
  charts[ctxId] = new Chart(ctx, { type:'line', data:{ labels, datasets }, options: baseChartOptions(extraOpts) });
}

function renderCharts(p, T, isCall){
  const {S,K,r,sigma,q} = p;

  const spotRange=[], callPayoff=[], putPayoff=[];
  for(let i=0;i<=60;i++){ const s=S*0.5+(S*1.5-S*0.5)*i/60; spotRange.push(s.toFixed(0)); callPayoff.push(Math.max(s-K,0)); putPayoff.push(Math.max(K-s,0)); }
  makeLineChart('chartPayoff', spotRange, [
    { label:'Call Payoff', data:callPayoff, borderColor:'#3ddc84', backgroundColor:'rgba(61,220,132,0.08)', fill:true, pointRadius:0, borderWidth:2 },
    { label:'Put Payoff', data:putPayoff, borderColor:'#ff5c5c', backgroundColor:'rgba(255,92,92,0.06)', fill:true, pointRadius:0, borderWidth:2 }
  ]);

  const spotLabels=[], callVsSpot=[], putVsSpot=[];
  for(let i=0;i<=50;i++){ const s=S*0.5+(S*1.5-S*0.5)*i/50; const bs=blackScholes(s,K,T,r,sigma,q); spotLabels.push(s.toFixed(0)); callVsSpot.push(bs.call); putVsSpot.push(bs.put); }
  makeLineChart('chartVsSpot', spotLabels, [
    { label:'Call', data:callVsSpot, borderColor:'#3ddc84', pointRadius:0, borderWidth:2, tension:0.15 },
    { label:'Put', data:putVsSpot, borderColor:'#ff5c5c', pointRadius:0, borderWidth:2, tension:0.15 }
  ]);

  const volLabels=[], callVsVol=[], putVsVol=[];
  for(let i=0;i<=50;i++){ const v=0.05+(0.80-0.05)*i/50; const bs=blackScholes(S,K,T,r,v,q); volLabels.push((v*100).toFixed(0)+'%'); callVsVol.push(bs.call); putVsVol.push(bs.put); }
  makeLineChart('chartVsVol', volLabels, [
    { label:'Call', data:callVsVol, borderColor:'#3ddc84', pointRadius:0, borderWidth:2, tension:0.15 },
    { label:'Put', data:putVsVol, borderColor:'#ff5c5c', pointRadius:0, borderWidth:2, tension:0.15 }
  ]);

  const timeLabels=[], callVsTime=[], putVsTime=[];
  for(let i=0;i<=50;i++){ const t=(1/365)+(2-1/365)*i/50; const bs=blackScholes(S,K,t,r,sigma,q); timeLabels.push(t.toFixed(2)); callVsTime.push(bs.call); putVsTime.push(bs.put); }
  makeLineChart('chartVsTime', timeLabels, [
    { label:'Call', data:callVsTime, borderColor:'#3ddc84', pointRadius:0, borderWidth:2, tension:0.15 },
    { label:'Put', data:putVsTime, borderColor:'#ff5c5c', pointRadius:0, borderWidth:2, tension:0.15 }
  ]);

  const dLabels=[], deltaVals=[], gammaVals=[];
  for(let i=0;i<=50;i++){ const s=S*0.5+(S*1.5-S*0.5)*i/50; const g=bsGreeks(s,K,T,r,sigma,q); dLabels.push(s.toFixed(0)); deltaVals.push(isCall?g.callDelta:g.putDelta); gammaVals.push(g.gamma); }
  if(charts['chartGreeksSpot']) charts['chartGreeksSpot'].destroy();
  charts['chartGreeksSpot'] = new Chart(document.getElementById('chartGreeksSpot').getContext('2d'), {
    type:'line',
    data:{ labels:dLabels, datasets:[
      { label:'Delta', data:deltaVals, borderColor:'#ffb020', pointRadius:0, borderWidth:2, tension:0.15, yAxisID:'y' },
      { label:'Gamma', data:gammaVals, borderColor:'#7fd4ff', pointRadius:0, borderWidth:2, tension:0.15, yAxisID:'y1' }
    ]},
    options: baseChartOptions({
      scales:{
        x:{ ticks:{ color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} }, grid:{ color:'#1d1e18' } },
        y:{ position:'left', ticks:{ color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} }, grid:{ color:'#1d1e18' } },
        y1:{ position:'right', ticks:{ color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} }, grid:{ display:false } }
      }
    })
  });

  const samples = sampleTerminalPrices(S,T,r,sigma,q,20000);
  const min=Math.min(...samples), max=Math.max(...samples);
  const bins=40; const width=(max-min)/bins;
  const counts=new Array(bins).fill(0);
  samples.forEach(v=>{ let idx=Math.floor((v-min)/width); if(idx>=bins) idx=bins-1; if(idx<0) idx=0; counts[idx]++; });
  const binLabels = counts.map((_,i)=> (min+i*width).toFixed(0));
  const strikeBinIdx = Math.min(bins-1, Math.max(0, Math.floor((K-min)/width)));
  const barColors = counts.map((_,i)=> i===strikeBinIdx ? '#ffb020' : 'rgba(255,176,32,0.35)');
  if(charts['chartMC']) charts['chartMC'].destroy();
  charts['chartMC'] = new Chart(document.getElementById('chartMC').getContext('2d'), {
    type:'bar',
    data:{ labels:binLabels, datasets:[{ label:'Simulated ST', data:counts, backgroundColor:barColors, borderWidth:0 }] },
    options: baseChartOptions({
      plugins:{ legend:{ display:false } },
      scales:{
        x:{ ticks:{ color:'#5c5d54', font:{family:'JetBrains Mono', size:8.5}, maxTicksLimit:10 }, grid:{ display:false } },
        y:{ ticks:{ color:'#5c5d54', font:{family:'JetBrains Mono', size:9.5} }, grid:{ color:'#1d1e18' } }
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
      { label:'OTM smile', data:otmPts, borderColor:'#ffb020', pointRadius:2, borderWidth:2, tension:0.25 },
      { label:'Call IV', data:callPts, borderColor:'rgba(61,220,132,0.6)', pointRadius:0, borderWidth:1, borderDash:[4,3], tension:0.25 },
      { label:'Put IV', data:putPts, borderColor:'rgba(255,92,92,0.6)', pointRadius:0, borderWidth:1, borderDash:[4,3], tension:0.25 },
      { label:'Spot', data:spotLine, borderColor:'#7fd4ff', pointRadius:0, borderWidth:1, borderDash:[2,2] }
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
