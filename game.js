'use strict';
(() => {
  const { T, genMap } = window.MapGen;

  // ---------- 설정 (기획서 [확정]/[제안] 값) ----------
  const QUEUE_LIMIT = 4;                       // 대기열이 이미 4개 이상일 때 새 퍼즐이 추가되면 체력 -1
  const DIFFS = { easy: { name: '쉬움', hp: 5 }, normal: { name: '보통', hp: 3 }, hard: { name: '어려움', hp: 1 } };
  const STAGES = 10;
  const stageSize = s => (s <= 3 ? 5 : s <= 6 ? 8 : s <= 9 ? 11 : 15);
  const storyInterval = s => 20 - (s - 1);     // 1스테이지 20초 -> 10스테이지 11초 (제안)
  const storyTarget = s => 6 + s;              // 스테이지 클리어에 필요한 퍼즐 수 (제안)
  const challengeInterval = t => Math.max(5, 20 - Math.floor(t / 20)); // 20초마다 1초 단축, 최소 5초
  function challengeSize(score) {
    const pool = score < 8 ? [5] : score < 20 ? [5, 8] : score < 35 ? [8, 11] : score < 55 ? [11] : [11, 15];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const C = {
    bg: '#0f1115', wall: '#1b1f27', path: '#868c96', goal: '#2ecc71', red: '#e5484d',
    player: '#ffd60a', frame: '#2a2f3a', cur: '#e8eaee', warn: '#ffb020', danger: '#ff4d4f',
    text: '#e8eaee', dim: '#8b93a1',
  };
  const FONT = 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

  // ---------- 상태 ----------
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const overlay = document.getElementById('overlay');
  const panel = document.getElementById('panel');
  let W = 0, H = 0, dpr = 1;
  let G = null;                 // 진행 중인 게임
  let state = 'menu';           // menu | playing | paused | stageclear | gameover | ending
  const sel = { diff: 'normal' };

  // ---------- 저장 (최고 점수) ----------
  const bestKey = (mode, diff) => `queuerun_best_${mode}_${diff}`;
  function getBest(mode, diff) { try { return +localStorage.getItem(bestKey(mode, diff)) || 0; } catch (e) { return 0; } }
  function setBest(mode, diff, v) { try { localStorage.setItem(bestKey(mode, diff), String(v)); } catch (e) { /* ignore */ } }

  // ---------- 사운드 (WebAudio 합성, 외부 소스 없음) ----------
  let actx = null, muted = false;
  function ensureAudio() {
    if (actx || muted) return;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
  }
  function tone(f, d, type = 'square', vol = 0.05, slide = 0, delay = 0) {
    if (!actx || muted) return;
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t0 + d);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + d + 0.02);
  }
  const sfx = {
    move: () => tone(260, 0.04, 'triangle', 0.035),
    clear: () => { tone(523, 0.09, 'square', 0.05); tone(659, 0.09, 'square', 0.05, 0, 0.08); tone(784, 0.14, 'square', 0.05, 0, 0.16); },
    hit: () => tone(220, 0.3, 'sawtooth', 0.07, -170),
    warn: () => { tone(880, 0.08, 'square', 0.04); tone(880, 0.08, 'square', 0.04, 0, 0.14); },
    over: () => { tone(330, 0.2, 'sawtooth', 0.07, -120); tone(220, 0.4, 'sawtooth', 0.07, -120, 0.22); },
    stage: () => { tone(523, 0.1, 'triangle', 0.06); tone(784, 0.1, 'triangle', 0.06, 0, 0.1); tone(1047, 0.25, 'triangle', 0.06, 0, 0.2); },
  };

  // ---------- 게임 진행 ----------
  function newGame(mode) {
    const hp = DIFFS[sel.diff].hp;
    G = {
      mode, diff: sel.diff, hp, maxHp: hp, score: 0, cleared: 0, stage: 1,
      maps: [],              // maps[0] = 현재 맵, 나머지 = 대기열(오래된 순)
      ghosts: [],            // 사라지는 맵 연출
      nextIn: 0, interval: 20, elapsed: 0, flash: 0, warnPulse: 0, stageCleared: 0,
    };
    beginStage();
  }

  function beginStage() {
    G.maps = []; G.ghosts = []; G.stageCleared = 0;
    G.interval = G.mode === 'story' ? storyInterval(G.stage) : challengeInterval(0);
    G.nextIn = G.interval;
    state = 'playing';
    hideOverlay();
  }

  function curInterval() { return G.mode === 'story' ? storyInterval(G.stage) : challengeInterval(G.elapsed); }

  function spawnMap() {
    const queueLen = Math.max(0, G.maps.length - 1);
    if (G.maps.length > 0 && queueLen >= QUEUE_LIMIT) {   // 적체 페널티
      damage(1);
      if (state !== 'playing') return;
    }
    const n = G.mode === 'story' ? stageSize(G.stage) : challengeSize(G.score);
    const m = genMap(n);
    m.x = m.tx = -200; m.y = m.ty = H / 2; m.s = m.ts = 100; m.a = 0;
    m.fresh = true;
    G.maps.push(m);
    if (Math.max(0, G.maps.length - 1) >= 3) sfx.warn();
  }

  function damage(k) {
    G.hp -= k; G.flash = 0.35; sfx.hit();
    if (G.hp <= 0) { G.hp = 0; gameOver(); }
  }

  function removeMap(m, kind) {
    G.ghosts.push({ x: m.x, y: m.y, s: m.s, m, kind, t: 0 });
  }

  function press(dx, dy) {
    if (state !== 'playing') return;
    ensureAudio();
    const removed = new Set();
    let moved = false, hits = 0, clears = 0;
    for (const m of G.maps) {
      const nx = m.px + dx, ny = m.py + dy;
      if (nx < 0 || ny < 0 || nx >= m.n || ny >= m.n) continue;       // 맵 밖 = 벽
      const t = m.grid[ny * m.n + nx];
      if (t === T.WALL) continue;                                       // 벽: 제자리
      m.px = nx; m.py = ny; moved = true;
      if (t === T.RED) { hits++; removed.add(m); removeMap(m, 'hit'); }
      else if (t === T.GOAL) { clears++; G.score += m.pts; G.cleared++; G.stageCleared++; removed.add(m); removeMap(m, 'clear'); }
    }
    if (removed.size) G.maps = G.maps.filter(m => !removed.has(m));
    if (hits) damage(hits);
    if (state !== 'playing') return;
    if (clears) {
      sfx.clear();
      if (G.mode === 'story' && G.stageCleared >= storyTarget(G.stage)) { stageClear(); return; }
    } else if (moved && !hits) sfx.move();
    if (!G.maps.length) { spawnMap(); G.nextIn = curInterval(); }     // 모두 비면 즉시 새 퍼즐
  }

  function update(dt) {
    if (!G) return;
    for (const g of G.ghosts) g.t += dt;
    G.ghosts = G.ghosts.filter(g => g.t < 0.35);
    if (G.flash > 0) G.flash = Math.max(0, G.flash - dt);
    G.warnPulse += dt;
    if (state !== 'playing') return;
    G.elapsed += dt;
    G.nextIn -= dt;
    if (G.nextIn <= 0) { spawnMap(); if (state !== 'playing') return; G.nextIn += curInterval(); }
    if (!G.maps.length) { spawnMap(); G.nextIn = curInterval(); }
  }

  // ---------- 종료/전환 ----------
  function finishScore() {
    const prev = getBest(G.mode, G.diff);
    const isBest = G.score > prev;
    if (isBest) setBest(G.mode, G.diff, G.score);
    return { best: Math.max(prev, G.score), isBest };
  }

  function gameOver() {
    state = 'gameover'; sfx.over();
    const { best, isBest } = finishScore();
    const extra = G.mode === 'story' ? `<p class="sub">스테이지 ${G.stage} / ${STAGES}</p>` : `<p class="sub">${Math.floor(G.elapsed)}초 생존</p>`;
    showOverlay(`
      <h2>GAME OVER</h2>${extra}
      <div class="big">${G.score}점</div>
      <div class="best">${isBest ? '🎉 새 최고 기록!' : '최고 기록'} ${best}점 · ${DIFFS[G.diff].name}</div>
      <div class="row"><button class="primary" data-act="retry">다시 하기</button><button data-act="menu">메뉴</button></div>`);
  }

  function stageClear() {
    sfx.stage();
    if (G.stage >= STAGES) {
      state = 'ending';
      const { best, isBest } = finishScore();
      showOverlay(`
        <h2>ALL CLEAR</h2>
        <p class="sub">10개의 스테이지를 모두 통과했습니다.</p>
        <div class="big">${G.score}점</div>
        <div class="best">${isBest ? '🎉 새 최고 기록!' : '최고 기록'} ${best}점 · ${DIFFS[G.diff].name} · 남은 체력 ${G.hp}</div>
        <div class="row"><button class="primary" data-act="menu">메뉴로</button><button data-act="retry">다시 도전</button></div>`);
      return;
    }
    state = 'stageclear';
    showOverlay(`
      <h2>STAGE ${G.stage} CLEAR</h2>
      <p class="sub">점수 ${G.score} · 체력 ${G.hp}/${G.maxHp}<br>다음: ${stageSize(G.stage + 1)}×${stageSize(G.stage + 1)} 맵, 새 퍼즐 ${storyInterval(G.stage + 1)}초 간격</p>
      <div class="row"><button class="primary" data-act="next" id="focus">다음 스테이지</button></div>`);
  }

  // ---------- 오버레이(DOM) ----------
  function showOverlay(html) {
    panel.innerHTML = html; overlay.classList.remove('hidden');
    const b = panel.querySelector('.primary'); if (b) b.focus({ preventScroll: true });
  }
  function hideOverlay() { overlay.classList.add('hidden'); if (document.activeElement) document.activeElement.blur(); }

  function showMenu() {
    state = 'menu'; G = null;
    const seg = d => `<button class="seg" data-diff="${d}" aria-pressed="${sel.diff === d}">${DIFFS[d].name} (HP ${DIFFS[d].hp})</button>`;
    const b = m => ['easy', 'normal', 'hard'].map(d => getBest(m, d)).map((v, i) => `${DIFFS[['easy', 'normal', 'hard'][i]].name} ${v}`).join(' · ');
    showOverlay(`
      <h1>Queue Run</h1>
      <p class="sub">하나의 입력으로 여러 개의 미로를 동시에 조종하세요.</p>
      <div class="label">난이도</div>
      <div class="row">${['easy', 'normal', 'hard'].map(seg).join('')}</div>
      <div class="row">
        <button class="primary" data-act="story">스토리 모드</button>
        <button class="primary" data-act="challenge">챌린지 모드</button>
      </div>
      <div class="legend">
        <span><i style="background:${C.player}"></i>플레이어</span>
        <span><i style="background:${C.path}"></i>길</span>
        <span><i style="background:${C.goal}"></i>도착</span>
        <span><i style="background:${C.red}"></i>위험</span>
      </div>
      <ul class="help">
        <li><kbd>←↑↓→</kbd> 또는 <kbd>WASD</kbd> (모바일은 화면 스와이프)로 <b>모든 맵이 동시에</b> 이동합니다. 벽에 막힌 맵은 제자리입니다.</li>
        <li>초록 칸에 닿으면 클리어(대기열 맵도 먼저 도착하면 점수). 빨간 칸에 닿으면 체력 -1, 그 맵은 사라집니다.</li>
        <li>새 퍼즐은 일정 시간마다 왼쪽 대기열에 쌓입니다. 대기열이 ${QUEUE_LIMIT}개일 때 또 추가되면 체력 -1!</li>
        <li><kbd>P</kbd>/<kbd>Esc</kbd> 일시정지 · <kbd>M</kbd> 소리 끄기/켜기</li>
      </ul>
      <div class="best" style="margin-top:12px">최고 점수 — 스토리: ${b('story')}<br>챌린지: ${b('challenge')}</div>`);
  }

  function showPause() {
    state = 'paused';
    showOverlay(`<h2>일시정지</h2><div class="row"><button class="primary" data-act="resume">계속하기</button><button data-act="menu">메뉴로</button></div>`);
  }

  overlay.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    ensureAudio();
    if (b.dataset.diff) { sel.diff = b.dataset.diff; showMenu(); return; }
    switch (b.dataset.act) {
      case 'story': newGame('story'); break;
      case 'challenge': newGame('challenge'); break;
      case 'retry': newGame(G.mode); break;
      case 'next': G.stage++; beginStage(); break;
      case 'resume': state = 'playing'; hideOverlay(); break;
      case 'menu': showMenu(); break;
    }
  });

  // ---------- 입력 ----------
  const KEYS = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1], A: [-1, 0], D: [1, 0], W: [0, -1], S: [0, 1],
  };
  window.addEventListener('keydown', e => {
    if (e.key === 'm' || e.key === 'M') { muted = !muted; if (!muted) ensureAudio(); return; }
    if (state === 'playing') {
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { showPause(); e.preventDefault(); return; }
      const d = KEYS[e.key];
      if (d) { e.preventDefault(); press(d[0], d[1]); }
    } else if (state === 'paused' && (e.key === 'p' || e.key === 'P' || e.key === 'Escape')) {
      state = 'playing'; hideOverlay();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') showPause(); });

  let touch = null;
  cv.addEventListener('touchstart', e => { const t = e.changedTouches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  cv.addEventListener('touchend', e => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y; touch = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) press(dx > 0 ? 1 : -1, 0); else press(0, dy > 0 ? 1 : -1);
  }, { passive: true });

  // ---------- 레이아웃/렌더링 ----------
  const lay = { cur: null, slots: [], visible: 0, hudH: 64 };
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  function computeLayout() {
    const hudH = Math.min(84, Math.max(64, H * 0.1));
    const top = hudH + 26, availH = H - top - 10, gap = 26;
    lay.hudH = hudH;
    const landscape = W >= H * 1.05;
    let Sc, Sq, cx, cy;
    lay.slots = [];
    if (landscape) {
      Sc = Math.max(80, Math.min(availH, W * 0.36));
      cx = W / 2; cy = top + availH / 2;
      const left = cx - Sc / 2 - gap - 44;                       // 대기열이 쓸 수 있는 왼쪽 폭
      Sq = Math.max(40, Math.min(Sc * 0.5, (availH - gap) / 2, (left + gap) / 2 - gap));
      const cols = Math.max(1, Math.floor((left + gap) / (Sq + gap)));
      for (let c = 0; c < cols; c++) {                          // 오래된 맵이 중앙에 가깝게, 2행으로 왼쪽으로 쌓임
        const x = cx - Sc / 2 - gap - Sq / 2 - c * (Sq + gap);
        lay.slots.push({ x, y: cy - (Sq + gap) / 2, s: Sq });
        lay.slots.push({ x, y: cy + (Sq + gap) / 2, s: Sq });
      }
    } else {
      Sc = Math.max(80, Math.min(W - 16, availH * 0.62));
      const g2 = 8;
      Sq = Math.max(40, Math.min(Sc * 0.4, (W - 20 - 3 * g2 - 36) / 4, availH - Sc - 30));
      cx = W / 2; cy = H - 10 - Sc / 2;
      const ry = top + Sq / 2;
      for (let i = 0; i < 40; i++) {
        const x = W - 10 - Sq / 2 - i * (Sq + g2);
        if (x - Sq / 2 < 40) break;
        lay.slots.push({ x, y: ry, s: Sq });
      }
    }
    lay.cur = { x: cx, y: cy, s: Sc };
    lay.Sq = Sq; lay.landscape = landscape;
  }

  function assignTargets() {
    G.maps.forEach((m, i) => {
      let t;
      if (i === 0) t = lay.cur;
      else t = lay.slots[i - 1] || { x: -lay.Sq, y: lay.slots[0] ? lay.slots[0].y : H / 2, s: lay.Sq };
      m.tx = t.x; m.ty = t.y; m.ts = t.s;
      if (m.fresh) { m.x = t.x - (lay.slots.length ? lay.Sq : 0); m.y = t.y; m.s = t.s; m.fresh = false; }
    });
  }

  function animate(dt) {
    const k = Math.min(1, dt * 12);
    for (const m of G.maps) {
      m.x += (m.tx - m.x) * k; m.y += (m.ty - m.y) * k; m.s += (m.ts - m.s) * k; m.a += (1 - m.a) * k;
    }
  }

  function drawMap(m, x, y, s, alpha, frameColor, lw) {
    const n = m.n, half = s / 2, pad = Math.max(2, Math.round(s * 0.018));
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = frameColor; ctx.fillRect(x - half - pad - lw, y - half - pad - lw, s + 2 * (pad + lw), s + 2 * (pad + lw));
    ctx.fillStyle = C.wall; ctx.fillRect(x - half - pad, y - half - pad, s + 2 * pad, s + 2 * pad);
    const cs = s / n, gp = cs > 10 ? 1.5 : cs > 5 ? 1 : 0.5, ox = x - half, oy = y - half;
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const t = m.grid[cy * n + cx];
        if (t === T.WALL) continue;
        ctx.fillStyle = t === T.GOAL ? C.goal : t === T.RED ? C.red : C.path;
        ctx.fillRect(ox + cx * cs, oy + cy * cs, cs - gp, cs - gp);
      }
    }
    const ins = cs * 0.16;
    ctx.fillStyle = C.player;
    ctx.fillRect(ox + m.px * cs + ins, oy + m.py * cs + ins, cs - gp - 2 * ins, cs - gp - 2 * ins);
    if (m.pts > 1 && s > 60) {
      ctx.fillStyle = C.player; ctx.font = `700 ${Math.max(11, Math.min(15, s * 0.08))}px ${FONT}`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(`+${m.pts}점`, x + half + pad, y - half - pad - lw - 3);
    }
    ctx.restore();
  }

  function text(str, x, y, size, color, align = 'left', weight = 600) {
    ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${FONT}`; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  function drawHud() {
    const h = lay.hudH, fs = W < 600 ? 12 : 15, queueLen = Math.max(0, G.maps.length - 1);
    ctx.fillStyle = '#12141a'; ctx.fillRect(0, 0, W, h);
    ctx.fillStyle = C.frame; ctx.fillRect(0, h - 1, W, 1);
    // 왼쪽: 체력 + 모드/스테이지
    const bs = W < 600 ? 12 : 16;
    for (let i = 0; i < G.maxHp; i++) {
      ctx.fillStyle = i < G.hp ? C.red : '#2a2f3a';
      ctx.fillRect(12 + i * (bs + 4), h / 2 - bs - 3, bs, bs);
    }
    const info = G.mode === 'story' ? `스테이지 ${G.stage}/${STAGES} · ${G.stageCleared}/${storyTarget(G.stage)}` : `챌린지 · ${DIFFS[G.diff].name}`;
    text(info, 12, h / 2 + 12, fs - 1, C.dim);
    // 가운데: 다음 퍼즐 타이머
    const bw = Math.min(360, W * 0.3), bx = W / 2 - bw / 2, danger = queueLen >= QUEUE_LIMIT;
    const ratio = Math.max(0, Math.min(1, G.nextIn / curInterval()));
    text(danger ? '⚠ 다음 퍼즐 추가 시 체력 -1' : '다음 퍼즐', W / 2, h / 2 - 15, fs - 1, danger ? C.danger : C.dim, 'center');
    text(G.nextIn.toFixed(1) + 's', W / 2, h / 2 + 3, fs + 8, C.text, 'center', 800);
    ctx.fillStyle = '#2a2f3a'; ctx.fillRect(bx, h / 2 + 18, bw, 5);
    ctx.fillStyle = danger ? C.danger : queueLen >= 3 ? C.warn : C.player; ctx.fillRect(bx, h / 2 + 18, bw * ratio, 5);
    // 오른쪽: 점수, 대기열
    text(`점수 ${G.score}`, W - 12, h / 2 - 8, fs + 3, C.text, 'right', 800);
    const qc = queueLen >= QUEUE_LIMIT ? C.danger : queueLen >= 3 ? C.warn : C.dim;
    text(`대기열 ${queueLen}/${QUEUE_LIMIT}`, W - 12, h / 2 + 14, fs, qc, 'right', 700);
  }

  function render() {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!G) return;
    computeLayout(); assignTargets();
    const queueLen = Math.max(0, G.maps.length - 1);
    const qColor = queueLen >= QUEUE_LIMIT ? C.danger : queueLen >= 3 ? C.warn : C.frame;
    // 대기열(뒤쪽부터) -> 현재 맵
    for (let i = G.maps.length - 1; i >= 1; i--) {
      const m = G.maps[i];
      if (m.x < -m.s) continue;
      drawMap(m, m.x, m.y, m.s, Math.max(0, Math.min(1, m.a)) * 0.92, qColor, qColor === C.frame ? 0 : 2);
    }
    const hidden = Math.max(0, queueLen - lay.slots.length);
    if (hidden > 0) {
      const hy = lay.landscape ? lay.cur.y : (lay.slots[0] ? lay.slots[0].y : H / 2);
      text(`+${hidden}`, 22, hy, 18, qColor === C.frame ? C.dim : qColor, 'center', 800);
    }
    if (G.maps[0]) drawMap(G.maps[0], G.maps[0].x, G.maps[0].y, G.maps[0].s, Math.min(1, G.maps[0].a), C.cur, 2);
    for (const g of G.ghosts) {
      const p = g.t / 0.35, sc = 1 + p * 0.25;
      ctx.save(); drawMap(g.m, g.x, g.y, g.s * sc, 1 - p, g.kind === 'clear' ? C.goal : C.red, 3); ctx.restore();
    }
    drawHud();
    if (queueLen >= QUEUE_LIMIT && state === 'playing') {
      const a = 0.12 + 0.1 * Math.sin(G.warnPulse * 6);
      ctx.strokeStyle = `rgba(255,77,79,${a * 4})`; ctx.lineWidth = 4; ctx.strokeRect(2, 2, W - 4, H - 4);
    }
    if (G.flash > 0) { ctx.fillStyle = `rgba(229,72,77,${G.flash * 0.9})`; ctx.fillRect(0, 0, W, H); }
    if (muted) text('🔇', W - 14, H - 14, 14, C.dim, 'right');
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (G) { update(dt); animate(dt); }
    render();
    requestAnimationFrame(frame);
  }

  // 테스트/디버그용 훅
  window.__QR = { get G() { return G; }, get state() { return state; }, press, newGame, sel };

  resize();
  showMenu();
  requestAnimationFrame(frame);
})();
