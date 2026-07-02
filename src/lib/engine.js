/**
 * Moteur de session : machine à états placement → couverture → fin.
 * Indépendant de React ; publie son état via les callbacks onHud / onDone.
 */
import { Voice, Beeper } from './voice.js';
import { PoseTracker, LM, isBackTurned } from './pose.js';
import {
  CoverageGrid, torsoFrame, toBack, backToPx, zoneName, ROWS, COLS,
} from './coverage.js';
import { tipFor } from './tips.js';

export class SunCoachEngine {
  /**
   * @param {object} p
   * @param {HTMLVideoElement} p.video
   * @param {HTMLCanvasElement} p.overlay
   * @param {(pct: number, status: string) => void} p.onHud
   * @param {(result: {seconds: number, fractions: number[]}) => void} p.onDone
   */
  constructor({ video, overlay, onHud, onDone }) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.onHud = onHud;
    this.onDone = onDone;

    this.voice = new Voice();
    this.beeper = new Beeper();
    this.tracker = new PoseTracker(video);
    this.grid = new CoverageGrid();

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
    if (!this.tracker.landmarker) await this.tracker.init();
    await this.tracker.startCamera();

    this.overlay.width = this.video.videoWidth;
    this.overlay.height = this.video.videoHeight;
    this.grid.reset();
    this.lastTs = 0;
    this.placementOkSince = 0;
    this.lastMilestone = 0;
    this.currentTargetKey = null;
    this.targetAnnounceCount = new Map();
    this.tipSaidForRow = new Set();

    this.state = 'placement';
    this.onHud(0, 'PLACEMENT…');
    this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.voice.say(
      'Bienvenue ! Pose le téléphone, puis mets-toi dos à la caméra, à environ deux mètres.',
      { interrupt: true }
    );
    this.tracker.start((lm, ts) => this._onFrame(lm, ts));
  }

  stop() {
    this.tracker.stop();
    this.tracker.stopCamera();
    this.voice.stop();
    this.beeper.setProximity(null);
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

  _onFrame(lm, ts) {
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = ts;

    // Landmarks normalisés → pixels (la géométrie doit tenir compte du ratio d'image).
    const W = this.overlay.width, H = this.overlay.height;
    const P = lm
      ? lm.map((p) => ({ x: p.x * W, y: p.y * H, visibility: p.visibility }))
      : null;
    const frame = P ? torsoFrame(P) : null;

    this._drawOverlay(P, frame);

    if (this.state === 'placement') this._placementTick(P, ts);
    else if (this.state === 'coverage') this._coverageTick(P, frame, ts, dt);
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
    this.onHud(0, 'CRÈME DANS LES MAINS !');
    this.voice.say(
      "C'est parti ! Mets une bonne dose de crème dans tes mains. " +
        'Commence par le haut du dos : passe tes mains par-dessus tes épaules. ' +
        'Je te dis au fur et à mesure où il en manque.',
      { interrupt: true }
    );
  }

  // ---------------------------------------------------------------- couverture

  _getHands(P, frame) {
    const hands = [];
    const defs = [
      { wrist: LM.L_WRIST, index: LM.L_INDEX, name: 'gauche' },
      { wrist: LM.R_WRIST, index: LM.R_INDEX, name: 'droite' },
    ];
    for (const d of defs) {
      const w = P[d.wrist], i = P[d.index];
      if (w.visibility < 0.4) continue;
      const px = i.visibility > 0.4 ? { x: (w.x + i.x) / 2, y: (w.y + i.y) / 2 } : w;
      hands.push({ name: d.name, ...toBack(px, frame) });
    }
    return hands;
  }

  _coverageTick(P, frame, ts, dt) {
    if (!P || !frame || !isBackTurned(P)) {
      this.beeper.setProximity(null);
      this.onHud(this.grid.fraction, 'RESTE DOS À LA CAMÉRA');
      this.voice.say('Reste bien dos à la caméra.', { id: 'stayback', cooldown: 7000 });
      return;
    }

    const hands = this._getHands(P, frame);
    this.grid.update(hands, dt);

    const pct = this.grid.fraction;

    const milestones = [
      [0.25, 'Un quart de fait, continue !'],
      [0.5, 'La moitié du dos est couverte !'],
      [0.75, 'Trois quarts ! Plus que quelques zones.'],
    ];
    for (const [th, msg] of milestones) {
      if (pct >= th && this.lastMilestone < th) {
        this.lastMilestone = th;
        this.voice.say(msg, { queue: true });
      }
    }

    if (this.grid.done) return this._finish();

    const target = this.grid.nextTarget();
    const center = this.grid.cellCenter(target.row, target.col);
    const key = `${target.row}:${target.col}`;

    // Bips radar : distance de la main la plus proche à la zone cible.
    let best = null;
    for (const h of hands) {
      const d = Math.hypot(h.u - center.u, (h.v - center.v) * (ROWS / COLS));
      if (best === null || d < best.d) best = { d, hand: h };
    }
    this.beeper.setProximity(best ? Math.min(1, best.d / 0.8) : null);
    this.beeper.tick(ts);

    this.onHud(pct, 'CIBLE : ' + zoneName(target.row, target.col).toUpperCase());

    // Annonce vocale de la cible (nouvelle cible, ou rappel périodique).
    if (!this.voice.busy) {
      const count = this.targetAnnounceCount.get(key) || 0;
      const isNew = key !== this.currentTargetKey;
      const spoke = this.voice.say(this._buildGuidance(target, center, best), {
        id: 'target:' + key,
        cooldown: isNew ? 2500 : 6500,
      });
      if (spoke) {
        this.currentTargetKey = key;
        this.targetAnnounceCount.set(key, count + 1);
        // Zone annoncée 2 fois sans succès → conseil de mouvement.
        if (count + 1 >= 2 && !this.tipSaidForRow.has(target.row)) {
          this.tipSaidForRow.add(target.row);
          this.voice.say(tipFor(target.row, target.col), { queue: true });
        }
      }
    }
  }

  _buildGuidance(target, center, best) {
    const zone = zoneName(target.row, target.col);
    if (!best) return `Il reste ${zone}.`;
    if (best.d < 0.14) return `Tu y es presque ! Frotte bien là, sur ${zone}.`;
    const du = center.u - best.hand.u;
    const dv = center.v - best.hand.v;
    // Vue de dos, la gauche de l'image est la gauche de la personne.
    const dir =
      Math.abs(du) > Math.abs(dv * 0.75)
        ? du > 0 ? 'vers ta droite' : 'vers ta gauche'
        : dv > 0 ? 'plus bas' : 'plus haut';
    return `Il reste ${zone}. Va ${dir} avec ta main ${best.hand.name}.`;
  }

  // ---------------------------------------------------------------- fin

  _finish() {
    const seconds = Math.round((performance.now() - this.coverageStartedAt) / 1000);
    this.state = 'done';
    this.beeper.setProximity(null);
    this.beeper.success();
    this.voice.say(
      'Bravo ! Ton dos est entièrement couvert. Pense à en remettre dans deux heures, ou après la baignade.',
      { interrupt: true }
    );
    const fractions = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) fractions.push(this.grid.fractionOf(r, c));
    this.tracker.stop();
    this.tracker.stopCamera();
    this.onDone({ seconds, fractions });
  }

  // ---------------------------------------------------------------- overlay

  _drawOverlay(P, frame) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!frame) return;

    // Grille du dos, cellules teintées selon la couverture (palette NERV).
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
        const f = this.grid.fractionOf(r, c);
        // rouge NERV → vert NERV
        ctx.fillStyle = f >= 1
          ? 'rgba(0, 255, 0, 0.28)'
          : `rgba(255, ${Math.round(f * 200)}, 0, ${0.10 + f * 0.15})`;
        ctx.fill();
        const isTarget = target && target.row === r && target.col === c;
        ctx.lineWidth = isTarget ? 4 : 1.5;
        ctx.strokeStyle = isTarget ? '#FF9900' : 'rgba(0, 255, 0, 0.4)';
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

export { ROWS, COLS };
