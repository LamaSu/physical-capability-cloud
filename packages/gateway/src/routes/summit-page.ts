// Self-contained, mobile-first PCC beta signup page — served public at GET /summit.
// Progressive capture: a stable client leadId is sent with every step, so each step
// upserts ONE record and partial signups are saved (email -> name -> company -> rest).
// Backed by POST /api/waitlist (upsert by leadId). Live counter from /api/waitlist/count.
// `source` defaults to "aiscience" (override via ?ref=). Built for the AI Science Summit.
export const SUMMIT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0e0d">
<title>Get on the PCC beta — Physical Capability Cloud</title>
<style>
:root{--bg:#0a0e0d;--card:#12181a;--ink:#e8f0ee;--mut:#8aa39c;--grn:#10B981;--line:#1f2a28}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 18px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 22px 22px}
.counter{color:var(--grn);font-size:13px;font-weight:600;letter-spacing:.02em;min-height:18px;margin-bottom:12px}
.steps{display:flex;gap:6px;margin-bottom:18px}
.dot{height:4px;flex:1;background:var(--line);border-radius:2px;transition:background .2s}
.dot.on{background:var(--grn)}
h1{font-size:25px;line-height:1.15;margin:0 0 8px}
.sub{color:var(--mut);margin:0 0 18px;font-size:15px}
input,textarea{width:100%;background:#0c1211;border:1px solid var(--line);color:var(--ink);border-radius:11px;padding:13px 14px;font-size:16px;margin-bottom:10px;outline:none;font-family:inherit}
input:focus,textarea:focus{border-color:var(--grn)}
button{font:inherit;cursor:pointer;border:none;border-radius:11px}
.go{width:100%;background:var(--grn);color:#04110c;font-weight:700;padding:14px;font-size:16px}
.go:disabled{opacity:.6}
.row{display:flex;gap:10px}
.row .go{flex:1}
.back{background:transparent;color:var(--mut);border:1px solid var(--line);padding:14px 16px;min-width:54px}
.cards{display:flex;flex-direction:column;gap:10px;margin-bottom:10px}
.side{display:flex;flex-direction:column;align-items:flex-start;text-align:left;background:#0c1211;border:1px solid var(--line);color:var(--ink);padding:14px 15px;border-radius:12px}
.side b{font-size:16px}
.side span{color:var(--mut);font-size:13px;margin-top:2px}
.side.sel{border-color:var(--grn);background:#0e1614}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.share{color:var(--mut);font-size:13px;margin-top:16px}
a{color:var(--grn);text-decoration:none}
</style>
</head>
<body>
<div class="wrap"><main class="card">
<div id="counter" class="counter"></div>
<div class="steps">
  <div class="dot" data-d="0"></div><div class="dot" data-d="1"></div><div class="dot" data-d="2"></div><div class="dot" data-d="3"></div>
</div>

<section data-screen="0">
  <h1>Get on the PCC beta.</h1>
  <p class="sub">Put your lab's or tool's capabilities on the network &mdash; or run the ones already there. Every call permissioned, every result traceable.</p>
  <form id="fEmail" autocomplete="on">
    <input id="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@lab.org">
    <input id="hp" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit" class="go">Continue &rarr;</button>
  </form>
</section>

<section data-screen="1" hidden>
  <h1>Your name?</h1>
  <p class="sub">So we know who we're talking to.</p>
  <form id="fName">
    <input id="name" autocomplete="name" placeholder="Ada Lovelace">
    <div class="row">
      <button type="button" class="back" data-back="1">&larr;</button>
      <button type="submit" class="go">Continue &rarr;</button>
    </div>
  </form>
</section>

<section data-screen="2" hidden>
  <h1>Company or individual?</h1>
  <p class="sub">Where you're coming from.</p>
  <form id="fCompany">
    <input id="company" autocomplete="organization" placeholder="Company name &mdash; or &ldquo;Individual&rdquo;">
    <div class="row">
      <button type="button" class="back" data-back="2">&larr;</button>
      <button type="submit" class="go">Continue &rarr;</button>
    </div>
  </form>
</section>

<section data-screen="3" hidden>
  <h1>What brings you to PCC?</h1>
  <p class="sub">Tell us what you'd host or run.</p>
  <div class="cards">
    <button type="button" class="side" data-side="operator"><b>I host capabilities</b><span>Instruments, a lab, a skill, an asset to put on the network</span></button>
    <button type="button" class="side" data-side="user"><b>I run workflows</b><span>I want to use capabilities on the network</span></button>
    <button type="button" class="side" data-side="both"><b>Both</b><span>A bit of each</span></button>
  </div>
  <form id="fRest">
    <textarea id="pitch" rows="2" placeholder="What can you run, or what do you want to run?"></textarea>
    <input id="invite" placeholder="Invite code? Skip the queue.">
    <div class="row">
      <button type="button" class="back" data-back="3">&larr;</button>
      <button type="submit" class="go">Finish &rarr;</button>
    </div>
  </form>
</section>

<section data-screen="done" hidden>
  <h1 id="doneTitle">You're in.</h1>
  <p class="sub" id="doneSub">We'll be in touch.</p>
  <p class="share">Pull a builder in &mdash; <a href="/summit">capability.network</a></p>
</section>

</main></div>
<script>
(function(){
  var source=(new URLSearchParams(location.search).get("ref"))||"aiscience";
  var leadId="lead-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
  var data={leadId:leadId,source:source};
  var role="";
  function $(id){return document.getElementById(id);}
  var SCREENS=["0","1","2","3","done"];
  function show(s){
    SCREENS.forEach(function(x){var el=document.querySelector('[data-screen="'+x+'"]');if(el)el.hidden=(x!==s);});
    var idx=(s==="done")?3:parseInt(s,10);
    Array.prototype.forEach.call(document.querySelectorAll(".dot"),function(d){var di=parseInt(d.getAttribute("data-d"),10);d.classList.toggle("on",!isNaN(idx)&&di<=idx);});
  }
  // Pull whatever is currently typed into the accumulator (captures unsubmitted fields).
  function collect(){
    var e=$("email").value.trim(); if(e)data.email=e;
    var n=$("name").value.trim(); if(n)data.name=n;
    var c=$("company").value.trim(); if(c)data.company=c;
    var p=$("pitch").value.trim(); if(p)data.useCase=p;
    var inv=$("invite").value.trim(); if(inv)data.inviteCode=inv;
  }
  // Fire-and-forget progressive save — always sends the full accumulated record.
  function save(){
    if(!data.email)return;
    try{fetch("/api/waitlist",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data),keepalive:true}).catch(function(){});}catch(e){}
  }
  // Capture even if they navigate away or background the tab mid-flow.
  window.addEventListener("pagehide",function(){collect();save();});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden"){collect();save();}});

  function getCount(cb){fetch("/api/waitlist/count").then(function(r){return r.json();}).then(function(d){cb(d&&typeof d.count==="number"?d.count:null);}).catch(function(){cb(null);});}
  getCount(function(n){if(n&&n>0){$("counter").textContent=n+" builders already on the beta";}});

  $("fEmail").addEventListener("submit",function(e){e.preventDefault();var v=$("email").value.trim();if(!v)return;if($("hp").value)data.website=$("hp").value;data.email=v;save();show("1");});
  $("fName").addEventListener("submit",function(e){e.preventDefault();var v=$("name").value.trim();if(v)data.name=v;save();show("2");});
  $("fCompany").addEventListener("submit",function(e){e.preventDefault();var v=$("company").value.trim();if(v)data.company=v;save();show("3");});
  Array.prototype.forEach.call(document.querySelectorAll(".side"),function(btn){btn.addEventListener("click",function(){role=btn.getAttribute("data-side");data.role=role;Array.prototype.forEach.call(document.querySelectorAll(".side"),function(x){x.classList.remove("sel");});btn.classList.add("sel");save();});});
  $("fRest").addEventListener("submit",function(e){e.preventDefault();collect();data.completed=true;var b=e.target.querySelector(".go");b.disabled=true;b.textContent="...";save();done();});
  Array.prototype.forEach.call(document.querySelectorAll(".back"),function(btn){btn.addEventListener("click",function(){var cur=parseInt(btn.getAttribute("data-back"),10);if(!isNaN(cur)&&cur>0)show(String(cur-1));});});

  function done(){show("done");getCount(function(n){$("doneTitle").textContent=(n&&n>0)?("You're in. #"+n+" on the beta."):"You're in.";$("doneSub").textContent=(role==="operator")?"Next: publish a capability.":((role==="user")?"Next: browse capabilities to run.":"We'll be in touch.");});}
  show("0");
})();
</script>
</body>
</html>`;
