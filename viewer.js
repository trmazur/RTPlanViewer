'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PLANS = ['A', 'B', 'C'];
const ORIENTS = ['axial', 'coronal', 'sagittal'];
const PLAN_COLORS = { A: '#4a9eff', B: '#ff9944', C: '#88ee66' };

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
function vp() { return { zoom: 1, panX: 0, panY: 0 }; }

const S = {
  // Volume dimensions (set on load)
  nx: 0, ny: 0, nz: 0,
  pixelSpacing: [1, 1],
  sliceSpacing: 1,
  origin: [0, 0, 0],

  // Shared slice positions (linked mode)
  slice: { axial: 0, coronal: 0, sagittal: 0 },
  sliceIndep: {
    A: { axial: 0, coronal: 0, sagittal: 0 },
    B: { axial: 0, coronal: 0, sagittal: 0 },
    C: { axial: 0, coronal: 0, sagittal: 0 },
  },

  linked: true,
  maximized: null,
  ww: 400, wl: 40,
  doseVisible: true,
  doseOpacity: 0.50,
  doseLoPct: 5,     // lower bound as % of max dose — below this, no wash shown
  doseHiPct: 100,   // upper bound as % of max dose — above this, saturate

  viewMode: 'all',  // 'all', 'axial', 'coronal', 'sagittal'

  isodoseLines: [
    { level: 0.95, color: '#ff3333', visible: true },
    { level: 0.80, color: '#ff9900', visible: true },
    { level: 0.60, color: '#ffff00', visible: true },
    { level: 0.40, color: '#00ccff', visible: true },
    { level: 0.20, color: '#0044ff', visible: true },
  ],

  structures: { A: [], B: [], C: [] },   // per-plan structure arrays
  structureList: [],                       // combined list for sidebar
  activeTool: 'scroll',

  views: {
    A: { axial: vp(), coronal: vp(), sagittal: vp() },
    B: { axial: vp(), coronal: vp(), sagittal: vp() },
    C: { axial: vp(), coronal: vp(), sagittal: vp() },
  },

  ctVolume: null,        // Int16Array
  doseVols: { A: null, B: null, C: null },   // Float32Array per plan
  doseMeta: { A: null, B: null, C: null },   // dose grid metadata per plan
  doseMaxGy: 70,         // max dose for colormap scaling

  // Loaded data
  manifest: null,
  dvhData: { A: {}, B: {}, C: {} },
  clinicalGoals: { A: [], B: [], C: [] },
  currentSite: '',
  currentSubject: '',

  getSlice(plan, orient) {
    return this.linked ? this.slice[orient] : this.sliceIndep[plan][orient];
  },
  setSlice(plan, orient, val) {
    const clamped = Math.max(0, Math.min(this._maxSlice(orient) - 1, val));
    if (this.linked) {
      this.slice[orient] = clamped;
    } else {
      this.sliceIndep[plan][orient] = clamped;
    }
  },
  _maxSlice(orient) {
    return orient === 'axial' ? this.nz : orient === 'coronal' ? this.ny : this.nx;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Data Loading
// ─────────────────────────────────────────────────────────────────────────────
const DataLoader = {
  async loadSites() {
    try {
      const resp = await fetch('/api/sites');
      const data = await resp.json();
      return data.sites || [];
    } catch (e) {
      console.warn('Failed to load sites:', e);
      return [];
    }
  },

  async loadSubjects(site) {
    try {
      const resp = await fetch(`/api/subjects?site=${encodeURIComponent(site)}`);
      const data = await resp.json();
      return (data.subjects || []).filter(s => s.hasManifest);
    } catch (e) {
      console.warn('Failed to load subjects:', e);
      return [];
    }
  },

  async loadSiteConfig(site) {
    try {
      const resp = await fetch(`/api/config?site=${encodeURIComponent(site)}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  async loadSubjectData(site, subject, onProgress) {
    const base = `SITES/${site}/${subject}/_processed`;

    // 1. Load manifest
    onProgress('Loading manifest...', 5);
    const manifestResp = await fetch(`${base}/manifest.json`);
    if (!manifestResp.ok) throw new Error('No manifest.json found. Run the admin tool first.');
    const manifest = await manifestResp.json();

    // 2. Load CT volume
    onProgress('Loading CT volume...', 15);
    const ctMetaResp = await fetch(`${base}/ct_meta.json`);
    const ctMeta = await ctMetaResp.json();

    const ctBinResp = await fetch(`${base}/ct_volume.bin.gz`);
    const ctCompressed = new Uint8Array(await ctBinResp.arrayBuffer());
    onProgress('Decompressing CT...', 30);
    const ctRaw = pako.ungzip(ctCompressed);
    const ctVolume = new Int16Array(ctRaw.buffer);

    // 3. Load dose grids
    const doseVols = {};
    const doseMeta = {};
    for (let i = 0; i < PLANS.length; i++) {
      const p = PLANS[i];
      onProgress(`Loading dose grid ${p}...`, 40 + i * 15);
      try {
        const dMetaResp = await fetch(`${base}/plan_${p}/dose_meta.json`);
        doseMeta[p] = await dMetaResp.json();

        const dBinResp = await fetch(`${base}/plan_${p}/dose.bin.gz`);
        const dCompressed = new Uint8Array(await dBinResp.arrayBuffer());
        const dRaw = pako.ungzip(dCompressed);
        doseVols[p] = new Float32Array(dRaw.buffer);
      } catch (e) {
        console.warn(`No dose data for plan ${p}:`, e);
        doseVols[p] = null;
        doseMeta[p] = null;
      }
    }

    // 4. Load structures
    onProgress('Loading structures...', 85);
    const structures = {};
    for (const p of PLANS) {
      try {
        const sResp = await fetch(`${base}/plan_${p}/structures.json`);
        structures[p] = await sResp.json();
      } catch (e) {
        structures[p] = [];
      }
    }

    // 5. Load DVH data
    onProgress('Loading DVH data...', 90);
    const dvhData = {};
    for (const p of PLANS) {
      try {
        const dvhResp = await fetch(`${base}/plan_${p}/dvh.json`);
        dvhData[p] = await dvhResp.json();
      } catch (e) {
        dvhData[p] = {};
      }
    }

    // 6. Load clinical goals
    const clinicalGoals = {};
    for (const p of PLANS) {
      try {
        const gResp = await fetch(`${base}/plan_${p}/clinical_goals.json`);
        clinicalGoals[p] = await gResp.json();
      } catch (e) {
        clinicalGoals[p] = [];
      }
    }

    onProgress('Done!', 100);

    return { manifest, ctMeta, ctVolume, doseVols, doseMeta, structures, dvhData, clinicalGoals };
  },

  async checkExistingRanking(site, subject, reviewer) {
    try {
      const resp = await fetch(
        `/api/ranking?site=${encodeURIComponent(site)}&subject=${encodeURIComponent(subject)}&reviewer=${encodeURIComponent(reviewer)}`
      );
      const data = await resp.json();
      return data.exists ? data.ranking : null;
    } catch (e) { return null; }
  },

  async saveRanking(data) {
    const resp = await fetch('/api/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await resp.json();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Apply Loaded Data to State
// ─────────────────────────────────────────────────────────────────────────────
function applyLoadedData(data) {
  const { ctMeta, ctVolume, doseVols, doseMeta, structures, dvhData, clinicalGoals, manifest } = data;

  S.nx = ctMeta.cols;
  S.ny = ctMeta.rows;
  S.nz = ctMeta.nSlices;
  S.pixelSpacing = ctMeta.pixelSpacing || [1, 1];
  S.sliceSpacing = ctMeta.sliceSpacing || 1;
  S.origin = ctMeta.origin || [0, 0, 0];

  S.ctVolume = ctVolume;
  S.rawDoseVols = doseVols;  // original dose grids (different geometry)
  S.doseMeta = doseMeta;
  S.manifest = manifest;
  S.dvhData = dvhData;
  S.clinicalGoals = clinicalGoals;

  // Compute max dose across all plans for colormap
  let maxDose = 1;
  PLANS.forEach(p => {
    if (S.rawDoseVols[p]) {
      for (let i = 0; i < S.rawDoseVols[p].length; i++) {
        if (S.rawDoseVols[p][i] > maxDose) maxDose = S.rawDoseVols[p][i];
      }
    }
  });
  S.doseMaxGy = Math.ceil(maxDose * 1.05);

  // Resample dose grids onto CT grid for fast rendering
  console.time('Dose resampling');
  resampleDoseToCtGrid();
  console.timeEnd('Dose resampling');

  // Process structures — convert DICOM coordinates to voxel indices
  S.structures = {};
  S.structureList = [];
  const structNames = new Set();

  PLANS.forEach(plan => {
    S.structures[plan] = [];
    const planStructs = structures[plan] || [];

    planStructs.forEach(st => {
      const processed = {
        templateId: st.templateId,
        name: st.templateName,
        color: st.templateColor,
        visible: true,
        contourSlices: [],
      };

      // Group contours by z and convert to voxel coords
      (st.contours || []).forEach(contour => {
        const voxelPoints = contour.points.map(pt => ({
          x: (pt.x - S.origin[0]) / S.pixelSpacing[1],
          y: (pt.y - S.origin[1]) / S.pixelSpacing[0],
          z: pt.z,
        }));

        // Find slice index for this z
        const sliceIdx = Math.round((contour.z - S.origin[2]) / S.sliceSpacing);

        processed.contourSlices.push({
          z: sliceIdx,
          zMm: contour.z,
          poly: voxelPoints,
        });
      });

      S.structures[plan].push(processed);

      if (!structNames.has(st.templateName)) {
        structNames.add(st.templateName);
        S.structureList.push({
          name: st.templateName,
          color: st.templateColor,
          visible: true,
        });
      }
    });
  });

  // Reset slice positions to middle
  const midAxial = Math.floor(S.nz / 2);
  const midCoronal = Math.floor(S.ny / 2);
  const midSagittal = Math.floor(S.nx / 2);
  S.slice = { axial: midAxial, coronal: midCoronal, sagittal: midSagittal };
  PLANS.forEach(p => {
    S.sliceIndep[p] = { axial: midAxial, coronal: midCoronal, sagittal: midSagittal };
    S.views[p] = { axial: vp(), coronal: vp(), sagittal: vp() };
  });
  S.maximized = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ctToGray(hu, ww, wl) {
  return Math.max(0, Math.min(255, Math.round(((hu - (wl - ww / 2)) / ww) * 255)));
}

function doseColor(t) {
  const stops = [
    [0.00,   0,   0, 139],
    [0.25,   0, 255, 255],
    [0.50,   0, 255,   0],
    [0.75, 255, 255,   0],
    [1.00, 255,   0,   0],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  return [255, 0, 0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dose Resampling — done once at load time for fast rendering
// ─────────────────────────────────────────────────────────────────────────────
// Resamples each plan's dose grid onto the CT voxel grid so that
// doseVols[plan][vi] can be looked up with the same index as ctVolume[vi].
function resampleDoseToCtGrid() {
  const { nx, ny, nz } = S;
  const N = nx * ny * nz;

  PLANS.forEach(plan => {
    const rawDose = S.rawDoseVols[plan];
    const meta = S.doseMeta[plan];
    if (!rawDose || !meta) { S.doseVols[plan] = null; return; }

    const resampled = new Float32Array(N);

    const doseOrigin = meta.origin || [0, 0, 0];
    const doseSpacing = meta.pixelSpacing || [2.5, 2.5];
    const doseSliceSpacing = meta.sliceSpacing || 2.5;
    const dCols = meta.cols;
    const dRows = meta.rows;
    const dFrames = meta.nFrames;

    // Pre-compute inverse transforms for speed
    const ctOx = S.origin[0], ctOy = S.origin[1], ctOz = S.origin[2];
    const ctSx = S.pixelSpacing[1], ctSy = S.pixelSpacing[0], ctSz = S.sliceSpacing;
    const invDx = 1 / doseSpacing[1], invDy = 1 / doseSpacing[0], invDz = 1 / doseSliceSpacing;
    const dOx = doseOrigin[0], dOy = doseOrigin[1], dOz = doseOrigin[2];

    for (let z = 0; z < nz; z++) {
      const pz = ctOz + z * ctSz;
      const dz = (pz - dOz) * invDz;
      const iz = Math.floor(dz);
      if (iz < 0 || iz >= dFrames) continue;

      const zOff = z * ny * nx;
      const dzOff = iz * dRows * dCols;

      for (let y = 0; y < ny; y++) {
        const py = ctOy + y * ctSy;
        const dy = (py - dOy) * invDy;
        const iy = Math.floor(dy);
        if (iy < 0 || iy >= dRows) continue;

        const yOff = zOff + y * nx;
        const dyOff = dzOff + iy * dCols;

        for (let x = 0; x < nx; x++) {
          const px = ctOx + x * ctSx;
          const dx = (px - dOx) * invDx;
          const ix = Math.floor(dx);
          if (ix < 0 || ix >= dCols) continue;

          resampled[yOff + x] = rawDose[dyOff + ix];
        }
      }
    }

    S.doseVols[plan] = resampled;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────
const Renderer = {
  cvs: {},
  ctxs: {},
  ros: {},

  init() {
    PLANS.forEach(p => {
      ORIENTS.forEach(o => {
        const key = `${p}-${o}`;
        const cv = document.getElementById(`cv-${key}`);
        this.cvs[key] = cv;
        this.ctxs[key] = cv.getContext('2d');
        const ro = new ResizeObserver(() => {
          const cell = cv.parentElement;
          cv.width  = cell.clientWidth;
          cv.height = cell.clientHeight;
          this.draw(p, o);
        });
        ro.observe(cv.parentElement);
        this.ros[key] = ro;
      });
    });
  },

  _rafId: null,

  renderAll() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      PLANS.forEach(p => {
        // Skip minimized plans
        const row = document.getElementById(`row-${p}`);
        if (row && row.classList.contains('minimized')) return;
        ORIENTS.forEach(o => this.draw(p, o));
      });
      DVH.render();
    });
  },

  draw(plan, orient) {
    const key = `${plan}-${orient}`;
    const cv  = this.cvs[key];
    const ctx = this.ctxs[key];
    if (!cv || !ctx) return;

    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!S.ctVolume || W < 4 || H < 4) return;

    const { nx, ny, nz } = S;
    const si = S.getSlice(plan, orient);
    let sliceW, sliceH, getIdx;

    if (orient === 'axial') {
      sliceW = nx; sliceH = ny;
      getIdx = (x, y) => si * ny * nx + y * nx + x;
    } else if (orient === 'coronal') {
      sliceW = nx; sliceH = nz;
      getIdx = (x, y) => (nz - 1 - y) * ny * nx + si * nx + x;
    } else {
      sliceW = ny; sliceH = nz;
      getIdx = (x, y) => (nz - 1 - y) * ny * nx + x * nx + si;
    }

    const imgData = ctx.createImageData(sliceW, sliceH);
    const buf = imgData.data;
    const ct = S.ctVolume;
    const dose = S.doseVols[plan];  // already resampled to CT grid
    const op = S.doseOpacity;
    const doseMax = S.doseMaxGy;
    const showDose = S.doseVisible && dose;

    // Dose bounds in Gy
    const doseLo = S.doseLoPct / 100 * doseMax;
    const doseHi = S.doseHiPct / 100 * doseMax;
    const doseRange = doseHi - doseLo;
    const invDoseRange = doseRange > 0 ? 1 / doseRange : 0;

    // Pre-compute W/L transform constants
    const wlBase = S.wl - S.ww / 2;
    const wlScale = 255 / S.ww;

    for (let py = 0; py < sliceH; py++) {
      for (let px = 0; px < sliceW; px++) {
        const vi = getIdx(px, py);

        // Inline W/L for speed
        let gray = (ct[vi] - wlBase) * wlScale;
        if (gray < 0) gray = 0; else if (gray > 255) gray = 255;

        let r = gray, g = gray, b = gray;

        if (showDose) {
          const d = dose[vi];
          if (d > doseLo) {
            // Map dose to 0-1 range between lower and upper bounds
            const t = Math.min(1, (d - doseLo) * invDoseRange);
            // Inline dose colormap
            let dr, dg, db;
            if (t < 0.25) {
              const f = t * 4;
              dr = 0; dg = f * 255; db = 139 + f * 116;
            } else if (t < 0.5) {
              const f = (t - 0.25) * 4;
              dr = 0; dg = 255; db = 255 - f * 255;
            } else if (t < 0.75) {
              const f = (t - 0.5) * 4;
              dr = f * 255; dg = 255; db = 0;
            } else {
              const f = Math.min(1, (t - 0.75) * 4);
              dr = 255; dg = 255 - f * 255; db = 0;
            }
            r = gray * (1 - op) + dr * op;
            g = gray * (1 - op) + dg * op;
            b = gray * (1 - op) + db * op;
          }
        }

        const pi = (py * sliceW + px) * 4;
        buf[pi]   = r;
        buf[pi+1] = g;
        buf[pi+2] = b;
        buf[pi+3] = 255;
      }
    }

    // Blit to canvas with zoom/pan
    const oc = new OffscreenCanvas(sliceW, sliceH);
    oc.getContext('2d').putImageData(imgData, 0, 0);

    const vs = S.views[plan][orient];
    const scale = Math.min(W / sliceW, H / sliceH) * vs.zoom;
    const ox = (W - sliceW * scale) / 2 + vs.panX;
    const oy = (H - sliceH * scale) / 2 + vs.panY;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(oc, ox, oy, sliceW * scale, sliceH * scale);

    // Isodose lines
    if (S.doseVisible) {
      S.isodoseLines.forEach(iso => {
        if (iso.visible) {
          drawIsodose(ctx, plan, orient, si, iso.level, iso.color,
                      sliceW, sliceH, scale, ox, oy);
        }
      });
    }

    // Structure contours (all orientations)
    drawStructures(ctx, plan, orient, si, scale, ox, oy);

    // Crosshair
    drawCrosshair(ctx, plan, orient, sliceW, sliceH, scale, ox, oy, W, H);

    // Position label
    const el = document.getElementById(`pos-${plan}-${orient}`);
    if (el) {
      const mm = orient === 'axial'
        ? S.origin[2] + si * S.sliceSpacing
        : orient === 'coronal'
          ? S.origin[1] + si * S.pixelSpacing[0]
          : S.origin[0] + si * S.pixelSpacing[1];
      el.textContent = `Sl ${si}  (${mm.toFixed(1)} mm)`;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Isodose Contours
// ─────────────────────────────────────────────────────────────────────────────
function drawIsodose(ctx, plan, orient, si, level, color, sliceW, sliceH, scale, ox, oy) {
  const { nx, ny, nz } = S;
  const dose = S.doseVols[plan];
  if (!dose) return;
  const threshold = level * S.doseMaxGy;

  // Direct array lookup using same indexing as CT
  let getV;
  if (orient === 'axial') {
    getV = (x, y) => dose[si * ny * nx + y * nx + x];
  } else if (orient === 'coronal') {
    getV = (x, y) => dose[(nz - 1 - y) * ny * nx + si * nx + x];
  } else {
    getV = (x, y) => dose[(nz - 1 - y) * ny * nx + x * nx + si];
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let y = 0; y < sliceH - 1; y++) {
    for (let x = 0; x < sliceW - 1; x++) {
      const code =
        (getV(x,   y)   > threshold ? 1 : 0) |
        (getV(x+1, y)   > threshold ? 2 : 0) |
        (getV(x,   y+1) > threshold ? 4 : 0) |
        (getV(x+1, y+1) > threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const x0 = ox + x * scale, y0 = oy + y * scale, s = scale, h = s / 2;
      const T = [x0+h, y0  ], B = [x0+h, y0+s];
      const L = [x0,   y0+h], R = [x0+s, y0+h];

      const segs = {
        1:[...L,...T], 2:[...T,...R], 3:[...L,...R], 4:[...L,...B],
        5:[...T,...B], 6:[...T,...L], 7:[...R,...B], 8:[...R,...B],
        9:[...T,...L], 10:[...T,...B], 11:[...L,...B], 12:[...L,...R],
        13:[...T,...R], 14:[...L,...T],
      };
      const seg = segs[code];
      if (seg) { ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); }
    }
  }
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure Contours (all orientations)
// ─────────────────────────────────────────────────────────────────────────────
function drawStructures(ctx, plan, orient, si, scale, ox, oy) {
  const structs = S.structures[plan] || [];

  structs.forEach(st => {
    // Check visibility from the combined structure list
    const listEntry = S.structureList.find(s => s.name === st.name);
    if (listEntry && !listEntry.visible) return;
    if (!st.visible) return;

    if (orient === 'axial') {
      // Draw contours on matching axial slices
      st.contourSlices.forEach(cs => {
        if (cs.z === si) {
          drawPoly(ctx, cs.poly, st.color, scale, ox, oy);
        }
      });
    } else {
      // For coronal/sagittal: find contours that cross this slice
      // and draw the intersection points as a connected line
      drawStructureCrossSection(ctx, st, orient, si, scale, ox, oy);
    }
  });
}

function drawStructureCrossSection(ctx, struct, orient, si, scale, ox, oy) {
  // For each axial contour slice, compute where the polygon edges cross
  // the coronal (y=si) or sagittal (x=si) plane. This produces pairs of
  // intersection points per slice, which we draw as horizontal line segments.
  const { nz } = S;

  ctx.strokeStyle = struct.color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]);

  struct.contourSlices.forEach(cs => {
    const poly = cs.poly;
    if (!poly || poly.length < 3) return;

    // Find all intersection points of the polygon with the cutting plane
    const crossings = [];

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];

      if (orient === 'coronal') {
        // Cutting plane: y = si (in voxel coords)
        if ((a.y <= si && b.y > si) || (b.y <= si && a.y > si)) {
          const frac = (si - a.y) / (b.y - a.y);
          const xCross = a.x + frac * (b.x - a.x);
          crossings.push(xCross);
        }
      } else {
        // Sagittal: cutting plane: x = si
        if ((a.x <= si && b.x > si) || (b.x <= si && a.x > si)) {
          const frac = (si - a.x) / (b.x - a.x);
          const yCross = a.y + frac * (b.y - a.y);
          crossings.push(yCross);
        }
      }
    }

    if (crossings.length < 2) return;
    crossings.sort((a, b) => a - b);

    // Draw pairs of crossings as line segments at this z level
    const screenY = oy + (nz - 1 - cs.z) * scale;

    for (let i = 0; i < crossings.length - 1; i += 2) {
      const x1 = orient === 'coronal'
        ? ox + crossings[i] * scale
        : ox + crossings[i] * scale;
      const x2 = orient === 'coronal'
        ? ox + crossings[i + 1] * scale
        : ox + crossings[i + 1] * scale;

      ctx.beginPath();
      ctx.moveTo(x1, screenY);
      ctx.lineTo(x2, screenY);
      ctx.stroke();
    }
  });

  ctx.setLineDash([]);
}

function drawPoly(ctx, poly, color, scale, ox, oy) {
  if (!poly || poly.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  poly.forEach((pt, i) => {
    const sx = ox + pt.x * scale, sy = oy + pt.y * scale;
    i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair
// ─────────────────────────────────────────────────────────────────────────────
function drawCrosshair(ctx, plan, orient, sliceW, sliceH, scale, ox, oy, W, H) {
  const { nz } = S;
  const sAx  = S.getSlice(plan, 'axial');
  const sCor = S.getSlice(plan, 'coronal');
  const sSag = S.getSlice(plan, 'sagittal');

  let cx, cy;
  if (orient === 'axial') {
    cx = ox + sSag * scale;
    cy = oy + sCor * scale;
  } else if (orient === 'coronal') {
    cx = ox + sSag * scale;
    cy = oy + (nz - 1 - sAx) * scale;
  } else {
    cx = ox + sCor * scale;
    cy = oy + (nz - 1 - sAx) * scale;
  }

  ctx.strokeStyle = 'rgba(120,190,255,0.5)';
  ctx.lineWidth = 0.8;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
  ctx.moveTo(0, cy); ctx.lineTo(W, cy);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────────────────────
// DVH — Combined Overlay Chart
// ─────────────────────────────────────────────────────────────────────────────
const DVH = {
  render() {
    const cv = document.getElementById('dvh-canvas');
    if (!cv) return;
    const wrap = cv.parentElement;
    cv.width = wrap.clientWidth;
    cv.height = wrap.clientHeight;
    if (cv.width < 20 || cv.height < 20) return;

    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, W, H);

    if (!S.ctVolume) return;

    const PAD = { top: 8, right: 8, bottom: 24, left: 36 };
    const pW = W - PAD.left - PAD.right;
    const pH = H - PAD.top - PAD.bottom;

    // Grid lines
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const x = PAD.left + (i / 5) * pW;
      const y = PAD.top + (i / 5) * pH;
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + pH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + pW, y); ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = '#555';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 5; i++) {
      ctx.fillText(`${((i / 5) * S.doseMaxGy).toFixed(0)}`, PAD.left + (i / 5) * pW, H - 4);
    }
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      ctx.fillText(`${100 - i * 25}%`, PAD.left - 3, PAD.top + (i / 4) * pH + 3);
    }

    // Draw DVH curves
    const legend = document.getElementById('dvh-legend');
    legend.innerHTML = '';
    const lineStyles = [[], [6, 3], [2, 2]];  // solid, dashed, dotted for plans

    // Get all structure names from DVH data
    const structNames = new Set();
    PLANS.forEach(p => {
      Object.values(S.dvhData[p] || {}).forEach(d => {
        if (d.templateName) structNames.add(d.templateName);
      });
    });

    // Line styles per plan: solid, dashed, dotted
    const planDash = { A: [], B: [8, 4], C: [3, 3] };
    const planLabel = { A: 'solid', B: 'dashed', C: 'dotted' };

    structNames.forEach(structName => {
      // Check visibility
      const listEntry = S.structureList.find(s => s.name === structName);
      if (listEntry && !listEntry.visible) return;

      const color = listEntry?.color || '#888';

      PLANS.forEach(plan => {
        const dvhEntry = Object.values(S.dvhData[plan] || {}).find(d => d.templateName === structName);
        if (!dvhEntry || !dvhEntry.curve) return;

        // Build cumulative DVH
        const cumDvh = buildCumulativeDVH(dvhEntry);
        if (!cumDvh || cumDvh.length === 0) return;

        const totalVol = cumDvh[0]?.volume || 1;

        ctx.strokeStyle = color;  // color by structure
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = 0.9;
        ctx.setLineDash(planDash[plan]);  // line style by plan
        ctx.beginPath();

        cumDvh.forEach((pt, i) => {
          const x = PAD.left + (pt.dose / S.doseMaxGy) * pW;
          const y = PAD.top + (1 - pt.volume / totalVol) * pH;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      });

      // Structure legend entry (colored)
      const item = document.createElement('div');
      item.className = 'dvh-legend-item';
      item.innerHTML = `<span class="dvh-legend-sw" style="background:${color};height:4px"></span>
        <span style="color:${color}">${structName}</span>`;
      legend.appendChild(item);
    });

    // Plan line-style legend
    PLANS.forEach(plan => {
      const item = document.createElement('div');
      item.className = 'dvh-legend-item';
      item.innerHTML = `<span style="width:20px;border-bottom:2px ${planLabel[plan]} #aaa;display:inline-block;margin-right:4px"></span>
        <span>Plan ${plan} (${planLabel[plan]})</span>`;
      legend.appendChild(item);
    });
  },
};

function buildCumulativeDVH(dvhEntry) {
  if (!dvhEntry.curve || dvhEntry.curve.length === 0) return [];

  if (dvhEntry.type === 'CUMULATIVE') {
    return dvhEntry.curve.map(p => ({ dose: p.dose, volume: p.volume }));
  }

  // Differential to cumulative
  const curve = dvhEntry.curve;
  const cumulative = [];
  let cumVol = 0;
  for (let i = curve.length - 1; i >= 0; i--) {
    cumVol += curve[i].volume;
    cumulative.unshift({ dose: curve[i].dose, volume: cumVol });
  }
  return cumulative;
}

// ─────────────────────────────────────────────────────────────────────────────
// Maximize / Restore
// ─────────────────────────────────────────────────────────────────────────────
function setMaximized(plan) {
  S.maximized = plan;
  PLANS.forEach(p => {
    const row = document.getElementById(`row-${p}`);
    const btn = row.querySelector('.max-btn');
    if (plan === null) {
      row.classList.remove('maximized', 'minimized');
      btn.textContent = '\u26F6';
      btn.classList.remove('restore');
      btn.title = `Maximize Plan ${p}`;
    } else if (p === plan) {
      row.classList.add('maximized');
      row.classList.remove('minimized');
      btn.textContent = '\u22A1';
      btn.classList.add('restore');
      btn.title = 'Restore grid view';
    } else {
      row.classList.add('minimized');
      row.classList.remove('maximized');
      btn.textContent = '\u26F6';
      btn.classList.remove('restore');
    }
  });
  setTimeout(() => Renderer.renderAll(), 250);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction
// ─────────────────────────────────────────────────────────────────────────────
const Interaction = {
  drag: null,

  init() {
    PLANS.forEach(plan => {
      ORIENTS.forEach(orient => {
        const cv = document.getElementById(`cv-${plan}-${orient}`);

        cv.addEventListener('wheel', e => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 1 : -1;

          if (S.activeTool === 'zoom') {
            const vs = S.views[plan][orient];
            vs.zoom = Math.max(0.4, Math.min(12, vs.zoom * (delta > 0 ? 0.9 : 1.1)));
            if (S.linked) {
              PLANS.forEach(p => { S.views[p][orient].zoom = vs.zoom; });
            }
            Renderer.renderAll();
          } else {
            const cur = S.getSlice(plan, orient);
            S.setSlice(plan, orient, cur + delta);
            if (S.linked) Renderer.renderAll();
            else { ORIENTS.forEach(o => Renderer.draw(plan, o)); }
          }
        }, { passive: false });

        cv.addEventListener('mousedown', e => {
          this.drag = {
            plan, orient,
            x0: e.clientX, y0: e.clientY,
            panX0: S.views[plan][orient].panX,
            panY0: S.views[plan][orient].panY,
          };
        });

        cv.addEventListener('mousemove', e => {
          if (!this.drag || this.drag.plan !== plan || this.drag.orient !== orient) return;
          if (S.activeTool === 'pan') {
            const dx = e.clientX - this.drag.x0;
            const dy = e.clientY - this.drag.y0;
            S.views[plan][orient].panX = this.drag.panX0 + dx;
            S.views[plan][orient].panY = this.drag.panY0 + dy;
            if (S.linked) {
              PLANS.forEach(p => {
                S.views[p][orient].panX = S.views[plan][orient].panX;
                S.views[p][orient].panY = S.views[plan][orient].panY;
              });
              Renderer.renderAll();
            } else {
              ORIENTS.forEach(o => Renderer.draw(plan, o));
            }
          }
        });

        cv.addEventListener('mouseup', () => { this.drag = null; });
        cv.addEventListener('mouseleave', () => { this.drag = null; });
      });

      // Maximize button
      const btn = document.querySelector(`.max-btn[data-plan="${plan}"]`);
      btn.addEventListener('click', () => {
        setMaximized(S.maximized === plan ? null : plan);
      });
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Isodose UI
// ─────────────────────────────────────────────────────────────────────────────
function renderIsodoseUI() {
  const tbody = document.getElementById('iso-tbody');
  tbody.innerHTML = '';
  S.isodoseLines.forEach((iso, i) => {
    const tr = document.createElement('tr');

    const tdC = document.createElement('td');
    const cp = document.createElement('input');
    cp.type = 'color'; cp.value = iso.color;
    cp.style.cssText = 'width:20px;height:20px;border:none;background:none;cursor:pointer;padding:0';
    cp.addEventListener('input', e => { iso.color = e.target.value; Renderer.renderAll(); });
    tdC.appendChild(cp);

    const tdL = document.createElement('td');
    const inp = document.createElement('input');
    inp.className = 'iso-lvl'; inp.type = 'number';
    inp.min = 1; inp.max = 100; inp.value = Math.round(iso.level * 100);
    inp.addEventListener('change', e => {
      iso.level = Math.max(0.01, Math.min(1, +e.target.value / 100));
      Renderer.renderAll();
    });
    tdL.appendChild(inp);
    tdL.appendChild(Object.assign(document.createElement('span'), { textContent: '%', style: 'color:#555;font-size:10px' }));

    const tdV = document.createElement('td');
    const eye = document.createElement('span');
    eye.className = 'iso-eye'; eye.textContent = iso.visible ? '\u{1F441}' : '\u25CB';
    eye.addEventListener('click', () => { iso.visible = !iso.visible; eye.textContent = iso.visible ? '\u{1F441}' : '\u25CB'; Renderer.renderAll(); });
    tdV.appendChild(eye);

    const tdD = document.createElement('td');
    const del = document.createElement('span');
    del.className = 'iso-del'; del.textContent = '\u2715';
    del.addEventListener('click', () => { S.isodoseLines.splice(i, 1); renderIsodoseUI(); Renderer.renderAll(); });
    tdD.appendChild(del);

    tr.append(tdC, tdL, tdV, tdD);
    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure UI
// ─────────────────────────────────────────────────────────────────────────────
function renderStructureUI() {
  const list = document.getElementById('struct-list');
  list.innerHTML = '';
  S.structureList.forEach(st => {
    const row = document.createElement('div');
    row.className = 'str-row';
    const sw = document.createElement('div');
    sw.className = 'str-sw'; sw.style.background = st.color;
    const nm = document.createElement('span');
    nm.className = 'str-name'; nm.textContent = st.name;
    const ey = document.createElement('span');
    ey.className = 'str-eye'; ey.textContent = st.visible ? '\u{1F441}' : '\u25CB';
    ey.addEventListener('click', () => {
      st.visible = !st.visible;
      ey.textContent = st.visible ? '\u{1F441}' : '\u25CB';
      Renderer.renderAll();
    });
    row.append(sw, nm, ey);
    list.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Clinical Goals Panel
// ─────────────────────────────────────────────────────────────────────────────
function renderClinicalGoals() {
  const content = document.getElementById('goals-content');

  // Check if we have any goals
  const hasGoals = PLANS.some(p => S.clinicalGoals[p] && S.clinicalGoals[p].length > 0);
  if (!hasGoals) {
    content.innerHTML = '<p style="color:var(--text-dim);font-size:12px">No clinical goal data available for this subject.</p>';
    return;
  }

  let html = `<table class="goals-tbl">
    <thead><tr>
      <th>Structure</th>
      <th>Goal</th>
      <th>Criteria</th>
      <th style="color:var(--row-A)">Plan A</th>
      <th style="color:var(--row-B)">Plan B</th>
      <th style="color:var(--row-C)">Plan C</th>
    </tr></thead><tbody>`;

  // Group by priority
  const allGoals = S.clinicalGoals.A || [];
  const priorities = [...new Set(allGoals.map(g => g.priority))].sort((a, b) => a - b);

  priorities.forEach(pri => {
    html += `<tr class="priority-hdr"><td colspan="6">Priority ${pri}</td></tr>`;

    const goalsAtPri = allGoals.filter(g => g.priority === pri);
    goalsAtPri.forEach((goal, gIdx) => {
      html += `<tr>
        <td>${goal.structName || ''}</td>
        <td>${goal.goalType || ''}</td>
        <td>${goal.criteria || ''}</td>`;

      PLANS.forEach(p => {
        const pGoals = (S.clinicalGoals[p] || []).filter(g => g.priority === pri);
        const match = pGoals[gIdx];
        if (match) {
          const cls = match.status === 'pass' ? 'g-pass'
            : match.status === 'marginal' ? 'g-marginal'
            : match.status === 'fail' ? 'g-fail' : '';
          html += `<td class="${cls}">${match.value}</td>`;
        } else {
          html += `<td>—</td>`;
        }
      });

      html += `</tr>`;
    });
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────
function initRanking() {
  const sels = PLANS.map(p => document.getElementById(`rank-${p}`));
  const btn  = document.getElementById('submit-btn');
  const stat = document.getElementById('rank-status');
  const tieWrap = document.getElementById('tie-confirm-wrap');
  const tieCheck = document.getElementById('tie-confirm');

  function validateRanking() {
    const reviewer = document.getElementById('reviewer-select').value;
    const vals = sels.map(s => s.value).filter(v => v);
    const allFilled = vals.length === 3;
    const hasFirst = vals.includes('1');
    const hasTies = allFilled && new Set(vals).size < 3;
    const tieConfirmed = tieCheck.checked;

    // Show/hide tie confirmation
    tieWrap.style.display = hasTies ? '' : 'none';
    if (!hasTies) tieCheck.checked = false;

    // Determine if ready
    let ready = false;
    if (!reviewer) {
      stat.textContent = 'Select a reviewer first.';
      stat.style.color = 'var(--yellow)';
    } else if (!allFilled) {
      stat.textContent = '';
      stat.style.color = '';
    } else if (!hasFirst) {
      stat.textContent = 'At least one plan must be ranked 1st.';
      stat.style.color = 'var(--red)';
    } else if (hasTies && !tieConfirmed) {
      stat.textContent = 'Tied rankings — check the box to confirm.';
      stat.style.color = 'var(--yellow)';
    } else {
      stat.textContent = 'Ready.';
      stat.style.color = 'var(--green)';
      ready = true;
    }

    btn.disabled = !ready;
  }

  sels.forEach(sel => sel.addEventListener('change', validateRanking));
  tieCheck.addEventListener('change', validateRanking);
  document.getElementById('reviewer-select').addEventListener('change', validateRanking);

  btn.addEventListener('click', async () => {
    const reviewer = document.getElementById('reviewer-select').value;
    if (!reviewer || !S.currentSite || !S.currentSubject) return;

    // Check for existing ranking
    const existing = await DataLoader.checkExistingRanking(S.currentSite, S.currentSubject, reviewer);
    if (existing) {
      // Show overwrite confirmation
      document.getElementById('overwrite-msg').textContent =
        `${reviewer} already submitted a ranking for this subject on ${new Date(existing.timestamp).toLocaleString()}. Overwrite?`;
      document.getElementById('overwrite-modal').classList.remove('hidden');

      // Wait for user decision
      const confirmed = await new Promise(resolve => {
        document.getElementById('overwrite-confirm').onclick = () => resolve(true);
        document.getElementById('overwrite-cancel').onclick = () => resolve(false);
      });
      document.getElementById('overwrite-modal').classList.add('hidden');

      if (!confirmed) return;
    }

    const notes = document.getElementById('rank-notes').value.trim();
    const result = {
      site: S.currentSite,
      subject: S.currentSubject,
      reviewer,
      rankings: Object.fromEntries(PLANS.map((p, i) => [p, sels[i].value])),
      tiedRankings: new Set(sels.map(s => s.value)).size < 3,
      notes: notes || null,
      timestamp: new Date().toISOString(),
    };

    try {
      await DataLoader.saveRanking(result);
      stat.textContent = 'Submitted!';
      stat.style.color = 'var(--green)';
      btn.disabled = true;
    } catch (e) {
      // Fallback: download as JSON
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `ranking_${S.currentSite}_${S.currentSubject}_${reviewer}_${Date.now()}.json`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      stat.textContent = 'Saved (downloaded).';
      stat.style.color = 'var(--yellow)';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar Controls
// ─────────────────────────────────────────────────────────────────────────────
function initControls() {
  // W/L
  document.getElementById('ww').addEventListener('input', e => {
    S.ww = +e.target.value;
    document.getElementById('ww-val').textContent = S.ww;
    Renderer.renderAll();
  });
  document.getElementById('wl').addEventListener('input', e => {
    S.wl = +e.target.value;
    document.getElementById('wl-val').textContent = S.wl;
    Renderer.renderAll();
  });

  // Dose
  document.getElementById('dop').addEventListener('input', e => {
    S.doseOpacity = e.target.value / 100;
    document.getElementById('dop-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  // Dose lower bound — sync slider and number input
  const doseLo = document.getElementById('dose-lo');
  const doseLoNum = document.getElementById('dose-lo-num');
  doseLo.addEventListener('input', e => {
    S.doseLoPct = +e.target.value;
    doseLoNum.value = e.target.value;
    document.getElementById('dose-lo-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  doseLoNum.addEventListener('change', e => {
    const v = Math.max(0, Math.min(100, +e.target.value));
    S.doseLoPct = v;
    doseLo.value = v;
    doseLoNum.value = v;
    document.getElementById('dose-lo-val').textContent = v;
    Renderer.renderAll();
  });
  // Dose upper bound
  const doseHi = document.getElementById('dose-hi');
  const doseHiNum = document.getElementById('dose-hi-num');
  doseHi.addEventListener('input', e => {
    S.doseHiPct = +e.target.value;
    doseHiNum.value = e.target.value;
    document.getElementById('dose-hi-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  doseHiNum.addEventListener('change', e => {
    const v = Math.max(0, Math.min(100, +e.target.value));
    S.doseHiPct = v;
    doseHi.value = v;
    doseHiNum.value = v;
    document.getElementById('dose-hi-val').textContent = v;
    Renderer.renderAll();
  });
  document.getElementById('dshow').addEventListener('change', e => {
    S.doseVisible = e.target.checked;
    Renderer.renderAll();
  });

  // Isodose all on/off
  document.getElementById('iso-all-on').addEventListener('click', () => {
    S.isodoseLines.forEach(iso => { iso.visible = true; });
    renderIsodoseUI();
    Renderer.renderAll();
  });
  document.getElementById('iso-all-off').addEventListener('click', () => {
    S.isodoseLines.forEach(iso => { iso.visible = false; });
    renderIsodoseUI();
    Renderer.renderAll();
  });

  // Structure all on/off
  document.getElementById('struct-all-on').addEventListener('click', () => {
    S.structureList.forEach(s => { s.visible = true; });
    renderStructureUI();
    Renderer.renderAll();
  });
  document.getElementById('struct-all-off').addEventListener('click', () => {
    S.structureList.forEach(s => { s.visible = false; });
    renderStructureUI();
    Renderer.renderAll();
  });

  // View mode
  document.getElementById('view-mode').addEventListener('change', e => {
    S.viewMode = e.target.value;
    applyViewMode();
    setTimeout(() => Renderer.renderAll(), 100);
  });

  // Isodose add
  document.getElementById('add-iso').addEventListener('click', () => {
    S.isodoseLines.push({ level: 0.5, color: '#ffffff', visible: true });
    renderIsodoseUI();
    Renderer.renderAll();
  });

  // Tools
  document.querySelectorAll('.tool-btn').forEach(btn => {
    if (!btn.dataset.tool) return; // skip struct buttons
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.activeTool = btn.dataset.tool;
    });
  });

  // Link toggle
  const linkBtn = document.getElementById('link-btn');
  linkBtn.addEventListener('click', () => {
    S.linked = !S.linked;
    linkBtn.textContent = S.linked ? 'Linked' : 'Unlinked';
    linkBtn.classList.toggle('linked', S.linked);
    if (S.linked) {
      PLANS.forEach(p => {
        S.sliceIndep[p] = { ...S.slice };
      });
    } else {
      PLANS.forEach(p => {
        S.sliceIndep[p] = { ...S.slice };
      });
    }
    Renderer.renderAll();
  });

  // Clinical goals panel
  document.getElementById('goals-btn').addEventListener('click', () => {
    document.getElementById('goals-panel').classList.toggle('open');
  });
  document.getElementById('goals-close-btn').addEventListener('click', () => {
    document.getElementById('goals-panel').classList.remove('open');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// View Mode
// ─────────────────────────────────────────────────────────────────────────────
function applyViewMode() {
  const mode = S.viewMode;
  const grid = document.getElementById('grid');

  // Switch grid direction: vertical (3x3) vs horizontal (1x3) for single views
  grid.classList.toggle('horizontal', mode !== 'all');

  PLANS.forEach(plan => {
    ORIENTS.forEach(orient => {
      const cell = document.getElementById(`cell-${plan}-${orient}`);
      if (!cell) return;
      if (mode === 'all') {
        cell.classList.remove('view-hidden');
      } else {
        cell.classList.toggle('view-hidden', orient !== mode);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation (site/subject/load)
// ─────────────────────────────────────────────────────────────────────────────
async function initNavigation() {
  const siteSel = document.getElementById('site-select');
  const subjSel = document.getElementById('subject-select');
  const loadBtn = document.getElementById('load-btn');

  // Load sites
  const sites = await DataLoader.loadSites();
  sites.forEach(site => {
    const opt = document.createElement('option');
    opt.value = site;
    opt.textContent = site;
    siteSel.appendChild(opt);
  });

  // Site change -> load subjects
  siteSel.addEventListener('change', async () => {
    subjSel.innerHTML = '<option value="">—</option>';
    subjSel.disabled = true;
    loadBtn.disabled = true;

    const site = siteSel.value;
    if (!site) return;

    const subjects = await DataLoader.loadSubjects(site);
    subjects.forEach(subj => {
      const opt = document.createElement('option');
      opt.value = subj.name;
      opt.textContent = subj.name + (subj.status === 'processed' ? '' : ' (not processed)');
      opt.disabled = subj.status !== 'processed';
      subjSel.appendChild(opt);
    });
    subjSel.disabled = false;

    // Load site config for reviewer list
    const config = await DataLoader.loadSiteConfig(site);
    if (config?.reviewers) {
      const revSel = document.getElementById('reviewer-select');
      revSel.innerHTML = '<option value="">—</option>';
      config.reviewers.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        revSel.appendChild(opt);
      });
    }
  });

  // Subject change -> enable load
  subjSel.addEventListener('change', () => {
    loadBtn.disabled = !subjSel.value;
  });

  // Load button
  loadBtn.addEventListener('click', async () => {
    const site = siteSel.value;
    const subject = subjSel.value;
    if (!site || !subject) return;

    S.currentSite = site;
    S.currentSubject = subject;

    // Show loading overlay
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden');

    try {
      const data = await DataLoader.loadSubjectData(site, subject, (msg, pct) => {
        document.getElementById('loading-text').textContent = msg;
        document.getElementById('load-fill').style.width = pct + '%';
      });

      applyLoadedData(data);

      // Update UI
      document.getElementById('case-label').textContent = `${site} / ${subject}`;
      document.getElementById('welcome-screen').classList.add('hidden');
      document.getElementById('body').style.display = 'flex';

      renderIsodoseUI();
      renderStructureUI();
      renderClinicalGoals();

      // Reset ranking
      PLANS.forEach(p => { document.getElementById(`rank-${p}`).value = ''; });
      document.getElementById('submit-btn').disabled = true;
      document.getElementById('rank-status').textContent = '';

      // Render after layout settles
      setTimeout(() => Renderer.renderAll(), 100);

    } catch (e) {
      alert(`Failed to load subject: ${e.message}`);
      console.error(e);
    } finally {
      overlay.classList.add('hidden');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  Renderer.init();
  Interaction.init();
  initRanking();
  initControls();
  initNavigation();

  // DVH panel toggle
  const dvhCol = document.getElementById('dvh-col');
  const dvhHeader = document.getElementById('dvh-header');
  dvhHeader.addEventListener('click', () => {
    dvhCol.classList.toggle('expanded');
    // Re-render DVH after transition
    setTimeout(() => DVH.render(), 350);
    // Re-render images since grid width changed
    setTimeout(() => Renderer.renderAll(), 350);
  });

  // DVH resize observer
  const dvhWrap = document.getElementById('dvh-canvas-wrap');
  if (dvhWrap) {
    new ResizeObserver(() => DVH.render()).observe(dvhWrap);
  }
});
