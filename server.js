const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = parseInt(process.env.PORT || "8080", 10);
const GRID_ROWS = clampInt(process.env.GRID_ROWS, 26, 1, 26); // A..Z
const GRID_COLS = clampInt(process.env.GRID_COLS, 26, 1, 1000);
const TILE_W = clampInt(process.env.TILE_W, 0, 0, 20000);
const TILE_H = clampInt(process.env.TILE_H, 0, 0, 20000);
const CACHE_MAX_AGE_SECONDS = clampInt(process.env.CACHE_MAX_AGE_SECONDS, 31536000, 0, 31536000);

const TILES_DIR = path.join(__dirname, "tiles");
const PUBLIC_DIR = path.join(__dirname, "public");

const MAPS_JSON = path.join(__dirname, "maps.json");


function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ""), 10);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return def;
}

// --- Static site
app.use("/", express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    // Ne pas cacher HTML/JS/CSS en dev
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// --- Meta endpoint
app.get("/api/meta", (_req, res) => {
  res.json({
    grid: {
      rows: GRID_ROWS,
      cols: GRID_COLS
    },
    tile: {
      w: TILE_W || 0,
      h: TILE_H || 0
    },
    naming: {
      rowLabels: "A..Z",
      colLabels: "1..N",
      filePattern: "{ROW}{COL}.png",
      example: "A1.png"
    }
  });
});

// --- Tiles endpoint
// URL: /tiles/A1.png // ou .webp
app.get("/tiles/:mapId/:name", (req, res) => {
  const mapId = String(req.params.mapId || "");
  const name = String(req.params.name || "");

  if (!/^[a-zA-Z0-9_-]+$/.test(mapId)) return res.status(400).send("Bad mapId");

  const m = name.match(/^([A-Z]\d+)\.(png|webp)$/);
  if (!m) return res.status(400).send("Bad tile name");

  const base = m[1];
  const ext = m[2];

  const dir = path.join(TILES_DIR, mapId);

  const candidates =
    ext === "webp"
      ? [`${base}.webp`, `${base}.png`]
      : [`${base}.png`, `${base}.webp`];

  (function tryNext(i) {
    if (i >= candidates.length) return res.status(404).end();

    const fp = path.join(dir, candidates[i]);
    fs.stat(fp, (err, stat) => {
      if (err || !stat.isFile()) return tryNext(i + 1);

      res.setHeader("Cache-Control", `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`);
      res.sendFile(fp);
    });
  })(0);
});

// map endpoint
app.get("/api/maps", (_req, res) => {
  try {
    const raw = fs.readFileSync(MAPS_JSON, "utf-8");
    const data = JSON.parse(raw);
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "maps.json invalid", details: String(e) });
  }
});



app.listen(PORT, "0.0.0.0", () => {
  console.log(`tilegrid listening on http://0.0.0.0:${PORT}`);
  console.log(`GRID_ROWS=${GRID_ROWS} GRID_COLS=${GRID_COLS} TILE_W=${TILE_W} TILE_H=${TILE_H}`);
});
