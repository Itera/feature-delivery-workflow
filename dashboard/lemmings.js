// Optional "lemmings" theme for the dashboard: pixel characters instead of the cogwheel.
// Running task = builder, pending = blocker, failed = "oh no" explosion, skipped = skipping rope (greyscale), the last
// task has the exit door on top, and lemmings keep walking from the first task over the finished ones (see plan()).
// The sprites are original pixel art drawn here; frames are painted on a canvas once and animated with CSS steps().
(() => {
  const PAL = {
    g: '#2ee82e', G: '#149614', s: '#ffd2a8', b: '#3a5cff', B: '#1e32b4', w: '#ffffff', k: '#111111',
    r: '#c8642d', R: '#e82020', y: '#ffe040', o: '#ff8a1e', n: '#9a9aa8', N: '#5a5a6a', d: '#1a0c04', u: '#7a4a20',
  };
  // Copy of rows with single pixels replaced: patch(rows, [row, col, ch], ...)
  const patch = (rows, ...px) => rows.map((r, i) => { let a = [...r]; for (const [y, x, c] of px) if (y === i) a[x] = c; return a.join(''); });
  const walkBase = ['...gg...', '..gggG..', '..ggss..', '...sss..', '..bbb...', '..bbb...', '..bbb...', '..bBb...'];
  const builderBase = [
    '..gg........', '.gggG.......', '.ggss.......', '..sss.......', '.bbb........',
    '.bbb........', '.bbb........', '.bBb.....rrr', '.b.b...rrrrr', 'ss.ss.rrrrrr'];
  // Blocker: arms held out, only the head turns (left, ahead, right, ahead).
  const blockerBody = ['ssbbbbbbss', '...bbbb...', '...bbbb...', '...bBBb...', '...b..b...', '..ss..ss..'];
  const blockerHead = (face, chin) => ['....gg....', '...gggg...', face, chin, ...blockerBody];
  const ohno = ['............', '....s..s....', '....sggs....', '....gggg....', '....gsss....', '.....ss.....',
    '....bbbb....', '....bbbb....', '.....bb.....', '....b..b....', '....s..s....', '............'];
  const exitBody = ['..u.nNNNNn.u..', '..unNddddNnu..', '..nNddddddNn..', '..nNddddddNn..', '..nNddddddNn..',
    '..nNddddddNn..', '..nNddddddNn..', '..nNddddddNn..', '.nnNddddddNnn.', 'nnnnnnnnnnnnnn', 'NNNNNNNNNNNNNN'];
  const umbrella = ['...RRwwRR...', '.RRwwRRwwRR.', 'RwwRRwwRRwwR', '......k.....', '......k.....'];
  const floaterBody = ['.....gs.....', '....ggs.....', '....gss.....', '.....ss.....', '....bbb.....', '....bbb.....', '....bBb.....'];
  const SPRITES = {
    walker: { dur: 0.6, frames: [
      [...walkBase, '..b..b..', '.ss...s.'],
      [...patch(walkBase, [5, 3, 's']), '...bb...', '...ss...'],
      [...patch(walkBase, [5, 1, 's']), '..b.b...', '..s..s..'],
      [...patch(walkBase, [5, 3, 's']), '...bb...', '...ss...']] },
    builder: { dur: 1.2, frames: [
      patch(builderBase, [5, 4, 's']),
      patch(builderBase, [0, 5, 'r'], [0, 6, 'r'], [1, 5, 's'], [2, 5, 's']),
      patch(builderBase, [4, 4, 's'], [4, 5, 'r'], [4, 6, 'r']),
      patch(builderBase, [5, 4, 's'], [6, 9, 'y'], [6, 10, 'y'], [6, 11, 'y'])] },
    blocker: { dur: 3.2, frames: [
      blockerHead('...ssgg...', '...sss....'), blockerHead('...gssg...', '....ss....'),
      blockerHead('...ggss...', '....sss...'), blockerHead('...gssg...', '....ss....')] },
    floater: { dur: 1.2, frames: [
      [...umbrella, ...floaterBody, '....b.b.....', '....s.s.....'],
      [...umbrella.map((r, i) => i < 3 ? '.' + r.slice(0, -1) : r), ...floaterBody, '.....bb.....', '.....ss.....']] },
    // Skipped task: a lemming skipping rope (shown in greyscale).
    skipper: { dur: 1.0, frames: [
      ['............', '....wwww....', '...w....w...', '..w......w..', '..w......w..', '..w..gg..w..', '..w.gggg.w..',
        '..w.gssg.w..', '..w..ss..w..', '...sbbbbs...', '....bbbb....', '....bBBb....', '....b..b....', '....s..s....'],
      ['............', '............', '............', '............', '............', '.....gg.....', '....gggg....',
        '....gssg....', '.....ss.....', '...sbbbbs...', '...wbbbbw...', '...wbBBbw...', '...wwwwww...', '....s..s....'],
      ['............', '............', '............', '.....gg.....', '....gggg....', '....gssg....', '.....ss.....',
        '...sbbbbs...', '...wbbbbw...', '...wbBBbw...', '...wb..bw...', '...ws..sw...', '....w..w....', '....wwww....'],
      ['............', '............', '............', '............', '............', '.....gg.....', '....gggg....',
        '....gssg....', '.....ss.....', '...sbbbbs...', '...wbbbbw...', '...wbBBbw...', '...wwwwww...', '....s..s....']] },
    ohno: { dur: 2.4, frames: [
      ohno,
      ohno.map((r) => r.slice(1) + '.'),
      ['............', '.....yy.....', '...y.oo.y...', '....oyyo....', '..yoywwyoy..', '.yoywwwwyoy.', '..yoywwyoy..',
        '....oyyo....', '...y.oo.y...', '.....yy.....', '............', '............'],
      ['..g......b..', '......s.....', 'y.........o.', '....b.......', '..........g.', '.s....y.....', '............',
        'b.......s...', '....g.......', '..o.......y.', '......b.....', '............'],
      ['............', '............', '.g.......b..', '............', 'y.....s...o.', '............', '...b........',
        '..........g.', '.s..........', '......y.....', 'b.......s...', '...g.....b..'],
      Array(12).fill('............')] },
    exit: { dur: 0.5, frames: [
      ['..y........y..', '.yoy......yoy.', '..o..nnnn..o..', ...exitBody],
      ['.y..........y.', '..yo......oy..', '..o..nnnn..o..', ...exitBody]] },
  };
  for (const [k, sp] of Object.entries(SPRITES)) {
    sp.w = sp.frames[0][0].length; sp.h = sp.frames[0].length;
    for (const f of sp.frames) if (f.length !== sp.h || f.some((r) => r.length !== sp.w)) throw new Error(`sprite ${k}: bad frame size`);
    const c = document.createElement('canvas');
    c.width = sp.w * sp.frames.length; c.height = sp.h;
    const g = c.getContext('2d');
    sp.frames.forEach((f, i) => f.forEach((row, y) => [...row].forEach((ch, x) => {
      if (PAL[ch]) { g.fillStyle = PAL[ch]; g.fillRect(i * sp.w + x, y, 1, 1); }
    })));
    sp.url = c.toDataURL();
  }

  // Animation phase from the clock, so sprites keep moving smoothly when the graph is re-rendered.
  function sprite(kind, scale, cls = '') {
    const sp = SPRITES[kind], w = sp.w * scale, h = sp.h * scale, n = sp.frames.length;
    return `<i class="lspr ${cls}" style="width:${w}px;height:${h}px;background-image:url(${sp.url});background-size:${w * n}px ${h}px;`
      + `--sw:${w * n}px;--n:${n};--dur:${sp.dur}s;animation-delay:-${Date.now() % (sp.dur * 1000)}ms"></i>`;
  }
  const NODE = { running: 'builder', pending: 'blocker', failed: 'ohno', skipped: 'skipper', stalled: 'builder' };
  // Character for a task box (small = sub-agent box).
  function nodeSprite(status, { small = false } = {}) {
    const kind = NODE[status];
    if (!kind || (small && kind !== 'builder')) return '';
    return sprite(kind, small || kind === 'skipper' ? 2 : 3, `l-char l-${kind}${status === 'stalled' ? ' l-still' : ''}`)
      + (kind === 'ohno' ? '<span class="l-ohno">Oh no!</span>' : '');
  }

  // Terrain and journeys. A journey starts inside the first task, walking along the bottom of its (brown) box.
  // From a finished box the lemmings go on:
  // - to the box right below in the same stage: from the middle of the box they float down with an umbrella and land on
  //   the (green) top of that box; if they have to go further down from there, they keep floating down through it;
  // - to a box of a later stage: they walk to the right edge (on top or inside, wherever they are) and take brick
  //   stairs (a bridge when level) into the bottom-left of that box.
  // Each journey goes on until a task that is not done yet, or through the exit door at the end of the last task.
  // Points are [x, y, kind of the segment leading there]. Stairs exist only where lemmings walk, so only out of done tasks.
  const DONE = ['ok', 'skipped'];
  function plan({ tasks, pos, H, status, exitId }) {
    const done = (id) => DONE.includes(status(id));
    const floor = (p) => p.y + H - 3, mid = (p) => p.x + p.w / 2;
    const outs = {};
    for (const t of tasks) for (const d of t.primary_deps) {
      const a = pos[d], b = pos[t.id];
      if (!a || !b) continue;
      if (Math.abs(a.x - b.x) < 1) {
        if (b.y <= a.y || tasks.some((o) => { const q = pos[o.id]; return q && Math.abs(q.x - a.x) < 1 && q.y > a.y && q.y < b.y; })) continue;
        (outs[d] ||= []).push({ to: t.id, down: true });
      } else if (b.x > a.x) (outs[d] ||= []).push({ to: t.id });
    }
    const stairs = new Map();
    const brick = (x, y) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="7" height="3"/>`;
    const build = ([x1, y1], [x2, y2]) => {
      const key = [x1, y1, x2, y2].join();
      if (stairs.has(key)) return;
      const n = Math.max(2, Math.round(Math.max(Math.abs(y2 - y1), Math.abs(x2 - x1)) / 5));
      let r = '';
      for (let i = 0; i <= n; i++) r += brick(x1 + (x2 - x1) * i / n - 3.5, y1 + (y2 - y1) * i / n);
      stairs.set(key, `<g class="l-stairs">${r}</g>`);
    };
    const ex = pos[exitId], doorX = ex && ex.x + ex.w - 18;
    const html = ex && done(exitId) ? `<div class="l-door" style="left:${doorX - 14}px;top:${ex.y + H - 29}px">${sprite('exit', 2)}</div>` : '';
    const journeys = [];
    // top: the lemming stands on the green top of box id (else inside it, on its bottom).
    const go = (id, pts, top, seen) => {
      if (journeys.length >= 48) return;
      const p = pos[id], cx = mid(p), here = top ? p.y : floor(p);
      const drop = top ? [[cx, floor(p), 'floater']] : [];
      if (!done(id)) return journeys.push(pts);
      if (id === exitId) return journeys.push([...pts, ...drop, [doorX, floor(p)]]);
      const list = (outs[id] || []).filter((o) => !seen.has(o.to));
      if (!list.length) return journeys.push([...pts, [p.x + p.w - 4, here]]);
      for (const o of list) {
        const q = pos[o.to], next = new Set([...seen, o.to]);
        if (o.down) { go(o.to, [...pts, ...(top ? [] : [[cx, floor(p)]]), [mid(q), q.y, 'floater']], true, next); continue; }
        const from = [p.x + p.w, here], to = [q.x, floor(q)];
        build(from, to);
        go(o.to, [...pts, from, to], false, next);
      }
    };
    for (const t of tasks) {
      const p = pos[t.id];
      if (!t.primary_deps.length && p && done(t.id)) go(t.id, [[p.x + 4, floor(p)]], false, new Set([t.id]));
    }
    return { svg: [...stairs.values()].join(''), html, journeys: journeys.filter((j) => j.length > 1).map(prepare) };
  }
  function prepare(pts) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1, kind = 'walker'] = pts[i], len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.5) continue;
      segs.push({ x0, y0, x1, y1, kind, start: total, len });
      total += len;
    }
    return { segs, len: total };
  }

  // One lemming leaves every SPAWN seconds, taking the journeys in turn; positions come from the clock.
  const SPEED = 24, SPAWN = 1.6;
  let journeys = [], pool = [], raf = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function afterGraph(graph, list) {
    journeys = list.filter((j) => j.len > 0);
    pool = [];
    if (!LEM.on || reduced || !journeys.length) return;
    const layer = document.createElement('div');
    layer.className = 'l-walkers';
    graph.appendChild(layer);
    const n = Math.ceil(Math.max(...journeys.map((j) => j.len)) / (SPEED * SPAWN)) + 1;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'l-walker';
      el.style.display = 'none';
      layer.appendChild(el);
      pool.push({ el, kind: null });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    raf = 0;
    if (!pool.length) return;
    const t = (performance.timeOrigin + performance.now()) / 1000, now = Math.floor(t / SPAWN), P = journeys.length;
    pool.forEach((w, i) => {
      const k = now - i, j = journeys[((k % P) + P) % P], d = (t - k * SPAWN) * SPEED;
      const s = d < j.len && j.segs.find((x) => d < x.start + x.len);
      if (!s || s.kind === 'in' || !w.el.isConnected) { w.el.style.display = 'none'; return; }
      const f = (d - s.start) / s.len, x = s.x0 + (s.x1 - s.x0) * f, y = s.y0 + (s.y1 - s.y0) * f;
      if (w.kind !== s.kind) { w.el.innerHTML = sprite(s.kind, 2); w.kind = s.kind; }
      const sp = SPRITES[s.kind];
      w.el.style.display = '';
      w.el.style.transformOrigin = `${sp.w}px ${sp.h}px`;
      w.el.style.transform = `translate(${(x - sp.w).toFixed(1)}px, ${(y - sp.h * 2 + 1).toFixed(1)}px)${s.x1 < s.x0 - 0.3 ? ' scaleX(-1)' : ''}`;
    });
    raf = requestAnimationFrame(tick);
  }

  const KEY = 'wfui-theme';
  const LEM = {
    on: localStorage.getItem(KEY) === 'lemmings',
    sprite, nodeSprite, plan, afterGraph,
    toggle() {
      LEM.on = !LEM.on;
      localStorage.setItem(KEY, LEM.on ? 'lemmings' : 'classic');
      LEM.apply();
    },
    apply() {
      document.body.classList.toggle('lem', LEM.on);
      const b = document.getElementById('themebtn');
      if (b) { b.textContent = LEM.on ? '⚙︎ Classic' : '🐹 Lemmings'; b.title = LEM.on ? 'Switch to the classic look' : 'Switch to the lemmings look'; }
      if (!LEM.on) pool = [];
    },
  };
  window.LEM = LEM;

  const css = document.createElement('style');
  css.textContent = `
  .lspr { position: absolute; display: block; background-repeat: no-repeat; image-rendering: pixelated; animation: lemspr var(--dur) steps(var(--n)) infinite; pointer-events: none; }
  .lspr.l-still { animation-play-state: paused; }
  @keyframes lemspr { from { background-position: 0 0; } to { background-position: calc(-1 * var(--sw)) 0; } }
  @media (prefers-reduced-motion: reduce) { .lspr { animation: none; } }
  .l-walkers { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 4; }
  .l-walker { position: absolute; left: 0; top: 0; width: 24px; height: 28px; }
  .l-walker .lspr { left: 0; top: 0; }

  body.lem { --bg: #05051a; --panel: #120e33; --line: #34287a; --text: #f4efff; --dim: #a79ce0;
    --pending: #6b6b80; --running: #3d7bff; --ok: #34d834; --failed: #ff3b3b; --skipped: #8fd0ff; --notrun: #1c1745; --stalled: #ffb020; }
  body.lem h1, body.lem h2, body.lem .stage, body.lem .col-title { font-family: "Courier New", ui-monospace, monospace; font-weight: 700; }
  body.lem #graph-wrap { border: 3px solid #4a2a10; border-radius: 0;
    background: radial-gradient(#ffffff 1px, transparent 1.5px) 0 0 / 61px 53px, radial-gradient(#9fd0ff 1px, transparent 1.5px) 23px 31px / 47px 59px,
      linear-gradient(#060628, #1b1050 70%, #2a1240); }
  body.lem .col-title { color: #ffe9a8; text-shadow: 1px 1px 0 #000; }
  body.lem .stage { border-radius: 0; border: 2px solid rgba(0,0,0,.45); box-shadow: inset 0 3px 0 rgba(255,255,255,.25); }
  body.lem .node { border-radius: 2px; border: 2px solid #4a2a10; border-top: 7px solid var(--pending); color: #fff4d6; text-shadow: 1px 1px 0 #3a1f08;
    background: radial-gradient(#6b4220 1.5px, transparent 2px) 0 0 / 9px 9px, radial-gradient(#b07a40 1px, transparent 1.5px) 4px 5px / 11px 7px, #8a5a2b; }
  body.lem .node .sub, body.lem .node .muted { color: #f3dcae !important; }
  body.lem .node .act { color: #cfe0ff; }
  body.lem .node.ok { border-top-color: var(--ok); }
  body.lem .node.running { border-top-color: var(--running); box-shadow: 0 0 0 2px #ffe040, 0 0 16px rgba(255,224,64,.5); }
  body.lem .node.failed { border-top-color: var(--failed); background: radial-gradient(#5a1a1a 1.5px, transparent 2px) 0 0 / 9px 9px, #8a2b2b; }
  body.lem .node.stalled { border-top-color: var(--stalled); }
  body.lem .node.skipped { border-top-color: var(--skipped); opacity: .7; filter: grayscale(1); }
  body.lem .node.ghost { background: rgba(138,90,43,.15); border-style: dashed; }
  body.lem .node.sel { outline: 2px solid #ffe040; }
  body.lem #graph .node .gear { display: none; }
  body.lem .node .l-char { right: 4px; top: 3px; }
  body.lem .node.subnode .l-char { top: 2px; }
  .l-door { position: absolute; width: 28px; height: 28px; pointer-events: none; z-index: 3; }
  body.lem .node .l-ohno { position: absolute; right: 42px; top: 6px; font: 700 10px "Courier New", monospace; color: #ffe040; text-shadow: 1px 1px 0 #000; }
  body.lem .node.has-spr .id, body.lem .node.has-spr .sub { padding-right: 38px; }
  body.lem .node.failed.has-spr .id { padding-right: 76px; }
  body.lem .node.subnode.has-spr .id { padding-right: 28px; }
  body.lem .l-stairs rect { fill: #c8642d; stroke: #5a2a10; stroke-width: .8; }
  body.lem #themebtn { border-color: #ffe040; color: #ffe040; }
  `;
  document.head.appendChild(css);
})();
