(async function () {
  const canvas = document.getElementById("canvas");
  const hud = document.getElementById("hud");
  const forceLoadBtn = document.getElementById("forceLoadBtn");
  const resetBtn = document.getElementById("resetBtn");
  const setHud = (s) => { if (hud) hud.textContent = s; };

  try {
    if (!canvas) throw new Error("Canvas #canvas introuvable");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Contexte 2D impossible");

    // Anti “traits” entre tuiles (seams)
    ctx.imageSmoothingEnabled = false;

    // --- Load maps config
    const cfg = await fetch("/api/maps", { cache: "no-store" }).then(r => {
      if (!r.ok) throw new Error(`/api/maps HTTP ${r.status}`);
      return r.json();
    });

    const WORLD_ROWS = Number(cfg?.world?.rows ?? 0);
    const WORLD_COLS = Number(cfg?.world?.cols ?? 0);
    
    // if (!WORLD_ROWS || !WORLD_COLS) throw new Error(`world.rows/cols invalid (${WORLD_ROWS}x${WORLD_COLS})`);

    const WORLD_TILE_W = Number(cfg?.world?.tile?.w ?? 0);
    const WORLD_TILE_H = Number(cfg?.world?.tile?.h ?? 0);
    if (!WORLD_TILE_W || !WORLD_TILE_H) throw new Error("world.tile.w/h manquant dans maps.json");

    let maps = Array.isArray(cfg?.maps) ? cfg.maps.slice() : [];
    if (maps.length === 0) throw new Error("maps[] vide");

    // Normalisation + tri par z desc (priorité conflits)
    maps = maps.map(m => ({
        tile: {
            w: Number(m?.tile?.w || 0),
            h: Number(m?.tile?.h || 0)
        },
      id: String(m.id),
      label: String(m.label || m.id),
      z: Number(m.z || 0),
      offset: { row: Number(m?.offset?.row || 0), col: Number(m?.offset?.col || 0) },
      grid: { rows: Number(m?.grid?.rows || 26), cols: Number(m?.grid?.cols || 26) },
      include: m.include ?? "auto",           // "auto" ou { "A1": true, ... }
      excludes: m.excludes || {},             // { "B7": true }
      overrides: m.overrides || {}            // réserve
    })).sort((a, b) => b.z - a.z);

    // --- Perf config
    const MAX_CACHE = 800;
    const MAX_INFLIGHT = 6;
    const LOAD_BUDGET_PER_FRAME = 18;
    const EXTRA_MARGIN_TILES = 1;

    // Démarrage zoomé (pas "fit whole world")
    const START_TILES_ON_SCREEN_X = 3;
    const START_TILES_ON_SCREEN_Y = 2;

    // --- Canvas sizing
    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        needsDraw = true;
      }
    }

    // --- View transform (world pixels -> screen)
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;

    function clampScale(s) { return Math.min(12, Math.max(0.01, s)); }
    function worldToScreen(wx, wy) { return { x: wx * scale + offsetX, y: wy * scale + offsetY }; }
    function screenToWorld(sx, sy) { return { x: (sx - offsetX) / scale, y: (sy - offsetY) / scale }; }

    function rowLabel(r) { return String.fromCharCode(65 + r); } // 0=>A
    function localKeyFromRC(r, c) { return `${rowLabel(r)}${c + 1}`; }

    // --- Tile resolver: given a WORLD tile (wr,wc), pick which map provides it (z priority)
    // Returns: { mapId, localKey, urlKey } or null
    function resolveWorldTile(wr, wc) {
      for (const m of maps) {
        const lr = wr - m.offset.row;
        const lc = wc - m.offset.col;

        if (lr < 0 || lc < 0 || lr >= m.grid.rows || lc >= m.grid.cols) continue;

        const localKey = localKeyFromRC(lr, lc); // ex "A1"
        if (m.excludes && m.excludes[localKey]) continue;

        // include can be "auto" OR explicit whitelist map
        if (m.include !== "auto") {
          const allowed = !!(m.include && m.include[localKey]);
          const forced = !!(m.overrides && m.overrides[localKey]);
          if (!allowed && !forced) continue;
        }

        // prefer webp; server may fallback to png
        const urlKey = `${localKey}.webp`;
        return { mapId: m.id, localKey, urlKey, z: m.z };
      }
      return null;
    }

    // --- Loading queue with concurrency
    const cache = new Map(); // cacheKey -> rec
    let use = 0;
    let inflight = 0;
    const queue = [];
    const queued = new Set();

    function evictIfNeeded() {
      if (cache.size <= MAX_CACHE) return;
      const entries = [...cache.entries()];
      entries.sort((a, b) => (a[1].lastUse || 0) - (b[1].lastUse || 0));
      const toRemove = Math.ceil(MAX_CACHE * 0.2);
      for (let i = 0; i < toRemove && i < entries.length; i++) cache.delete(entries[i][0]);
    }

    function getRec(cacheKey) {
      let rec = cache.get(cacheKey);
      if (!rec) {
        rec = { img: null, ok: false, pending: false, err: null, lastUse: 0 };
        cache.set(cacheKey, rec);
        evictIfNeeded();
      }
      rec.lastUse = ++use;
      return rec;
    }

    function enqueueLoad(mapId, urlKey) {
      const cacheKey = `${mapId}/${urlKey}`;
      const rec = getRec(cacheKey);
      if (rec.ok || rec.pending) return;
      if (queued.has(cacheKey)) return;
      queued.add(cacheKey);
      queue.push({ mapId, urlKey, cacheKey });
    }

    function pumpQueue() {
      while (inflight < MAX_INFLIGHT && queue.length > 0) {
        const job = queue.shift();
        queued.delete(job.cacheKey);

        const rec = getRec(job.cacheKey);
        if (rec.ok || rec.pending) continue;

        rec.pending = true;
        inflight++;

        const img = new Image();
        img.decoding = "async";

        img.onload = () => {
          rec.img = img;
          rec.ok = true;
          rec.pending = false;
          rec.err = null;
          inflight--;

          requestDraw();
          pumpQueue();
        };

        img.onerror = () => {
          rec.img = null;
          rec.ok = false;
          rec.pending = false;
          rec.err = "load error";
          inflight--;
          requestDraw();
          pumpQueue();
        };

        img.src = `/tiles/${job.mapId}/${job.urlKey}`;
      }
    }

    function forceLoadAllTiles() {
        // ATTENTION: peut déclencher énormément de requêtes et de RAM.
        let count = 0;

        for (const m of maps) {
            // Si include est une whitelist (objet), on charge seulement ces clés
            if (m.include && m.include !== "auto" && typeof m.include === "object") {
            for (const localKey of Object.keys(m.include)) {
                if (m.excludes && m.excludes[localKey]) continue;
                enqueueLoad(m.id, `${localKey}.webp`);
                count++;
            }
            continue;
            }

            // include = "auto" => on tente toute la grille locale (moins fin, mais ça "essaie tout")
            for (let lr = 0; lr < m.grid.rows; lr++) {
            for (let lc = 0; lc < m.grid.cols; lc++) {
                const localKey = localKeyFromRC(lr, lc); // "A1"
                if (m.excludes && m.excludes[localKey]) continue;
                enqueueLoad(m.id, `${localKey}.webp`);
                count++;
            }
            }
        }

        // Kick
        pumpQueue();
        requestDraw();

        // Info HUD (tu verras queue grossir)
        console.log(`Force load enqueued ~${count} tiles`);
    }
    forceLoadBtn?.addEventListener("click", () => {
      forceLoadAllTiles();
    });



    // --- Visible WORLD tiles
    function computeVisibleWorldTiles() {
      if (!WORLD_TILE_W || !WORLD_TILE_H) return [{ wr: 0, wc: 0 }];

      const tl = screenToWorld(0, 0);
      const br = screenToWorld(canvas.width, canvas.height);

      const minX = Math.min(tl.x, br.x);
      const maxX = Math.max(tl.x, br.x);
      const minY = Math.min(tl.y, br.y);
      const maxY = Math.max(tl.y, br.y);

      let c0 = Math.floor(minX / WORLD_TILE_W) - EXTRA_MARGIN_TILES;
      let c1 = Math.floor(maxX / WORLD_TILE_W) + EXTRA_MARGIN_TILES;
      let r0 = Math.floor(minY / WORLD_TILE_H) - EXTRA_MARGIN_TILES;
      let r1 = Math.floor(maxY / WORLD_TILE_H) + EXTRA_MARGIN_TILES;

      c0 = Math.max(0, Math.min(WORLD_COLS - 1, c0));
      c1 = Math.max(0, Math.min(WORLD_COLS - 1, c1));
      r0 = Math.max(0, Math.min(WORLD_ROWS - 1, r0));
      r1 = Math.max(0, Math.min(WORLD_ROWS - 1, r1));

      const out = [];
      for (let wr = r0; wr <= r1; wr++) {
        for (let wc = c0; wc <= c1; wc++) out.push({ wr, wc });
      }
      return out;
    }

    // Prioritise loads near screen center
    function sortByCenterDistanceWorld(tiles) {
      const center = screenToWorld(canvas.width / 2, canvas.height / 2);
      const cx = center.x / (WORLD_TILE_W || 1);
      const cy = center.y / (WORLD_TILE_H || 1);

      tiles.sort((a, b) => {
        const da = (a.wc - cx) ** 2 + (a.wr - cy) ** 2;
        const db = (b.wc - cx) ** 2 + (b.wr - cy) ** 2;
        return da - db;
      });
      return tiles;
    }

    // --- Draw loop
    let raf = null;
    let needsDraw = true;

    function requestDraw() {
      needsDraw = true;
      if (!raf) raf = requestAnimationFrame(draw);
    }

    function resetToStartView() {
      resizeCanvas();

      if (WORLD_TILE_W && WORLD_TILE_H) {
        const targetScaleX = canvas.width / (START_TILES_ON_SCREEN_X * WORLD_TILE_W);
        const targetScaleY = canvas.height / (START_TILES_ON_SCREEN_Y * WORLD_TILE_H);
        scale = clampScale(Math.min(targetScaleX, targetScaleY));
      } else {
        scale = 1;
      }

      // centre initial: sur la 1ère map (ex: c1 A1)
      const base = maps[maps.length - 1] || maps[0]; // pas vital
      const startWr = (base?.offset?.row || 0);
      const startWc = (base?.offset?.col || 0);

      // place world tile (startWc,startWr) near top-left with margin
      offsetX = 20;
      offsetY = 20;

      // Optionnel: recentrer vraiment sur A1 du premier continent
      // (si tu veux centrer, décommente)
      // offsetX = canvas.width / 2 - (startWc * TILE_W) * scale;
      // offsetY = canvas.height / 2 - (startWr * TILE_H) * scale;

      requestDraw();
    }

    function draw() {
      raf = null;
      resizeCanvas();
      if (!needsDraw) return;
      needsDraw = false;

      // background
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0b0c10";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let visible = computeVisibleWorldTiles();
      if (WORLD_TILE_W && WORLD_TILE_H) visible = sortByCenterDistanceWorld(visible);

      // schedule limited loads
      let asked = 0;
      let resolved = 0;
      for (const t of visible) {
        if (asked >= LOAD_BUDGET_PER_FRAME) break;
        const r = resolveWorldTile(t.wr, t.wc);
        if (!r) continue;
        resolved++;
        enqueueLoad(r.mapId, r.urlKey);
        asked++;
      }
      pumpQueue();

      // draw cached tiles
      let drawn = 0, pending = 0, missing = 0, empty = 0;

      for (const t of visible) {
        const r = resolveWorldTile(t.wr, t.wc);
        if (!r) { empty++; continue; }

        const cacheKey = `${r.mapId}/${r.urlKey}`;
        const rec = getRec(cacheKey);

        if (rec.ok && rec.img && WORLD_TILE_W && WORLD_TILE_H) {
            const wx = t.wc * WORLD_TILE_W;
            const wy = t.wr * WORLD_TILE_H;
            const s = worldToScreen(wx, wy);

            // Snap + overdraw
            const dx = Math.round(s.x);
            const dy = Math.round(s.y);
            const dw = Math.round(WORLD_TILE_W * scale) + 1;
            const dh = Math.round(WORLD_TILE_H * scale) + 1;

            ctx.drawImage(rec.img, dx, dy, dw, dh);

          drawn++;
        } else if (rec.pending) {
          pending++;
          // placeholder light
          if (WORLD_TILE_W && WORLD_TILE_H) {
            const wx = t.wc * WORLD_TILE_W;
            const wy = t.wr * WORLD_TILE_H;
            const s = worldToScreen(wx, wy);
            ctx.fillStyle = "rgba(255,255,255,0.03)";
            ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.round(WORLD_TILE_W * scale), Math.round(WORLD_TILE_H * scale));
          }
        } else {
          missing++;
        }
      }

      const center = screenToWorld(canvas.width / 2, canvas.height / 2);
      setHud(
        `world ${WORLD_ROWS}x${WORLD_COLS}\n` +
        `tile ${WORLD_TILE_W || "?"}x${WORLD_TILE_H || "?"}\n` +
        `scale ${scale.toFixed(5)}\n` +
        `visible ${visible.length} | resolved ${resolved}\n` +
        `drawn ${drawn} | pending ${pending} | missing ${missing} | empty ${empty}\n` +
        `inflight ${inflight}/${MAX_INFLIGHT} | queue ${queue.length}\n` +
        `cache ${cache.size}/${MAX_CACHE}\n` +
        `center x=${center.x.toFixed(0)} y=${center.y.toFixed(0)}`
      );
    }

    // --- Pan/zoom
    let dragging = false;
    let lastX = 0, lastY = 0;

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.classList.add("dragging");
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dpr = window.devicePixelRatio || 1;
      offsetX += (e.clientX - lastX) * dpr;
      offsetY += (e.clientY - lastY) * dpr;
      lastX = e.clientX;
      lastY = e.clientY;
      requestDraw();
    });

    canvas.addEventListener("pointerup", () => {
      dragging = false;
      canvas.classList.remove("dragging");
    });
    canvas.addEventListener("pointercancel", () => {
      dragging = false;
      canvas.classList.remove("dragging");
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dpr = window.devicePixelRatio || 1;
      const mx = e.offsetX * dpr;
      const my = e.offsetY * dpr;

      const before = screenToWorld(mx, my);
      const factor = Math.exp((-e.deltaY) * 0.0015);
      scale = clampScale(scale * factor);

      const after = worldToScreen(before.x, before.y);
      offsetX += (mx - after.x);
      offsetY += (my - after.y);

      requestDraw();
    }, { passive: false });

    window.addEventListener("resize", () => requestDraw());
    resetBtn?.addEventListener("click", resetToStartView);

    // --- Start: preload a few tiles around each map A1 (optional)
    for (const m of maps) {
      enqueueLoad(m.id, "A1.webp");
    }
    pumpQueue();

    resetToStartView();
    requestDraw();
  } catch (err) {
    console.error(err);
    setHud("ERREUR JS:\n" + (err?.stack || err?.message || String(err)));
  }
})();
