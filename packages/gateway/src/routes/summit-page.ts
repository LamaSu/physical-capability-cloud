// Self-contained, mobile-first PCC beta signup page — served public at GET /summit.
// Step 1: email -> /api/waitlist (everyone, <15s). Step 2 (skippable): pick side +
// optional name/company/pitch -> /api/beta-apply. Live counter from /api/waitlist/count.
// `source` defaults to "aiscience" (override via ?ref=). Built for the AI Science Summit.
// No vendor framework, no build step, no "moat" anywhere.
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
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 22px 24px}
.counter{color:var(--grn);font-size:13px;font-weight:600;letter-spacing:.02em;min-height:18px;margin-bottom:14px}
h1{font-size:26px;line-height:1.15;margin:0 0 8px}
h2{font-size:22px;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 18px;font-size:15px}
.flyline{color:var(--mut);font-size:13px;margin:16px 0 0;border-top:1px solid var(--line);padding-top:14px}
input,textarea{width:100%;background:#0c1211;border:1px solid var(--line);color:var(--ink);border-radius:11px;padding:13px 14px;font-size:16px;margin-bottom:10px;outline:none;font-family:inherit}
input:focus,textarea:focus{border-color:var(--grn)}
button{font:inherit;cursor:pointer;border:none;border-radius:11px}
.go{width:100%;background:var(--grn);color:#04110c;font-weight:700;padding:14px;font-size:16px}
.go:disabled{opacity:.6}
.cards{display:flex;flex-direction:column;gap:10px;margin-bottom:6px}
.side{display:flex;flex-direction:column;align-items:flex-start;text-align:left;background:#0c1211;border:1px solid var(--line);color:var(--ink);padding:14px 15px;border-radius:12px}
.side b{font-size:16px}
.side span{color:var(--mut);font-size:13px;margin-top:2px}
.side.sel{border-color:var(--grn);background:#0e1614}
.row{display:flex;gap:10px}
.row .go{flex:1}
.ghost{background:transparent;color:var(--mut);border:1px solid var(--line);padding:14px 16px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.share{color:var(--mut);font-size:13px;margin-top:14px}
a{color:var(--grn);text-decoration:none}
</style>
</head>
<body>
<div class="wrap"><main class="card">
<div id="counter" class="counter"></div>

<section id="step1">
  <h1>Get on the PCC beta.</h1>
  <p class="sub">Put your capabilities on the network &mdash; or compose everyone else's.</p>
  <form id="f1" autocomplete="on">
    <input id="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@lab.org">
    <input id="hp" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit" class="go" id="b1">Join the beta &rarr;</button>
  </form>
  <p class="flyline">This room is both sides of the flywheel. Which side are you?</p>
</section>

<section id="step2" hidden>
  <h2>Which side are you?</h2>
  <p class="sub">PCC needs both &mdash; and this room is both.</p>
  <div class="cards">
    <button type="button" class="side" data-side="operator"><b>Operator</b><span>I have capabilities to offer</span></button>
    <button type="button" class="side" data-side="user"><b>User</b><span>I want to run workflows</span></button>
    <button type="button" class="side" data-side="both"><b>Both</b><span>A bit of each</span></button>
  </div>
  <form id="f2" hidden>
    <input id="name" autocomplete="name" placeholder="Name (optional)">
    <input id="company" autocomplete="organization" placeholder="Company or Individual (optional)">
    <textarea id="pitch" rows="2" placeholder="(optional)"></textarea>
    <input id="invite" placeholder="Invite code? (skip the queue)">
    <div class="row">
      <button type="submit" class="go" id="b2">Finish &rarr;</button>
      <button type="button" class="ghost" id="skip">Skip</button>
    </div>
  </form>
</section>

<section id="done" hidden>
  <h2 id="doneTitle">You are in.</h2>
  <p class="sub" id="doneSub">We will be in touch.</p>
  <p class="share">Pull a builder in &mdash; <a href="/summit">capability.network</a></p>
</section>

</main></div>
<script>
(function(){
  var source=(new URLSearchParams(location.search).get("ref"))||"aiscience";
  var email="";
  var role="";
  var labels={operator:"What can you run? (instruments / assays / throughput)",user:"What do you want to run or compose?",both:"What can you run, and what do you want to compose?"};
  function $(id){return document.getElementById(id);}
  function show(id){["step1","step2","done"].forEach(function(s){$(s).hidden=(s!==id);});}
  function getCount(cb){fetch("/api/waitlist/count").then(function(r){return r.json();}).then(function(d){cb(d&&typeof d.count==="number"?d.count:null);}).catch(function(){cb(null);});}
  getCount(function(n){if(n&&n>0){$("counter").textContent=n+" builders already on the beta";}});
  $("f1").addEventListener("submit",function(e){e.preventDefault();email=$("email").value.trim();var b=$("b1");b.disabled=true;b.textContent="Joining...";fetch("/api/waitlist",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,source:source,website:$("hp").value})}).then(function(r){return r.json();}).then(function(d){if(d&&d.status==="ok"){show("step2");}else{b.disabled=false;b.textContent="Join the beta \\u2192";alert((d&&d.message)||"Please enter a valid email.");}}).catch(function(){b.disabled=false;b.textContent="Join the beta \\u2192";alert("Network error - try again.");});});
  Array.prototype.forEach.call(document.querySelectorAll(".side"),function(btn){btn.addEventListener("click",function(){role=btn.getAttribute("data-side");Array.prototype.forEach.call(document.querySelectorAll(".side"),function(x){x.classList.remove("sel");});btn.classList.add("sel");$("pitch").placeholder=labels[role]||"(optional)";$("f2").hidden=false;});});
  function done(){show("done");getCount(function(n){$("doneTitle").textContent=(n&&n>0)?("You are in. #"+n+" on the beta."):"You are in.";$("doneSub").textContent=(role==="operator")?"Next: publish a capability.":((role==="user")?"Next: browse capabilities to compose.":"We will route you to both sides.");});}
  $("f2").addEventListener("submit",function(e){e.preventDefault();var b=$("b2");b.disabled=true;b.textContent="...";fetch("/api/beta-apply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,name:$("name").value.trim(),company:$("company").value.trim(),role:role||"both",source:source,inviteCode:$("invite").value.trim(),pitch:$("pitch").value.trim(),website:$("hp").value})}).then(function(){done();}).catch(function(){done();});});
  $("skip").addEventListener("click",function(){if(role){fetch("/api/beta-apply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,role:role,source:source})}).then(function(){done();}).catch(function(){done();});}else{done();}});
})();
</script>
</body>
</html>`;
