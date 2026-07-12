/**
 * Moteur de session : HolisticLandmarker (pose + mains), calibration distance,
 * silhouette morphologique, zones anatomiques avec gestes animés.
 */
import { Voice, Beeper } from './voice.js';
import { PoseTracker, LM, isBackTurned, OneEuro, BackOrientation, palmFromHand } from './pose.js';
import {
  CoverageGrid, torsoFrame, backHalfWidth,
  toBack, nearBackShape, coverageHeatRGBA, setShapeScale,
  setTracedContour, customBackOutlineUV, setCustomBackAnchors,
  setMinimapLayout, getMinimapLayout, backToPx, paintUvFromWarpedPixel,
  getBackWarp,
  HEAT_W, HEAT_H, ZONE_COUNT, ANATOMICAL_ZONES, MIN_COVERAGE_SEC,
} from './coverage.js';
import {
  estimateSubjectDistance, touchDistanceForRange, formatDistance,
} from './calibration.js';
import { gapMessage, gapShort, calibrationVoice } from './tips.js';
import { MaskLockAccumulator, LOCK_FRAMES } from './maskLock.js';
import { warpToLocked, cloneFrame } from './backTemplate.js';
import {
  defaultAnchorsPx,
  capturePoseSignature, comparePoseSignature, shouldEnterCoverage,
} from './anchorShape.js';
import { applyCalibration } from './sessionCore.js';
import { isDebugMinimap, minimapDebugInfo, setupMinimapCanvas, MINIMAP_CSS_W, MINIMAP_CSS_H } from './minimapCanvas.js';
import { credibleBackHand, crediblePoseWrist, elbowBackContact, handContactPixels, ContactVelocityGate, handConfidence, updateCoachMode } from './handGate.js';
import { anchorAssistedContacts } from './backCalibration.js';
import {
  buildBackSilhouette, buildFallbackSilhouette, buildBackSilhouetteFromBytes,
  traceBackContour, drawBackSegmentationOverlay,
} from './segmentation.js';

export class SunCoachEngine {
  constructor({ video, overlay, minimap, onHud, onDone, onPhase }) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.minimap = minimap || null;
    this.minimapCtx = minimap ? minimap.getContext('2d') : null;
    this.onHud = onHud;
    this.onDone = onDone;
    this.onPhase = onPhase || (() => {});

    this.voice = new Voice();
    this.beeper = new Beeper();
    this.tracker = new PoseTracker(video);
    this.grid = new CoverageGrid();

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
    this.smoothMask = null;
    this.backContour = null;

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

    if (this.minimap) {
      const setup = setupMinimapCanvas(this.minimap);
      this.minimapCtx = setup.ctx;
      this.minimapLogicalW = setup.logicalW;
      this.minimapLogicalH = setup.logicalH;
    }

    this.overlay.width = this.video.videoWidth;
    this.overlay.height = this.video.videoHeight;
    this.grid.reset();
    this.smoothMask = null;
    this.backContour = null;
    this.calibrationFrame = null;
    this.frozenMask = null;
    this.lockedShoulderW = 0;
    this.lockedMid = null;
    this.maskLock = null;
    this.lockStartedAt = 0;
    this.calibrationAnchors = {};
    this.draftAnchorsPx = null;
    this.frozenPoseP = null;
    this.lockedPoseSignature = null;
    this.snapshotDataUrl = null;
    this.snapshotW = 0;
    this.snapshotH = 0;
    this.coachMode = 'precise';
    this.repositionStableFrames = 0;
    this.lastTs = 0;
    this.placementOkSince = 0;
    this.lastMilestone = 0;
    this.paths = { gauche: [], droite: [] };
    this.lastPathTs = { gauche: 0, droite: 0 };
    this.smFrame = null;
    this.lastPaintTs = { new: 0, old: 0 };
    this.lastCaptureHintTs = 0;
    this.lastGapVoiceTs = 0;
    this.freePaintSince = 0;
    this.distSamples = [];
    this.shapeSamples = [];
    this.touchDist = 0.16;
    this.filters = {
      gauche: { u: new OneEuro(), v: new OneEuro() },
      droite: { u: new OneEuro(), v: new OneEuro() },
    };
    this.contactGate = new ContactVelocityGate();

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
    this.tracker.aiSegEnabled = false;
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
    this.smoothMask = null;
    this.backContour = null;
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

    if (P) {
      const useFrozen = this.frozenMask && this.state !== 'placement';
      const skipSeg = this.state === 'locking' || useFrozen;
      if (!skipSeg) {
        if (track.aiPersonMask) {
          this.smoothMask = buildBackSilhouetteFromBytes(
            track.aiPersonMask, P, W, H, this.smoothMask
          );
        } else if (track.segmentationMask) {
          this.smoothMask = buildBackSilhouette(track.segmentationMask, P, W, H, this.smoothMask);
        } else {
          this.smoothMask = buildFallbackSilhouette(P, W, H, this.smoothMask);
        }
        this.backContour = this.smoothMask
          ? traceBackContour(this.smoothMask, W, H)
          : null;
      }
      if (this.state === 'placement' && track.segmentationMask && frame) {
        this._sampleShapeFromMask(track.segmentationMask, P, frame, W, H);
      }
    }

    this._drawOverlay(P, frame, track, ts, W, H);
    this._drawMinimap(ts);

    if (this.state === 'placement') this._placementTick(P, ts, frame);
    else if (this.state === 'locking') this._lockingTick(P, track, frame, ts, W, H);
    else if (this.state === 'adjusting') { /* pose en pause visuelle — ajustement écran */ }
    else if (this.state === 'reposition') this._repositionTick(P, ts, W);
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

  _placementTick(P, ts, frame) {
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
    if (shoulderW > 0.52 * W) {
      return fail('Tu es trop près. Recule un peu.', 'tooclose', 'DISTANCE : TROP PRÈS');
    }
    if (shoulderW < 0.05 * W) {
      return fail('Tu es un peu loin. Approche-toi.', 'toofar', 'DISTANCE : TROP LOIN');
    }
    if (!isBackTurned(P, W)) {
      return fail('Tourne-toi, dos à la caméra.', 'turn', 'ORIENTATION : FACE — TOURNE-TOI');
    }

    const distM = estimateSubjectDistance(shoulderW, W);
    this.distSamples.push(distM);
    if (this.distSamples.length > 40) this.distSamples.shift();

    this.onHud(0, `CALIBRAGE BIENTÔT… DIST. ${formatDistance(distM)}`);
    if (!this.placementOkSince) this.placementOkSince = ts;
    if (ts - this.placementOkSince > 1500) this._startLocking(frame);
  }

  _startLocking(frame) {
    this._finalizeCalibration();
    this.state = 'locking';
    this.lockStartedAt = performance.now();
    this.calibrationFrame = frame ? cloneFrame(frame) : null;
    const W = this.overlay.width;
    const H = this.overlay.height;
    this.maskLock = new MaskLockAccumulator(W, H);
    this.tracker.aiSegEnabled = true;
    this.onHud(0, 'SCAN IA DU DOS… RESTE IMMOBILE');
    this.voice.say(
      'Parfait. Reste immobile, je prends une photo et je scanne ton dos.',
      { interrupt: true },
    );
  }

  _holisticMaskBytes(mask, P, W, H) {
    if (!mask) return null;
    let raw;
    try {
      raw = mask.getAsFloat32Array();
    } catch {
      return null;
    }
    const mw = mask.width;
    const mh = mask.height;
    const out = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(mh - 1, Math.round((y / H) * mh));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(mw - 1, Math.round((x / W) * mw));
        out[y * W + x] = raw[sy * mw + sx] > 0.28 ? 255 : 0;
      }
    }
    return out;
  }

  _lockingTick(P, track, frame, ts, W, H) {
    const calFrame = this.calibrationFrame || frame;
    const lock = this.maskLock;

    if (!P || !calFrame || !lock) {
      this.onHud(0, 'SCAN IA… RESTE DANS LE CADRE');
      return;
    }

    const bytes = track.aiPersonMask
      ?? this._holisticMaskBytes(track.segmentationMask, P, W, H);
    if (bytes) lock.push(bytes);

    const pct = Math.min(100, Math.round((lock.count / LOCK_FRAMES) * 100));
    this.onHud(lock.count / LOCK_FRAMES, `SCAN IA ${pct} %`);

    const timedOut = performance.now() - this.lockStartedAt > 8000;
    if (lock.count >= LOCK_FRAMES || (timedOut && lock.count >= 8)) {
      this._finalizeLock(calFrame, P, W, H);
    } else if (timedOut) {
      this.voice.say(
        'Je n’arrive pas à bien te voir. Vérifie la lumière et reste dos à la caméra.',
        { id: 'lock:fail', cooldown: 6000 },
      );
      this.lockStartedAt = performance.now();
    }
  }

  _finalizeLock(calFrame, P, W, H) {
    this.tracker.aiSegEnabled = false;
    const lock = this.maskLock;
    const averaged = lock?.getAveraged() ?? null;
    const contour = averaged
      ? lock.extractContour(calFrame, averaged)
      : null;

    if (contour) {
      setTracedContour(contour);
      this.frozenMask = buildBackSilhouetteFromBytes(averaged, P, W, H, null);
      this.smoothMask = this.frozenMask;
      this.backContour = traceBackContour(this.smoothMask, W, H);
    } else {
      this.frozenMask = buildFallbackSilhouette(P, W, H, null);
      this.smoothMask = this.frozenMask;
      this.backContour = traceBackContour(this.smoothMask, W, H);
    }

    const ls = P[LM.L_SHOULDER];
    const rs = P[LM.R_SHOULDER];
    this.lockedShoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    this.lockedMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

    this.frozenPoseP = P.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));
    this.lockedPoseSignature = capturePoseSignature(P, calFrame);

    this.maskLock = null;
    this._startAdjusting(P, W, H);
  }

  _captureSnapshot() {
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(this.video, 0, 0, W, H);
    this.snapshotDataUrl = c.toDataURL('image/jpeg', 0.9);
    this.snapshotW = W;
    this.snapshotH = H;
  }

  getAdjustmentPayload() {
    return {
      imageUrl: this.snapshotDataUrl,
      anchorsPx: { ...this.draftAnchorsPx },
      videoW: this.snapshotW,
      videoH: this.snapshotH,
    };
  }

  setDraftAnchorPx(id, x, y) {
    if (this.state !== 'adjusting' || !this.draftAnchorsPx) return;
    const W = this.snapshotW;
    const H = this.snapshotH;
    this.draftAnchorsPx[id] = {
      x: Math.max(8, Math.min(W - 8, x)),
      y: Math.max(8, Math.min(H - 8, y)),
    };
  }

  confirmAdjustment() {
    if (this.state !== 'adjusting' || !this.draftAnchorsPx || !this.calibrationFrame) return;
    const { calibrationAnchors } = applyCalibration(this.draftAnchorsPx, this.calibrationFrame);
    this.calibrationAnchors = calibrationAnchors;
    this.voice.say(calibrationVoice('done'), { interrupt: true });
    this._startReposition();
  }

  skipReposition() {
    if (this.state !== 'reposition') return;
    this.voice.say(calibrationVoice('reposition_approx_ok'), { interrupt: true });
    this._startCoverage();
  }

  _notifyPhase() {
    const data = this.state === 'adjusting' ? this.getAdjustmentPayload() : {};
    this.onPhase(this.state, data);
  }

  _startAdjusting(P, W, H) {
    this._captureSnapshot();
    this.state = 'adjusting';
    this.draftAnchorsPx = defaultAnchorsPx(P, W, H)
      ?? defaultAnchorsPx(this.frozenPoseP, W, H)
      ?? {};
    this.calibrationAnchors = {};
    this.onHud(0, 'AJUSTE LES 8 POINTS SUR TA PHOTO');
    this.voice.say(calibrationVoice('adjust_intro'), { interrupt: true });
    this._notifyPhase();
  }

  _startReposition() {
    this.state = 'reposition';
    this.repositionOkSince = 0;
    this.repositionStableFrames = 0;
    this.repositionStartedAt = performance.now();
    this.onHud(0, 'REPLACE-TOI (APPROX. OK)');
    this.voice.say(calibrationVoice('reposition_intro'), { interrupt: true });
    this._notifyPhase();
  }

  _repositionTick(P, ts, W) {
    const locked = this.calibrationFrame;

    if (!P || !locked || !this.lockedPoseSignature) {
      this.repositionStableFrames = 0;
      this.onHud(0, 'REPOSITION…');
      this.voice.say('Je ne te vois pas. Replace-toi dos à la caméra.', { id: 'repo:novis', cooldown: 7000 });
      return;
    }

    const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
    if (ls.visibility < 0.45 || rs.visibility < 0.45) {
      this.repositionStableFrames = 0;
      this.onHud(0, 'ÉPAULES NON VISIBLES');
      this.voice.say('Montre tes épaules à la caméra.', { id: 'repo:sh', cooldown: 7000 });
      return;
    }
    if (!isBackTurned(P, W)) {
      this.repositionStableFrames = 0;
      this.onHud(0, 'TOURNE-TOI');
      this.voice.say(calibrationVoice('reposition_turn'), { id: 'repo:turn', cooldown: 7000 });
      return;
    }

    const frame = torsoFrame(P);
    const liveSig = capturePoseSignature(P, frame ?? locked);
    const cmp = comparePoseSignature(liveSig, this.lockedPoseSignature);
    const enter = shouldEnterCoverage(cmp.score ?? cmp.pct ?? 0, this.repositionStableFrames);
    this.repositionStableFrames = enter.stableFrames;

    this.onHud(cmp.pct ?? 0, cmp.status);
    if (cmp.hint) {
      this.voice.say(calibrationVoice(cmp.hint) || calibrationVoice('reposition_shift'), {
        id: 'repo:' + cmp.hint,
        cooldown: 5000,
      });
    }

    if (enter.entered) {
      this.voice.say(cmp.ok ? calibrationVoice('reposition_ok') : calibrationVoice('reposition_approx_ok'), { interrupt: true });
      this._startCoverage();
    }
  }

  /** Contact → repère schéma unifié (backWarp → UV générique). */
  _toPaintUv(warpedPx, backU, backV) {
    return paintUvFromWarpedPixel(warpedPx, backU, backV, getMinimapLayout());
  }

  _startCoverage() {
    this._finalizeCalibration();
    this.backOrient.reset();
    this.orientWarnTs = 0;
    this.contactGate.reset();
    this.coachMode = 'precise';
    this.filters.gauche.u.reset();
    this.filters.gauche.v.reset();
    this.filters.droite.u.reset();
    this.filters.droite.v.reset();
    this.state = 'coverage';
    this.coverageStartedAt = performance.now();
    this.lastCaptureHintTs = this.coverageStartedAt + 6000;
    this.onHud(0, 'CRÈME DANS LES MAINS !');
    this.lastGapVoiceTs = 0;
    this.freePaintSince = performance.now();
    this._notifyPhase();
    this.voice.say(
      "C'est parti ! Frotte librement tout ton dos. Quand ça cliquette, ta main est détectée. " +
        'L’orange montre ce qui reste à faire, le vert ce qui est couvert.',
      { interrupt: true }
    );
  }

  // ---------------------------------------------------------------- couverture

  /** Zone torse + nuque (main qui monte au-dessus des épaules). */
  _pointNearTorso(p, frame) {
    const dx = p.x - frame.origin.x;
    const dy = p.y - frame.origin.y;
    const localX = dx * frame.ex.x + dy * frame.ex.y;
    const localY = dx * frame.ey.x + dy * frame.ey.y;
    return (
      Math.abs(localX) <= frame.width * 0.65 &&
      localY >= -frame.height * 0.38 &&
      localY <= frame.height * 1.08
    );
  }

  /**
   * Contacts pour la couverture : repère figé au scan + filtre anti-hallucination.
   * Pas de repli poignet pose (trop de faux positifs dos tourné).
   */
  _getCoverageContacts(track, P, liveFrame, lockedFrame, W, H, ts) {
    if (!lockedFrame || !P) return [];
    const out = [];

    const anchorPts = anchorAssistedContacts(
      P, track, lockedFrame, this.calibrationAnchors, W, H
    );
    const anchorUsed = new Set();
    for (const pt of anchorPts) {
      const f = this.filters[pt.name];
      const px = backToPx(pt.u, pt.v, lockedFrame);
      const layoutUv = this._toPaintUv(px, pt.u, pt.v);
      const sm = this.contactGate.clamp(pt.name, f.u.filter(layoutUv.u, ts), f.v.filter(layoutUv.v, ts));
      out.push({ name: pt.name, u: sm.u, v: sm.v });
      anchorUsed.add(pt.anchor);
    }

    const defs = [
      { hand: track.leftHand2D, poseWrist: LM.L_WRIST, name: 'gauche' },
      { hand: track.rightHand2D, poseWrist: LM.R_WRIST, name: 'droite' },
    ];

    for (const d of defs) {
      let rawPoints = [];

      if (d.hand?.length >= 21 && credibleBackHand(d.hand, P[d.poseWrist], P, W, H)) {
        rawPoints = handContactPixels(d.hand, W, H);
      }

      if (!rawPoints.length) {
        const w = P[d.poseWrist];
        if (crediblePoseWrist(w, P)) rawPoints = [w];
      }

      if (!rawPoints.length) {
        const est = elbowBackContact(P, d.name);
        if (est) rawPoints = [est];
      }

      const f = this.filters[d.name];
      for (const p of rawPoints) {
        const warped = liveFrame ? warpToLocked(p, liveFrame, lockedFrame) : p;
        if (!this._pointNearTorso(warped, lockedFrame)) continue;
        const raw = toBack(warped, lockedFrame);
        const layoutUv = this._toPaintUv(warped, raw.u, raw.v);
        const sm = this.contactGate.clamp(d.name, f.u.filter(layoutUv.u, ts), f.v.filter(layoutUv.v, ts));
        if (sm.v < 0.42 && anchorUsed.size > 0) continue;
        out.push({ name: d.name, u: sm.u, v: sm.v });
      }
    }
    return out;
  }

  _coverageTick(P, track, frame, ts, dt) {
    const W = this.overlay.width;
    const H = this.overlay.height;

    if (!P || !frame) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.paintedRatio, 'RECHERCHE DU TORSE…');
      return;
    }

    const backOk = this.backOrient.update(P, W);
    if (!backOk && ts - this.orientWarnTs > 15000) {
      this.orientWarnTs = ts;
      this.onHud(this.grid.paintedRatio, 'ORIENTATION : VÉRIFIE LE DOS');
      this.voice.say('Reste bien dos à la caméra.', { id: 'stayback', cooldown: 15000 });
    }

    const paintFrame = this.calibrationFrame || frame;
    const contacts = this._getCoverageContacts(
      track, P, frame, paintFrame, W, H, ts
    );

    const confL = handConfidence(track.leftHand2D, P, LM.L_WRIST, LM.L_ELBOW);
    const confR = handConfidence(track.rightHand2D, P, LM.R_WRIST, LM.R_ELBOW);
    this.coachMode = updateCoachMode(Math.max(confL, confR), this.coachMode);

    const painting = contacts.filter((h) => nearBackShape(h.u, h.v));

    let added = 0, crossed = 0;
    if (this.coachMode === 'degraded' && painting.length > 0) {
      const near = this.grid.nearestZone(painting[0].u, painting[0].v);
      if (near) ({ added, crossed } = this.grid.paintZone(near.idx, dt));
    } else {
      ({ added, crossed } = this.grid.update(painting, dt));
    }

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
        'Je vois ton bras mais pas sur le dos enregistré. Reste dos à la caméra, frotte lentement.',
        { queue: true }
      );
    } else if (
      contacts.length === 0 &&
      (this.lastPaintTs.new === 0 || ts - this.lastPaintTs.new > 10000) &&
      ts - this.lastCaptureHintTs > 14000
    ) {
      this.lastCaptureHintTs = ts;
      this.voice.say(
        'Je ne capte pas ta main. Colle la paume à plat sur le dos et frotte lentement.',
        { queue: true }
      );
    }

    for (const h of painting) {
      if (ts - this.lastPathTs[h.name] > 80) {
        this.lastPathTs[h.name] = ts;
        this.paths[h.name].push({ u: h.u, v: h.v });
      }
    }

    const painted = this.grid.paintedRatio;
    const pct = Math.round(painted * 100);
    const gap = this.grid.biggestGap();
    const modeLabel = this.coachMode === 'degraded' ? ' · ZONE APPROX' : '';

    if (pct >= 0.5 && this.lastMilestone < 0.5) {
      this.lastMilestone = 0.5;
      this.voice.say('La moitié du dos est couverte, continue !', { queue: true });
    }

    if (this.grid.done) {
      const elapsedSec = (performance.now() - this.coverageStartedAt) / 1000;
      if (elapsedSec >= MIN_COVERAGE_SEC) return this._finish();
    }

    this.onHud(painted, (gap ? gapShort(gap) : `${pct} % COUVERT`) + modeLabel);

    const elapsed = ts - this.freePaintSince;
    if (
      gap &&
      elapsed > 10000 &&
      ts - this.lastGapVoiceTs > 14000 &&
      !this.voice.busy
    ) {
      this.lastGapVoiceTs = ts;
      this.voice.say(gapMessage(gap), { id: 'gap:' + gap.zone.id, cooldown: 14000 });
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
      outline: customBackOutlineUV(),
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
      'Bravo ! Ton dos est bien couvert. Pense à en remettre dans deux heures, ou après la baignade.',
      { interrupt: true }
    );
    this.onDone(result);
  }

  // ---------------------------------------------------------------- rendu

  _renderMiniHeat() {
    const px = this.miniImage.data;
    for (let i = 0; i < HEAT_W * HEAT_H; i++) {
      const o = i * 4;
      if (!this.grid.isBody(i)) {
        px[o + 3] = 0;
        continue;
      }
      const [r, g, b, a] = coverageHeatRGBA(this.grid.pixelFraction(i));
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
    }
    this.miniCtx.putImageData(this.miniImage, 0, 0);
  }

  _traceBackPath(c, toX, toY) {
    const outline = customBackOutlineUV();
    if (outline?.length >= 4) {
      c.beginPath();
      outline.forEach((p, i) => {
        const x = toX(p.u);
        const y = toY(p.v);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.closePath();
      return;
    }
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

  _minimapViewport(W, H) {
    const layout = getMinimapLayout();
    const pad = 6;
    const labelH = 14;
    const availW = W - 2 * pad;
    const availH = H - 2 * pad - labelH;
    const aspect = layout?.aspect ?? 0.55;

    let mapW, mapH;
    if (availW / availH > aspect) {
      mapH = availH;
      mapW = mapH * aspect;
    } else {
      mapW = availW;
      mapH = mapW / aspect;
    }
    const ox = pad + (availW - mapW) / 2;
    const oy = pad + (availH - mapH) / 2;
    return {
      mapW, mapH, ox, oy,
      toX: (u) => ox + u * mapW,
      toY: (v) => oy + v * mapH,
      customShape: !!layout,
    };
  }

  _drawMinimap(ts) {
    if (!this.minimapCtx) return;
    const c = this.minimapCtx;
    const W = this.minimapLogicalW ?? this.minimap.width;
    const H = this.minimapLogicalH ?? this.minimap.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0, 0, 0, 0.78)';
    c.fillRect(0, 0, W, H);

    const vp = this._minimapViewport(W, H);
    const { toX, toY, customShape } = vp;
    const cx = W / 2;

    if (!customShape) {
      const headH = H * 0.16;
      c.beginPath();
      c.arc(cx, headH * 0.45, headH * 0.34, 0, Math.PI * 2);
      c.fillStyle = 'rgba(120, 130, 120, 0.9)';
      c.fill();
      c.fillRect(cx - headH * 0.13, headH * 0.7, headH * 0.26, headH * 0.35);
    }

    this._renderMiniHeat();

    c.save();
    this._traceBackPath(c, toX, toY);
    c.clip();
    c.imageSmoothingEnabled = true;
    c.drawImage(this.miniCanvas, vp.ox, vp.oy, vp.mapW, vp.mapH);

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
    c.strokeStyle = 'rgba(0, 255, 0, 0.85)';
    c.lineWidth = 2;
    c.stroke();

    c.font = '9px Fira Code, monospace';
    c.fillStyle = 'rgba(0, 255, 0, 0.7)';
    c.textAlign = 'left';
    c.fillText('G', vp.ox + 2, vp.oy + 10);
    c.textAlign = 'right';
    c.fillText('D', vp.ox + vp.mapW - 2, vp.oy + 10);

    if (this.state === 'locking' && this.maskLock) {
      const pct = Math.round((this.maskLock.count / LOCK_FRAMES) * 100);
      c.font = 'bold 16px Fira Code, monospace';
      c.textAlign = 'center';
      c.fillStyle = '#00FF00';
      c.fillText('SCAN ' + pct + '%', cx, H - 6);
    }

    if (this.state === 'reposition') {
      c.font = 'bold 14px Fira Code, monospace';
      c.textAlign = 'center';
      c.fillStyle = '#FF9900';
      c.fillText('REPLACE-TOI', cx, H - 6);
    }

    if (this.state === 'coverage') {
      const gap = this.grid.biggestGap();
      if (gap) {
        const z = gap.zone;
        c.save();
        c.strokeStyle = 'rgba(255, 50, 50, 0.95)';
        c.lineWidth = 2.5;
        c.setLineDash([4, 3]);
        c.beginPath();
        c.rect(toX(z.u0), toY(z.v0), toX(z.u1) - toX(z.u0), toY(z.v1) - toY(z.v0));
        c.stroke();
        c.restore();
      }

      const pct = Math.round(this.grid.paintedRatio * 100);
      c.font = 'bold 20px Fira Code, monospace';
      c.textAlign = 'center';
      c.fillStyle = '#00FF00';
      c.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      c.lineWidth = 3;
      c.strokeText(pct + '%', cx, H - 6);
      c.fillText(pct + '%', cx, H - 6);
    }

    if (isDebugMinimap()) {
      c.font = '7px Fira Code, monospace';
      c.fillStyle = 'rgba(255, 255, 0, 0.95)';
      c.textAlign = 'left';
      const dbg = [
        minimapDebugInfo(this.minimap),
        `state ${this.state} · coach ${this.coachMode}`,
        `warp ${getBackWarp() ? 'on' : 'off'} · body ${this.grid.heat.length}`,
      ];
      dbg.forEach((line, i) => c.fillText(line, 4, 10 + i * 9));
    }
  }

  _drawOverlay(P, frame, track, ts, W, H) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    if (this.state === 'locking') {
      if (this.smoothMask) {
        drawBackSegmentationOverlay(ctx, this.smoothMask, W, H, {
          contour: this.backContour,
          grid: null,
          frame: this.calibrationFrame || frame,
          showCoverage: false,
        });
      }
      return;
    }

    if (this.state === 'adjusting') return;

    const paintFrame = this.calibrationFrame || frame;
    const mask = this.frozenMask || this.smoothMask;

    if (this.state === 'reposition') {
      if (mask) {
        drawBackSegmentationOverlay(ctx, mask, W, H, {
          contour: this.backContour,
          grid: null,
          frame: paintFrame,
          showCoverage: false,
        });
      }
      return;
    }

    if (!frame && !mask) return;

    if (mask) {
      drawBackSegmentationOverlay(ctx, mask, W, H, {
        contour: this.backContour,
        grid: this.state === 'coverage' ? this.grid : null,
        frame: paintFrame,
        showCoverage: this.state === 'coverage',
      });
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

export { ZONE_COUNT, HEAT_W, HEAT_H, ANATOMICAL_ZONES };
