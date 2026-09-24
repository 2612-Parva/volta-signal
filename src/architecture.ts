/** Public, secret-free map of how Volta Signal is put together. */

export function architectureResponse(): Response {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Volta Signal — system architecture</title>
  <style>
    :root {
      --bg:#050505; --panel:#0c0c0c; --line:#1c1c1c; --ink:#f4f4f4;
      --muted:#8a8a8a; --dim:#5c5c5c;
      --memory:#60a5fa; --skills:#34d399; --hooks:#c084fc;
      --integrations:#22d3ee; --outputs:#f472b6; --core:#f5a623;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; background:var(--bg); color:var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, sans-serif; overflow:hidden; }
    .hud { position:fixed; top:0; left:250px; right:0; z-index:40;
      padding:18px 22px 12px; background:linear-gradient(#050505 70%, transparent);
      pointer-events:none; }
    .hud * { pointer-events:auto; }
    h1 { font-size:20px; letter-spacing:-.03em; font-weight:650; }
    .sub { color:var(--muted); font-size:13px; margin:6px 0 12px; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; }
    .filters button { background:transparent; color:var(--muted); border:1px solid #2a2a2a;
      border-radius:999px; padding:6px 12px; cursor:pointer; font-size:12px; }
    .filters button.on { color:#000; background:#fff; border-color:#fff; }
    .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
    .layout { display:grid; grid-template-columns: 1fr; height:100%; }
    .tree { position:fixed; left:0; top:0; bottom:0; width:250px; z-index:35;
      padding:108px 16px 24px; border-right:1px solid var(--line); overflow:auto;
      background:rgba(8,8,8,.92); backdrop-filter:blur(8px); }
    .tree h2, .detail h2 { font-size:10px; letter-spacing:.16em; text-transform:uppercase;
      color:var(--dim); margin-bottom:12px; }
    .tree .dir { color:var(--muted); font-size:12px; margin:10px 0 4px; }
    .tree { scrollbar-width:thin; scrollbar-color:#333 transparent; }
    .tree button.file { display:block; width:100%; text-align:left; background:none; border:0;
      color:#d4d4d4; font:12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding:3px 6px; cursor:pointer; border-radius:6px; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .tree button.file:hover, .tree button.file.on { background:#161616; color:#fff; }
    .stage { position:relative; overflow:hidden; cursor:grab; margin-left:250px; }
    .stage:active { cursor:grabbing; }
    .canvas { position:absolute; transform-origin:0 0; width:1400px; height:900px; }
    svg.edges { position:absolute; inset:0; width:1400px; height:900px; pointer-events:none; }
    .node { position:absolute; min-width:168px; max-width:210px; padding:12px 14px;
      border-radius:12px; border:1px solid; background:#0d0d0d; cursor:pointer;
      box-shadow:0 8px 24px rgba(0,0,0,.45); }
    .node:hover { transform:translateY(-2px); }
    .node.active { outline:2px solid #fff; }
    .node .ico { font-size:16px; margin-bottom:4px; }
    .node .t { font-size:13px; font-weight:650; }
    .node .s { font-size:11px; color:var(--muted); margin-top:2px; }
    .node .tag { display:inline-block; margin-top:8px; font-size:10px; letter-spacing:.04em;
      padding:2px 6px; border-radius:4px; font-family:ui-monospace, Menlo, monospace; }
    .node.core { border-color:var(--core); left:560px; top:340px; min-width:200px; }
    .node.core .tag { color:var(--core); background:rgba(245,166,35,.12); }
    .node.memory { border-color:var(--memory); }
    .node.memory .tag { color:var(--memory); background:rgba(96,165,250,.12); }
    .node.skills { border-color:var(--skills); }
    .node.skills .tag { color:var(--skills); background:rgba(52,211,153,.12); }
    .node.hooks { border-color:var(--hooks); }
    .node.hooks .tag { color:var(--hooks); background:rgba(192,132,252,.12); }
    .node.integrations { border-color:var(--integrations); }
    .node.integrations .tag { color:var(--integrations); background:rgba(34,211,238,.12); }
    .node.outputs { border-color:var(--outputs); }
    .node.outputs .tag { color:var(--outputs); background:rgba(244,114,182,.12); }
    .hidden { opacity:.12; pointer-events:none; }
    .detail { position:fixed; top:0; right:0; width:min(420px, 92vw); height:100%;
      background:#0a0a0a; border-left:1px solid var(--line); z-index:50;
      transform:translateX(110%); transition:transform .25s ease; overflow:auto;
      padding:24px 22px 40px; }
    .detail.open { transform:none; }
    .detail .k { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    .detail h3 { font-size:22px; margin:8px 0 6px; letter-spacing:-.03em; }
    .detail .path { font-family:ui-monospace, Menlo, monospace; font-size:11px; color:var(--skills);
      margin-bottom:14px; }
    .detail p, .detail li { color:#cfcfcf; font-size:14px; line-height:1.55; }
    .close { position:absolute; top:14px; right:14px; background:transparent; color:#fff;
      border:1px solid #333; border-radius:8px; width:32px; height:32px; cursor:pointer; }
    .zoom { position:fixed; bottom:18px; right:18px; z-index:45; display:flex; gap:6px; }
    .zoom button { width:36px; height:36px; border-radius:10px; border:1px solid #2a2a2a;
      background:#111; color:#fff; cursor:pointer; }
    @media (max-width: 720px) {
      .tree { width:min(250px, 78vw); }
      .stage { margin-left:0; }
    }
  </style>
</head>
<body>
  <div class="hud">
    <h1>Volta Signal architecture</h1>
    <p class="sub">Rules always or by file. Skills load for the matching job. Hooks block secrets. Memory is facts. Click a file — descriptions only, no source dumps.</p>
    <div class="filters" id="filters"></div>
  </div>
  <div class="layout">
    <aside class="tree">
      <h2>Folders the agent loads</h2>
      <div id="tree"></div>
    </aside>
    <div class="stage" id="stage">
      <div class="canvas" id="canvas">
        <svg class="edges" id="edges"></svg>
        <div id="nodes"></div>
      </div>
    </div>
  </div>
  <aside class="detail" id="detail">
    <button class="close" id="close">✕</button>
    <div id="detailBody"></div>
  </aside>
  <div class="zoom">
    <button id="zin">+</button>
    <button id="zout">−</button>
    <button id="zreset">⟲</button>
  </div>
<script>
const C = { memory:"#60a5fa", skills:"#34d399", hooks:"#c084fc", integrations:"#22d3ee", outputs:"#f472b6", core:"#f5a623" };
const nodes = [
  { id:"core", x:560, y:360, w:210, cat:"core", ico:"◈", label:"Volta Signal", sub:"Worker + D1", tag:"CORE",
    path:"volta-signal/src/index.ts",
    body:"Cloudflare Worker. Cron every 30 minutes UTC; Halifax local time decides collect vs publish. Staging admin is POST /admin/run." },
  { id:"claude", x:40, y:80, cat:"memory", ico:"📄", label:"CLAUDE.md", sub:"short briefing", tag:"ALWAYS",
    path:"CLAUDE.md",
    body:"Project briefing only: buyers, monthly cadence, volta-signal/ is the system of record. Points at rules, skills, hooks, memory, logs." },
  { id:"rules", x:40, y:190, cat:"memory", ico:"📐", label:"Project rules", sub:".cursor/rules/*.mdc", tag:"RULE",
    path:".cursor/rules/",
    body:"Cursor project rules. Worker rule attaches on volta-signal source files. Harness rule attaches when editing markdown or .cursor files. One concern each, no copied source." },
  { id:"mem", x:40, y:300, cat:"memory", ico:"🧠", label:"memory/", sub:"facts only", tag:"memory/",
    path:"volta-signal/memory/MEMORY.md",
    body:"Durable facts. buyers.md is Bader vs Matt. staging.md is public URLs and names. No procedures and no secrets." },
  { id:"vclaude", x:40, y:410, cat:"memory", ico:"📄", label:"volta-signal/CLAUDE.md", sub:"nested briefing", tag:"DIRECTORY",
    path:"volta-signal/CLAUDE.md",
    body:"Loads when work is inside volta-signal/. No auto-send, no invented sources, drafts are not sent, Send test is not Approve." },
  { id:"skpub", x:40, y:530, cat:"skills", ico:"⚡", label:"skill: publish", sub:"collect → Slack", tag:"SKILL",
    path:".cursor/skills/volta-signal-publish/SKILL.md",
    body:"Loads when you ask to publish, generate, or post the review card. Five steps. No curl dumps. Live send is a different skill." },
  { id:"sksend", x:40, y:640, cat:"skills", ico:"⚡", label:"skill: send", sub:"test vs live", tag:"SKILL",
    path:".cursor/skills/volta-signal-send/SKILL.md",
    body:"Loads for inbox, Approve, or live send. Send test is not the list. Slack SENT is not Gmail opened." },
  { id:"chook", x:250, y:700, cat:"hooks", ico:"🪝", label:"hooks.json", sub:"block .dev.vars", tag:"CURSOR HOOK",
    path:".cursor/hooks.json",
    body:"Cursor hooks. beforeReadFile and beforeShellExecution run block-secrets.mjs so the agent cannot dump .dev.vars." },
  { id:"cron", x:860, y:70, cat:"hooks", ico:"⏱", label:"Cron + Halifax", sub:"Worker schedule", tag:"WORKER",
    path:"volta-signal/src/schedule.ts",
    body:"Worker cron, not a Cursor hook. First Monday 07:30 America/Halifax publish. Day-1 collect. job_runs stops doubles." },
  { id:"kill", x:1080, y:200, cat:"hooks", ico:"🛑", label:"LIVE_SEND_ENABLED", sub:"kill switch", tag:"WORKER",
    path:"volta-signal/wrangler.toml",
    body:"Worker kill switch. false blocks Approve and send. Staging is on for a one-person list. Production stays off." },
  { id:"qa", x:1080, y:320, cat:"hooks", ico:"✅", label:"QA + release", sub:"validate.ts", tag:"WORKER",
    path:"volta-signal/src/validate.ts",
    body:"Cited sources only, no extra URLs, approval TTL, one send per idempotency key." },
  { id:"src", x:860, y:470, cat:"integrations", ico:"🌐", label:"Volta sources", sub:"allowlist", tag:"SRC",
    path:"volta-signal/src/sources.ts",
    body:"ICS, blog /news/, events JSON-LD, program pages. Disabled sources stay off." },
  { id:"groq", x:1080, y:470, cat:"integrations", ico:"✦", label:"Groq LLM", sub:"gpt-oss-120b", tag:"LLM",
    path:"volta-signal/src/generate.ts",
    body:"JSON variants that must cite source ids from the facts pack. One retry on 429." },
  { id:"d1", x:860, y:580, cat:"integrations", ico:"🗄", label:"D1", sub:"staging DB", tag:"DB",
    path:"volta-signal/migrations/0001_init.sql",
    body:"Issues, sources, variants, send attempts, audit. Aggregate metrics only." },
  { id:"mc", x:1080, y:580, cat:"integrations", ico:"✉", label:"Mailchimp", sub:"draft / test / live", tag:"ESP",
    path:"volta-signal/src/email.ts",
    body:"Drafts for Edit. Test copy to reply-to. Live send to the audience." },
  { id:"slack", x:860, y:690, cat:"integrations", ico:"#", label:"Slack", sub:"#volta-signal-review", tag:"REVIEW",
    path:"volta-signal/src/slack.ts",
    body:"Review card and HMAC-verified buttons. Approver allowlist." },
  { id:"vars", x:320, y:80, cat:"outputs", ico:"✉", label:"3 variants", sub:"founder / builder / pulse", tag:"OUTPUT",
    path:"volta-signal/src/generate.ts",
    body:"Three scored variants. Recommended is founders-first on ties. HTML is Volta black." },
  { id:"prev", x:320, y:190, cat:"outputs", ico:"👁", label:"Signed preview", sub:"7-day HMAC", tag:"OUTPUT",
    path:"volta-signal/src/preview.ts",
    body:"Signed /preview links. Theme changes re-render from stored JSON." },
  { id:"card", x:560, y:190, cat:"outputs", ico:"🗂", label:"Slack review card", sub:"human gate", tag:"OUTPUT",
    path:"volta-signal/src/slack.ts",
    body:"Nothing live-sends without this click and the confirmation modal." },
  { id:"camp", x:560, y:560, cat:"outputs", ico:"📬", label:"Mailchimp campaign", sub:"draft / test / live", tag:"OUTPUT",
    path:"volta-signal/src/email.ts",
    body:"Draft for editing. Test has [TEST] in the subject. Live does not." },
  { id:"log", x:320, y:560, cat:"outputs", ico:"📜", label:"logs/", sub:"what ran", tag:"LOG",
    path:"volta-signal/logs/2026-09-pipeline.md",
    body:"History, not a playbook. Deploys, drafts, and live send for 2026-M09." }
];
const edges = [
  ["claude","core"],["rules","core"],["vclaude","core"],["mem","core"],
  ["skpub","core"],["sksend","core"],["chook","core"],
  ["cron","core"],["kill","core"],["qa","core"],
  ["src","core"],["groq","core"],["d1","core"],["mc","core"],["slack","core"],
  ["core","vars"],["core","card"],["core","prev"],["core","camp"],["core","log"]
];
const tree = [
  { dir:"CLAUDE.md + rules" },
  { path:"CLAUDE.md", id:"claude" },
  { path:"volta-signal/CLAUDE.md", id:"vclaude" },
  { path:".cursor/rules/volta-signal-worker.mdc", id:"rules" },
  { path:".cursor/rules/volta-signal-harness.mdc", id:"rules" },
  { dir:"skills" },
  { path:"volta-signal-publish/SKILL.md", id:"skpub" },
  { path:"volta-signal-send/SKILL.md", id:"sksend" },
  { dir:"hooks" },
  { path:"hooks.json", id:"chook" },
  { path:"hooks/block-secrets.mjs", id:"chook" },
  { dir:"memory" },
  { path:"MEMORY.md", id:"mem" },
  { path:"buyers.md", id:"mem" },
  { path:"staging.md", id:"mem" },
  { dir:"logs" },
  { path:"2026-09-pipeline.md", id:"log" }
];
const cats = ["all","memory","skills","hooks","integrations","outputs"];
let filter = "all";
let scale = 0.92, tx = 10, ty = 20, dragging=false, px=0, py=0;
const vis = (n) => filter==="all" || n.cat==="core" || n.cat===filter;
function applyCam() {
  document.getElementById("canvas").style.transform = "translate("+tx+"px,"+ty+"px) scale("+scale+")";
}
function show(id) {
  const n = nodes.find(x => x.id === id);
  if (!n) return;
  document.querySelectorAll(".node").forEach(el => el.classList.toggle("active", el.dataset.id===id));
  document.querySelectorAll(".file").forEach(el => el.classList.toggle("on", el.dataset.id===id));
  document.getElementById("detail").classList.add("open");
  document.getElementById("detailBody").innerHTML =
    "<div class='k'>"+n.cat+"</div><h3>"+n.label+"</h3><div class='path'>"+n.path+"</div><p>"+n.body+"</p>";
}
function draw() {
  const host = document.getElementById("nodes");
  host.innerHTML = nodes.map(n =>
    '<div class="node '+n.cat+(vis(n)?'':' hidden')+'" data-id="'+n.id+'" style="left:'+n.x+'px;top:'+n.y+'px">'+
    '<div class="ico">'+n.ico+'</div><div class="t">'+n.label+'</div><div class="s">'+n.sub+'</div>'+
    '<div class="tag">'+n.tag+'</div></div>'
  ).join("");
  host.querySelectorAll(".node").forEach(el => el.addEventListener("click", ev => { ev.stopPropagation(); show(el.dataset.id); }));
  let e = "";
  for (const [a,b] of edges) {
    const A = nodes.find(n=>n.id===a), B = nodes.find(n=>n.id===b);
    if (!vis(A) || !vis(B)) continue;
    const ax=A.x+(A.w||90), ay=A.y+36, bx=B.x+20, by=B.y+36;
    e += '<path d="M'+ax+' '+ay+' C '+(ax+bx)/2+' '+ay+', '+(ax+bx)/2+' '+by+', '+bx+' '+by+
         '" fill="none" stroke="'+(C[A.cat]||"#fff")+'" stroke-opacity="0.35" stroke-width="1.6"/>';
  }
  document.getElementById("edges").innerHTML = e;
}
document.getElementById("filters").innerHTML = cats.map(c =>
  '<button data-c="'+c+'">'+(c==="all"?"All":'<span class="dot" style="background:'+(C[c]||"#fff")+'"></span>'+c)+"</button>"
).join("");
document.querySelectorAll("#filters button").forEach(b => {
  b.addEventListener("click", () => {
    filter=b.dataset.c;
    document.querySelectorAll("#filters button").forEach(x=>x.classList.toggle("on", x===b));
    draw();
  });
});
document.querySelector("#filters button").classList.add("on");
document.getElementById("tree").innerHTML = tree.map(item =>
  item.dir ? '<div class="dir">'+item.dir+"</div>" :
  '<button class="file" data-id="'+item.id+'">'+item.path+"</button>"
).join("");
document.querySelectorAll(".file").forEach(b => b.addEventListener("click", () => show(b.dataset.id)));
document.getElementById("close").onclick = () => {
  document.getElementById("detail").classList.remove("open");
  document.querySelectorAll(".node,.file").forEach(el => el.classList.remove("active","on"));
};
const stage = document.getElementById("stage");
stage.addEventListener("pointerdown", e => { if (e.target.closest(".node")) return; dragging=true; px=e.clientX-tx; py=e.clientY-ty; });
window.addEventListener("pointermove", e => { if (!dragging) return; tx=e.clientX-px; ty=e.clientY-py; applyCam(); });
window.addEventListener("pointerup", () => dragging=false);
stage.addEventListener("wheel", e => {
  e.preventDefault();
  const next = Math.min(1.6, Math.max(0.5, scale + (e.deltaY<0?0.08:-0.08)));
  scale = next; applyCam();
}, {passive:false});
document.getElementById("zin").onclick = () => { scale=Math.min(1.6, scale+0.1); applyCam(); };
document.getElementById("zout").onclick = () => { scale=Math.max(0.5, scale-0.1); applyCam(); };
document.getElementById("zreset").onclick = () => { scale=0.92; tx=10; ty=20; applyCam(); };
draw(); applyCam();
</script>
</body>
</html>`;
