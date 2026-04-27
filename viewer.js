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
  doseLo: 5,        // lower bound (in current unit — % or Gy)
  doseHi: 100,      // upper bound (in current unit — % or Gy)
  doseMode: 'rel',  // 'rel' = % of RX, 'abs' = Gy
  rxTotalDoseGy: null,  // prescription total dose (set from manifest)
  rxFractionDoseGy: null,
  rxNumFractions: null,

  viewMode: 'all',  // 'all', 'axial', 'coronal', 'sagittal'

  isodoseLines: [
    { level: 0.95, color: '#ff3333', visible: false },
    { level: 0.80, color: '#ff9900', visible: false },
    { level: 0.60, color: '#ffff00', visible: false },
    { level: 0.40, color: '#00ccff', visible: false },
    { level: 0.20, color: '#0044ff', visible: false },
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
  currentSubjects: [],   // cached subject list for active site
  rankingStatus: {},     // { subjectName: { phase1: bool, phase2: bool } }

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

    // Cache-buster to ensure fresh data
    const cb = `?_=${Date.now()}`;

    // 1. Load manifest
    onProgress('Loading manifest...', 5);
    const manifestResp = await fetch(`${base}/manifest.json${cb}`);
    if (!manifestResp.ok) throw new Error('No manifest.json found. Run the admin tool first.');
    const manifest = await manifestResp.json();

    // 2. Load CT volume
    onProgress('Loading CT volume...', 15);
    const ctMetaResp = await fetch(`${base}/ct_meta.json${cb}`);
    const ctMeta = await ctMetaResp.json();

    const ctBinResp = await fetch(`${base}/ct_volume.bin.gz${cb}`);
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
        const sResp = await fetch(`${base}/plan_${p}/structures.json${cb}`);
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
        const dvhResp = await fetch(`${base}/plan_${p}/dvh.json${cb}`);
        dvhData[p] = await dvhResp.json();
      } catch (e) {
        dvhData[p] = {};
      }
    }

    // 6. Load clinical goals
    const clinicalGoals = {};
    for (const p of PLANS) {
      try {
        const gResp = await fetch(`${base}/plan_${p}/clinical_goals.json${cb}`);
        clinicalGoals[p] = await gResp.json();
      } catch (e) {
        clinicalGoals[p] = [];
      }
    }

    // 7. Load plan parameters (arcs, MU, delivery time, limiting axis)
    const planParams = {};
    for (const p of PLANS) {
      try {
        const ppResp = await fetch(`${base}/plan_${p}/plan_params.json${cb}`);
        planParams[p] = ppResp.ok ? await ppResp.json() : null;
      } catch (e) {
        planParams[p] = null;
      }
    }

    onProgress('Done!', 100);

    return { manifest, ctMeta, ctVolume, doseVols, doseMeta, structures, dvhData, clinicalGoals, planParams };
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

  async loadRankingStatus(site, reviewer) {
    if (!site || !reviewer) return {};
    try {
      const resp = await fetch(
        `/api/ranking-status?site=${encodeURIComponent(site)}&reviewer=${encodeURIComponent(reviewer)}`
      );
      if (!resp.ok) return {};
      return await resp.json();
    } catch (e) { return {}; }
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
  const { ctMeta, ctVolume, doseVols, doseMeta, structures, dvhData, clinicalGoals, manifest, planParams } = data;

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
  S.planParams = planParams || { A: null, B: null, C: null };
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

  // Prescription dose from manifest
  const rx = manifest.prescriptionDose;
  if (rx) {
    S.rxFractionDoseGy = rx.fractionDoseGy;
    S.rxNumFractions = rx.numFractions;
    S.rxTotalDoseGy = rx.totalDoseGy;
  } else {
    S.rxFractionDoseGy = null;
    S.rxNumFractions = null;
    S.rxTotalDoseGy = null;
  }

  // Resample dose grids onto CT grid for fast rendering
  resampleDoseToCtGrid();

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
          visible: false,
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
  // Reset Plan Focus to "All" for the newly loaded subject — covers both
  // the row layout (hidden max-btn state) and the top-bar segmented control.
  S.maximized = null;
  PLANS.forEach(p => {
    const row = document.getElementById(`row-${p}`);
    if (row) row.classList.remove('maximized', 'minimized');
  });
  document.querySelectorAll('#plan-focus button').forEach(b => {
    b.classList.toggle('active', b.dataset.plan === '');
  });
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
          this.renderAll();  // re-render all to maintain uniform scale
        });
        ro.observe(cv.parentElement);
        this.ros[key] = ro;
      });
    });
  },

  _rafId: null,

  // Compute a uniform pixels-per-mm scale that fits all visible orientations
  _uniformScale() {
    if (!S.ctVolume || S.viewMode !== 'all') return null; // only unify in 3x3 mode

    const ps = S.pixelSpacing, ss = S.sliceSpacing;
    const { nx, ny, nz } = S;
    let minFit = Infinity;

    ORIENTS.forEach(orient => {
      const cv = this.cvs[`A-${orient}`];
      if (!cv || cv.width < 4 || cv.height < 4) return;
      const W = cv.width, H = cv.height;

      let physW, physH;
      if (orient === 'axial')        { physW = nx * ps[1]; physH = ny * ps[0]; }
      else if (orient === 'coronal') { physW = nx * ps[1]; physH = nz * ss; }
      else                           { physW = ny * ps[0]; physH = nz * ss; }

      const fit = Math.min(W / physW, H / physH);
      if (fit < minFit) minFit = fit;
    });

    return isFinite(minFit) ? minFit : null;
  },

  renderAll() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      const uniformFit = this._uniformScale();
      PLANS.forEach(p => {
        const row = document.getElementById(`row-${p}`);
        if (row && row.classList.contains('minimized')) return;
        ORIENTS.forEach(o => this.draw(p, o, uniformFit));
      });
      DVH.render();
    });
  },

  draw(plan, orient, uniformFit) {
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

    // Dose bounds in Gy — convert from current display unit
    const refDose = S.rxTotalDoseGy || doseMax;
    const doseLo = S.doseMode === 'rel' ? (S.doseLo / 100) * refDose : S.doseLo;
    const doseHi = S.doseMode === 'rel' ? (S.doseHi / 100) * refDose : S.doseHi;
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

    // Blit to canvas with zoom/pan — use physical mm for consistent magnification
    const oc = new OffscreenCanvas(sliceW, sliceH);
    oc.getContext('2d').putImageData(imgData, 0, 0);

    // Physical dimensions of this slice in mm
    const ps = S.pixelSpacing;  // [row_spacing, col_spacing]
    const ss = S.sliceSpacing;
    let physW, physH;
    if (orient === 'axial')        { physW = sliceW * ps[1]; physH = sliceH * ps[0]; }
    else if (orient === 'coronal') { physW = sliceW * ps[1]; physH = sliceH * ss; }
    else                           { physW = sliceW * ps[0]; physH = sliceH * ss; }

    const vs = S.views[plan][orient];
    // Use uniform scale across orientations (in 3x3 mode) for consistent magnification
    // Apply 1.6x default boost so images fill more of the cells
    const baseFit = uniformFit || Math.min(W / physW, H / physH);
    const fitScale = baseFit * vs.zoom * 1.6;
    const drawW = physW * fitScale;
    const drawH = physH * fitScale;
    const ox = (W - drawW) / 2 + vs.panX;
    const oy = (H - drawH) / 2 + vs.panY;

    // Per-voxel scale factors (for overlays that work in voxel coords)
    const sxVox = drawW / sliceW;  // canvas pixels per voxel in x
    const syVox = drawH / sliceH;  // canvas pixels per voxel in y

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(oc, ox, oy, drawW, drawH);

    // Isodose lines
    if (S.doseVisible) {
      S.isodoseLines.forEach(iso => {
        if (iso.visible) {
          drawIsodose(ctx, plan, orient, si, iso.level, iso.color,
                      sliceW, sliceH, sxVox, syVox, ox, oy);
        }
      });
    }

    // Structure contours (all orientations)
    drawStructures(ctx, plan, orient, si, sxVox, syVox, ox, oy);

    // Crosshair
    drawCrosshair(ctx, plan, orient, sliceW, sliceH, sxVox, syVox, ox, oy, W, H);

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
function drawIsodose(ctx, plan, orient, si, level, color, sliceW, sliceH, sxVox, syVox, ox, oy) {
  const { nx, ny, nz } = S;
  const dose = S.doseVols[plan];
  if (!dose) return;
  // Isodose level: in rel mode it's % of RX, in abs mode it's fraction of max dose
  const refDose = S.rxTotalDoseGy || S.doseMaxGy;
  const threshold = S.doseMode === 'rel' ? level * refDose : level * S.doseMaxGy;

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

      const x0 = ox + x * sxVox, y0 = oy + y * syVox;
      const hx = sxVox / 2, hy = syVox / 2;
      const T = [x0+hx, y0     ], B = [x0+hx, y0+syVox];
      const L = [x0,    y0+hy  ], R = [x0+sxVox, y0+hy];

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
function drawStructures(ctx, plan, orient, si, sxVox, syVox, ox, oy) {
  const structs = S.structures[plan] || [];

  structs.forEach(st => {
    const listEntry = S.structureList.find(s => s.name === st.name);
    if (listEntry && !listEntry.visible) return;
    if (!st.visible) return;

    if (orient === 'axial') {
      st.contourSlices.forEach(cs => {
        if (cs.z === si) {
          drawPoly(ctx, cs.poly, st.color, sxVox, syVox, ox, oy);
        }
      });
    } else {
      drawStructureCrossSection(ctx, st, orient, si, sxVox, syVox, ox, oy);
    }
  });
}

function drawStructureCrossSection(ctx, struct, orient, si, sxVox, syVox, ox, oy) {
  // For each axial contour slice, find where polygon edges intersect
  // the cutting plane. Draw a short vertical tick at each crossing point.
  // This works correctly for any structure shape (convex, concave, multi-region).
  const { nz } = S;
  const TICK_H = syVox * 0.8;  // tick height = ~80% of one slice spacing

  ctx.strokeStyle = struct.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  struct.contourSlices.forEach(cs => {
    const poly = cs.poly;
    if (!poly || poly.length < 3) return;

    const crossings = [];

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];

      if (orient === 'coronal') {
        if ((a.y <= si && b.y > si) || (b.y <= si && a.y > si)) {
          const frac = (si - a.y) / (b.y - a.y);
          crossings.push(a.x + frac * (b.x - a.x));
        }
      } else {
        if ((a.x <= si && b.x > si) || (b.x <= si && a.x > si)) {
          const frac = (si - a.x) / (b.x - a.x);
          crossings.push(a.y + frac * (b.y - a.y));
        }
      }
    }

    if (crossings.length < 1) return;

    const screenY = oy + (nz - 1 - cs.z) * syVox;

    // Draw a vertical tick mark at each crossing point
    crossings.forEach(c => {
      const screenX = ox + c * sxVox;
      ctx.moveTo(screenX, screenY - TICK_H / 2);
      ctx.lineTo(screenX, screenY + TICK_H / 2);
    });
  });

  ctx.stroke();
}

function drawPoly(ctx, poly, color, sxVox, syVox, ox, oy) {
  if (!poly || poly.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  poly.forEach((pt, i) => {
    const sx = ox + pt.x * sxVox, sy = oy + pt.y * syVox;
    i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair
// ─────────────────────────────────────────────────────────────────────────────
function drawCrosshair(ctx, plan, orient, sliceW, sliceH, sxVox, syVox, ox, oy, W, H) {
  const { nz } = S;
  const sAx  = S.getSlice(plan, 'axial');
  const sCor = S.getSlice(plan, 'coronal');
  const sSag = S.getSlice(plan, 'sagittal');

  let cx, cy;
  if (orient === 'axial') {
    cx = ox + sSag * sxVox;
    cy = oy + sCor * syVox;
  } else if (orient === 'coronal') {
    cx = ox + sSag * sxVox;
    cy = oy + (nz - 1 - sAx) * syVox;
  } else {
    cx = ox + sCor * sxVox;
    cy = oy + (nz - 1 - sAx) * syVox;
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
  // Keep top-bar Plan Focus segmented control in sync, regardless of
  // whether this was triggered by the segmented control, the (hidden)
  // per-row max button, or a programmatic call.
  const targetVal = plan || '';
  document.querySelectorAll('#plan-focus button').forEach(b => {
    b.classList.toggle('active', b.dataset.plan === targetVal);
  });
  setTimeout(() => Renderer.renderAll(), 250);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction
// ─────────────────────────────────────────────────────────────────────────────
const Interaction = {
  drag: null,

  // Determine which crosshair line the mouse is near (if any).
  // Returns { targetOrient, axis } or null.
  _nearCrosshair(plan, orient, e, cv) {
    const { nx, ny, nz } = S;
    const W = cv.width, H = cv.height;
    const ps = S.pixelSpacing, ss = S.sliceSpacing;

    let sliceW, sliceH, physW, physH;
    if (orient === 'axial')        { sliceW = nx; sliceH = ny; physW = nx * ps[1]; physH = ny * ps[0]; }
    else if (orient === 'coronal') { sliceW = nx; sliceH = nz; physW = nx * ps[1]; physH = nz * ss; }
    else                           { sliceW = ny; sliceH = nz; physW = ny * ps[0]; physH = nz * ss; }

    const vs = S.views[plan][orient];
    const uniformFit = Renderer._uniformScale();
    const baseFit = uniformFit || Math.min(W / physW, H / physH);
    const fitScale = baseFit * vs.zoom * 1.6;  // must match the 1.6x boost in Renderer.draw
    const drawW = physW * fitScale;
    const drawH = physH * fitScale;
    const ox = (W - drawW) / 2 + vs.panX;
    const oy = (H - drawH) / 2 + vs.panY;
    const sxVox = drawW / sliceW;
    const syVox = drawH / sliceH;

    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const sAx  = S.getSlice(plan, 'axial');
    const sCor = S.getSlice(plan, 'coronal');
    const sSag = S.getSlice(plan, 'sagittal');

    let hx, hy;
    if (orient === 'axial') {
      hx = ox + sSag * sxVox;
      hy = oy + sCor * syVox;
    } else if (orient === 'coronal') {
      hx = ox + sSag * sxVox;
      hy = oy + (nz - 1 - sAx) * syVox;
    } else {
      hx = ox + sCor * sxVox;
      hy = oy + (nz - 1 - sAx) * syVox;
    }

    const GRAB_PX = 8;

    if (Math.abs(mx - hx) < GRAB_PX) {
      if (orient === 'axial') return { targetOrient: 'sagittal', axis: 'x', scale: sxVox, ox };
      if (orient === 'coronal') return { targetOrient: 'sagittal', axis: 'x', scale: sxVox, ox };
      if (orient === 'sagittal') return { targetOrient: 'coronal', axis: 'x', scale: sxVox, ox };
    }
    if (Math.abs(my - hy) < GRAB_PX) {
      if (orient === 'axial') return { targetOrient: 'coronal', axis: 'y', scale: syVox, oy };
      if (orient === 'coronal') return { targetOrient: 'axial', axis: 'y', scale: syVox, oy, invert: true };
      if (orient === 'sagittal') return { targetOrient: 'axial', axis: 'y', scale: syVox, oy, invert: true };
    }
    return null;
  },

  init() {
    PLANS.forEach(plan => {
      ORIENTS.forEach(orient => {
        const cv = document.getElementById(`cv-${plan}-${orient}`);

        // ── Mouse wheel: always scrolls slices ──
        cv.addEventListener('wheel', e => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -1 : 1;  // scroll up = cranial (higher slice)
          const cur = S.getSlice(plan, orient);
          S.setSlice(plan, orient, cur + delta);
          if (S.linked) Renderer.renderAll();
          else { ORIENTS.forEach(o => Renderer.draw(plan, o)); }
        }, { passive: false });

        // ── Mouse down ──
        cv.addEventListener('mousedown', e => {
          e.preventDefault();

          if (S.activeTool === 'scroll') {
            // Check if near a crosshair — if so, grab it
            const hit = this._nearCrosshair(plan, orient, e, cv);
            if (hit) {
              this.drag = {
                type: 'crosshair', plan, orient,
                targetOrient: hit.targetOrient,
                axis: hit.axis,
                scale: hit.scale,
                offset: hit.axis === 'x' ? hit.ox : hit.oy,
                invert: hit.invert || false,
                x0: e.clientX, y0: e.clientY,
              };
              cv.style.cursor = hit.axis === 'x' ? 'col-resize' : 'row-resize';
              return;
            }
          }

          if (S.activeTool === 'zoom') {
            this.drag = {
              type: 'zoom', plan, orient,
              y0: e.clientY,
              zoom0: S.views[plan][orient].zoom,
            };
            cv.style.cursor = 'ns-resize';
            return;
          }

          if (S.activeTool === 'pan') {
            this.drag = {
              type: 'pan', plan, orient,
              x0: e.clientX, y0: e.clientY,
              panX0: S.views[plan][orient].panX,
              panY0: S.views[plan][orient].panY,
            };
            cv.style.cursor = 'grabbing';
            return;
          }
        });

        // ── Mouse move ──
        cv.addEventListener('mousemove', e => {
          // Update cursor when not dragging
          if (!this.drag) {
            if (S.activeTool === 'scroll') {
              const hit = this._nearCrosshair(plan, orient, e, cv);
              cv.style.cursor = hit
                ? (hit.axis === 'x' ? 'col-resize' : 'row-resize')
                : 'crosshair';
            } else if (S.activeTool === 'zoom') {
              cv.style.cursor = 'ns-resize';
            } else if (S.activeTool === 'pan') {
              cv.style.cursor = 'grab';
            }
            return;
          }

          if (this.drag.plan !== plan || this.drag.orient !== orient) return;

          if (this.drag.type === 'crosshair') {
            // Drag crosshair to scroll the target orientation
            const { targetOrient, axis, scale, offset, invert } = this.drag;
            const rect = cv.getBoundingClientRect();
            const pos = axis === 'x'
              ? (e.clientX - rect.left - offset) / scale
              : (e.clientY - rect.top - offset) / scale;

            let sliceVal;
            if (invert) {
              // For axial from coronal/sagittal: y-axis is inverted (nz-1-slice)
              sliceVal = Math.round(S.nz - 1 - pos);
            } else {
              sliceVal = Math.round(pos);
            }

            S.setSlice(plan, targetOrient, sliceVal);
            if (S.linked) Renderer.renderAll();
            else { ORIENTS.forEach(o => Renderer.draw(plan, o)); }
          }

          else if (this.drag.type === 'zoom') {
            // Drag up = zoom in, drag down = zoom out
            const dy = this.drag.y0 - e.clientY; // positive = up = zoom in
            const factor = Math.exp(dy * 0.005); // smooth exponential zoom
            const newZoom = Math.max(0.3, Math.min(20, this.drag.zoom0 * factor));
            S.views[plan][orient].zoom = newZoom;
            if (S.linked) {
              PLANS.forEach(p => { S.views[p][orient].zoom = newZoom; });
            }
            Renderer.renderAll();
          }

          else if (this.drag.type === 'pan') {
            const dx = e.clientX - this.drag.x0;
            const dy = e.clientY - this.drag.y0;
            S.views[plan][orient].panX = this.drag.panX0 + dx;
            S.views[plan][orient].panY = this.drag.panY0 + dy;
            if (S.linked) {
              PLANS.forEach(p => {
                S.views[p][orient].panX = S.views[plan][orient].panX;
                S.views[p][orient].panY = S.views[plan][orient].panY;
              });
            }
            Renderer.renderAll();
          }
        });

        // ── Mouse up / leave ──
        const endDrag = () => {
          if (this.drag) {
            cv.style.cursor = S.activeTool === 'pan' ? 'grab'
              : S.activeTool === 'zoom' ? 'ns-resize' : 'crosshair';
          }
          this.drag = null;
        };
        cv.addEventListener('mouseup', endDrag);
        cv.addEventListener('mouseleave', endDrag);
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
  const refDose = S.rxTotalDoseGy || S.doseMaxGy;
  const isRel = S.doseMode === 'rel';

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
    inp.step = isRel ? '1' : '0.1';

    if (isRel) {
      // Display as % of RX
      inp.min = 1; inp.max = 150;
      inp.value = Math.round(iso.level * 100);
      inp.addEventListener('change', e => {
        iso.level = Math.max(0.01, Math.min(1.5, +e.target.value / 100));
        Renderer.renderAll();
      });
    } else {
      // Display as Gy
      const isoGy = iso.level * refDose;
      inp.min = 0; inp.max = Math.ceil(S.doseMaxGy);
      inp.value = isoGy.toFixed(1);
      inp.addEventListener('change', e => {
        // Convert Gy back to fraction of refDose
        iso.level = Math.max(0.001, +e.target.value / refDose);
        Renderer.renderAll();
      });
    }

    tdL.appendChild(inp);
    const unitSpan = document.createElement('span');
    unitSpan.textContent = isRel ? '%' : 'Gy';
    unitSpan.style.cssText = 'color:#555;font-size:10px;margin-left:2px';
    tdL.appendChild(unitSpan);

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
// ─────────────────────────────────────────────────────────────────────────────
// Clinical Context Panel
// ─────────────────────────────────────────────────────────────────────────────
// Returns the raw clinical-context text for the current subject (may be empty).
function contextText() {
  return S.manifest?.clinicalContext || '';
}

function renderClinicalContext() {
  const content = document.getElementById('context-content');
  const text = contextText();
  if (text.trim()) {
    content.textContent = text;
  } else {
    content.innerHTML = '<p style="color:var(--text-dim)">No clinical context provided for this subject.</p>';
  }
  // Keep popup window in sync if currently open
  if (typeof PopOut !== 'undefined') PopOut.refresh('context');
}

// Shown after reviewer selects their name but before a subject is loaded
function showEmptyWorkspace() {
  // Don't show the main body until a subject is actually loaded —
  // keep the welcome screen hidden and let the top-bar prompts guide the user.
  // The case-label will show "No subject loaded" until they load one.
  const caseLabel = document.getElementById('case-label');
  if (caseLabel && !S.currentSubject) caseLabel.textContent = 'No subject loaded — select site and subject above';
}


// Build the goals-table HTML (or an empty-state message). Used both by the
// in-app panel and the pop-out window so the two stay structurally identical.
function goalsHtml() {
  const hasGoals = PLANS.some(p => S.clinicalGoals[p] && S.clinicalGoals[p].length > 0);
  if (!hasGoals) {
    return '<p style="color:var(--text-dim);font-size:12px">No clinical goal data available for this subject.</p>';
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

  const allGoals = S.clinicalGoals.A || [];
  const priorities = [...new Set(allGoals.map(g => g.priority))].sort((a, b) => a - b);

  priorities.forEach(pri => {
    const priLabel = pri === 99 ? 'Reporting Only' : `Priority ${pri}`;
    html += `<tr class="priority-hdr"><td colspan="6">${priLabel}</td></tr>`;

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
  return html;
}

function renderClinicalGoals() {
  document.getElementById('goals-content').innerHTML = goalsHtml();
  // Keep popup window in sync if currently open
  if (typeof PopOut !== 'undefined') PopOut.refresh('goals');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pop-out windows for Clinical Goals + Clinical Context
// ─────────────────────────────────────────────────────────────────────────────
// Opens a separate browser window (about:blank, same-origin) the user can
// drag to a second monitor. The opener writes HTML directly into the popup's
// document and re-pushes content whenever the underlying data changes.
// Polling-based close detection (beforeunload is not reliable from opener).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const PopOut = {
  windows: { goals: null, context: null },
  pollers: { goals: null, context: null },

  // Stylesheet injected into each popup. Mirrors the CSS classes used by
  // the goals table + context text in the main viewer so the popup looks
  // visually consistent with the in-app panel.
  POPUP_CSS: `
    :root {
      --bg: #111; --panel: #1e1e1e; --panel2: #242424; --border: #333;
      --accent: #4a9eff; --text: #e0e0e0; --text-dim: #777;
      --green: #44cc77; --red: #ff5544; --yellow: #ffcc44;
      --row-A: #4a9eff; --row-B: #ff9944; --row-C: #88ee66;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text);
      font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px;
      padding: 18px 22px; line-height: 1.5; }
    h2 { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
    .subhdr { color: var(--text-dim); font-size: 12px; margin-bottom: 18px;
      padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .goals-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
    .goals-tbl th { background: #2a2a2a; padding: 8px; text-align: left;
      font-weight: 600; position: sticky; top: 0; z-index: 2; }
    .goals-tbl td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
    .goals-tbl .priority-hdr { background: #1a2a3a; font-weight: 700;
      font-size: 13px; color: var(--accent); }
    .g-pass { color: var(--green); font-weight: 600; }
    .g-marginal { color: var(--yellow); font-weight: 600; }
    .g-fail { color: var(--red); font-weight: 600; }
    .ctx-text { white-space: pre-wrap; line-height: 1.65; font-size: 14px; }
    .empty { color: var(--text-dim); font-style: italic; }
    .stale-banner { background: #3a2a1a; border: 1px solid var(--yellow);
      color: var(--yellow); padding: 8px 12px; border-radius: 4px;
      font-size: 12px; margin-bottom: 14px; }
  `,

  open(kind) {
    // If already open, just focus it
    const existing = this.windows[kind];
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }

    const titles = { goals: 'Clinical Goals', context: 'Clinical Context' };
    const sizes  = { goals: 'width=860,height=720', context: 'width=560,height=720' };
    const w = window.open('', `rtv_${kind}_popup`, sizes[kind] + ',resizable=yes,scrollbars=yes');
    if (!w) {
      alert('Pop-out window was blocked by your browser. Please allow pop-ups for this site and try again.');
      return;
    }

    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">` +
      `<title>${titles[kind]} — RT Plan Viewer</title>` +
      `<style>${this.POPUP_CSS}</style></head>` +
      `<body><h2>${titles[kind]}</h2>` +
      `<div class="subhdr" id="subj-hdr">—</div>` +
      `<div id="popout-body"></div>` +
      `</body></html>`);
    w.document.close();

    this.windows[kind] = w;
    this._refreshButton(kind);
    this.refresh(kind);

    // Close in-app panel since the popup now owns this content
    if (kind === 'goals') {
      document.getElementById('goals-panel').classList.remove('open');
    } else {
      document.getElementById('context-panel').style.right = '-420px';
    }

    // Poll for popup-closed state. window.closed flips true when the user
    // closes the popup, even if they bypass beforeunload (e.g. via the
    // close button). 500 ms is fast enough that the dock-back UI feels
    // responsive without burning cycles.
    if (this.pollers[kind]) clearInterval(this.pollers[kind]);
    this.pollers[kind] = setInterval(() => {
      const ww = this.windows[kind];
      if (!ww || ww.closed) {
        clearInterval(this.pollers[kind]);
        this.pollers[kind] = null;
        this.windows[kind] = null;
        this._refreshButton(kind);
      }
    }, 500);
  },

  // Push the latest content into the popup's DOM. Safe to call even if
  // popup is closed (no-op).
  refresh(kind) {
    const w = this.windows[kind];
    if (!w || w.closed) return;
    const subjHdr = w.document.getElementById('subj-hdr');
    const body    = w.document.getElementById('popout-body');
    if (!body) return;

    if (subjHdr) {
      subjHdr.textContent = S.currentSubject
        ? `Subject: ${S.currentSubject}` + (S.currentSite ? `   (${S.currentSite})` : '')
        : 'No subject loaded — return to the main window to select one.';
    }

    if (kind === 'goals') {
      body.innerHTML = goalsHtml();
    } else {
      const text = contextText();
      if (text.trim()) {
        body.innerHTML = `<div class="ctx-text">${escapeHtml(text)}</div>`;
      } else {
        body.innerHTML = '<p class="empty">No clinical context provided for this subject.</p>';
      }
    }
  },

  // Close popup if open, otherwise open it. Wired to the panel header
  // pop-out / dock-back button.
  toggle(kind) {
    const w = this.windows[kind];
    if (w && !w.closed) {
      w.close();
      this.windows[kind] = null;
      if (this.pollers[kind]) {
        clearInterval(this.pollers[kind]);
        this.pollers[kind] = null;
      }
      this._refreshButton(kind);
    } else {
      this.open(kind);
    }
  },

  isOpen(kind) {
    return !!(this.windows[kind] && !this.windows[kind].closed);
  },

  _refreshButton(kind) {
    const btn = document.getElementById(`${kind}-popout-btn`);
    if (!btn) return;
    if (this.isOpen(kind)) {
      btn.innerHTML = '↙ Dock back';
      btn.classList.add('docked');
      btn.title = 'Close pop-out window and return content to side panel';
    } else {
      btn.innerHTML = '↗ Pop out';
      btn.classList.remove('docked');
      btn.title = 'Open in separate window';
    }
  },
};

// Best-effort cleanup: close any popup windows when the main viewer is
// being torn down. The browser will also close them automatically when
// their opener navigates away, but doing it explicitly avoids orphan
// windows in some browser/popup-blocker combinations.
window.addEventListener('beforeunload', () => {
  ['goals', 'context'].forEach(k => {
    const w = PopOut.windows[k];
    if (w && !w.closed) { try { w.close(); } catch (_) {} }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subject Dropdown — status indicators
// ─────────────────────────────────────────────────────────────────────────────

// Returns CSS class suffix for a subject's current ranking status
function getStatusClass(subjectName) {
  const st = S.rankingStatus[subjectName];
  if (!st) return 'none';
  if (st.phase1 && st.phase2) return 'both';
  if (st.phase1) return 'phase1';
  return 'none';
}

// Rebuild the full subject list inside the dropdown
function renderSubjectDropdown() {
  const items = document.getElementById('subj-items');
  if (!items) return;
  items.innerHTML = '';

  S.currentSubjects.forEach(subj => {
    const item = document.createElement('div');
    item.className = 'subj-item' +
      (subj.name === S.currentSubject ? ' selected' : '') +
      (subj.status !== 'processed' ? ' subj-disabled' : '');
    item.dataset.name = subj.name;

    const dot = document.createElement('span');
    dot.className = `sdot sdot-${getStatusClass(subj.name)}`;
    dot.id = `sdot-${CSS.escape(subj.name)}`;

    const label = document.createElement('span');
    label.textContent = subj.name + (subj.status !== 'processed' ? ' (not processed)' : '');
    label.style.flex = '1';

    item.append(dot, label);

    if (subj.status === 'processed') {
      item.addEventListener('click', () => subjectDropdownSelect(subj.name));
    }
    items.appendChild(item);
  });
}

// Update just the status dot for one subject (after a submission)
function updateSubjectStatus(subjectName) {
  const cls = `sdot sdot-${getStatusClass(subjectName)}`;
  // Dot inside the list
  try {
    const dot = document.getElementById(`sdot-${CSS.escape(subjectName)}`);
    if (dot) dot.className = cls;
  } catch (e) { /* CSS.escape not available in very old browsers */ }
  // Dot on the trigger button (if this is the loaded subject)
  if (subjectName === S.currentSubject) {
    const triggerDot = document.getElementById('subj-trigger-dot');
    if (triggerDot) triggerDot.className = cls;
    // Keep the rank-carrot text in sync with the new status
    if (typeof RankWorkspace !== 'undefined') RankWorkspace._refreshCarrot();
  }
}

// Called when user clicks a subject in the dropdown list
let _pendingSubject = null;
function subjectDropdownSelect(name) {
  _pendingSubject = name;
  document.getElementById('subj-trigger-text').textContent = name;
  document.getElementById('subj-trigger-dot').className = `sdot sdot-${getStatusClass(name)}`;
  // Highlight selected item
  document.querySelectorAll('.subj-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.name === name);
  });
  closeSubjectDropdown();
  document.getElementById('load-btn').disabled = false;
}

function closeSubjectDropdown() {
  document.getElementById('subj-list').classList.add('hidden');
  document.getElementById('subj-trigger').classList.remove('open');
}

// Module-level reference so reviewer-change handler can call it
let _refreshSubjectsAndStatus = null;

// ─────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Ranking Workspace — carrot-expanded overlay that drives both phases
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the always-visible rank bar + post-submit modal with a unified
// overlay that:
//   Phase 1: rank + Likert (plan quality) per plan, no plan details visible
//   Phase 2: same form, with plan-detail table revealed at top, pre-populated
// Ranking-status carrot (always visible at bottom of viewport) shows
// progress and is the entry point.
const RankWorkspace = {
  // _phase1Data is non-null when phase 1 has been submitted in the current
  // session and we're either showing or about to show phase 2.
  _phase1Data: null,

  // Open the workspace overlay. Reopens at the appropriate phase view.
  open() {
    // If reviewer dismissed the workspace mid-phase-2, restore phase 2 view
    // (form values are still in place; phase1Data is preserved).
    if (this._phase1Data) {
      // Already in phase 2 view from earlier transition; just show.
    } else {
      this._toPhase1View();
    }
    document.getElementById('rank-overlay').classList.remove('hidden');
  },

  // Hide overlay (does not discard saved phase 1 or in-progress phase 2 form).
  close() {
    document.getElementById('rank-overlay').classList.add('hidden');
  },

  // Called on subject load — clear form, return to phase 1 view, refresh carrot.
  reset() {
    this.close();
    this._phase1Data = null;
    PLANS.forEach(p => {
      document.getElementById(`rank-${p}`).value = '';
      document.getElementById(`likert-${p}`).value = '';
    });
    document.getElementById('rank-notes').value = '';
    document.getElementById('tie-confirm').checked = false;
    document.getElementById('tie-confirm-wrap').style.display = 'none';
    document.getElementById('rank-status').textContent = '';
    this._toPhase1View();
    this._refreshCarrot();
  },

  _toPhase1View() {
    document.getElementById('rank-panel').classList.remove('phase2');
    document.getElementById('rank-panel-title').textContent = 'Phase 1 — Rank plans by dose';
    document.getElementById('rank-panel-subtitle').textContent =
      'Provide your ranking and plan-quality score for each plan, based on the dose distributions shown.';
    document.getElementById('rank-form-section-label').textContent = 'Your assessment';
    document.getElementById('rank-details-pane').classList.add('hidden');
    document.getElementById('submit-btn').textContent = 'Submit Phase 1';
    document.getElementById('rank-skip-btn').classList.add('hidden');
    // Disabled until validateRanking() re-checks once user changes a field
    document.getElementById('submit-btn').disabled = true;
  },

  // Phase 1 → Phase 2 transition (called from initRanking after phase 1 save).
  transitionToPhase2(resultBase, phase1Rankings, phase1Likert) {
    this._phase1Data = { rankings: phase1Rankings, likert: phase1Likert, resultBase };

    // Render plan-detail table at the top of the panel
    document.getElementById('rank-details-content').innerHTML =
      this._planDetailsTableHtml(phase1Rankings);
    document.getElementById('rank-details-pane').classList.remove('hidden');

    // Style + copy
    document.getElementById('rank-panel').classList.add('phase2');
    document.getElementById('rank-panel-title').textContent = 'Phase 2 — Final ranking with plan details';
    document.getElementById('rank-panel-subtitle').textContent =
      'You may now revise your ranking and plan-quality scores based on the delivery parameters shown above.';
    document.getElementById('rank-form-section-label').textContent = 'Revised assessment';

    // Pre-populate form with phase 1 values
    PLANS.forEach(p => {
      document.getElementById(`rank-${p}`).value = phase1Rankings[p] || '';
      document.getElementById(`likert-${p}`).value = phase1Likert[p] || '';
    });
    document.getElementById('rank-notes').value = '';
    document.getElementById('tie-confirm').checked = false;
    document.getElementById('tie-confirm-wrap').style.display = 'none';

    // Phase 2 buttons
    document.getElementById('submit-btn').textContent = 'Submit Phase 2';
    document.getElementById('submit-btn').disabled = false;
    document.getElementById('rank-skip-btn').classList.remove('hidden');
    document.getElementById('rank-status').textContent =
      'Phase 1 saved. Confirm or revise below, then submit Phase 2.';
    document.getElementById('rank-status').style.color = 'var(--accent)';

    // Scroll to top so the user sees the plan details first
    document.getElementById('rank-panel-body').scrollTop = 0;

    this._refreshCarrot();
  },

  // After phase 2 submitted (or skipped) — collapse and update carrot.
  markComplete() {
    this._phase1Data = null;
    this.close();
    this._refreshCarrot();
  },

  // Returns true if the user is mid-phase-2 (phase 1 saved, phase 2 not).
  isInPhase2() { return this._phase1Data !== null; },

  // Update the always-visible carrot text/style based on rankingStatus cache.
  _refreshCarrot() {
    const carrot = document.getElementById('rank-carrot');
    const text   = document.getElementById('rank-carrot-text');
    const status = document.getElementById('rank-carrot-status');
    const subj = S.currentSubject;
    const st = subj ? (S.rankingStatus[subj] || {}) : {};

    if (st.phase1 && st.phase2) {
      carrot.classList.add('complete');
      text.innerHTML = '&#x2714; Ranking submitted (both phases) &mdash; click to amend';
      status.textContent = '';
    } else if (st.phase1 || this._phase1Data) {
      carrot.classList.remove('complete');
      text.innerHTML = '&#x25B2; Continue to Phase 2 &mdash; final ranking with plan details';
      status.textContent = 'Phase 1 saved';
    } else {
      carrot.classList.remove('complete');
      text.innerHTML = '&#x25B2; Submit ranking &amp; plan-quality scores';
      status.textContent = '';
    }
  },

  // Build the plan-detail table HTML that appears at top of phase 2 view.
  // Number-of-arcs intentionally omitted (institutional bias control).
  _planDetailsTableHtml(phase1Rankings) {
    const pp = S.planParams || {};
    const fmtTime = (s) => {
      if (s == null) return '—';
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return `${m}:${String(sec).padStart(2, '0')} (${(s/60).toFixed(1)} min)`;
    };
    const fmtLimit = (p) => {
      if (!p || !p.limitingBreakdown) return '—';
      const lb = p.limitingBreakdown;
      const parts = [];
      if (lb.mu_pct > 1)     parts.push(`MU ${lb.mu_pct.toFixed(0)}%`);
      if (lb.gantry_pct > 1) parts.push(`Gantry ${lb.gantry_pct.toFixed(0)}%`);
      if (lb.mlc_pct > 1)    parts.push(`MLC ${lb.mlc_pct.toFixed(0)}%`);
      return parts.join(' / ');
    };

    let html = '<table><thead><tr>';
    html += '<th>Parameter</th>';
    html += '<th style="color:var(--row-A);text-align:center">Plan A</th>';
    html += '<th style="color:var(--row-B);text-align:center">Plan B</th>';
    html += '<th style="color:var(--row-C);text-align:center">Plan C</th>';
    html += '</tr></thead><tbody>';

    const rows = [
      ['Your initial ranking',   p => phase1Rankings[p] ? `${phase1Rankings[p]}${ordinal(phase1Rankings[p])}` : '—'],
      ['Total MU',               p => pp[p] ? Math.round(pp[p].totalMU).toLocaleString() : '—'],
      ['Est. delivery time',     p => pp[p] ? fmtTime(pp[p].deliveryTimeS) : '—'],
      ['Speed-limiting factor',  p => pp[p] ? fmtLimit(pp[p]) : '—'],
    ];
    rows.forEach(([label, fn]) => {
      html += `<tr><td>${label}</td>`;
      PLANS.forEach(p => { html += `<td>${fn(p)}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  },
};

function initRanking() {
  const rankSels   = PLANS.map(p => document.getElementById(`rank-${p}`));
  const likertSels = PLANS.map(p => document.getElementById(`likert-${p}`));
  const btn        = document.getElementById('submit-btn');
  const skipBtn    = document.getElementById('rank-skip-btn');
  const stat       = document.getElementById('rank-status');
  const tieWrap    = document.getElementById('tie-confirm-wrap');
  const tieCheck   = document.getElementById('tie-confirm');

  // Carrot click → open the workspace
  document.getElementById('rank-carrot').addEventListener('click', () => RankWorkspace.open());
  // Close button or backdrop click → hide overlay (without discarding state)
  document.getElementById('rank-panel-close').addEventListener('click', () => RankWorkspace.close());
  document.getElementById('rank-overlay-backdrop').addEventListener('click', () => RankWorkspace.close());

  function validateRanking() {
    const reviewer = document.getElementById('reviewer-select').value;
    const rankVals   = rankSels.map(s => s.value).filter(v => v);
    const likertVals = likertSels.map(s => s.value).filter(v => v);
    const allRanked  = rankVals.length === 3;
    const allRated   = likertVals.length === 3;
    const hasFirst   = rankVals.includes('1');
    const hasTies    = allRanked && new Set(rankVals).size < 3;
    const tieConfirmed = tieCheck.checked;

    tieWrap.style.display = hasTies ? '' : 'none';
    if (!hasTies) tieCheck.checked = false;

    let ready = false;
    if (!reviewer) {
      stat.textContent = 'Select a reviewer first.';
      stat.style.color = 'var(--yellow)';
    } else if (!allRanked) {
      stat.textContent = 'Provide a rank (1st/2nd/3rd) for all three plans.';
      stat.style.color = 'var(--text-dim)';
    } else if (!allRated) {
      stat.textContent = 'Provide a plan-quality score for all three plans.';
      stat.style.color = 'var(--text-dim)';
    } else if (!hasFirst) {
      stat.textContent = 'At least one plan must be ranked 1st.';
      stat.style.color = 'var(--red)';
    } else if (hasTies && !tieConfirmed) {
      stat.textContent = 'Tied rankings — check the box below to confirm.';
      stat.style.color = 'var(--yellow)';
    } else {
      stat.textContent = 'Ready to submit.';
      stat.style.color = 'var(--green)';
      ready = true;
    }
    btn.disabled = !ready;
  }

  rankSels.forEach(s => s.addEventListener('change', validateRanking));
  likertSels.forEach(s => s.addEventListener('change', validateRanking));
  tieCheck.addEventListener('change', validateRanking);
  document.getElementById('reviewer-select').addEventListener('change', validateRanking);

  // Submit button — branches based on whether we're in phase 1 or phase 2.
  btn.addEventListener('click', async () => {
    const reviewer = document.getElementById('reviewer-select').value;
    if (!reviewer || !S.currentSite || !S.currentSubject) return;

    if (RankWorkspace.isInPhase2()) {
      // ── Phase 2 submission ──
      await submitPhase2(reviewer);
    } else {
      // ── Phase 1 submission ──
      await submitPhase1(reviewer);
    }
  });

  // Skip phase 2 — preserves phase 1 only, marks phase 2 as skipped.
  skipBtn.addEventListener('click', async () => {
    const data = RankWorkspace._phase1Data;
    if (!data) { RankWorkspace.close(); return; }
    stat.textContent = 'Saving (no revision)…';
    stat.style.color = 'var(--text-dim)';
    try {
      await DataLoader.saveRanking({
        ...data.resultBase,
        phase2_skipped: true,
        timestamp_phase2: new Date().toISOString(),
      });
      S.rankingStatus[S.currentSubject] = { phase1: true, phase2: true };
      updateSubjectStatus(S.currentSubject);
      RankWorkspace.markComplete();
    } catch (e) {
      stat.textContent = 'Save failed — see console.';
      stat.style.color = 'var(--red)';
      console.error(e);
    }
  });

  async function submitPhase1(reviewer) {
    // Existing-ranking overwrite check (preserved from previous flow)
    const existing = await DataLoader.checkExistingRanking(S.currentSite, S.currentSubject, reviewer);
    if (existing) {
      document.getElementById('overwrite-msg').textContent =
        `${reviewer} already submitted a ranking for this subject on ${new Date(existing.timestamp).toLocaleString()}. Overwrite?`;
      document.getElementById('overwrite-modal').classList.remove('hidden');
      const confirmed = await new Promise(resolve => {
        document.getElementById('overwrite-confirm').onclick = () => resolve(true);
        document.getElementById('overwrite-cancel').onclick  = () => resolve(false);
      });
      document.getElementById('overwrite-modal').classList.add('hidden');
      if (!confirmed) return;
    }

    const notes  = document.getElementById('rank-notes').value.trim();
    const phase1Rankings = Object.fromEntries(PLANS.map((p, i) => [p, rankSels[i].value]));
    const phase1Likert   = Object.fromEntries(PLANS.map((p, i) => [p, likertSels[i].value]));
    const tied1 = new Set(rankSels.map(s => s.value)).size < 3;

    const result = {
      site: S.currentSite,
      subject: S.currentSubject,
      reviewer,
      rankings_phase1: phase1Rankings,
      likert_phase1:   phase1Likert,
      tied_phase1: tied1,
      notes_phase1: notes || null,
      // Phase 2 fields filled in by phase 2 submit / skip
      rankings_phase2: null,
      likert_phase2:   null,
      tied_phase2: null,
      notes_phase2: null,
      phase2_changed: false,
      timestamp: new Date().toISOString(),
    };

    try {
      await DataLoader.saveRanking(result);
      S.rankingStatus[S.currentSubject] = {
        ...(S.rankingStatus[S.currentSubject] || {}),
        phase1: true,
      };
      updateSubjectStatus(S.currentSubject);
    } catch (e) {
      // Server unreachable — fall back to client download so reviewer's data
      // is not lost. They can email this file to the study coordinator.
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `ranking_${S.currentSite}_${S.currentSubject}_${reviewer}_${Date.now()}.json`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // Transition to phase 2 in the open workspace
    RankWorkspace.transitionToPhase2(result, phase1Rankings, phase1Likert);
  }

  async function submitPhase2(reviewer) {
    const data = RankWorkspace._phase1Data;
    if (!data) return;

    const phase2Rankings = Object.fromEntries(PLANS.map((p, i) => [p, rankSels[i].value]));
    const phase2Likert   = Object.fromEntries(PLANS.map((p, i) => [p, likertSels[i].value]));
    const tied2 = new Set(rankSels.map(s => s.value)).size < 3;
    const notes2 = document.getElementById('rank-notes').value.trim();

    const changed =
      PLANS.some(p => data.rankings[p] !== phase2Rankings[p]) ||
      PLANS.some(p => data.likert[p]   !== phase2Likert[p]);

    const finalResult = {
      ...data.resultBase,
      rankings_phase2: phase2Rankings,
      likert_phase2:   phase2Likert,
      tied_phase2: tied2,
      notes_phase2: notes2 || null,
      phase2_changed: changed,
      timestamp_phase2: new Date().toISOString(),
    };

    try {
      await DataLoader.saveRanking(finalResult);
      S.rankingStatus[S.currentSubject] = { phase1: true, phase2: true };
      updateSubjectStatus(S.currentSubject);
      RankWorkspace.markComplete();
    } catch (e) {
      stat.textContent = 'Save failed — see console.';
      stat.style.color = 'var(--red)';
      console.error(e);
    }
  }
}


// Old modal-based phase 2 dialog (openRerankDialog) was removed — phase 2 is
// now handled in-place by RankWorkspace.transitionToPhase2(). The
// #rerank-modal HTML element is still present in index.html but no longer
// referenced; safe to remove in a future cleanup pass.

function ordinal(n) {
  const s = String(n);
  return s === '1' ? 'st' : s === '2' ? 'nd' : s === '3' ? 'rd' : 'th';
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

  // Dose opacity
  document.getElementById('dop').addEventListener('input', e => {
    S.doseOpacity = e.target.value / 100;
    document.getElementById('dop-val').textContent = e.target.value;
    Renderer.renderAll();
  });

  // Dose mode toggle (abs/rel)
  const doseModeRel = document.getElementById('dose-mode-rel');
  const doseModeAbs = document.getElementById('dose-mode-abs');

  function setDoseMode(mode) {
    S.doseMode = mode;
    doseModeRel.classList.toggle('active', mode === 'rel');
    doseModeAbs.classList.toggle('active', mode === 'abs');

    const unit = mode === 'rel' ? '%' : ' Gy';
    document.getElementById('dose-lo-unit').textContent = unit;
    document.getElementById('dose-hi-unit').textContent = unit;
    document.getElementById('iso-unit-label').textContent = mode === 'rel' ? '(% of RX)' : '(Gy)';

    const refDose = S.rxTotalDoseGy || S.doseMaxGy;

    if (mode === 'rel') {
      // Convert current Gy values to % of RX
      const loSlider = document.getElementById('dose-lo');
      const hiSlider = document.getElementById('dose-hi');
      loSlider.max = 150;
      hiSlider.max = 150;
      S.doseLo = 5;
      S.doseHi = 100;
    } else {
      // Set to Gy values
      const loSlider = document.getElementById('dose-lo');
      const hiSlider = document.getElementById('dose-hi');
      const maxGy = Math.ceil(S.doseMaxGy);
      loSlider.max = maxGy;
      hiSlider.max = maxGy;
      S.doseLo = +(refDose * 0.05).toFixed(1);
      S.doseHi = +refDose.toFixed(1);
    }

    // Sync UI
    syncDoseBoundsUI();
    renderIsodoseUI();
    Renderer.renderAll();
  }

  function syncDoseBoundsUI() {
    const loSlider = document.getElementById('dose-lo');
    const loNum = document.getElementById('dose-lo-num');
    const hiSlider = document.getElementById('dose-hi');
    const hiNum = document.getElementById('dose-hi-num');
    loSlider.value = S.doseLo;
    loNum.value = S.doseLo;
    hiSlider.value = S.doseHi;
    hiNum.value = S.doseHi;
    document.getElementById('dose-lo-val').textContent = S.doseLo;
    document.getElementById('dose-hi-val').textContent = S.doseHi;
  }

  doseModeRel.addEventListener('click', () => setDoseMode('rel'));
  doseModeAbs.addEventListener('click', () => setDoseMode('abs'));

  // Dose lower bound — sync slider and number input
  const doseLoEl = document.getElementById('dose-lo');
  const doseLoNum = document.getElementById('dose-lo-num');
  doseLoEl.addEventListener('input', e => {
    S.doseLo = +e.target.value;
    doseLoNum.value = e.target.value;
    document.getElementById('dose-lo-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  doseLoNum.addEventListener('change', e => {
    S.doseLo = +e.target.value;
    doseLoEl.value = e.target.value;
    document.getElementById('dose-lo-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  // Dose upper bound
  const doseHiEl = document.getElementById('dose-hi');
  const doseHiNum = document.getElementById('dose-hi-num');
  doseHiEl.addEventListener('input', e => {
    S.doseHi = +e.target.value;
    doseHiNum.value = e.target.value;
    document.getElementById('dose-hi-val').textContent = e.target.value;
    Renderer.renderAll();
  });
  doseHiNum.addEventListener('change', e => {
    S.doseHi = +e.target.value;
    doseHiEl.value = e.target.value;
    document.getElementById('dose-hi-val').textContent = e.target.value;
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

  // View mode (orientation filter — sidebar dropdown)
  document.getElementById('view-mode').addEventListener('change', e => {
    S.viewMode = e.target.value;
    applyViewMode();
    setTimeout(() => Renderer.renderAll(), 100);
  });

  // Plan Focus (top bar segmented control) — orthogonal to orientation filter.
  // Drives the same setMaximized() function used by the (now hidden) per-row
  // max buttons, so existing maximize logic continues to work unchanged.
  document.querySelectorAll('#plan-focus button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#plan-focus button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const plan = btn.dataset.plan || null;  // '' → null = show all
      setMaximized(plan);
    });
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

  // Clinical goals panel — top-bar button opens the in-app slide-out, OR
  // focuses the pop-out window if one is currently open.
  document.getElementById('goals-btn').addEventListener('click', () => {
    if (PopOut.isOpen('goals')) {
      PopOut.windows.goals.focus();
      return;
    }
    document.getElementById('goals-panel').classList.toggle('open');
  });
  document.getElementById('goals-close-btn').addEventListener('click', () => {
    document.getElementById('goals-panel').classList.remove('open');
  });
  document.getElementById('goals-popout-btn').addEventListener('click', () => {
    PopOut.toggle('goals');
  });

  // Clinical context panel — same dual behavior as goals.
  const ctxPanel = document.getElementById('context-panel');
  function toggleContext() {
    if (ctxPanel.style.right === '0px') ctxPanel.style.right = '-420px';
    else ctxPanel.style.right = '0px';
  }
  document.getElementById('context-btn').addEventListener('click', () => {
    if (PopOut.isOpen('context')) {
      PopOut.windows.context.focus();
      return;
    }
    toggleContext();
  });
  document.getElementById('context-close-btn').addEventListener('click', () => {
    ctxPanel.style.right = '-420px';
  });
  document.getElementById('context-popout-btn').addEventListener('click', () => {
    PopOut.toggle('context');
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

  // Load reviewers from reviewers.json and populate BOTH the gate and the hidden top-bar select
  try {
    const revResp = await fetch(`/reviewers.json?_=${Date.now()}`);
    if (revResp.ok) {
      const reviewers = await revResp.json();
      reviewers.sort((a, b) => {
        const lastA = a.trim().split(/\s+/).pop().toLowerCase();
        const lastB = b.trim().split(/\s+/).pop().toLowerCase();
        return lastA.localeCompare(lastB);
      });
      const revSel = document.getElementById('reviewer-select');
      const revGate = document.getElementById('reviewer-gate');
      reviewers.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        revSel.appendChild(opt);

        const optG = document.createElement('option');
        optG.value = name;
        optG.textContent = name;
        revGate.appendChild(optG);
      });
    }
  } catch (e) { console.warn('Could not load reviewers.json:', e); }

  // Reviewer gate — user must select name before accessing the viewer
  const revGate = document.getElementById('reviewer-gate');
  const continueBtn = document.getElementById('reviewer-continue-btn');
  const switchBtn = document.getElementById('reviewer-switch-btn');
  const reviewerLocked = document.getElementById('reviewer-locked');

  function setReviewer(name) {
    document.getElementById('reviewer-select').value = name;
    reviewerLocked.textContent = name || '—';
    // Trigger change event so ranking validation re-runs
    document.getElementById('reviewer-select').dispatchEvent(new Event('change'));
    // If a site is already selected, refresh subject status for the new reviewer
    const currentSite = siteSel.value;
    if (currentSite && _refreshSubjectsAndStatus) {
      _refreshSubjectsAndStatus(currentSite);
    }
  }

  revGate.addEventListener('change', () => {
    continueBtn.disabled = !revGate.value;
  });

  continueBtn.addEventListener('click', () => {
    const name = revGate.value;
    if (!name) return;
    setReviewer(name);
    document.getElementById('welcome-screen').classList.add('hidden');
    // Show a placeholder body area until a subject is loaded
    showEmptyWorkspace();
  });

  switchBtn.addEventListener('click', () => {
    // Return to the gate
    document.getElementById('welcome-screen').classList.remove('hidden');
    document.getElementById('body').style.display = 'none';
    revGate.value = '';
    continueBtn.disabled = true;
    setReviewer('');
    // Reset current subject state so nothing is "in progress"
    S.currentSite = '';
    S.currentSubject = '';
  });

  // ── Custom subject dropdown toggle ──────────────────────────────────────
  const subjTrigger = document.getElementById('subj-trigger');
  const subjList    = document.getElementById('subj-list');

  subjTrigger.addEventListener('click', () => {
    if (subjTrigger.disabled) return;
    const isOpen = !subjList.classList.contains('hidden');
    if (isOpen) {
      closeSubjectDropdown();
    } else {
      subjList.classList.remove('hidden');
      subjTrigger.classList.add('open');
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!document.getElementById('subj-dropdown').contains(e.target)) {
      closeSubjectDropdown();
    }
  });

  // ── Refresh subjects + ranking status for a site/reviewer combo ──────────
  async function refreshSubjectsAndStatus(site) {
    subjTrigger.disabled = true;
    loadBtn.disabled = true;
    _pendingSubject = null;
    document.getElementById('subj-trigger-text').textContent = '—';
    document.getElementById('subj-trigger-dot').className = 'sdot sdot-none';
    S.currentSubjects = [];
    S.rankingStatus = {};
    renderSubjectDropdown();

    if (!site) return;

    const reviewer = document.getElementById('reviewer-select').value;
    const [subjects, status] = await Promise.all([
      DataLoader.loadSubjects(site),
      DataLoader.loadRankingStatus(site, reviewer),
    ]);

    S.currentSubjects = subjects;
    S.rankingStatus = status || {};
    renderSubjectDropdown();
    if (subjects.length > 0) subjTrigger.disabled = false;

    await DataLoader.loadSiteConfig(site);
  }

  // Expose so reviewer-change handler can call it
  _refreshSubjectsAndStatus = refreshSubjectsAndStatus;

  // Load sites
  const sites = await DataLoader.loadSites();
  sites.forEach(site => {
    const opt = document.createElement('option');
    opt.value = site;
    opt.textContent = site;
    siteSel.appendChild(opt);
  });

  // Site change -> refresh subjects + status
  siteSel.addEventListener('change', () => refreshSubjectsAndStatus(siteSel.value));

  // Load button
  loadBtn.addEventListener('click', async () => {
    const site = siteSel.value;
    const subject = _pendingSubject;
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
      // Sync dropdown selection highlight and trigger dot
      document.querySelectorAll('.subj-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.name === subject);
      });
      updateSubjectStatus(subject);

      // Display prescription dose
      const rxLabel = document.getElementById('rx-label');
      if (S.rxTotalDoseGy) {
        rxLabel.textContent = `RX: ${S.rxFractionDoseGy} Gy x ${S.rxNumFractions} fx = ${S.rxTotalDoseGy} Gy`;
      } else {
        rxLabel.textContent = 'RX: not configured';
      }
      document.getElementById('welcome-screen').classList.add('hidden');
      document.getElementById('body').style.display = 'flex';

      renderIsodoseUI();
      renderStructureUI();
      renderClinicalGoals();
      renderClinicalContext();

      // Reset ranking workspace + carrot for the newly loaded subject
      RankWorkspace.reset();

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
