"""Build 2.8/dist/btc_pin_radar_28.html from the preserved 2.7 page (Btc-signal/pinradar-research/versions/2.7,
sha 804638dd...). Every patch must match exactly once.  usage: python3 2.8/build/build_page28.py
Adds: PREDICTED LOCKED wording, flip-risk uncertainty band, settlement designation (PREDICTED LOCKED /
MATHEMATICALLY FINAL / OFFICIALLY SETTLED), the three separate decisions (outcome confidence / trade value /
execution readiness), the per-size EV ladder, failure-alarm and proof-of-edge monitors, the fee-schedule source,
the designation of the window that just closed, and client latency reporting."""
import hashlib, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R28 = os.path.abspath(os.path.join(HERE, '..'))
# the preserved 2.7 page is vendored in pinradar-research/pkg27_page (sha-checked below); PAGE27 may point elsewhere
SRC = os.environ.get('PAGE27') or os.path.abspath(os.path.join(R28, '..', 'pkg27_page', 'btc_pin_radar_27.html'))
OUT = os.path.join(os.environ.get('BUILD28_OUT_DIR') or os.path.join(R28, 'dist'), 'btc_pin_radar_28.html')   # run_all builds into a temp dir
s = open(SRC, encoding='utf8').read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('804638ddafb40f8a'):
    sys.exit('page28: source is not the delivered 2.7 page (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'page28: expected {count} match(es), found {n}: {old[:120]!r}')
    return s.replace(old, new)


s = rep(s, '<title>BTC Pin Radar 2.7 — settlement-aware LOCKED call</title>', '<title>BTC Pin Radar 2.8 — predicted LOCKED call, trade value, forward evidence</title>')
s = rep(s, 'BTC <span>Pin Radar 2.7</span> · settlement-aware LOCKED call', 'BTC <span>Pin Radar 2.8</span> · predicted LOCKED · trade value · forward evidence')
s = rep(s, 'Pin Radar 2.7 · KXBTC15M settles', 'Pin Radar 2.8 · KXBTC15M settles')
# the backtest line under the call: the record's own label (development, not independent) instead of "out of sample"
s = rep(s, "calls (out of sample): '+a.losses+' flips in '+a.n", "calls ('+(a.label||'out of sample')+'): '+a.losses+' flips in '+a.n")
s = rep(s, "const VERSION='pin-radar-2.7';", "const VERSION='pin-radar-2.8';")
s = rep(s, "pinradar27", "pinradar28", count=2)
s = rep(s, """<span class="flip">FLIP RISK '+(sg.pFlipLabel||'—')+'</span>'""",
        """<span class="flip">FLIP RISK '+((sg.v28&&sg.v28.outcome&&sg.v28.outcome.flipLabel)||sg.pFlipLabel||'—')+'</span>'""")
s = rep(s, '    <div class="d27" id="d27"></div>\n', '    <div class="d27" id="d27"></div>\n    <div class="v28" id="v28"></div>\n')
s = rep(s, "  renderSettle27(sg.settle||null,d.strike);", "  renderSettle27(sg.settle||null,d.strike);\n  renderV28(d,sg);")
RENDER = r"""/* v2.8: designation, the three separate decisions, EV ladder, monitors, fee source */
function esc28(x){return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function c28(x){return x==null||!Number.isFinite(x)?'—':((x>=0?'+':'−')+Math.abs(x).toFixed(2)+'¢');}
function renderV28(d,sg){
  const el=$('v28'); if(!el)return;
  const v=sg&&sg.v28; if(!v){el.innerHTML='';return;}
  let h='';
  const dz=v.designation;
  if(dz&&dz.label)h+='<div class="dz '+esc28(String(dz.code).toLowerCase())+'" id="v28dz">'+esc28(dz.label)+'<s>'+esc28(dz.basis||'')+'</s></div>';
  const o=v.outcome||{},va=v.value||{},ex=v.execution||{};
  h+='<div class="tri">'
    +'<div id="v28o"><span class="k">OUTCOME CONFIDENCE</span><b>'+esc28(o.winLabel||'—')+'</b><s>flip risk '+esc28(o.flipLabel||'—')+'</s></div>'
    +'<div id="v28v"><span class="k">TRADE VALUE</span><b class="'+(va.positive?'g':'a')+'">'+c28(va.evConsCents)+'</b><s>'
      +(va.askCents!=null?('ask '+Number(va.askCents).toFixed(1)+'¢ · fee '+(va.feeCents!=null?Number(va.feeCents).toFixed(2):'—')+'¢/ct · '+va.contracts+' ct'):'no offer')
      +(va.stressEvCents!=null?(' · stress '+c28(va.stressEvCents)):'')+(va.veto?(' · <b class="r">'+esc28(va.veto)+'</b>'):'')+'</s></div>'
    +'<div id="v28x"><span class="k">EXECUTION READINESS</span><b class="'+(ex.ready?'g':'a')+'">'+(ex.ready?'READY':'NOT READY')+'</b><s>book '
      +(ex.bookAgeMs!=null?Math.round(ex.bookAgeMs)+'ms':'—')+' · depth '+(ex.depth!=null?Math.floor(ex.depth):'—')+(ex.secondsLeft!=null?(' · '+Math.round(ex.secondsLeft)+'s left'):'')+'</s></div>'
    +'</div>';
  if(v.ladder&&v.ladder.length){
    h+='<table class="lad" id="v28lad"><tr><th>size</th><th>fillable</th><th>avg</th><th>fee/ct</th><th>EV</th><th>EV cons</th><th>EV stress</th></tr>';
    for(const r of v.ladder)h+='<tr'+(r.full?'':' class="thin"')+'><td>'+r.size+'</td><td>'+(r.fillable||0)+'</td><td>'+(r.avgCents!=null?Number(r.avgCents).toFixed(2)+'¢':'—')+'</td><td>'
      +(r.feeCentsPerContract!=null?Number(r.feeCentsPerContract).toFixed(2)+'¢':'—')+'</td><td>'+c28(r.evCents)+'</td><td class="'+(r.evConsCents>=0?'g':'a')+'">'+c28(r.evConsCents)+'</td><td>'+c28(r.evStressCents)+'</td></tr>';
    h+='</table><div class="ladN">'+esc28(v.ladderNote||'')+'</div>';
  }
  const m=v.monitor;
  if(m&&m.failure&&m.edge)h+='<div class="mon" id="v28mon">'+(m.failure.alarm?'<b class="r">FAILURE ALARM</b>':'failure monitor: no alarm')+' · '+m.failure.losses+' of '+m.failure.n+' forward LOCKED calls lost (e='+m.failure.eValue+', alarm at '+m.failure.threshold+')'
    +' · '+(m.edge.proven?'<b class="g">EDGE ESTABLISHED</b>':'edge NOT established')+' (e='+m.edge.eValue+', '+m.edge.n+' paper trades'+(m.edge.meanCentsPerContract!=null?(', mean '+c28(m.edge.meanCentsPerContract)):'')+')</div>';
  const f=v.fees;
  if(f)h+='<div class="fee" id="v28fee">fees: '+(f.verified?'from the Kalshi series record':'<b class="a">default, not verified with Kalshi</b>')+' · taker '+f.takerMult+' × '+f.seriesMultiplier+' · '+esc28(f.rounding)+' rounding'+(f.makerMult?(' · maker '+f.makerMult):'')+'</div>';
  const lw=d.lastWindow&&d.lastWindow.designation;
  if(lw&&lw.label)h+='<div class="lw" id="v28lw">just closed '+esc28(d.lastWindow.ticker||'')+': '+esc28(lw.label)+'</div>';
  el.innerHTML=h;
}
function renderCall(d){"""
s = rep(s, "function renderCall(d){", RENDER)
CSS = """.v28{margin-top:10px;font-size:12px;line-height:1.45}
.v28 .dz{font-family:var(--mono);font-weight:800;font-size:12px;padding:5px 8px;border-radius:8px;border:1px solid var(--line);margin-bottom:8px}
.v28 .dz s{display:block;text-decoration:none;font-weight:500;color:var(--muted);font-size:11px}
.v28 .dz.predicted_locked{border-color:var(--amber);color:var(--amber)}.v28 .dz.mathematically_final{border-color:var(--green);color:var(--green)}
.v28 .dz.officially_settled{border-color:var(--text);color:var(--text)}.v28 .dz.awaiting_settlement{color:var(--muted)}
.v28 .tri{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.v28 .tri>div{border:1px solid var(--line);border-radius:10px;padding:6px 8px;min-width:0}
.v28 .tri .k{display:block;font-size:9px;letter-spacing:.06em;color:var(--muted);font-weight:700}
.v28 .tri b{display:block;font-family:var(--mono);font-size:13px}.v28 .tri s{display:block;text-decoration:none;color:var(--muted);font-size:10px;overflow-wrap:anywhere}
.v28 .g{color:var(--green)}.v28 .a{color:var(--amber)}.v28 .r{color:var(--red)}
.v28 table.lad{width:100%;border-collapse:collapse;margin-top:8px;font-family:var(--mono);font-size:11px}
.v28 table.lad th,.v28 table.lad td{padding:2px 4px;text-align:right;border-bottom:1px solid var(--line)}
.v28 table.lad tr.thin td{color:var(--muted)}
.v28 .ladN,.v28 .mon,.v28 .fee,.v28 .lw{margin-top:6px;color:var(--muted);font-size:11px;font-family:var(--mono)}
@media (max-width:520px){.v28 .tri{grid-template-columns:1fr}}
</style>"""
s = rep(s, "</style>", CSS)
# client latency reporting (round trip, and how old the signal was when it was drawn)
s = rep(s, "  if(haveTimer)p.timer={secondsLeft:Math.max(0,(m||0)*60+(s||0))};",
        "  if(haveTimer)p.timer={secondsLeft:Math.max(0,(m||0)*60+(s||0))};\n"
        "  if(Number.isFinite(state.lastRtt28))p.clientRttMs=state.lastRtt28;\n"
        "  if(Number.isFinite(state.lastDisplay28))p.clientDisplayDelayMs=state.lastDisplay28;")
s = rep(s, "    render(d,rtt);\n",
        "    render(d,rtt);\n"
        "    state.lastRtt28=Math.round(rtt);\n"
        "    if(d.signal&&Number.isFinite(d.signal.ts)&&Number.isFinite(state.serverSkewMs))state.lastDisplay28=Math.round((Date.now()-state.serverSkewMs)-d.signal.ts);\n")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(s)
print('built', OUT, 'sha256', hashlib.sha256(s.encode()).hexdigest())
