/* Cards Against Our Family — screens + phone-to-phone rooms.
   One phone hosts (it runs Engine and holds the game); the others connect to it with PeerJS. */
"use strict";
const VERSION = "1.0";
const App = (() => {
  const PREFIX = "cards-against-our-family-";
  const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LS_ME = "caf_me", LS_HOST = "caf_host", LS_CLIENT = "caf_client";
  const ls = {
    get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
    del(k){ try{ localStorage.removeItem(k); }catch(e){} }
  };
  const uid = () => Math.random().toString(36).slice(2, 10);
  let me = ls.get(LS_ME) || { id: uid() + uid(), name: "" };
  ls.set(LS_ME, me);

  let screen = "home";           // home | host | join | how | room
  let peer = null, isHost = false, code = null, O = null, V = null, conn = null;
  const conns = {};
  let status = "", retryTimer = null, overlay = null, flash = "";
  let sel = [], blankText = {}, editing = null, lastRoundKey = "";
  const drafts = {};

  const $app = document.getElementById("app");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const peerOpts = () => Object.assign({ debug: 0 }, window.PEER_OPTS || {});
  const genCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
  const peerId = c => PREFIX + c.toLowerCase();
  const inviteLink = () => location.href.split(/[?#]/)[0] + "?join=" + code;
  const online = id => id === me.id || !!(conns[id] && conns[id].open);

  /* =================== HOST =================== */
  function broadcast(){
    if(!isHost || !O) return;
    ls.set(LS_HOST, O);
    Object.keys(conns).forEach(pid => {
      const c = conns[pid];
      if(c && c.open){ try{ c.send({ t: "state", v: Engine.viewFor(O, pid, online) }); }catch(e){} }
    });
    V = Engine.viewFor(O, me.id, online);
    render();
  }
  function hostMsg(c, m){
    if(!m || typeof m !== "object") return;
    if(m.t === "hello"){
      if(typeof m.id !== "string" || !m.id || m.id === me.id) return;
      const old = conns[m.id];
      if(old && old !== c){ try{ old.close(); }catch(e){} }
      if(Engine.addPlayer(O, m.id, m.name) === "full"){ try{ c.send({ t: "full" }); }catch(e){} return; }
      conns[m.id] = c; c.pid = m.id;
      broadcast();
      return;
    }
    if(c.pid && conns[c.pid] === c) hostAct(c.pid, m);
  }
  function hostAct(from, m){
    if(m.t === "kick"){
      const c = conns[m.id];
      if(from === me.id && c){ try{ c.send({ t: "kicked" }); }catch(e){} setTimeout(() => { try{ c.close(); }catch(e){} }, 300); delete conns[m.id]; }
    }
    if(m.t === "leave"){ Engine.removePlayer(O, from); const c = conns[from]; delete conns[from]; if(c) setTimeout(() => { try{ c.close(); }catch(e){} }, 300); broadcast(); return; }
    Engine.act(O, from, m, me.id);
    broadcast();
  }
  function openHostPeer(resuming, tries){
    tries = tries || 0;
    if(peer){ try{ peer.destroy(); }catch(e){} }
    status = resuming ? "Reopening room…" : "Creating room…";
    render();
    if(typeof Peer === "undefined"){ status = "Couldn't load the connection library. Check your internet and reload."; render(); return; }
    peer = new Peer(peerId(code), peerOpts());
    peer.on("open", () => { status = ""; broadcast(); });
    peer.on("connection", c => {
      c.on("data", m => hostMsg(c, m));
      c.on("close", () => { if(c.pid && conns[c.pid] === c){ delete conns[c.pid]; broadcast(); } });
      c.on("error", () => {});
    });
    peer.on("disconnected", () => {
      status = "Reconnecting…"; render();
      setTimeout(() => { if(peer && !peer.destroyed && peer.disconnected){ try{ peer.reconnect(); }catch(e){} } }, 1500);
    });
    peer.on("error", e => {
      if(e.type === "unavailable-id"){
        if(!resuming && O.phase === "lobby" && O.round === 0){ code = genCode(); O.code = code; openHostPeer(false); }
        else if(tries < 20){ status = "Reopening room… (the old connection is still closing)"; render(); setTimeout(() => openHostPeer(true, tries + 1), 3000); }
        else { status = "Couldn't reopen the room. Try again in a minute."; render(); }
      } else if(["network", "server-error", "socket-error", "socket-closed"].includes(e.type)){
        status = "Connection problem — retrying…"; render();
        setTimeout(() => { if(peer && !peer.destroyed){ if(peer.disconnected){ try{ peer.reconnect(); }catch(x){} } } else openHostPeer(true); }, 3000);
      }
    });
  }

  /* =================== CLIENT =================== */
  function scheduleRetry(){
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if(!isHost && code && !(conn && conn.open)) connectClient(); }, 3000);
  }
  function connectClient(){
    if(typeof Peer === "undefined"){ status = "Couldn't load the connection library. Check your internet and reload."; render(); return; }
    if(peer && peer.destroyed) peer = null;
    if(!peer){
      peer = new Peer(peerOpts());
      peer.on("open", dial);
      peer.on("disconnected", () => { setTimeout(() => { if(peer && !peer.destroyed && peer.disconnected){ try{ peer.reconnect(); }catch(e){} } }, 1000); });
      peer.on("error", e => {
        if(e.type === "peer-unavailable") status = V ? "Lost the host's phone — reconnecting…" : `Can't find room ${code}. Check the code, and make sure the host has the game open.`;
        else status = "Connection trouble — retrying…";
        render(); scheduleRetry();
      });
    } else if(peer.open) dial();
    else if(peer.disconnected){ try{ peer.reconnect(); }catch(e){} }
  }
  function dial(){
    if(conn){ try{ conn.close(); }catch(e){} }
    const c = peer.connect(peerId(code), { reliable: true });
    conn = c;
    c.on("open", () => { status = ""; c.send({ t: "hello", id: me.id, name: me.name }); render(); });
    c.on("data", m => {
      if(!m) return;
      if(m.t === "state"){ V = m.v; render(); }
      if(m.t === "kicked"){ leave(true); flash = "You were removed from the room."; render(); }
      if(m.t === "full"){ leave(true); flash = "That room is full (20 players max)."; render(); }
    });
    c.on("close", () => { if(conn === c){ status = "Lost connection — reconnecting…"; render(); scheduleRetry(); } });
    c.on("error", () => { scheduleRetry(); });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if(conn === c && !c.open){ status = V ? "Reconnecting…" : "Still trying to reach the room…"; render(); connectClient(); } }, 8000);
  }
  function send(m){
    if(isHost) hostAct(me.id, m);
    else if(conn && conn.open) conn.send(m);
    else { status = "Not connected — reconnecting…"; render(); connectClient(); }
  }
  function leave(silent){
    clearTimeout(retryTimer);
    if(!isHost && conn && conn.open && !silent){ try{ conn.send({ t: "leave" }); }catch(e){} }
    const p = peer;
    setTimeout(() => { if(p){ try{ p.destroy(); }catch(e){} } }, 250);
    peer = null; conn = null; V = null; O = null; code = null; status = ""; overlay = null; editing = null; sel = [];
    Object.keys(conns).forEach(k => delete conns[k]);
    if(isHost) ls.del(LS_HOST); else ls.del(LS_CLIENT);
    isHost = false;
    screen = "home"; render(); window.scrollTo(0, 0);
  }
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState !== "visible" || screen !== "room" || !code) return;
    if(peer && !peer.destroyed && peer.disconnected){ try{ peer.reconnect(); }catch(e){} }
    if(isHost && (!peer || peer.destroyed)) openHostPeer(true);
    if(!isHost && !(conn && conn.open)) connectClient();
  });

  /* =================== RENDER HELPERS =================== */
  const nm = id => ((V && V.players.find(p => p.id === id)) || {}).name || "?";
  const trimEnd = t => String(t).replace(/[.!]+$/, "");
  function blackHTML(b, cards, cls){
    if(!b) return "";
    const src = b.pick > 1 ? `<span class="pk">PICK ${b.pick}</span>` : "";
    let html;
    if(cards){
      let i = 0;
      const hasBlank = b.t.includes("_");
      html = esc(b.t).replace(/_/g, () => `<span class="fill">${esc(trimEnd(cards[i++] || "____"))}</span>`);
      if(!hasBlank) html += `<span class="ans">${cards.map(esc).join(" / ")}</span>`;
    } else html = esc(b.t).replace(/_/g, '<span class="blank"></span>');
    return `<div class="black ${cls || ""}">${html}${src}<span class="src">${esc(PACKS[b.pack] ? PACKS[b.pack].name : "")}</span></div>`;
  }
  function comboText(b, cards){
    let i = 0;
    if(!b.t.includes("_")) return `${esc(b.t)} <span class="fill">${cards.map(c => esc(c)).join(" / ")}</span>`;
    return esc(b.t).replace(/_/g, () => `<span class="fill">${esc(trimEnd(cards[i++] || ""))}</span>`);
  }
  const bar = () => `<div class="bar"><span class="meta">Room <b>${esc(code)}</b>${V && V.round ? " · Round " + V.round : ""}</span><button class="iconbtn" data-a="menu" aria-label="Menu">☰</button></div>`;
  const statusBox = () => status ? `<div class="err">${esc(status)}</div>` : "";
  function scoreList(kick){
    const ps = V.players.slice().sort((a, b) => b.score - a.score);
    return `<div class="list">${ps.map(p => `<div class="row"><span>${p.czar ? "👑 " : ""}${esc(p.name)}${p.id === me.id ? " (you)" : ""}${p.online ? "" : ' <span style="color:#777;font-size:13px">· offline</span>'}</span>
      <span>${kick && isHost && p.id !== me.id ? `<button class="x" data-a="kick" data-id="${esc(p.id)}">Remove</button> ` : ""}<span class="sc">${p.score}</span></span></div>`).join("")}</div>`;
  }

  /* =================== SCREENS =================== */
  function home(){
    const h = ls.get(LS_HOST), c = ls.get(LS_CLIENT);
    return `
      <div class="logo"><div class="c k">Cards Against Our ______.</div><div class="c w">Family.</div></div>
      <p class="tag">A horrible game for horrible families. Everyone plays on their own phone.</p>
      ${flash ? `<div class="err">${esc(flash)}</div>` : ""}
      ${h && h.code ? `<button class="btn gold" data-a="resume">Reopen your room ${esc(h.code)}</button>` : ""}
      ${c && c.code ? `<button class="btn gold" data-a="rejoin">Rejoin room ${esc(c.code)}</button>` : ""}
      <button class="btn" data-a="goHost">Host a game</button>
      <button class="btn ghost" data-a="goJoin">Join a game</button>
      <button class="link" data-a="goHow">How to play</button>
      <div class="ver">Version ${VERSION} · ${Engine.BLACK.length} black cards · ${Engine.WHITE.length} white cards</div>`;
  }
  function hostScreen(){
    return `<div class="bar"><button class="iconbtn" data-a="home" aria-label="Back">‹</button><span></span></div>
      <h1>Host a game</h1>
      <p class="sub">Your phone runs the room — keep this page open while you play. Everyone else joins with the room code or a link.</p>
      <label class="lbl">Your name</label>
      <input type="text" id="name" maxlength="20" autocomplete="off" value="${esc(drafts.name != null ? drafts.name : me.name)}">
      <button class="btn gold" data-a="create">Create room</button>`;
  }
  function joinScreen(){
    return `<div class="bar"><button class="iconbtn" data-a="home" aria-label="Back">‹</button><span></span></div>
      <h1>Join a game</h1>
      <p class="sub">Get the 4-letter room code from the host's phone.</p>
      ${flash ? `<div class="err">${esc(flash)}</div>` : ""}
      <label class="lbl">Your name</label>
      <input type="text" id="name" maxlength="20" autocomplete="off" value="${esc(drafts.name != null ? drafts.name : me.name)}">
      <label class="lbl">Room code</label>
      <input type="text" id="code" maxlength="4" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase;font-size:30px;letter-spacing:.3em;text-align:center;font-weight:900" value="${esc(drafts.code || "")}">
      <button class="btn gold" data-a="join">Join</button>`;
  }
  function howScreen(){
    return `<div class="bar"><button class="iconbtn" data-a="home" aria-label="Back">‹</button><span></span></div>
      <div class="howto"><h1>How to play</h1>
      <p><b>1.</b> One person hosts and everyone joins on their own phone. 3 players minimum — it's best with 7 or more (up to 20).</p>
      <p><b>2.</b> Each round, one player is the <b>👑 Card Czar</b>. They read the black card out loud.</p>
      <p><b>3.</b> Everyone else picks the funniest white card from their hand (or two, if it says PICK 2 — in order) and taps <b>Play</b>.</p>
      <p><b>4.</b> When all cards are in, the Czar reads every answer out loud and crowns a favorite. That player gets a point.</p>
      <p><b>5.</b> The Czar passes to the next person. First to the target score wins.</p>
      <p>✏️ <b>Blank cards</b> show up now and then — write whatever you want on them.</p>
      <p>🔁 <b>Bad hand?</b> Swap your whole hand for 1 point (free if you have nothing you're allowed to play).</p>
      <p>🍼 Baby Jo Jo cards can't be played on spicy cards, and spicy cards can't be played on baby Jo Jo cards. The host can turn whole packs on or off in the lobby.</p></div>
      <button class="btn" data-a="home">Got it</button>`;
  }

  function lobby(){
    const packs = Object.keys(PACKS).map(k => `<button class="toggle" data-a="pack" data-k="${k}" ${isHost ? "" : "disabled"}><span><b>${esc(PACKS[k].name)}</b><small>${esc(PACKS[k].desc)} · ${PACKS[k].black.length + PACKS[k].white.length} cards</small></span><span class="sw ${V.packs[k] ? "on" : ""}"></span></button>`).join("");
    const n = V.players.length;
    return `${bar()}${statusBox()}
      <div class="center" style="color:var(--muted);font-size:13px;margin-top:6px;font-weight:700;letter-spacing:.1em">ROOM CODE</div>
      <div class="code">${esc(code)}</div>
      <button class="btn ghost small" data-a="share">📨 Send invite link</button>
      <h2>Players (${n})</h2>${scoreList(true)}
      ${n < 7 ? `<p class="sub" style="margin-top:10px">${n < 3 ? "Need at least 3 players to start." : "Ready to go — but it's best with 7 or more."}</p>` : ""}
      <h2>Packs</h2>${packs}
      <button class="toggle" data-a="blanks" ${isHost ? "" : "disabled"}><span><b>Blank cards</b><small>Occasionally get a card you write yourself</small></span><span class="sw ${V.blanks ? "on" : ""}"></span></button>
      <h2>Points to win</h2>
      <div class="stepper"><span>First to</span><span style="display:flex;align-items:center">${isHost ? `<button data-a="target" data-d="-1">−</button>` : ""}<b>${V.target}</b>${isHost ? `<button data-a="target" data-d="1">+</button>` : ""}</span></div>
      <div class="sticky"><div class="in">${isHost ? `<button class="btn gold" data-a="start" ${n < 3 ? "disabled" : ""}>Start game</button>` : `<div class="status center">Waiting for the host to start…</div>`}</div></div>`;
  }

  function playScreen(){
    const b = V.black;
    if(V.isCzar){
      const ps = V.players.filter(p => !p.czar);
      return `${bar()}${statusBox()}
        <div class="banner">👑 You're the Card Czar — read this out loud!</div>
        ${blackHTML(b)}
        <div class="status"><b>${V.have} of ${V.need}</b> played<br>${ps.map(p => `<span class="pill ${p.played ? "done" : ""} ${p.online ? "" : "off"}">${p.played ? "✓ " : ""}${esc(p.name)}</span>`).join("")}</div>
        ${V.have === 0 ? `<button class="btn ghost small" data-a="skip">⏭ Skip this black card</button>` : ""}
        <div class="sticky"><div class="in">${V.have >= 1 ? `<button class="btn gold" data-a="judgeNow">Read answers now (${V.have})</button>` : `<div class="status center" style="margin:0">Waiting for cards…</div>`}</div></div>`;
    }
    const czar = nm(V.czarId);
    if(V.mine){
      const ps = V.players.filter(p => !p.czar);
      return `${bar()}${statusBox()}
        <div class="status">👑 <b>${esc(czar)}</b> is the Card Czar</div>
        ${blackHTML(b, V.mine)}
        <div class="status">You played! Waiting on everyone else — <b>${V.have} of ${V.need}</b> in.<br>${ps.map(p => `<span class="pill ${p.played ? "done" : ""}">${p.played ? "✓ " : ""}${esc(p.name)}</span>`).join("")}</div>
        <button class="btn ghost small" data-a="unplay">↩︎ Take it back</button>`;
    }
    if(!V.hand.length) return `${bar()}<div class="status">Dealing you in…</div>`;
    const cards = V.hand.map(c => {
      const i = sel.indexOf(c.id);
      const label = c.blank ? (blankText[c.id] ? esc(blankText[c.id]) : "✏️ Blank card<br><span style='font-weight:600;font-size:14px'>Tap to write your own</span>") : esc(c.t);
      return `<button class="wc ${i >= 0 ? "sel" : ""} ${c.ok ? "" : "no"} ${c.blank ? "blk" : ""}" data-a="card" data-id="${esc(c.id)}">${label}${i >= 0 && b.pick > 1 ? `<span class="num">${i + 1}</span>` : ""}${c.ok ? "" : `<span class="note">🍼🌶️ not with this card</span>`}${c.blank && blankText[c.id] ? `<span class="note">✏️ your card</span>` : ""}</button>`;
    }).join("");
    const me_ = V.players.find(p => p.id === me.id) || { score: 0 };
    const preview = sel.length ? sel.map(id => { const c = V.hand.find(h => h.id === id); return c ? (c.blank ? blankText[id] || "" : c.t) : ""; }) : null;
    const ready = sel.length === b.pick && sel.every(id => { const c = V.hand.find(h => h.id === id); return c && (!c.blank || (blankText[id] || "").trim()); });
    return `${bar()}${statusBox()}
      <div class="status">👑 <b>${esc(czar)}</b> is the Card Czar · ${V.have} of ${V.need} played</div>
      ${blackHTML(b, preview && sel.length === b.pick ? preview : null)}
      <p class="sub" style="margin:12px 0 0">${b.pick > 1 ? `Pick <b>${b.pick}</b> cards in order.` : "Pick your funniest card."}</p>
      ${!V.canPlay ? `<div class="err">Nothing in your hand works with this card — swap your hand for free.</div>` : ""}
      <div class="hand">${cards}</div>
      <button class="btn ghost small" data-a="swap" style="margin-top:16px" ${V.canPlay && me_.score < 1 ? "disabled" : ""}>🔁 Swap my whole hand ${V.canPlay ? "(costs 1 point)" : "(free)"}</button>
      <div class="sticky"><div class="in"><button class="btn gold" data-a="play" ${ready ? "" : "disabled"}>${sel.length < b.pick ? (b.pick > 1 ? `Pick ${b.pick - sel.length} more` : "Pick a card") : "Play " + (b.pick > 1 ? "these cards" : "this card")}</button></div></div>`;
  }

  function judgeScreen(){
    const b = V.black;
    const list = V.subs.map(s => `<button class="combo ${V.sel === s.id ? "sel" : ""} ${s.id === me.id ? "mine" : ""}" data-a="select" data-id="${esc(s.id)}">${comboText(b, s.cards)}${s.id === me.id ? `<span class="who">your card</span>` : ""}</button>`).join("");
    if(V.isCzar){
      return `${bar()}${statusBox()}
        <div class="banner">👑 Read each one out loud, then tap your favorite.</div>
        ${list}
        <div class="sticky"><div class="in"><button class="btn gold" data-a="crown" ${V.sel ? "" : "disabled"}>👑 ${V.sel ? "Crown this one" : "Tap your favorite"}</button></div></div>`;
    }
    return `${bar()}${statusBox()}
      <div class="status">👑 <b>${esc(nm(V.czarId))}</b> is reading the answers and picking a winner…</div>
      ${list.replace(/data-a="select"/g, "")}`;
  }

  function resultScreen(){
    const L = V.last, b = L.black;
    const w = L.subs.find(s => s.id === L.winner);
    const others = L.subs.filter(s => s.id !== L.winner);
    const canNext = V.isCzar || isHost;
    return `${bar()}${statusBox()}
      <div class="big-emoji" style="margin-top:6px">🏆</div>
      <h1 class="center">${esc(nm(L.winner))} ${L.winner === me.id ? "(you!) " : ""}wins the round</h1>
      ${w ? `<div class="combo win">${comboText(b, w.cards)}</div>` : ""}
      ${others.length ? `<h2>The rest</h2>` + others.map(s => `<div class="combo" style="cursor:default">${comboText(b, s.cards)}<span class="who">${esc(nm(s.id))}</span></div>`).join("") : ""}
      <h2>Scores · first to ${V.target}</h2>${scoreList(false)}
      <div class="sticky"><div class="in">${canNext ? `<button class="btn gold" data-a="next">Next round →</button>` : `<div class="status center" style="margin:0">Waiting for ${esc(nm(L.czar))} to start the next round…</div>`}</div></div>`;
  }

  function winnerScreen(){
    const names = V.winners.map(nm).join(" & ");
    return `${bar()}
      <div class="big-emoji">🎉👑🎉</div>
      <h1 class="center">${esc(names)} ${V.winners.length > 1 ? "win" : "wins"}!</h1>
      <p class="sub center">Somehow, the most horrible person here.</p>
      ${V.last ? `<div class="combo win" style="cursor:default">${comboText(V.last.black, (V.last.subs.find(s => s.id === V.last.winner) || { cards: [] }).cards)}</div>` : ""}
      <h2>Final scores</h2>${scoreList(false)}
      <div class="sticky"><div class="in">${isHost ? `<button class="btn gold" data-a="again">Play again</button>` : `<div class="status center" style="margin:0">Waiting for the host…</div>`}</div></div>`;
  }

  function roomScreen(){
    if(!V) return `<div class="big-emoji">📡</div><p class="center">${isHost ? "Opening" : "Joining"} room</p><div class="code">${esc(code)}</div>${statusBox()}<button class="link" data-a="leave">Cancel</button>`;
    if(!V.players.some(p => p.id === me.id)) return `<div class="big-emoji">👋</div><p class="center">You're not in this room anymore.</p><button class="btn" data-a="leave">Back home</button>`;
    switch(V.phase){
      case "lobby": return lobby();
      case "play": return playScreen();
      case "judge": return judgeScreen();
      case "result": return resultScreen();
      case "winner": return winnerScreen();
    }
    return "";
  }

  function menuSheet(){
    const hist = (V && V.log || []).map(l => `<div class="hist"><b>${esc(nm(l.winner))}</b> · round ${l.round}<br>${comboText({ t: l.black }, l.cards)}</div>`).join("");
    return `<div class="overlay" data-a="closeOv"><div class="sheet" data-stop="1">
      ${V && V.phase !== "lobby" ? `<h2 style="margin-top:4px">Scores · first to ${V.target}</h2>${scoreList(true)}` : `<h2 style="margin-top:4px">Room ${esc(code)}</h2>`}
      <button class="btn ghost small" data-a="share">📨 Invite someone (room ${esc(code)})</button>
      ${isHost && V && V.phase !== "lobby" ? `<button class="btn ghost small" data-a="toLobby">Back to lobby (ends this game)</button>` : ""}
      ${hist ? `<h2>Round winners</h2>${hist}` : ""}
      <button class="btn ghost small" data-a="leave" style="margin-top:18px">${isHost ? "Close room" : "Leave room"}</button>
      <button class="btn small" data-a="closeOv">Done</button>
      <div class="ver">Cards Against Our Family · Version ${VERSION}</div>
    </div></div>`;
  }
  function editSheet(){
    return `<div class="overlay" data-a="closeEdit"><div class="sheet" data-stop="1">
      <h2 style="margin-top:4px">✏️ Write your own card</h2>
      ${V && V.black ? blackHTML(V.black) : ""}
      <textarea id="blankInput" maxlength="120" placeholder="Something horrible…" style="margin-top:12px">${esc(drafts.blankInput != null ? drafts.blankInput : (blankText[editing] || ""))}</textarea>
      <button class="btn gold" data-a="saveBlank">Use this card</button>
      <button class="btn ghost small" data-a="closeEdit">Cancel</button>
    </div></div>`;
  }

  function render(){
    // Keep whatever the person is typing.
    const a = document.activeElement;
    let focusId = null, s0 = 0, s1 = 0;
    if(a && a.id && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")){ focusId = a.id; drafts[a.id] = a.value; s0 = a.selectionStart; s1 = a.selectionEnd; }
    // New round → clear selections.
    const key = V ? V.round + ":" + (V.black ? V.black.t : "") : "";
    if(key !== lastRoundKey){ lastRoundKey = key; sel = []; }
    if(V && V.hand){ sel = sel.filter(id => V.hand.some(c => c.id === id)); Object.keys(blankText).forEach(id => { if(!V.hand.some(c => c.id === id)) delete blankText[id]; }); }

    let html = "";
    if(screen === "room") html = roomScreen();
    else if(screen === "host") html = hostScreen();
    else if(screen === "join") html = joinScreen();
    else if(screen === "how") html = howScreen();
    else html = home();
    if(screen === "room" && overlay === "menu") html += menuSheet();
    if(screen === "room" && editing) html += editSheet();
    $app.innerHTML = html;
    if(focusId){ const el = document.getElementById(focusId); if(el){ el.focus(); try{ el.setSelectionRange(s0, s1); }catch(e){} } }
  }

  /* =================== ACTIONS =================== */
  function val(id){ const el = document.getElementById(id); return el ? el.value : (drafts[id] || ""); }
  function setName(){
    const n = val("name").trim().slice(0, 20);
    if(!n){ flash = "Type your name first."; render(); return false; }
    me.name = n; ls.set(LS_ME, me); return true;
  }
  function share(){
    const text = `Join my Cards Against Our Family game! Room code ${code}`;
    if(navigator.share) navigator.share({ title: "Cards Against Our Family", text, url: inviteLink() }).catch(() => {});
    else if(navigator.clipboard) navigator.clipboard.writeText(text + " " + inviteLink()).then(() => { alertish("Invite link copied!"); });
  }
  function alertish(t){ status = t; render(); setTimeout(() => { if(status === t){ status = ""; render(); } }, 1800); }

  function act(a, el){
    switch(a){
      case "home": flash = ""; screen = "home"; delete drafts.name; render(); break;
      case "goHost": flash = ""; screen = "host"; render(); break;
      case "goJoin": flash = ""; screen = "join"; render(); break;
      case "goHow": screen = "how"; render(); break;
      case "create":
        if(!setName()) break;
        flash = ""; isHost = true; code = genCode();
        O = Engine.newGame(code, me); screen = "room"; V = null;
        openHostPeer(false); break;
      case "join": {
        if(!setName()) break;
        const c = val("code").trim().toUpperCase().replace(/[^A-Z]/g, "");
        if(c.length !== 4){ flash = "Room codes are 4 letters."; render(); break; }
        flash = ""; isHost = false; code = c; V = null; status = ""; screen = "room";
        ls.set(LS_CLIENT, { code }); render(); connectClient(); break;
      }
      case "resume": {
        const h = ls.get(LS_HOST); if(!h) break;
        O = h; code = O.code; isHost = true; screen = "room"; V = Engine.viewFor(O, me.id, online);
        openHostPeer(true); break;
      }
      case "rejoin": {
        const c = ls.get(LS_CLIENT); if(!c) break;
        code = c.code; isHost = false; V = null; status = ""; screen = "room"; render(); connectClient(); break;
      }
      case "menu": overlay = "menu"; render(); break;
      case "closeOv": overlay = null; render(); break;
      case "share": share(); break;
      case "leave":
        if(isHost && V && V.phase !== "lobby" && !confirm("Close the room? This ends the game for everyone.")) break;
        leave(); break;
      case "toLobby": overlay = null; send({ t: "lobby" }); break;
      case "kick": if(confirm("Remove " + nm(el.dataset.id) + " from the game?")) send({ t: "kick", id: el.dataset.id }); break;
      case "pack": send({ t: "pack", k: el.dataset.k }); break;
      case "blanks": send({ t: "blanks" }); break;
      case "target": send({ t: "target", v: V.target + (+el.dataset.d) }); break;
      case "start": send({ t: "start" }); break;
      case "card": {
        const id = el.dataset.id, c = V.hand.find(h => h.id === id);
        if(!c || !c.ok) break;
        if(c.blank && !sel.includes(id)){
          editing = id; delete drafts.blankInput; render();
          const t = document.getElementById("blankInput"); if(t) t.focus();
          break;
        }
        const i = sel.indexOf(id);
        if(i >= 0) sel.splice(i, 1);
        else { if(V.black.pick === 1) sel = []; if(sel.length < V.black.pick) sel.push(id); }
        render(); break;
      }
      case "saveBlank": {
        const t = val("blankInput").replace(/\s+/g, " ").trim().slice(0, 120);
        if(!t) break;
        blankText[editing] = t;
        if(!sel.includes(editing)){ if(V.black.pick === 1) sel = []; if(sel.length < V.black.pick) sel.push(editing); }
        editing = null; delete drafts.blankInput; render(); break;
      }
      case "closeEdit": editing = null; delete drafts.blankInput; render(); break;
      case "play": {
        const cards = sel.map(id => ({ id, text: blankText[id] || "" }));
        send({ t: "play", cards }); sel = []; window.scrollTo(0, 0); break;
      }
      case "unplay": send({ t: "unplay" }); break;
      case "swap":
        if(V.canPlay && !confirm("Swap your whole hand for 1 point?")) break;
        sel = []; send({ t: "swap" }); break;
      case "skip": send({ t: "skip" }); break;
      case "judgeNow":
        if(V.have < V.need && !confirm(`Only ${V.have} of ${V.need} have played. Read the answers now?`)) break;
        send({ t: "judgeNow" }); window.scrollTo(0, 0); break;
      case "select": if(V.isCzar) send({ t: "select", id: el.dataset.id }); break;
      case "crown": if(V.sel) send({ t: "crown", id: V.sel }); window.scrollTo(0, 0); break;
      case "next": send({ t: "next" }); window.scrollTo(0, 0); break;
      case "again": send({ t: "again" }); break;
    }
  }

  $app.addEventListener("click", e => {
    const el = e.target.closest("[data-a]");
    if(!el) return;
    // Taps inside a sheet don't close it.
    if(el.classList.contains("overlay") && e.target.closest("[data-stop]")) return;
    if(el.disabled) return;
    act(el.dataset.a, el);
  });
  $app.addEventListener("input", e => { if(e.target.id) drafts[e.target.id] = e.target.value; });
  $app.addEventListener("keydown", e => {
    if(e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    if(screen === "host") act("create"); else if(screen === "join") act("join");
  });

  // Invite links: ?join=ABCD
  const q = new URLSearchParams(location.search).get("join");
  if(q && /^[A-Za-z]{4}$/.test(q)){
    drafts.code = q.toUpperCase(); screen = "join";
    history.replaceState(null, "", location.pathname);
  }
  render();
  return { _state: () => ({ O, V, isHost, code }) };
})();
