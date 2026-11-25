/* Cards Against Our Ulibarri Family — game rules. Runs only on the host's phone.
   No DOM in here, so it can be tested on its own. */
"use strict";
const Engine = (() => {
  const HAND = 10, MAX_PLAYERS = 20, BLANK_ODDS = 0.04;

  // Build a flat catalog of every card once.
  const BLACK = [], WHITE = [];
  function parse(raw, pack, spicyPack){
    let t = raw, s = spicyPack, b = false;
    while(t[0] === "!" || t[0] === "~"){ if(t[0] === "!") s = true; else b = true; t = t.slice(1); }
    return { t, pack, s, b };
  }
  Object.keys(PACKS).forEach(k => {
    const sp = k === "dirty";
    PACKS[k].black.forEach(raw => {
      const c = parse(raw, k, sp);
      c.pick = Math.max(1, (c.t.match(/_/g) || []).length);
      BLACK.push(c);
    });
    PACKS[k].white.forEach(raw => WHITE.push(parse(raw, k, sp)));
  });

  const shuffle = a => { for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const rid = () => Math.random().toString(36).slice(2, 9);
  const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // Can this white card be played on this black card?
  function allowed(black, w){
    if(!black || !w) return true;
    if(w.blank) return true;
    return !((black.s && w.b) || (black.b && w.s));
  }

  function newGame(code, host){
    return {
      code, phase: "lobby", round: 0, czar: 0, target: 7, blanks: true,
      packs: { main: true, dirty: true, eggs: true },
      players: [{ id: host.id, name: host.name, score: 0, hand: [] }],
      wdeck: [], bdeck: [], black: null, subs: {}, order: [], pick: null, last: null, log: [], cheaters: []
    };
  }
  const enabled = O => Object.keys(O.packs).filter(k => O.packs[k] && PACKS[k]);

  function drawWhite(O){
    if(O.blanks && Math.random() < BLANK_ODDS) return { id: rid(), blank: true, t: "" };
    if(!O.wdeck.length){
      const inHand = new Set();
      O.players.forEach(p => p.hand.forEach(c => { if(c.w != null) inHand.add(c.w); }));
      const on = enabled(O);
      O.wdeck = shuffle(WHITE.map((c, i) => i).filter(i => on.includes(WHITE[i].pack) && !inHand.has(i)));
      if(!O.wdeck.length) return { id: rid(), blank: true, t: "" };
    }
    const w = O.wdeck.pop();
    return { id: rid(), w, t: WHITE[w].t, s: WHITE[w].s, b: WHITE[w].b };
  }
  function drawBlack(O){
    if(!O.bdeck.length){
      const on = enabled(O);
      O.bdeck = shuffle(BLACK.map((c, i) => i).filter(i => on.includes(BLACK[i].pack)));
    }
    const i = O.bdeck.pop();
    const c = BLACK[i];
    return { i, t: c.t, pick: c.pick, s: c.s, b: c.b };
  }
  function fill(O, p){ while(p.hand.length < HAND) p.hand.push(drawWhite(O)); }

  const czarP = O => O.players[O.czar];
  const playersIn = O => O.players.filter((p, i) => i !== O.czar);

  function startRound(O){
    O.round++;
    O.black = drawBlack(O);
    O.subs = {}; O.order = []; O.pick = null; O.last = null;
    O.phase = "play";
  }
  function reshuffleDecks(O){ O.wdeck = []; O.bdeck = []; }

  function canPlayAny(O, p){
    const usable = p.hand.filter(c => allowed(O.black, c));
    return usable.length >= O.black.pick;
  }

  function returnSubs(O){
    Object.keys(O.subs).forEach(pid => {
      const p = O.players.find(x => x.id === pid);
      if(p) O.subs[pid].forEach(c => p.hand.push(c.blank ? { id: c.id, blank: true, t: "" } : { id: c.id, w: c.w, t: c.t, s: c.s, b: c.b }));
    });
    O.subs = {};
  }
  function goJudge(O){
    const ids = Object.keys(O.subs);
    if(ids.length < 1) return;
    O.order = shuffle(ids.slice());
    O.pick = null;
    O.phase = "judge";
  }
  function maybeAutoJudge(O){
    if(O.phase !== "play") return;
    const need = playersIn(O).map(p => p.id);
    if(need.length && need.every(id => O.subs[id])) goJudge(O);
  }

  function winners(O){
    const max = Math.max(...O.players.map(p => p.score));
    return max >= O.target ? O.players.filter(p => p.score === max).map(p => p.id) : [];
  }

  function removePlayer(O, id){
    const idx = O.players.findIndex(p => p.id === id);
    if(idx < 0) return;
    const wasCzar = idx === O.czar;
    O.players.splice(idx, 1);
    delete O.subs[id];
    O.order = O.order.filter(x => x !== id);
    if(!O.players.length) return;
    if(idx < O.czar) O.czar--;
    if(O.czar >= O.players.length) O.czar = 0;
    if(O.phase === "lobby" || O.phase === "winner") return;
    if(O.players.length < 2){ O.phase = "lobby"; O.round = 0; return; }
    if(wasCzar && (O.phase === "play" || O.phase === "judge")){
      // Give played cards back, then start over with the next czar.
      returnSubs(O);
      startRound(O);
      return;
    }
    if(O.phase === "judge" && !O.order.length){ O.phase = "play"; }
    maybeAutoJudge(O);
  }

  // Every action from any phone goes through here. Returns true if state changed.
  function act(O, from, m, hostId){
    const host = from === hostId;
    const me = O.players.find(p => p.id === from);
    const cz = czarP(O);
    const isCzar = !!(cz && cz.id === from);
    switch(m.t){
      case "target": if(host && O.phase === "lobby"){ const v = Math.round(+m.v); if(v >= 1 && v <= 50) O.target = v; } return true;
      case "pack":
        if(host && O.phase === "lobby" && PACKS[m.k]){
          O.packs[m.k] = !O.packs[m.k];
          if(!enabled(O).length) O.packs.main = true;
          reshuffleDecks(O);
        } return true;
      case "blanks": if(host && O.phase === "lobby") O.blanks = !O.blanks; return true;
      case "start":
        if(host && O.phase === "lobby" && O.players.length >= 2){
          reshuffleDecks(O);
          O.players.forEach(p => { p.score = 0; p.hand = []; });
          O.players.forEach(p => fill(O, p));
          O.round = 0; O.czar = Math.floor(Math.random() * O.players.length); O.log = [];
          startRound(O);
        } return true;
      case "kick": if(host && m.id !== hostId){ removePlayer(O, m.id); } return true;
      case "play": {
        if(O.phase !== "play" || !me || isCzar || O.subs[from]) return false;
        const ids = Array.isArray(m.cards) ? m.cards : [];
        if(ids.length !== O.black.pick) return false;
        const picked = [];
        for(const x of ids){
          const c = me.hand.find(h => h.id === (x && x.id));
          if(!c || picked.some(p => p.id === c.id)) return false;
          if(!allowed(O.black, c)) return false;
          if(c.blank){
            const t = clean(x.text).slice(0, 120);
            if(!t) return false;
            picked.push({ id: c.id, t, blank: true, w: null });
          } else picked.push({ id: c.id, t: c.t, w: c.w, s: c.s, b: c.b });
        }
        me.hand = me.hand.filter(h => !picked.some(p => p.id === h.id));
        O.subs[from] = picked;
        maybeAutoJudge(O);
        return true;
      }
      case "unplay": {
        if(O.phase !== "play" || !me || !O.subs[from]) return false;
        O.subs[from].forEach(c => me.hand.push(c.blank ? { id: c.id, blank: true, t: "" } : { id: c.id, w: c.w, t: c.t, s: c.s, b: c.b }));
        delete O.subs[from];
        return true;
      }
      case "swap": {
        // Trade in your whole hand: costs a point, or free if you have no legal play.
        if(O.phase !== "play" || !me || O.subs[from]) return false;
        const cheater = (O.cheaters || []).includes(from);
        const free = cheater || (!isCzar && !canPlayAny(O, me));
        if(!free && me.score < 1) return false;
        if(!free) me.score--;
        me.hand = []; fill(O, me);
        return true;
      }
      case "skip": if((isCzar || host) && O.phase === "play" && !Object.keys(O.subs).length){ O.black = drawBlack(O); } return true;
      case "judgeNow": if((isCzar || host) && O.phase === "play" && Object.keys(O.subs).length >= 1) goJudge(O); return true;
      case "select": if(isCzar && O.phase === "judge" && O.order.includes(m.id)) O.pick = m.id; return true;
      case "crown": {
        if(!isCzar || O.phase !== "judge" || !O.order.includes(m.id)) return false;
        const w = O.players.find(p => p.id === m.id);
        if(w) w.score++;
        O.last = { winner: m.id, czar: cz.id, black: O.black, subs: O.order.map(id => ({ id, cards: O.subs[id].map(c => c.t) })) };
        O.log.unshift({ round: O.round, winner: m.id, black: O.black.t, cards: O.subs[m.id].map(c => c.t) });
        O.log = O.log.slice(0, 40);
        O.phase = "result";
        return true;
      }
      case "next": {
        if(!(isCzar || host) || O.phase !== "result") return false;
        O.players.forEach(p => fill(O, p));
        if(winners(O).length){ O.phase = "winner"; return true; }
        O.czar = (O.czar + 1) % O.players.length;
        startRound(O);
        return true;
      }
      case "cheat":
        // "Unlimited points" = unlimited free hand swaps, but everyone sees the cheater alert while it's on.
        if(!O.cheaters) O.cheaters = [];
        if(me && m.on && !O.cheaters.includes(from)) O.cheaters.push(from);
        if(!m.on) O.cheaters = O.cheaters.filter(x => x !== from);
        return true;
      case "again":
        if(host && O.phase === "winner"){ O.phase = "lobby"; O.round = 0; O.black = null; O.subs = {}; O.order = []; O.last = null; O.players.forEach(p => { p.score = 0; p.hand = []; }); }
        return true;
      case "lobby":
        if(host && O.phase !== "lobby"){
          O.phase = "lobby"; O.round = 0; O.black = null; O.subs = {}; O.order = []; O.last = null;
          O.players.forEach(p => { p.score = 0; p.hand = []; });
        } return true;
      default: return false;
    }
  }

  function addPlayer(O, id, name){
    if(O.players.some(p => p.id === id)) return "ok";
    if(O.players.length >= MAX_PLAYERS) return "full";
    const p = { id, name: uniqueName(O, name), score: 0, hand: [] };
    if(O.phase !== "lobby") fill(O, p);
    O.players.push(p);
    return "ok";
  }
  function uniqueName(O, n){
    n = clean(n).slice(0, 20) || "Player";
    let out = n, k = 2;
    while(O.players.some(p => p.name.toLowerCase() === out.toLowerCase())) out = n + " " + (k++);
    return out;
  }

  // What one phone is allowed to see.
  function viewFor(O, id, online){
    const cz = czarP(O);
    const me = O.players.find(p => p.id === id);
    const v = {
      code: O.code, me: id, phase: O.phase, round: O.round, target: O.target, packs: O.packs, blanks: O.blanks,
      players: O.players.map((p, i) => ({ id: p.id, name: p.name, score: p.score, online: online(p.id), czar: i === O.czar && O.phase !== "lobby", played: !!O.subs[p.id] })),
      czarId: cz && O.phase !== "lobby" ? cz.id : null,
      isCzar: !!(cz && cz.id === id && O.phase !== "lobby"),
      black: O.black, winners: O.phase === "winner" ? winners(O) : [],
      hand: me ? me.hand.map(c => ({ id: c.id, t: c.t, blank: !!c.blank, ok: allowed(O.black, c) })) : [],
      mine: O.subs[id] ? O.subs[id].map(c => c.t) : null,
      need: playersIn(O).length, have: Object.keys(O.subs).length,
      canPlay: me && O.black ? canPlayAny(O, me) : true,
      log: O.log.slice(0, 15),
      cheaters: (O.cheaters || []).filter(cid => O.players.some(p => p.id === cid))
    };
    if(O.phase === "judge") v.subs = O.order.map(sid => ({ id: sid, cards: O.subs[sid].map(c => c.t) })), v.sel = O.pick;
    if(O.phase === "result" || O.phase === "winner") v.last = O.last;
    return v;
  }

  return { act, addPlayer, removePlayer, viewFor, newGame, allowed, BLACK, WHITE, HAND, MAX_PLAYERS };
})();
if(typeof module !== "undefined") module.exports = Engine;
