"""Build 2.8.1/dist/btc_pin_radar_281.html from the 2.8 page (2.8/dist/btc_pin_radar_28.html, sha cf9fce39...), which is
byte-identical to the page the user deployed on Oct 14 23:23 UTC. Every patch must match exactly once.
usage: python3 2.8.1/build/build_page281.py

2.8.1 page = 2.8 page + an ACTION banner at the top of the call card (TRADE NOW / PREDICTED LOCKED / TOO LATE TO TRADE /
SIT OUT / FINAL, with the reason and the last moment an order can still be placed), a GET READY note, a restart /
warm-up banner, and the trader's order time (sent to the server as execSec; TRADE NOW needs at least 3 s + that time)."""
import hashlib, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R281 = os.path.abspath(os.path.join(HERE, '..'))
SRC = os.path.abspath(os.path.join(R281, '..', '2.8', 'dist', 'btc_pin_radar_28.html'))
OUT = os.path.join(os.environ.get('BUILD281_OUT_DIR') or os.path.join(R281, 'dist'), 'btc_pin_radar_281.html')
s = open(SRC, encoding='utf8').read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('cf9fce39fda0a7f3'):
    sys.exit('page281: 2.8/dist/btc_pin_radar_28.html is not the delivered 2.8 page (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'page281: expected {count} match(es), found {n}: {old[:140]!r}')
    return s.replace(old, new)


s = rep(s, "<title>BTC Pin Radar 2.8 — predicted LOCKED call, trade value, forward evidence</title>",
        "<title>BTC Pin Radar 2.8.1 — action, predicted LOCKED call, trade value</title>")
s = rep(s, "const VERSION='pin-radar-2.8';", "const VERSION='pin-radar-2.8.1';")
s = rep(s, '<div class="brand">BTC <span>Pin Radar 2.8</span> · predicted LOCKED · trade value · forward evidence</div>',
        '<div class="brand">BTC <span>Pin Radar 2.8.1</span> · action first · predicted LOCKED · trade value</div>')
# styles
s = rep(s, "  /* ===== 2.5 CALL PANEL ===== */",
        "  /* ===== 2.8.1 ACTION BANNER ===== */\n"
        "  .act281{border-radius:14px;padding:10px 14px;margin:0 0 10px;border:1px solid var(--line);background:#0a1119}\n"
        "  .act281 b{display:block;font-size:30px;font-weight:900;letter-spacing:.02em;line-height:1.1}\n"
        "  .act281 .w{display:block;font-size:12px;font-family:var(--mono);margin-top:4px;line-height:1.45;color:var(--text)}\n"
        "  .act281 .c{display:block;font-size:12px;font-family:var(--mono);margin-top:4px;color:var(--muted)}\n"
        "  .act281 .p{display:block;font-size:13px;margin-top:6px;color:var(--yellow);font-weight:700}\n"
        "  .act281.go{border-color:var(--green);background:rgba(44,229,146,.12)} .act281.go b{color:var(--green)}\n"
        "  .act281.pred b{color:var(--accent)} .act281.late b{color:var(--amber)} .act281.sit b{color:var(--muted)}\n"
        "  .act281.fin b{color:var(--dim)} .act281.bad b{color:var(--red)}\n"
        "  .warm281{display:none;border-radius:10px;padding:8px 12px;margin:0 0 10px;border:1px dashed var(--amber);color:var(--amber);font-size:12px;font-family:var(--mono)}\n"
        "  @media(max-width:620px){.act281 b{font-size:24px}}\n\n"
        "  /* ===== 2.5 CALL PANEL ===== */")
# markup: action banner + warm-up banner at the top of the call card
s = rep(s, '  <div class="call" id="call">\n    <div class="callTop">',
        '  <div class="call" id="call">\n'
        '    <div class="warm281" id="warm281"></div>\n'
        '    <div class="act281 sit" id="act281"><b id="act281S">WAITING FOR DATA</b><span class="w" id="act281W"></span><span class="c" id="act281C"></span><span class="p" id="act281P"></span></div>\n'
        '    <div class="callTop">')
# order time setting
s = rep(s, """      <div class="field"><label>&nbsp;</label><div class="hint">TRADE NOW requires LOCKED, offers for at least this many contracts, a fresh book, ≥3 s left and positive conservative edge after Kalshi's fee.</div></div>""",
        """      <div class="field"><label>My order time, seconds (from seeing TRADE NOW to the order reaching Kalshi)</label><input id="execSec" inputmode="numeric" placeholder="12"/></div>
    </div>
    <div class="grid" style="margin-top:6px">
      <div class="field" style="grid-column:1/-1"><div class="hint">TRADE NOW requires LOCKED, offers for at least this many contracts, a fresh book, at least 3 s + your order time left, and a positive conservative edge after Kalshi's fee that survives an adverse BTC move while you place the order. A LOCKED call that comes later than that is shown as TOO LATE TO TRADE.</div></div>""")
s = rep(s, "function save(){try{localStorage.setItem('pinradar28',JSON.stringify({u:$('backendUrl').value,lf:$('localFeedToggle').checked,c:$('contracts').value}));}catch(e){}}",
        "function save(){try{localStorage.setItem('pinradar28',JSON.stringify({u:$('backendUrl').value,lf:$('localFeedToggle').checked,c:$('contracts').value,e:$('execSec').value}));}catch(e){}}")
s = rep(s, "  if(s.c)$('contracts').value=s.c;}catch(e){}}",
        "  if(s.c)$('contracts').value=s.c;\n  if(s.e!=null&&s.e!=='')$('execSec').value=s.e;}catch(e){}}")
s = rep(s, "  const ct=parseInt($('contracts').value,10);if(Number.isFinite(ct)&&ct>0)p.contracts=ct;",
        "  const ct=parseInt($('contracts').value,10);if(Number.isFinite(ct)&&ct>0)p.contracts=ct;\n"
        "  const ex=parseFloat($('execSec').value);p.execSec=Number.isFinite(ex)&&ex>=0?Math.min(120,ex):12;   // v2.8.1: your order time")
s = rep(s, "  ['backendUrl','target','contracts'].forEach(id=>$(id).addEventListener('change',save));",
        "  ['backendUrl','target','contracts','execSec'].forEach(id=>$(id).addEventListener('change',save));")
# render: action banner (server's exec state; a client-side data downgrade always wins)
s = rep(s, "  else if(/TOO LATE|TOO THIN|DO NOT TRADE|BOOK STALE|NO BOOK/.test(act))tcls='tradeBox late';",
        "  else if(/TOO LATE|TOO THIN|DO NOT TRADE|BOOK STALE|NO BOOK/.test(act))tcls='tradeBox late';\n"
        "  if(!downgraded&&tr.noOffers&&/TOO LATE/.test(act)){act='LOCKED — NO OFFERS';tcls='tradeBox late';}   // v2.8.1: an empty book is not a timing problem")
s = rep(s, "  $('tradeBox').className=tcls;$('tradeAct').textContent=act;$('tradeWhy').textContent=why;",
        "  $('tradeBox').className=tcls;$('tradeAct').textContent=act;$('tradeWhy').textContent=why;\n"
        "  const head281=render281(sg,downgraded,!!(dv&&dv.bad));\n"
        "  if(act==='TRADE NOW'&&head281&&head281!=='TRADE NOW'){act=head281==='TOO LATE'?'LOCKED — TOO LATE':head281;tcls='tradeBox '+(head281==='TOO LATE'?'late':'bad');$('tradeBox').className=tcls;$('tradeAct').textContent=act;}   // v2.8.1: one decision everywhere (card, beep)")
# review round 3: a reading's age counts from when it was REQUESTED (the server made it after that moment); measuring from receipt hid
# 2-5 s of age on slow links, and the skew estimate (rtt/2) can put the browser's tau seconds ahead on an asymmetric link
s = rep(s, "    const t0=performance.now();\n    const d=await fetchJson(b+'/radar'",
        "    const t0=performance.now(), sent281=Date.now();\n    const d=await fetchJson(b+'/radar'")
s = rep(s, "    state.lastServer=d; state.lastServerAt=Date.now();\n",
        "    state.lastServer=d; state.lastServerAt=Date.now(); state.sentAt281=sent281;   // v2.8.1\n")
# a stale or dead backend, and the close, downgrade the action banner too (the page may downgrade a call, never upgrade it)
s = rep(s, "function markCallStale(age){\n  $('call').className='call stale';",
        "function markCallStale(age){\n  act281Down('STALE — DO NOT TRADE','last server reading is '+(age/1000).toFixed(1)+' s old; the action shown may no longer hold');\n  $('call').className='call stale';")
s = rep(s, "  $('bigTau').style.color=t<=10?'var(--red)':t<=60?'var(--amber)':'var(--text)';",
        "  $('bigTau').style.color=t<=10?'var(--red)':t<=60?'var(--amber)':'var(--text)';\n"
        "  if(t<=0){const b=$('act281');if(b&&/go|pred|late/.test(b.className))act281Down('WINDOW CLOSED — FINAL / SETTLEMENT','the window has closed: nothing here is an opportunity',true);}")
# TRADE NOW never outlives the last order moment or a fresh server reading (review finding: at T >= 120 s the stale downgrade waited
# 6 s, and nothing compared the local clock with the last order moment)
s = rep(s, "  if(d&&d.signal&&age>CALL_STALE_MS&&t>0&&t<120)markCallStale(age);\n}",
        "  if(d&&d.signal&&age>CALL_STALE_MS&&t>0&&t<120)markCallStale(age);\n"
        "  state.tau281=t;   // v2.8.1\n"
        "  {const b=$('act281'),ex=d&&d.signal&&d.signal.exec,c=cons281(d&&d.signal),tc=Math.min(t,c.tau);\n"
        "   if(b&&/\\bgo\\b/.test(b.className)&&t>0){\n"
        "     if(ex&&Number.isFinite(ex.lastOrderTau)&&tc<ex.lastOrderTau){act281Down('TOO LATE','T−'+Math.max(0,tc).toFixed(1)+' s at most: past the last moment to place an order (T−'+ex.lastOrderTau+' s with your '+ex.execSec+' s order time)');b.className='act281 late';}\n"
        "     else if(age>CALL_STALE_MS||c.ageMs>CALL_STALE_MS||!state.running)act281Down('STALE — DO NOT TRADE','the reading is up to '+(Math.max(age,c.ageMs)/1000).toFixed(1)+' s old (counted from when it was requested); TRADE NOW may no longer hold');}}\n"
        "}")
s = rep(s, "function renderCall(d){",
        """/* v2.8.1: the one action to take now. TRADE NOW only when the server says so; a LOCKED call that cannot be traded
   is PREDICTED LOCKED (with why); past the last moment an order can be placed it is TOO LATE TO TRADE; after the
   close it is FINAL (never an opportunity). */
function act281Down(title,why,fin){
  const b=$('act281');if(!b)return;
  b.className='act281 '+(fin?'fin':'bad');$('act281S').textContent=title;$('act281W').textContent=why;$('act281C').textContent='';$('act281P').textContent='';
  if($('tradeAct')&&$('tradeAct').textContent==='TRADE NOW'){$('tradeAct').textContent=title;$('tradeWhy').textContent=why;$('tradeBox').className='tradeBox bad';if(/trade/.test($('call').className))$('call').className='call locked';}
}
/* the most conservative age of the shown reading (from the moment it was requested) and time left (server tau minus that age) */
function cons281(sg){
  const ageMs=Number.isFinite(state.sentAt281)?Date.now()-state.sentAt281:Infinity;
  return {ageMs, tau:sg&&Number.isFinite(sg.tau)?sg.tau-ageMs/1000:Infinity};
}
function render281(sg,downgraded,divergent){
  const ex=sg&&sg.exec, wu=sg&&sg.warmup, box=$('act281');
  const wb=$('warm281');
  if(wb){if(wu&&wu.label){wb.style.display='block';wb.textContent='⟳ '+wu.label;}else{wb.style.display='none';wb.textContent='';}}
  if(!box)return;
  if(!ex){box.className='act281 sit';$('act281S').textContent='NO ACTION DATA';$('act281W').textContent='backend is not 2.8.1: TRADE NOW timing does not include your order time';$('act281C').textContent='';$('act281P').textContent='';return;}
  /* the decision in three words, the reversal risk, one reason: TRADE NOW / SIT OUT / TOO LATE */
  let head=ex.headline||'SIT OUT', cls=head==='TRADE NOW'?'go':head==='TOO LATE'?'late':'sit', why=ex.reason||ex.why||'';
  if(downgraded){head='SIT OUT';why='DATA SUSPECT — '+downgraded;cls='bad';}
  else if(head==='TRADE NOW'&&((Number.isFinite(state.tau281)&&state.tau281>0&&state.tau281<ex.lastOrderTau)||cons281(sg).tau<ex.lastOrderTau)){head='TOO LATE';cls='late';why='past the last moment to place an order (T−'+ex.lastOrderTau+' s with your '+ex.execSec+' s order time)';}   // the browser's clock, or the reading's age, says it is too late
  else if(head==='TRADE NOW'&&cons281(sg).ageMs>CALL_STALE_MS){head='STALE — DO NOT TRADE';cls='bad';why='the reading is up to '+(cons281(sg).ageMs/1000).toFixed(1)+' s old (slow connection): TRADE NOW may no longer hold';}
  else if(sg.state==='REVERSAL WARNING'||sg.state==='DATA UNRELIABLE')cls='bad';
  else if(ex.state==='FINAL')cls='fin';
  box.className='act281 '+cls;
  $('act281S').textContent=head==='TRADE NOW'?('TRADE NOW — BUY '+(sg.side==='UP'?'YES (UP)':'NO (DOWN)')):head;
  $('act281W').textContent=(ex.reversalPct!=null&&!downgraded?('reversal risk '+(ex.reversalPct<0.01?'<0.01':ex.reversalPct.toFixed(2))+'% · '):'')+why;
  const left=ex.secondsToLastOrder;
  $('act281C').textContent=ex.state==='FINAL'?'':(left!=null?(left>0?('last moment to place an order: T−'+ex.lastOrderTau+' s (in '+Math.floor(left)+' s) · your order time '+ex.execSec+' s')
    :('past the last moment to place an order (T−'+ex.lastOrderTau+' s with your '+ex.execSec+' s order time)')):'');
  $('act281P').textContent=(!downgraded&&!divergent&&ex.prepare)?ex.prepare:'';   // never GET READY on data the browser disputes
  return head;
}
function renderCall(d){""")
s = rep(s, "    $('callProb').textContent='';$('tradeAct').textContent='—';$('tradeWhy').textContent='upload the 2.5 pinradar_server.js to enable LOCKED calls';\n    return;",
        "    $('callProb').textContent='';$('tradeAct').textContent='—';$('tradeWhy').textContent='upload the 2.5 pinradar_server.js to enable LOCKED calls';\n"
        "    render281(null,null);\n    return;")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(s)
print('built', OUT, 'sha256', hashlib.sha256(s.encode()).hexdigest(), len(s.splitlines()), 'lines')
