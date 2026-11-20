'use strict';
/* 맵 자동 생성 + BFS 풀이 검증 (기획서 5장)
 * - 반드시 풀 수 있어야 함: 시작 -> 초록 칸 경로가 "빨간 칸을 피해서" 최소 1개 존재
 * - 맵마다 구조가 다르도록 미로형(maze) / 흩뿌림형(scatter) 두 생성기를 섞어 사용
 */
(function (root) {
  const T = { PATH: 0, WALL: 1, GOAL: 2, RED: 3 };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function bfs(grid, n, sx, sy, blockRed) {
    const dist = new Int16Array(n * n).fill(-1);
    const q = [sy * n + sx];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % n, y = (c - x) / n;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const k = ny * n + nx;
        if (dist[k] >= 0) continue;
        const t = grid[k];
        if (t === T.WALL || (blockRed && t === T.RED)) continue;
        dist[k] = dist[c] + 1;
        q.push(k);
      }
    }
    return dist;
  }

  function mazeGrid(n) {
    const g = new Uint8Array(n * n).fill(T.WALL);
    const m = Math.floor((n - 1) / 2);
    const vis = new Uint8Array(m * m);
    const set = (x, y, v) => { g[y * n + x] = v; };
    const sx = ri(0, m - 1), sy = ri(0, m - 1);
    const stack = [[sx, sy]];
    vis[sy * m + sx] = 1;
    set(2 * sx + 1, 2 * sy + 1, T.PATH);
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const nb = shuffle(DIRS.map(d => [cx + d[0], cy + d[1], d]))
        .filter(([x, y]) => x >= 0 && y >= 0 && x < m && y < m && !vis[y * m + x]);
      if (!nb.length) { stack.pop(); continue; }
      const [nx, ny, d] = nb[0];
      vis[ny * m + nx] = 1;
      set(2 * nx + 1, 2 * ny + 1, T.PATH);
      set(2 * cx + 1 + d[0], 2 * cy + 1 + d[1], T.PATH);
      stack.push([nx, ny]);
    }
    // 짝수 크기(예: 8x8)의 남는 행/열은 무작위로 열어 둔다
    if (n % 2 === 0) {
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.65) set(n - 1, i, T.PATH);
        if (Math.random() < 0.65) set(i, n - 1, T.PATH);
      }
    }
    // 일부 벽을 허물어 순환 경로(분기)를 만든다
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        if (g[y * n + x] !== T.WALL) continue;
        const h = g[y * n + x - 1] !== T.WALL && g[y * n + x + 1] !== T.WALL;
        const v = g[(y - 1) * n + x] !== T.WALL && g[(y + 1) * n + x] !== T.WALL;
        if ((h || v) && Math.random() < 0.2) set(x, y, T.PATH);
      }
    }
    return g;
  }

  function scatterGrid(n) {
    const g = new Uint8Array(n * n);
    const density = rnd(0.2, 0.36);
    for (let i = 0; i < g.length; i++) if (Math.random() < density) g[i] = T.WALL;
    return g;
  }

  // 고난이도 판정: 최단 경로 길이 + 분기 수 (기획서 3-4)
  function scorePoints(n, L, junc) {
    if (L >= 2.3 * n && junc >= 0.7 * n) return 3;
    if (L >= 1.8 * n) return 2;
    return 1;
  }

  function genMap(n) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const useMaze = n >= 8 && Math.random() < 0.6;
      const g = useMaze ? mazeGrid(n) : scatterGrid(n);
      const open = [];
      for (let i = 0; i < g.length; i++) if (g[i] === T.PATH) open.push(i);
      if (open.length < n * n * 0.3) continue;

      const s = open[ri(0, open.length - 1)];
      const sx = s % n, sy = (s - sx) / n;
      const d = bfs(g, n, sx, sy, false);
      const minD = Math.max(3, Math.round(n * (useMaze ? 1.2 : 0.9)));
      const cand = open.filter(i => d[i] >= minD).sort((a, b) => d[b] - d[a]);
      if (!cand.length) continue;
      const gi = cand[ri(0, Math.max(0, Math.floor(cand.length * 0.4) - 1))];
      g[gi] = T.GOAL;

      // 빨간 칸: 정답 경로를 막지 않는 곳에만 배치
      const redN = Math.round(open.length * rnd(0.06, 0.12));
      const pool = shuffle(open.filter(i =>
        i !== s && i !== gi &&
        Math.abs((i % n) - sx) + Math.abs(Math.floor(i / n) - sy) >= 2));
      let placed = 0;
      for (const i of pool) {
        if (placed >= redN) break;
        g[i] = T.RED;
        if (bfs(g, n, sx, sy, true)[gi] < 0) g[i] = T.PATH; else placed++;
      }

      const dist = bfs(g, n, sx, sy, true);
      const L = dist[gi];
      if (L < 0) continue; // 안전장치
      let junc = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const t = g[y * n + x];
        if (t === T.WALL || t === T.RED) continue;
        let c = 0;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const tt = g[ny * n + nx];
          if (tt !== T.WALL && tt !== T.RED) c++;
        }
        if (c >= 3) junc++;
      }
      return { n, grid: g, px: sx, py: sy, L, junc, pts: scorePoints(n, L, junc) };
    }
    // 최후의 수단: 빈 직선 맵
    const g = new Uint8Array(n * n);
    g[n * n - 1] = T.GOAL;
    return { n, grid: g, px: 0, py: 0, L: 2 * (n - 1), junc: 0, pts: 1 };
  }

  const API = { T, bfs, genMap, scorePoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MapGen = API;
})(typeof window !== 'undefined' ? window : globalThis);
