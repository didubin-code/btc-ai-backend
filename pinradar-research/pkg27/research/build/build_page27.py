"""Build dist27/btc_pin_radar_27.html (Pin Radar 2.7 page) from the delivered 2.6 page (dist26/btc_pin_radar_26.html,
sha 7b55e88c...). Every patch must match exactly once.  usage: python3 build/build_page27.py
Adds: the requested decision block (LOCKED — PREDICTED UP / WIN PROBABILITY / REVERSAL PROBABILITY / SECONDS REMAINING /
CRITICAL REMAINING AVERAGE) and the exact settlement panel, each labelled OFFICIAL (CF Benchmarks BRTI via Kalshi) or
PROXY (exchange index + basis estimate)."""
import hashlib, os

ROOT = '/home/claude/pr25'
s = open(os.path.join(ROOT, 'dist26/btc_pin_radar_26.html')).read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('7b55e88ccb5e379a'):
    raise SystemExit('page27: dist26 page is not the delivered 2.6 page (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        raise SystemExit(f'page27: expected {count} match(es), found {n}: {old[:100]!r}')
    return s.replace(old, new)


s = rep(s, '<title>BTC Pin Radar 2.6 — LOCKED call + executable edge</title>', '<title>BTC Pin Radar 2.7 — settlement-aware LOCKED call</title>')
s = rep(s, '<div class="brand">BTC <span>Pin Radar 2.6</span> · LOCKED call + executable edge</div>',
        '<div class="brand">BTC <span>Pin Radar 2.7</span> · settlement-aware LOCKED call</div>')
s = rep(s, '    Pin Radar 2.6 · KXBTC15M settles', '    Pin Radar 2.7 · KXBTC15M settles')
s = rep(s, "const VERSION='pin-radar-2.6';", "const VERSION='pin-radar-2.7';")
s = rep(s, "localStorage.setItem('pinradar26',", "localStorage.setItem('pinradar27',")
s = rep(s, "localStorage.getItem('pinradar26')", "localStorage.getItem('pinradar27')")
NOTE_OLD = 'LOCKED = flip risk ≤ 0.5% in every volatility regime (validated out of sample), not a guarantee'
NOTE_NEW = 'LOCKED = predictive classification: flip risk ≤ 0.5% (validated out of sample), not a guarantee of the settlement'
s = rep(s, '<div class="callNote" id="callNote">' + NOTE_OLD + '</div>', '<div class="callNote" id="callNote">' + NOTE_NEW + '</div>')
s = rep(s, "  $('callNote').textContent=sg.guarantee||'" + NOTE_OLD + "';", "  $('callNote').textContent=sg.guarantee||'" + NOTE_NEW + "';")

# --- decision block under the probability line, settlement panel under the key-value grid ---
s = rep(s, '    <div class="callProb" id="callProb"></div>\n',
        '    <div class="callProb" id="callProb"></div>\n    <div class="d27" id="d27"></div>\n')
s = rep(s, '    <div class="proj" id="proj"></div>\n    <div class="valid" id="valid"></div>\n  </div>',
        '    <div class="settle" id="settle">\n'
        '      <div class="sHead"><span class="ref none" id="sRef">—</span><span class="sTitle">settlement · 60 one-second BRTI values, '
        'YES iff the rounded average ≥ strike</span></div>\n'
        '      <div class="kv">\n'
        '        <div><b id="sRec">—</b><s id="sRecL">recorded so far</s></div>\n'
        '        <div><b id="sCrit">—</b><s id="sCritL">critical average for the rest</s></div>\n'
        '        <div><b id="sMove">—</b><s id="sMoveL">move from spot to flip it</s></div>\n'
        '        <div><b id="sOff">—</b><s id="sOffL">official BRTI check</s></div>\n'
        '      </div>\n'
        '      <div class="sNote" id="sNote"></div>\n'
        '    </div>\n'
        '    <div class="proj" id="proj"></div>\n    <div class="valid" id="valid"></div>\n  </div>')
s = rep(s, '.pud{font-size:12px;font-weight:600;opacity:.85;margin-top:4px;letter-spacing:0}\n</style>',
        '.pud{font-size:12px;font-weight:600;opacity:.85;margin-top:4px;letter-spacing:0}\n'
        '.d27{font-family:var(--mono);font-size:13px;font-weight:700;margin-top:8px;line-height:1.55;color:var(--text)}\n'
        '.d27 .k{color:var(--muted);font-weight:600}\n'
        '.settle{margin-top:12px;border:1px solid var(--line);border-radius:14px;padding:10px 12px;background:#0a1119}\n'
        '.settle .kv{margin-top:8px}\n'
        '.sHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n'
        '.sTitle{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700}\n'
        '.ref{font-family:var(--mono);font-size:11px;font-weight:800;border-radius:6px;padding:2px 7px;border:1px solid var(--line)}\n'
        '.ref.off{color:var(--green);border-color:var(--green)}.ref.proxy{color:var(--amber);border-color:var(--amber)}.ref.none{color:var(--muted)}\n'
        '.sNote{margin-top:6px;font-size:11px;color:var(--muted);font-family:var(--mono);line-height:1.45}\n'
        '</style>')

# --- render: requested headline + lines, and the panel ---
s = rep(s, "  let cls='callHead none', head=sg.headline||st;",
        "  const d7=sg.display27||null;\n  let cls='callHead none', head=(d7&&d7.headline)||sg.headline||st;")
RENDER = r"""
  /* v2.7 decision block + settlement panel */
  const d7b=$('d27');
  if(d7b){
    if(d7&&st!=='DATA UNRELIABLE'&&st!=='AWAITING SETTLEMENT'&&d7.winProbability){
      d7b.innerHTML='<span class="k">WIN PROBABILITY</span> '+d7.winProbability+'<br><span class="k">REVERSAL PROBABILITY</span> '+d7.reversalProbability
        +'<br><span class="k">SECONDS REMAINING</span> '+(d7.secondsRemaining!=null?d7.secondsRemaining:'—')
        +'<br><span class="k">CRITICAL REMAINING AVERAGE</span> '+(d7.criticalRemainingAverage||'—')+' <span class="k">('+(d7.reference||'—')+')</span>';
    }else d7b.textContent='';
  }
  renderSettle27(sg.settle||null,d.strike);
"""
s = rep(s, "  $('tradeBox').className=tcls;$('tradeAct').textContent=act;$('tradeWhy').textContent=why;",
        "  $('tradeBox').className=tcls;$('tradeAct').textContent=act;$('tradeWhy').textContent=why;" + RENDER)
FN = r"""
/* v2.7: exact settlement panel (OFFICIAL = Kalshi's CF Benchmarks BRTI accumulator; PROXY = exchange index + basis) */
function fmtVs27(x){if(x==null||!Number.isFinite(x))return '—';return (x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2);}
function renderSettle27(p,strike){
  const ref=$('sRef');if(!ref)return;
  if(!p||p.reference==='NONE'){ref.className='ref none';ref.textContent='NO DATA';
    ['sRec','sCrit','sMove','sOff'].forEach(id=>$(id).textContent='—');$('sNote').textContent=p&&p.officialReasons?p.officialReasons.join(' · '):'';return;}
  const off=p.reference==='OFFICIAL';
  ref.className='ref '+(off?'off':'proxy');ref.textContent=off?'OFFICIAL BRTI':'PROXY';
  $('sRec').textContent=p.recorded>0?(fmtVs27(p.recordedVsStrike)):'none yet';
  $('sRecL').textContent=p.recorded+'/60 recorded'+(p.recordedAvg!=null?' · avg $'+p.recordedAvg.toFixed(2):'')+' vs strike';
  if(p.decided){$('sCrit').textContent='settled';$('sCritL').textContent='final $'+(p.final!=null?p.final.toFixed(2):'—');$('sMove').textContent='—';$('sMoveL').textContent='no observations left';}
  else{
    $('sCrit').textContent=p.criticalVsStrike!=null?('$'+Math.abs(p.criticalVsStrike).toFixed(2)+(p.criticalVsStrike<0?' below':' above')):'—';
    $('sCritL').textContent='remaining '+p.remaining+' must average '+(p.leader==='UP'?'≤':'≥')+' $'+(p.criticalRemainingAvg!=null?p.criticalRemainingAvg.toFixed(2):'—')+' to flip '+p.leader;
    $('sMove').textContent=p.requiredMove!=null?('$'+p.requiredMove.toFixed(2)):'—';
    $('sMoveL').textContent='held from now'+(p.jumpIn5s!=null?' · $'+p.jumpIn5s.toFixed(2)+' if it starts in 5 s':'')+' · spot '+fmtVs27(p.spotVsStrike);
  }
  if(off){
    $('sOff').textContent=p.officialFlip!=null?('flip '+(100*p.officialFlip).toFixed(2)+'%'):'live';
    $('sOffL').textContent='official reference'+(p.divergenceUsd!=null?' · proxy diff '+fmtVs27(p.divergenceUsd):'')+(p.brtiAgeMs!=null?' · '+p.brtiAgeMs+' ms old':'');
    $('sNote').textContent='Recorded average and count are Kalshi\'s official settlement accumulator (last_60s_windowed_average_15min). The flip risk in the headline is the validated 2.6 model; LOCKED is withheld if the official reference disagrees.';
  }else{
    $('sOff').textContent='not live';
    $('sOffL').textContent=(p.officialReasons&&p.officialReasons[0])?p.officialReasons[0]:'official BRTI feed not connected';
    $('sNote').textContent='PROXY: our Coinbase/Kraken/Bitstamp index shifted by the measured basis to the official settlement ($'
      +(p.basisMeanUsd!=null?p.basisMeanUsd.toFixed(2):'—')+(p.basisSdUsd!=null?', ±$'+Number(p.basisSdUsd).toFixed(2)+' 1 sd':'')+'). Not identical to the official BRTI; the flip risk already includes that uncertainty.';
  }
}
"""
s = rep(s, "function renderCall(d){", FN + "function renderCall(d){")
s = rep(s, "window.PIN_RADAR={state,VERSION,render,renderDegraded,renderCall,renderCallClock,",
        "window.PIN_RADAR={state,VERSION,render,renderDegraded,renderCall,renderSettle27,renderCallClock,")
os.makedirs(os.path.join(ROOT, 'dist27'), exist_ok=True)
open(os.path.join(ROOT, 'dist27/btc_pin_radar_27.html'), 'w').write(s)
print('built dist27/btc_pin_radar_27.html', len(s), 'bytes')
