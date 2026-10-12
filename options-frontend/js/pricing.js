/* Client-side Black-Scholes / CRR / Monte Carlo — mirrors backend/pricing.py.
   Used to draw chart curves instantly and to let the user run local
   what-if recalculations without a round trip to the backend. */

function erf(x){
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1/(1+p*x);
  const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normCDF(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function normPDF(x){ return Math.exp(-x*x/2)/Math.sqrt(2*Math.PI); }

function blackScholes(S,K,T,r,sigma,q){
  if(T<=0){ return {call:Math.max(S-K,0), put:Math.max(K-S,0), d1:NaN, d2:NaN}; }
  const d1 = (Math.log(S/K) + (r-q+0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const call = S*Math.exp(-q*T)*normCDF(d1) - K*Math.exp(-r*T)*normCDF(d2);
  const put  = K*Math.exp(-r*T)*normCDF(-d2) - S*Math.exp(-q*T)*normCDF(-d1);
  return {call, put, d1, d2};
}

function bsGreeks(S,K,T,r,sigma,q){
  const d1 = (Math.log(S/K) + (r-q+0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const pdfD1 = normPDF(d1);
  const callDelta = Math.exp(-q*T)*normCDF(d1);
  const putDelta  = Math.exp(-q*T)*(normCDF(d1)-1);
  const gamma = Math.exp(-q*T)*pdfD1/(S*sigma*Math.sqrt(T));
  const vega = S*Math.exp(-q*T)*pdfD1*Math.sqrt(T);
  const callTheta = -(S*Math.exp(-q*T)*pdfD1*sigma/(2*Math.sqrt(T))) - r*K*Math.exp(-r*T)*normCDF(d2) + q*S*Math.exp(-q*T)*normCDF(d1);
  const putTheta  = -(S*Math.exp(-q*T)*pdfD1*sigma/(2*Math.sqrt(T))) + r*K*Math.exp(-r*T)*normCDF(-d2) - q*S*Math.exp(-q*T)*normCDF(-d1);
  const callRho = K*T*Math.exp(-r*T)*normCDF(d2);
  const putRho  = -K*T*Math.exp(-r*T)*normCDF(-d2);
  return {callDelta,putDelta,gamma,vega,callTheta,putTheta,callRho,putRho};
}

function crrPrice(S,K,T,r,sigma,q,steps,type,american){
  const dt = T/steps;
  const u = Math.exp(sigma*Math.sqrt(dt));
  const d = 1/u;
  const disc = Math.exp(-r*dt);
  const p = (Math.exp((r-q)*dt) - d) / (u-d);
  let values = new Float64Array(steps+1);
  for(let j=0;j<=steps;j++){
    const sp = S * Math.pow(u,j) * Math.pow(d,steps-j);
    values[j] = type==='call' ? Math.max(sp-K,0) : Math.max(K-sp,0);
  }
  for(let i=steps-1;i>=0;i--){
    const next = new Float64Array(i+1);
    for(let j=0;j<=i;j++){
      const cont = disc*(p*values[j+1] + (1-p)*values[j]);
      if(american){
        const sp = S * Math.pow(u,j) * Math.pow(d,i-j);
        const ex = type==='call' ? Math.max(sp-K,0) : Math.max(K-sp,0);
        next[j] = Math.max(cont, ex);
      } else {
        next[j] = cont;
      }
    }
    values = next;
  }
  return values[0];
}

function monteCarlo(S,K,T,r,sigma,q,sims,type){
  let sum=0, sumSq=0;
  const drift = (r-q-0.5*sigma*sigma)*T;
  const diff = sigma*Math.sqrt(T);
  for(let i=0;i<sims;i+=2){
    const u1=Math.random(), u2=Math.random();
    const mag = Math.sqrt(-2*Math.log(u1));
    const z0 = mag*Math.cos(2*Math.PI*u2);
    const z1 = mag*Math.sin(2*Math.PI*u2);
    for(const z of [z0,z1]){
      const ST = S*Math.exp(drift + diff*z);
      const payoff = type==='call' ? Math.max(ST-K,0) : Math.max(K-ST,0);
      sum += payoff; sumSq += payoff*payoff;
    }
  }
  const n = sims % 2 === 0 ? sims : sims+1;
  const mean = sum/n;
  const variance = Math.max(sumSq/n - mean*mean, 0);
  const price = Math.exp(-r*T)*mean;
  const se = Math.exp(-r*T)*Math.sqrt(variance/n);
  return {price, se};
}

function sampleTerminalPrices(S,T,r,sigma,q,n){
  const out = new Float64Array(n);
  const drift = (r-q-0.5*sigma*sigma)*T;
  const diff = sigma*Math.sqrt(T);
  for(let i=0;i<n;i+=2){
    const u1=Math.random(), u2=Math.random();
    const mag = Math.sqrt(-2*Math.log(u1));
    const z0 = mag*Math.cos(2*Math.PI*u2);
    const z1 = mag*Math.sin(2*Math.PI*u2);
    out[i] = S*Math.exp(drift + diff*z0);
    if(i+1<n) out[i+1] = S*Math.exp(drift + diff*z1);
  }
  return out;
}

function impliedVol(marketPrice,S,K,T,r,q,type){
  let lo=0.001, hi=5.0;
  const f = (vol)=>{
    const bs = blackScholes(S,K,T,r,vol,q);
    return (type==='call'?bs.call:bs.put) - marketPrice;
  };
  let flo=f(lo), fhi=f(hi);
  if(isNaN(flo)||isNaN(fhi)||flo*fhi>0) return NaN;
  for(let i=0;i<80;i++){
    const mid=(lo+hi)/2, fm=f(mid);
    if(Math.abs(fm)<1e-6) return mid;
    if(flo*fm<0){ hi=mid; fhi=fm; } else { lo=mid; flo=fm; }
  }
  return (lo+hi)/2;
}

/* Local suggestion heuristic — mirrors backend/pricing.py build_suggestion(),
   used when running a client-side what-if recompute. */
function buildSuggestionLocal(K, type, fairValue, marketPrice, gk){
  const theta = (type==='call' ? gk.callTheta : gk.putTheta)/365;
  const zoneLow = fairValue*0.97, zoneHigh = fairValue*1.01;
  const base = { fairValue, thetaPerDay: theta, thetaFiveDay: theta*5, zoneLow, zoneHigh };
  if(!marketPrice || fairValue <= 1e-8){
    return Object.assign(base, {
      verdict:'MODEL_FAIR_VALUE', headline:'MODEL FAIR VALUE', suggestedEntry: fairValue,
      reasoning: `No live premium supplied — this is the theoretical fair value. Reasonable entry zone: ${zoneLow.toFixed(2)} to ${zoneHigh.toFixed(2)}.`
    });
  }
  const diffPct = (marketPrice - fairValue)/fairValue;
  let verdict, headline, entry, reasoning;
  if(diffPct <= -0.08){
    verdict='UNDERVALUED'; headline=`BUY ${type.toUpperCase()} — UNDERVALUED`; entry=marketPrice;
    reasoning = `LTP (${marketPrice.toFixed(2)}) is ${Math.abs(diffPct*100).toFixed(1)}% below fair value (${fairValue.toFixed(2)}).`;
  } else if(diffPct <= -0.02){
    verdict='ATTRACTIVE'; headline=`${type.toUpperCase()} LOOKS ATTRACTIVE`; entry=Math.min(marketPrice, zoneHigh);
    reasoning = `LTP is ${Math.abs(diffPct*100).toFixed(1)}% cheaper than fair value (${fairValue.toFixed(2)}).`;
  } else if(diffPct < 0.02){
    verdict='FAIR'; headline='FAIRLY PRICED'; entry=fairValue;
    reasoning = `LTP is within ~2% of fair value (${fairValue.toFixed(2)}).`;
  } else if(diffPct <= 0.08){
    verdict='SLIGHTLY_RICH'; headline='SLIGHTLY RICH — WAIT'; entry=zoneHigh;
    reasoning = `LTP is ${(diffPct*100).toFixed(1)}% above fair value. Consider waiting for a pullback toward ${fairValue.toFixed(2)}.`;
  } else {
    verdict='OVERPRICED'; headline=`${type.toUpperCase()} OVERPRICED — AVOID`; entry=fairValue;
    reasoning = `LTP is ${(diffPct*100).toFixed(1)}% above fair value (${fairValue.toFixed(2)}).`;
  }
  return Object.assign(base, { verdict, headline, marketPrice, mispricingPct: diffPct*100, suggestedEntry: entry, reasoning });
}

/* Probability of the underlying finishing above `level` at expiry under the
   risk-neutral (Black-Scholes) measure: N(d2) evaluated with K = level. */
function probAbove(S,level,T,r,sigma,q){
  if(level<=0) return 1;
  const d2 = (Math.log(S/level) + (r-q-0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  return normCDF(d2);
}

/* Probability read-outs for a long option bought at `premium`. */
function probabilityMetrics(S,K,T,r,sigma,q,type,premium){
  const isCall = type==='call';
  const pAboveK = probAbove(S,K,T,r,sigma,q);
  const breakeven = isCall ? K+premium : K-premium;
  const pAboveBE = probAbove(S,breakeven,T,r,sigma,q);
  const pITM = isCall ? pAboveK : 1-pAboveK;
  const sdMove = sigma*Math.sqrt(T);
  return {
    pITM,
    pProfit: isCall ? pAboveBE : (breakeven>0 ? 1-pAboveBE : 0),
    // Reflection-principle approximation: P(touch) ~ 2 x P(finish beyond K), capped at 1.
    pTouch: (isCall ? S>=K : S<=K) ? 1 : Math.min(1, 2*pITM),
    breakeven,
    breakevenMovePct: (breakeven-S)/S,
    expectedMove: S*sdMove,
    rangeLow: S*Math.exp(-sdMove),
    rangeHigh: S*Math.exp(sdMove)
  };
}
