/**
 * Moteur de session : HolisticLandmarker (pose + mains), calibration distance,
 * silhouette morphologique, zones anatomiques avec gestes animés.
 */
import { Voice, Beeper } from './voice.js';
import { PoseTracker, LM, isBackTurned, OneEuro, BackOrientation, contactPointsFromHand, palmFromHand } from './pose.js';
import {
  CoverageGrid, torsoFrame, backToPx, zoneName, backHalfWidth,
  toBack, nearBackShape, setShapeScale,
  HEAT_W, HEAT_H, ZONE_COUNT, ANATOMICAL_ZONES,
} from './coverage.js';
import {
  estimateSubjectDistance, touchDistanceForRange, formatDistance,
} from './calibration.js';
import { strokeZoneOutline } from './zones.js';
import { tipFor, zoneInstruction } from './tips.js';

export class SunCoachEngine {
  constructor({ video, overlay, minimap, onHud, onDone }) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.minimap = minimap || null;
    this.minimapCtx = minimap ? minimap.getContext('2d') : null;
    this.onHud = onHud;
    this.onDone = onDone;

    this.voice = new Voice();
    this.beeper = new Beeper();
    this.tracker = new PoseTracker(video);
    this.grid = new CoverageGrid();

    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = HEAT_W;
    this.heatCanvas.height = HEAT_H;
    this.heatCtx = this.heatCanvas.getContext('2d');
    this.heatImage = this.heatCtx.createImageData(HEAT_W, HEAT_H);

    this.miniCanvas = document.createElement('canvas');
    this.miniCanvas.width = HEAT_W;
    this.miniCanvas.height = HEAT_H;
    this.miniCtx = this.miniCanvas.getContext('2d');
    this.miniImage = this.miniCtx.createImageData(HEAT_W, HEAT_H);

    this.state = 'idle';
    this.wakeLock = null;
    this.touchDist = 0.16;
    this.backOrient = new BackOrientation();
    this.orientWarnTs = 0;

    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.state !== 'idle') {
        this._acquireWakeLock();
      }
    };
  }

  get muted() {
    return this.voice.muted;
  }

  setMuted(m) {
    this.voice.muted = m;
    this.beeper.muted = m;
    if (m) this.voice.stop();
  }

  async start() {
    this.voice.unlock();
    this.beeper.unlock();
    this.onHud(0, 'TÉLÉCHARGEMENT DU MODÈLE…');
    if (!this.tracker.landmarker) await this.tracker.init();
    this.onHud(0, 'DÉMARRAGE DE LA CAMÉRA…');
    await this.tracker.startCamera();

    this.overlay.width = this.video.videoWidth;
    this.overlay.height = this.video.videoHeight;
    this.grid.reset();
    this.lastTs = 0;
    this.placementOkSince = 0;
    this.lastMilestone = 0;
    this.currentTargetIdx = null;
    this.tipSaidForZone = new Set();
    this.coveredZones = new Set();
    this.paths = { gauche: [], droite: [] };
    this.lastPathTs = { gauche: 0, droite: 0 };
    this.smFrame = null;
    this.lastPaintTs = { new: 0, old: 0 };
    this.lastCaptureHintTs = 0;
    this.distSamples = [];
    this.shapeSamples = [];
    this.touchDist = 0.16;
    this.filters = {
      gauche: { u: new OneEuro(), v: new OneEuro() },
      droite: { u: new OneEuro(), v: new OneEuro() },
    };

    this.state = 'placement';
    this.onHud(0, 'PLACEMENT…');
    this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.voice.say(
      'Bienvenue ! Pose le téléphone sur un support, puis mets-toi dos à la caméra, à environ deux mètres.',
      { interrupt: true }
    );
    this.tracker.start((track, ts) => this._onFrame(track, ts));
  }

  stop({ silence = true } = {}) {
    if (this._released) return;
    this._released = true;
    this.tracker.stop();
    this.tracker.stopCamera();
    if (silence) this.voice.stop();
    this.beeper.setPaintActivity('off');
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.state = 'idle';
  }

  async flip() {
    await this.tracker.switchCamera();
    this.overlay.width = this.video.videoWidth;
    this.overlay.height = this.video.videoHeight;
  }

  async _acquireWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch { /* pas bloquant */ }
  }

  // ---------------------------------------------------------------- boucle

  _onFrame(track, ts) {
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = ts;

    const W = this.overlay.width, H = this.overlay.height;
    const lm = track.pose2D;
    const P = lm ? lm.map((p) => ({ x: p.x * W, y: p.y * H, visibility: p.visibility })) : null;
    const frame = this._smoothTorso(P ? torsoFrame(P) : null);

    if (track.segmentationMask && frame && P && this.state === 'placement') {
      this._sampleShapeFromMask(track.segmentationMask, P, frame, W, H);
    }

    this._drawOverlay(P, frame, track);
    this._drawMinimap(ts);

    if (this.state === 'placement') this._placementTick(P, ts);
    else if (this.state === 'coverage') {
      this._coverageTick(P, track, frame, ts, dt);
    }
  }

  _smoothTorso(frame) {
    if (!frame) {
      this.smFrame = null;
      return null;
    }
    if (!this.smFrame) {
      this.smFrame = {
        origin: { ...frame.origin },
        ex: { ...frame.ex },
        ey: { ...frame.ey },
        width: frame.width,
        height: frame.height,
      };
      return this.smFrame;
    }
    const a = 0.3;
    const s = this.smFrame;
    s.origin.x += a * (frame.origin.x - s.origin.x);
    s.origin.y += a * (frame.origin.y - s.origin.y);
    s.width += a * (frame.width - s.width);
    s.height += a * (frame.height - s.height);
    for (const axis of ['ex', 'ey']) {
      s[axis].x += a * (frame[axis].x - s[axis].x);
      s[axis].y += a * (frame[axis].y - s[axis].y);
      const n = Math.hypot(s[axis].x, s[axis].y) || 1;
      s[axis].x /= n;
      s[axis].y /= n;
    }
    return s;
  }

  /** Segmentation légère : compare la largeur du torse au repère épaules. */
  _sampleShapeFromMask(mask, P, frame, W, H) {
    let data;
    try {
      data = mask.getAsFloat32Array();
    } catch {
      return;
    }
    const mw = mask.width, mh = mask.height;
    const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
    const shoulderY = Math.round(((ls.y + rs.y) / 2) * mh / H);
    const cx = Math.round(((ls.x + rs.x) / 2) * mw / W);
    const shoulderLandmarkW = Math.hypot(rs.x - ls.x, rs.y - ls.y);

    let left = cx, right = cx;
    for (let x = cx; x >= 0; x--) {
      if (data[shoulderY * mw + x] > 0.45) left = x;
      else break;
    }
    for (let x = cx; x < mw; x++) {
      if (data[shoulderY * mw + x] > 0.45) right = x;
      else break;
    }
    const maskWpx = ((right - left) * W) / mw;
    if (maskWpx < shoulderLandmarkW * 0.5) return;

    const ratio = maskWpx / (shoulderLandmarkW * 1.1);
    this.shapeSamples.push(Math.max(0.75, Math.min(1.25, ratio)));
    if (this.shapeSamples.length > 30) this.shapeSamples.shift();
  }

  _finalizeCalibration() {
    if (this.distSamples.length) {
      const avg = this.distSamples.reduce((a, b) => a + b, 0) / this.distSamples.length;
      this.touchDist = touchDistanceForRange(avg);
      this.camDistanceM = avg;
    }
    if (this.shapeSamples.length) {
      const avg = this.shapeSamples.reduce((a, b) => a + b, 0) / this.shapeSamples.length;
      setShapeScale(avg);
    }
  }

  // ---------------------------------------------------------------- placement

  _placementTick(P, ts) {
    const W = this.overlay.width;
    const fail = (msg, id, statusMsg) => {
      this.placementOkSince = 0;
      this.onHud(0, statusMsg);
      this.voice.say(msg, { id, cooldown: 6000 });
    };

    if (!P) {
      return fail(
        'Je ne vois personne. Pose le téléphone sur un support et recule.',
        'noperson', 'PERSONNE DÉTECTÉE : NÉGATIF'
      );
    }
    const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
    const lh = P[LM.L_HIP], rh = P[LM.R_HIP];
    if (ls.visibility < 0.5 || rs.visibility < 0.5) {
      return fail('Je ne vois pas bien tes épaules. Recule un peu.', 'shoulders', 'ÉPAULES NON VISIBLES');
    }
    if (lh.visibility < 0.5 || rh.visibility < 0.5) {
      return fail(
        'Je dois voir jusqu’à tes hanches. Recule, ou incline un peu le téléphone.',
        'hips', 'HANCHES NON VISIBLES'
      );
    }
    const shoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    if (shoulderW > 0.45 * W) {
      return fail('Tu es trop près. Recule un peu.', 'tooclose', 'DISTANCE : TROP PRÈS');
    }
    if (shoulderW < 0.08 * W) {
      return fail('Tu es un peu loin. Approche-toi.', 'toofar', 'DISTANCE : TROP LOIN');
    }
    if (!isBackTurned(P, W)) {
      return fail('Tourne-toi, dos à la caméra.', 'turn', 'ORIENTATION : FACE — TOURNE-TOI');
    }

    const distM = estimateSubjectDistance(shoulderW, W);
    this.distSamples.push(distM);
    if (this.distSamples.length > 40) this.distSamples.shift();

    this.onHud(0, `VERROUILLAGE… DIST. ${formatDistance(distM)}`);
    if (!this.placementOkSince) this.placementOkSince = ts;
    if (ts - this.placementOkSince > 1500) this._startCoverage();
  }

  _startCoverage() {
    this._finalizeCalibration();
    this.backOrient.reset();
    this.orientWarnTs = 0;
    this.state = 'coverage';
    this.coverageStartedAt = performance.now();
    this.lastCaptureHintTs = this.coverageStartedAt + 6000;
    this.onHud(0, 'CRÈME DANS LES MAINS !');
    this.voice.say(
      "C'est parti ! Mets une bonne dose de crème. Quand ça cliquette, ta main est détectée. " +
        'On commence par la nuque : main par-dessus l’épaule.',
      { interrupt: true }
    );
  }

  // ---------------------------------------------------------------- couverture

  /** La main doit être dans la zone torse élargie (bras par-dessus l'épaule). */
  _pointNearTorso(p, frame) {
    const dx = p.x - frame.origin.x;
    const dy = p.y - frame.origin.y;
    const localX = dx * frame.ex.x + dy * frame.ex.y;
    const localY = dx * frame.ey.x + dy * frame.ey.y;
    return (
      Math.abs(localX) <= frame.width * 0.58 &&
      localY >= -frame.height * 0.18 &&
      localY <= frame.height * 1.06
    );
  }

  /**
   * Projection 2D image → repère torse (u, v). Plus fiable que le monde 3D
   * quand on frotte le dos dos à la caméra.
   */
  _getContactPoints2D(track, P, frame, W, H, ts) {
    const out = [];
    const defs = [
      { hand: track.leftHand2D, poseWrist: LM.L_WRIST, name: 'gauche' },
      { hand: track.rightHand2D, poseWrist: LM.R_WRIST, name: 'droite' },
    ];

    for (const d of defs) {
      let points = [];
      if (d.hand?.length >= 21) {
        const handPx = d.hand.map((p) => ({
          x: p.x * W,
          y: p.y * H,
          visibility: p.visibility ?? p.presence ?? 0,
        }));
        points = contactPointsFromHand(handPx);
      }
      if (!points.length && P) {
        const w = P[d.poseWrist];
        if (w && w.visibility >= 0.45) points = [w];
      }

      const f = this.filters[d.name];
      for (const p of points) {
        if (!this._pointNearTorso(p, frame)) continue;
        const raw = toBack(p, frame);
        out.push({
          name: d.name,
          u: f.u.filter(raw.u, ts),
          v: f.v.filter(raw.v, ts),
        });
      }
    }
    return out;
  }

  _coverageTick(P, track, frame, ts, dt) {
    const W = this.overlay.width;

    if (!P || !frame) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.fraction, 'RECHERCHE DU TORSE…');
      return;
    }

    const backOk = this.backOrient.update(P, W);
    if (!backOk && ts - this.orientWarnTs > 15000) {
      this.orientWarnTs = ts;
      this.onHud(this.grid.fraction, 'ORIENTATION : VÉRIFIE LE DOS');
      this.voice.say('Reste bien dos à la caméra.', { id: 'stayback', cooldown: 15000 });
    }

    const contacts = this._getContactPoints2D(track, P, frame, W, this.overlay.height, ts);
    const painting = contacts.filter((h) => nearBackShape(h.u, h.v));

    const { added, crossed } = this.grid.update(painting, dt);

    if (crossed > 0 || added > dt * 0.25) this.lastPaintTs.new = ts;
    else if (painting.length > 0) this.lastPaintTs.old = ts;
    if (ts - this.lastPaintTs.new < 350) this.beeper.setPaintActivity('new');
    else if (ts - this.lastPaintTs.old < 350) this.beeper.setPaintActivity('old');
    else this.beeper.setPaintActivity('off');
    this.beeper.tick(ts);

    if (
      contacts.length > 0 &&
      painting.length === 0 &&
      (this.lastPaintTs.new === 0 || ts - this.lastPaintTs.new > 8000) &&
      ts - this.lastCaptureHintTs > 12000
    ) {
      this.lastCaptureHintTs = ts;
      this.voice.say(
        'Je ne capte pas ta paume sur le dos. Colle bien la main à plat et frotte lentement.',
        { queue: true }
      );
    }

    for (const h of painting) {
      if (ts - this.lastPathTs[h.name] > 80) {
        this.lastPathTs[h.name] = ts;
        this.paths[h.name].push({ u: h.u, v: h.v });
      }
    }

    for (let zi = 0; zi < ZONE_COUNT; zi++) {
      if (!this.coveredZones.has(zi) && this.grid.isCovered(zi)) {
        this.coveredZones.add(zi);
        this.beeper.zoneDone();
        this.voice.say(`${capitalize(zoneName(zi))} : c’est fait !`, { interrupt: true });
      }
    }

    const pct = this.grid.fraction;
    if (pct >= 0.5 && this.lastMilestone < 0.5) {
      this.lastMilestone = 0.5;
      this.voice.say('La moitié du dos est couverte, continue !', { queue: true });
    }

    if (this.grid.done) return this._finish();

    const targetIdx = this.grid.nextTarget();
    const zone = ANATOMICAL_ZONES[targetIdx];
    this.onHud(pct, 'CIBLE : ' + zone.short);

    if (!this.voice.busy) {
      const isNew = targetIdx !== this.currentTargetIdx;
      const msg = isNew
        ? `Zone suivante : ${zone.name}. ${zoneInstruction(targetIdx)}`
        : `Toujours ${zone.name}. ${zoneInstruction(targetIdx)}`;
      const spoke = this.voice.say(msg, {
        id: 'target:' + zone.id,
        cooldown: isNew ? 2000 : 9000,
      });
      if (spoke) {
        if (!isNew && !this.tipSaidForZone.has(targetIdx)) {
          this.tipSaidForZone.add(targetIdx);
          this.voice.say(tipFor(targetIdx), { queue: true });
        }
        this.currentTargetIdx = targetIdx;
      }
    }
  }

  _buildResult(aborted) {
    let zonesCovered = 0;
    for (let i = 0; i < ZONE_COUNT; i++) if (this.grid.isCovered(i)) zonesCovered++;
    return {
      aborted,
      seconds: Math.round((performance.now() - this.coverageStartedAt) / 1000),
      paintedRatio: this.grid.paintedRatio,
      zonesCovered,
      zonesTotal: ZONE_COUNT,
      heat: this.grid.snapshot(),
      paths: this.paths,
    };
  }

  stopEarly() {
    if (this.state !== 'coverage') {
      this.stop();
      return null;
    }
    const result = this._buildResult(true);
    this.stop({ silence: false });
    this.voice.say('Session interrompue. Voici le bilan.', { interrupt: true });
    return result;
  }

  _finish() {
    const result = this._buildResult(false);
    this.beeper.success();
    this.stop({ silence: false });
    this.voice.say(
      'Bravo ! Ton dos est entièrement couvert. Pense à en remettre dans deux heures, ou après la baignade.',
      { interrupt: true }
    );
    this.onDone(result);
  }

  // ---------------------------------------------------------------- rendu

  _renderHeat() {
    const px = this.heatImage.data;
    for (let i = 0; i < HEAT_W * HEAT_H; i++) {
      const o = i * 4;
      if (!this.grid.isBody(i)) {
        px[o + 3] = 0;
        continue;
      }
      const f = this.grid.pixelFraction(i);
      if (f >= 1) {
        px[o] = 0; px[o + 1] = 255; px[o + 2] = 0; px[o + 3] = 165;
      } else {
        px[o] = 255; px[o + 1] = Math.round(60 + f * 140); px[o + 2] = 0;
        px[o + 3] = Math.round(f * 150);
      }
    }
    this.heatCtx.putImageData(this.heatImage, 0, 0);
  }

  _traceBackPath(c, toX, toY) {
    const STEPS = 28;
    c.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const v = i / STEPS;
      const x = toX(0.5 - effectiveHalfWidth(v));
      const y = toY(v);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    for (let i = STEPS; i >= 0; i--) {
      c.lineTo(toX(0.5 + effectiveHalfWidth(i / STEPS)), toY(i / STEPS));
    }
    c.closePath();
  }

  _drawMinimap(ts) {
    if (!this.minimapCtx) return;
    const c = this.minimapCtx;
    const W = this.minimap.width, H = this.minimap.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0, 0, 0, 0.78)';
    c.fillRect(0, 0, W, H);

    const headH = H * 0.16;
    const pad = 7;
    const mapW = W - 2 * pad, mapH = H - headH - pad;
    const toX = (u) => pad + u * mapW;
    const toY = (v) => headH + v * mapH;

    const cx = W / 2;
    c.beginPath();
    c.arc(cx, headH * 0.45, headH * 0.34, 0, Math.PI * 2);
    c.fillStyle = 'rgba(120, 130, 120, 0.9)';
    c.fill();
    c.fillRect(cx - headH * 0.13, headH * 0.7, headH * 0.26, headH * 0.35);

    const px = this.miniImage.data;
    for (let i = 0; i < HEAT_W * HEAT_H; i++) {
      const o = i * 4;
      if (!this.grid.isBody(i)) {
        px[o + 3] = 0;
        continue;
      }
      const f = this.grid.pixelFraction(i);
      if (f >= 1) {
        px[o] = 0; px[o + 1] = 230; px[o + 2] = 0; px[o + 3] = 245;
      } else {
        px[o] = Math.round(72 + f * 183);
        px[o + 1] = Math.round(82 + f * 71);
        px[o + 2] = 62;
        px[o + 3] = 245;
      }
    }
    this.miniCtx.putImageData(this.miniImage, 0, 0);

    c.save();
    this._traceBackPath(c, toX, toY);
    c.clip();
    c.imageSmoothingEnabled = true;
    c.drawImage(this.miniCanvas, pad, headH, mapW, mapH);

    if (this.paths) {
      const trail = (path, color) => {
        const pts = path.slice(-50);
        if (pts.length < 2) return;
        c.beginPath();
        c.moveTo(toX(pts[0].u), toY(pts[0].v));
        for (let i = 1; i < pts.length; i++) c.lineTo(toX(pts[i].u), toY(pts[i].v));
        c.strokeStyle = color;
        c.lineWidth = 2;
        c.globalAlpha = 0.85;
        c.stroke();
        c.globalAlpha = 1;
      };
      trail(this.paths.gauche, '#00FFFF');
      trail(this.paths.droite, '#FF00FF');
    }

    c.restore();

    this._traceBackPath(c, toX, toY);
    c.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    c.lineWidth = 2;
    c.stroke();

    if (this.state === 'coverage') {
      const tIdx = this.grid.nextTarget();
      if (tIdx != null) {
        const zone = ANATOMICAL_ZONES[tIdx];
        strokeZoneOutline(c, zone, toX, toY, '#FF9900', 2);
      }

      const pct = Math.round(this.grid.fraction * 100);
      c.font = 'bold 22px Fira Code, monospace';
      c.textAlign = 'center';
      c.fillStyle = '#00FF00';
      c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      c.lineWidth = 3;
      c.strokeText(pct + '%', cx, H - 6);
      c.fillText(pct + '%', cx, H - 6);
    }
  }

  _drawOverlay(P, frame, track) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!frame) return;

    if (this.state === 'coverage') {
      this._renderHeat();
      const a = frame.ex.x * frame.width;
      const b = frame.ex.y * frame.width;
      const c = frame.ey.x * frame.height;
      const d = frame.ey.y * frame.height;
      const e = frame.origin.x - 0.5 * a;
      const f = frame.origin.y - 0.5 * b;
      ctx.save();
      ctx.setTransform(a, b, c, d, e, f);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.heatCanvas, 0, 0, 1, 1);
      ctx.restore();
    }

    const targetIdx = this.state === 'coverage' ? this.grid.nextTarget() : null;
    for (let zi = 0; zi < ANATOMICAL_ZONES.length; zi++) {
      const z = ANATOMICAL_ZONES[zi];
      const u0 = z.u0, u1 = z.u1, v0 = z.v0, v1 = z.v1;
      const pts = [
        backToPx(u0, v0, frame), backToPx(u1, v0, frame),
        backToPx(u1, v1, frame), backToPx(u0, v1, frame),
      ];
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      const isTarget = targetIdx === zi;
      ctx.lineWidth = isTarget ? 3 : 1;
      ctx.strokeStyle = isTarget ? '#FF9900' : 'rgba(0, 255, 0, 0.25)';
      ctx.stroke();
    }

    if (P) {
      for (const idx of [LM.L_WRIST, LM.R_WRIST]) {
        const p = P[idx];
        if (p.visibility < 0.4) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 255, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#00FFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Paumes Holistic (plus précises).
    const drawHand2D = (hand, color) => {
      if (!hand || !hand.length) return;
      const palm = palmFromHand(hand.map((p) => ({
        x: p.x * W, y: p.y * H, z: p.z ?? 0,
        visibility: p.visibility ?? p.presence ?? 0,
      })));
      if (!palm) return;
      ctx.beginPath();
      ctx.arc(palm.x, palm.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    if (track.leftHand2D) {
      drawHand2D(track.leftHand2D, 'rgba(0, 255, 255, 0.45)');
    }
    if (track.rightHand2D) {
      drawHand2D(track.rightHand2D, 'rgba(255, 0, 255, 0.45)');
    }
  }
}

function effectiveHalfWidth(v) {
  let hw = backHalfWidth(v);
  if (v < 0.06) {
    const t = v / 0.06;
    hw = Math.min(hw, 0.42 + t * 0.1);
  }
  return hw;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { ZONE_COUNT, HEAT_W, HEAT_H, ANATOMICAL_ZONES };
