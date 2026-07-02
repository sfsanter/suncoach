/**
 * Moteur de session : machine à états placement → couverture → fin.
 *
 * La peinture se fait dans le repère torse 3D (world landmarks MediaPipe) :
 * invariant à la rotation du corps, et la coordonnée w (distance au plan du
 * dos) garantit qu'on ne peint que quand la paume touche vraiment le dos.
 * L'overlay vidéo, lui, reste en 2D (repère image lissé).
 */
import { Voice, Beeper } from './voice.js';
import { PoseTracker, LM, isBackTurned, OneEuro } from './pose.js';
import {
  CoverageGrid, torsoFrame, backToPx, zoneName, backHalfWidth,
  torsoFrame3D, toBack3D,
  ROWS, COLS, HEAT_W, HEAT_H,
} from './coverage.js';
import { tipFor, zoneInstruction } from './tips.js';

/** Distance max paume ↔ plan du dos pour peindre (mètres, z bruité → marge). */
const TOUCH_DIST = 0.16;

export class SunCoachEngine {
  /**
   * @param {object} p
   * @param {HTMLVideoElement} p.video
   * @param {HTMLCanvasElement} p.overlay
   * @param {HTMLCanvasElement} [p.minimap] dessin de dos fixe, toujours visible
   * @param {(pct: number, status: string) => void} p.onHud
   * @param {(result: object) => void} p.onDone
   */
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

    // Heatmap dessinée en basse résolution puis étirée sur le dos via transform.
    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = HEAT_W;
    this.heatCanvas.height = HEAT_H;
    this.heatCtx = this.heatCanvas.getContext('2d');
    this.heatImage = this.heatCtx.createImageData(HEAT_W, HEAT_H);

    // Même principe pour le remplissage du dessin de dos.
    this.miniCanvas = document.createElement('canvas');
    this.miniCanvas.width = HEAT_W;
    this.miniCanvas.height = HEAT_H;
    this.miniCtx = this.miniCanvas.getContext('2d');
    this.miniImage = this.miniCtx.createImageData(HEAT_W, HEAT_H);

    this.state = 'idle';
    this.wakeLock = null;
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
    this.currentTargetKey = null;
    this.tipSaidForRow = new Set();
    this.coveredZones = new Set();
    this.paths = { gauche: [], droite: [] };
    this.lastPathTs = { gauche: 0, droite: 0 };
    this.smFrame = null;
    this.lastPaintTs = { new: 0, old: 0 };
    this.lastCaptureHintTs = 0;
    this.filters = {
      gauche: { u: new OneEuro(), v: new OneEuro() },
      droite: { u: new OneEuro(), v: new OneEuro() },
    };

    this.state = 'placement';
    this.onHud(0, 'PLACEMENT…');
    this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.voice.say(
      'Bienvenue ! Pose le téléphone, puis mets-toi dos à la caméra, à environ deux mètres.',
      { interrupt: true }
    );
    this.tracker.start((lm, world, ts) => this._onFrame(lm, world, ts));
  }

  /**
   * silence=false permet de laisser finir la phrase de bilan quand la session
   * se termine (le démontage React rappelle stop(), qui devient alors no-op).
   */
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

  _onFrame(lm, world, ts) {
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = ts;

    // Landmarks normalisés → pixels (pour l'affichage uniquement).
    const W = this.overlay.width, H = this.overlay.height;
    const P = lm
      ? lm.map((p) => ({ x: p.x * W, y: p.y * H, visibility: p.visibility }))
      : null;
    const frame = this._smoothTorso(P ? torsoFrame(P) : null);

    this._drawOverlay(P, frame);
    this._drawMinimap();

    if (this.state === 'placement') this._placementTick(P, ts);
    else if (this.state === 'coverage') this._coverageTick(P, world, frame, ts, dt);
  }

  /** Moyenne mobile sur origine/axes/dimensions du repère torse 2D (affichage). */
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
        'Je ne vois personne. Place le téléphone à hauteur de poitrine et recule.',
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
    if (!isBackTurned(P)) {
      return fail('Tourne-toi, dos à la caméra.', 'turn', 'ORIENTATION : FACE — TOURNE-TOI');
    }

    this.onHud(0, 'VERROUILLAGE CIBLE…');
    if (!this.placementOkSince) this.placementOkSince = ts;
    if (ts - this.placementOkSince > 1500) this._startCoverage();
  }

  _startCoverage() {
    this.state = 'coverage';
    this.coverageStartedAt = performance.now();
    // Période de grâce avant l'alerte « je ne capte pas ta paume ».
    this.lastCaptureHintTs = this.coverageStartedAt + 6000;
    this.onHud(0, 'CRÈME DANS LES MAINS !');
    this.voice.say(
      "C'est parti ! Mets une bonne dose de crème dans tes mains. " +
        'Quand ça cliquette, c’est que ta main est bien détectée sur le dos. ' +
        'On commence en haut : main gauche par-dessus l’épaule gauche.',
      { interrupt: true }
    );
  }

  // ---------------------------------------------------------------- couverture

  /**
   * Paumes en coordonnées dos 3D : (u, v) position sur le dos, w distance au
   * plan du dos en mètres. Centre paume = poignet décalé vers index/auriculaire.
   */
  _getHands3D(world, f3) {
    const hands = [];
    const defs = [
      { wrist: LM.L_WRIST, fingers: [LM.L_INDEX, LM.L_PINKY], name: 'gauche' },
      { wrist: LM.R_WRIST, fingers: [LM.R_INDEX, LM.R_PINKY], name: 'droite' },
    ];
    for (const d of defs) {
      const w = world[d.wrist];
      if (w.visibility < 0.45) continue;
      const seen = d.fingers.map((i) => world[i]).filter((p) => p.visibility > 0.45);
      let palm;
      if (seen.length) {
        const fx = seen.reduce((s, p) => s + p.x, 0) / seen.length;
        const fy = seen.reduce((s, p) => s + p.y, 0) / seen.length;
        const fz = seen.reduce((s, p) => s + p.z, 0) / seen.length;
        palm = {
          x: w.x + (fx - w.x) * 0.66,
          y: w.y + (fy - w.y) * 0.66,
          z: w.z + (fz - w.z) * 0.66,
        };
      } else {
        palm = w;
      }
      hands.push({ name: d.name, ...toBack3D(palm, f3) });
    }
    return hands;
  }

  _coverageTick(P, world, frame, ts, dt) {
    if (!P || !world || !isBackTurned(P)) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.fraction, 'RESTE DOS À LA CAMÉRA');
      this.voice.say('Reste bien dos à la caméra.', { id: 'stayback', cooldown: 7000 });
      return;
    }

    const f3 = torsoFrame3D(world);
    if (!f3) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.fraction, 'RECHERCHE DU TORSE…');
      return;
    }

    // Garde uniquement contre le quasi-profil (landmarks trop peu fiables) :
    // les rotations modérées sont maintenant absorbées par le repère 3D.
    const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
    const shoulderPx = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    const hipPx = Math.hypot(P[LM.R_HIP].x - P[LM.L_HIP].x, P[LM.R_HIP].y - P[LM.L_HIP].y);
    const torsoPx = Math.hypot(
      (ls.x + rs.x) / 2 - (P[LM.L_HIP].x + P[LM.R_HIP].x) / 2,
      (ls.y + rs.y) / 2 - (P[LM.L_HIP].y + P[LM.R_HIP].y) / 2
    );
    if (Math.max(shoulderPx, hipPx) < torsoPx * 0.28) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.fraction, 'TROP DE PROFIL — TOURNE-TOI DOS À LA CAMÉRA');
      this.voice.say('Je te vois trop de profil. Remets-toi bien dos à la caméra.', {
        id: 'profile', cooldown: 6000,
      });
      return;
    }

    // Paumes en 3D, lissées par filtre one-euro, gardées si elles touchent le dos.
    const rawHands = this._getHands3D(world, f3);
    const hands = [];
    for (const h of rawHands) {
      const f = this.filters[h.name];
      const u = f.u.filter(h.u, ts);
      const v = f.v.filter(h.v, ts);
      hands.push({ name: h.name, u, v, w: h.w });
    }
    const touching = hands.filter((h) => Math.abs(h.w) < TOUCH_DIST);

    const { added, crossed } = this.grid.update(touching, dt);

    // Feedback Geiger : neuf = cliquetis rapide, déjà-couvert = lent, rien = silence.
    if (crossed > 0 || added > dt * 0.25) this.lastPaintTs.new = ts;
    else if (touching.length > 0) this.lastPaintTs.old = ts;
    if (ts - this.lastPaintTs.new < 350) this.beeper.setPaintActivity('new');
    else if (ts - this.lastPaintTs.old < 350) this.beeper.setPaintActivity('old');
    else this.beeper.setPaintActivity('off');
    this.beeper.tick(ts);

    // « Ça capte pas » : des mains sont vues mais rien ne se peint depuis 8 s.
    if (
      hands.length > 0 &&
      (this.lastPaintTs.new === 0 || ts - this.lastPaintTs.new > 8000) &&
      ts - this.lastCaptureHintTs > 12000
    ) {
      this.lastCaptureHintTs = ts;
      this.voice.say(
        'Je ne capte pas ta paume sur le dos. Colle bien la main à plat et frotte lentement.',
        { queue: true }
      );
    }

    // Trace du parcours (échantillonnée toutes les ~80 ms).
    for (const h of touching) {
      if (h.u < -0.05 || h.u > 1.05 || h.v < -0.05 || h.v > 1.05) continue;
      if (ts - this.lastPathTs[h.name] > 80) {
        this.lastPathTs[h.name] = ts;
        this.paths[h.name].push({ u: h.u, v: h.v });
      }
    }

    // Confirmation sonore + vocale à chaque zone validée.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${r}:${c}`;
        if (!this.coveredZones.has(key) && this.grid.isCovered(r, c)) {
          this.coveredZones.add(key);
          this.beeper.zoneDone();
          this.voice.say(`${capitalize(zoneName(r, c))} : c’est fait !`, { interrupt: true });
        }
      }
    }

    const pct = this.grid.fraction;

    const milestones = [
      [0.5, 'La moitié du dos est couverte, continue !'],
    ];
    for (const [th, msg] of milestones) {
      if (pct >= th && this.lastMilestone < th) {
        this.lastMilestone = th;
        this.voice.say(msg, { queue: true });
      }
    }

    if (this.grid.done) return this._finish();

    const target = this.grid.nextTarget();
    const key = `${target.row}:${target.col}`;
    this.onHud(pct, 'CIBLE : ' + zoneName(target.row, target.col).toUpperCase());

    // Annonce de la cible : zone + main + geste. Rappel périodique espacé.
    if (!this.voice.busy) {
      const isNew = key !== this.currentTargetKey;
      const msg = isNew
        ? `Zone suivante : ${zoneName(target.row, target.col)}. ${zoneInstruction(target.row, target.col)}`
        : `Toujours ${zoneName(target.row, target.col)}. ${zoneInstruction(target.row, target.col)}`;
      const spoke = this.voice.say(msg, {
        id: 'target:' + key,
        cooldown: isNew ? 2000 : 9000,
      });
      if (spoke) {
        if (!isNew && !this.tipSaidForRow.has(target.row)) {
          // La zone traîne : conseil de mouvement complet une fois par rangée.
          this.tipSaidForRow.add(target.row);
          this.voice.say(tipFor(target.row, target.col), { queue: true });
        }
        this.currentTargetKey = key;
      }
    }
  }

  // ---------------------------------------------------------------- fin

  _buildResult(aborted) {
    let zonesCovered = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (this.grid.isCovered(r, c)) zonesCovered++;
    return {
      aborted,
      seconds: Math.round((performance.now() - this.coverageStartedAt) / 1000),
      paintedRatio: this.grid.paintedRatio,
      zonesCovered,
      zonesTotal: ROWS * COLS,
      heat: this.grid.snapshot(),
      paths: this.paths,
    };
  }

  /** STOP en cours de session : renvoie le récap (null si rien à récapituler). */
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

  /** Recolore le canvas basse résolution à partir de la heatmap (détouré au dos). */
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

  /** Tracé du contour du dos (silhouette dessinée) dans un contexte 2D. */
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
      const v = i / STEPS;
      c.lineTo(toX(0.5 + effectiveHalfWidth(v)), toY(v));
    }
    c.closePath();
  }

  /**
   * Dessin de dos fixe : silhouette (tête + nuque décoratives), remplie au fur
   * et à mesure par la heatmap, avec parcours des mains et zone cible.
   * Toujours lisible, même quand on se retourne.
   */
  _drawMinimap() {
    if (!this.minimapCtx) return;
    const c = this.minimapCtx;
    const W = this.minimap.width, H = this.minimap.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0, 0, 0, 0.78)';
    c.fillRect(0, 0, W, H);

    // Zone du dos : sous la tête décorative.
    const headH = H * 0.16;
    const pad = 7;
    const mapW = W - 2 * pad, mapH = H - headH - pad;
    const toX = (u) => pad + u * mapW;
    const toY = (v) => headH + v * mapH;

    // Tête + nuque décoratives.
    const cx = W / 2;
    c.beginPath();
    c.arc(cx, headH * 0.45, headH * 0.34, 0, Math.PI * 2);
    c.fillStyle = 'rgba(120, 130, 120, 0.9)';
    c.fill();
    c.fillRect(cx - headH * 0.13, headH * 0.7, headH * 0.26, headH * 0.35);

    // Remplissage : heatmap détourée à la silhouette.
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

    // Parcours récent des mains (gauche cyan, droite magenta), sous le clip.
    const trail = (path, color) => {
      const pts = path.slice(-45);
      if (pts.length < 2) return;
      c.beginPath();
      c.moveTo(toX(pts[0].u), toY(pts[0].v));
      for (let i = 1; i < pts.length; i++) c.lineTo(toX(pts[i].u), toY(pts[i].v));
      c.strokeStyle = color;
      c.lineWidth = 1.5;
      c.globalAlpha = 0.9;
      c.stroke();
      c.globalAlpha = 1;
    };
    if (this.paths) {
      trail(this.paths.gauche, '#00FFFF');
      trail(this.paths.droite, '#FF00FF');
    }

    // Colonne vertébrale.
    c.beginPath();
    c.moveTo(toX(0.5), toY(0));
    c.lineTo(toX(0.5), toY(1));
    c.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();

    // Contour de la silhouette.
    this._traceBackPath(c, toX, toY);
    c.strokeStyle = 'rgba(0, 255, 0, 0.75)';
    c.lineWidth = 1.5;
    c.stroke();

    // Zone cible : rectangle orange clippé à la silhouette.
    if (this.state === 'coverage') {
      const t = this.grid.nextTarget();
      if (t) {
        c.save();
        this._traceBackPath(c, toX, toY);
        c.clip();
        c.strokeStyle = '#FF9900';
        c.lineWidth = 2;
        c.strokeRect(
          toX(t.col / COLS), toY(t.row / ROWS),
          mapW / COLS, mapH / ROWS
        );
        c.restore();
      }
    }
  }

  _drawOverlay(P, frame) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!frame) return;

    // Heatmap fine, étirée sur le quadrilatère du dos.
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

    // Contours des zones de guidage + cible courante.
    const target = this.state === 'coverage' ? this.grid.nextTarget() : null;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const u0 = c / COLS, u1 = (c + 1) / COLS;
        const v0 = r / ROWS, v1 = (r + 1) / ROWS;
        const pts = [
          backToPx(u0, v0, frame), backToPx(u1, v0, frame),
          backToPx(u1, v1, frame), backToPx(u0, v1, frame),
        ];
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        const isTarget = target && target.row === r && target.col === c;
        ctx.lineWidth = isTarget ? 4 : 1;
        ctx.strokeStyle = isTarget ? '#FF9900' : 'rgba(0, 255, 0, 0.35)';
        ctx.stroke();
      }
    }

    // Points des mains.
    if (P) {
      for (const idx of [LM.L_WRIST, LM.R_WRIST]) {
        const p = P[idx];
        if (p.visibility < 0.4) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 255, 0.35)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#00FFFF';
        ctx.stroke();
      }
    }
  }
}

/** Demi-largeur avec les épaules arrondies (cohérente avec le masque). */
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

export { ROWS, COLS, HEAT_W, HEAT_H };
