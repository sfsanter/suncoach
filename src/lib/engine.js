/**
 * Moteur de session.
 * Couverture = stack labo validé (?vidhands=1) :
 * PoseLandmarker + HandLandmarker + torsoAffine → warp.toGenericUv.
 * Ancien chemin Holistic / warpToLocked / handGate cascade : retiré de la peinture.
 */
import { Voice, Beeper } from './voice.js';
import { PoseTracker, LM, isBackTurned, OneEuro, BackOrientation, palmFromHand } from './pose.js';
import {
  CoverageGrid, torsoFrame, backHalfWidth,
  nearBackShape, coverageHeatRGBA, setShapeScale,
  setTracedContour, customBackOutlineUV, setCustomBackAnchors,
  setMinimapLayout, getMinimapLayout, paintUvFromWarpedPixel,
  getBackWarp,
  HEAT_W, HEAT_H, ZONE_COUNT, ANATOMICAL_ZONES, MIN_COVERAGE_SEC,
} from './coverage.js';
import {
  estimateSubjectDistance, touchDistanceForRange, formatDistance,
} from './calibration.js';
import { gapMessage, gapShort, calibrationVoice } from './tips.js';
import { LOCK_FRAMES } from './maskLock.js';
import { cloneFrame } from './backTemplate.js';
import {
  defaultAnchorsPx,
  capturePoseSignature, comparePoseSignature, shouldEnterCoverage,
} from './anchorShape.js';
import { applyCalibration } from './sessionCore.js';
import { isDebugMinimap, minimapDebugInfo, setupMinimapCanvas, MINIMAP_CSS_W, MINIMAP_CSS_H } from './minimapCanvas.js';
import { ContactVelocityGate } from './handGate.js';
import { BACK_ANCHOR_ORDER } from './backWarp.js';
import {
  drawMinimapScene,
  drawMappedHeatCells,
  strokeMappedPath,
  strokeMappedZone,
} from './minimapRender.js';
import {
  buildBackSilhouette, buildFallbackSilhouette, buildBackSilhouetteFromBytes,
  traceBackContour, drawBackSegmentationOverlay,
} from './segmentation.js';
import { updateStandStill, STILL_DURATION_MS, torsoMotionFrac } from './standStill.js';
import { refineBackAnchorsFromFrame } from './skinEdgeRefine.js';
import {
  torsoAttachTransform,
  torsoCornersFromPose,
  blendAffineParams,
} from './torsoAffine.js';
import { contactsFromHandLandmarker } from './handLandmarker.js';

/** Compte à rebours audible avant photo (ms). */
const PHOTO_COUNTDOWN_MS = 3000;

/** `?adjust=1` force l’écran 8 points manuel ; sinon auto-calibration. */
function wantManualAdjust() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('adjust');
  } catch {
    return false;
  }
}

export class SunCoachEngine {
  constructor({ video, overlay, minimap, onHud, onDone, onPhase, replaySource = null }) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.minimap = minimap || null;
    this.minimapCtx = minimap ? minimap.getContext('2d') : null;
    this.onHud = onHud;
    this.onDone = onDone;
    this.onPhase = onPhase || (() => {});
    this.replaySource = replaySource;
    this.replayMode = !!replaySource;

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
    this._released = false;
    this.voice.unlock();
    this.beeper.unlock();
    this.onHud(0, 'TÉLÉCHARGEMENT IA (~13 Mo, 1re fois)…');
    if (!this.tracker.landmarker) await this.tracker.init();
    if (this.replaySource) {
      this.onHud(0, 'CHARGEMENT DE LA VIDÉO…');
      await this.tracker.startVideoFile(this.replaySource, { loop: false });
    } else {
      this.onHud(0, 'DÉMARRAGE DE LA CAMÉRA…');
      await this.tracker.startCamera();
    }
    // Ne PAS charger BodySegmenter ici : 3e modèle WASM + GPU pendant la
    // caméra fait planter Safari iPhone au moment du « Parfait / scan dos ».

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
    this.lockPoseP = null;
    this.lockSnapshotDone = false;
    this.lockSub = null;
    this.stillState = { lastCloud: null, stillSince: null, fired: false };
    this.countdownEndsAt = 0;
    this.countdownSaid = null;
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
    /** @type {{ corners: any, lastXf: any, xfSmooth: any }|null} */
    this.torsoLock = null;

    this.state = 'placement';
    this.onHud(0, 'PLACEMENT…');
    this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.voice.say(
      'Bienvenue ! Mets-toi dos à la caméra, à environ deux mètres.',
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
    if (this.replayMode) return;
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
    this._lastP = P;
    const frame = this._smoothTorso(P ? torsoFrame(P) : null);

    if (P) {
      const useFrozen = this.frozenMask && this.state !== 'placement';
      const skipSeg = this.state === 'locking' || this.state === 'adjusting' || useFrozen;
      if (!skipSeg) {
        if (track.aiPersonMask) {
          this.smoothMask = buildBackSilhouetteFromBytes(
            track.aiPersonMask, P, W, H, this.smoothMask
          );
        } else if (track.segmentationMask) {
          this.smoothMask = buildBackSilhouette(track.segmentationMask, P, W, H, this.smoothMask);
        }
        // Pas de buildFallbackSilhouette chaque frame (W×H) — OOM iPhone.
        this.backContour = this.smoothMask
          ? traceBackContour(this.smoothMask, W, H)
          : null;
      }
      if (this.state === 'placement' && track.segmentationMask && frame) {
        this._sampleShapeFromMask(track.segmentationMask, P, frame, W, H);
      }
    }

    // State ticks avant draw : paint + affine à jour pour la projection live.
    if (this.state === 'placement') this._placementTick(P, ts, frame);
    else if (this.state === 'locking') this._lockingTick(P, track, frame, ts, W, H);
    else if (this.state === 'adjusting') { /* pose en pause — ajustement écran */ }
    else if (this.state === 'reposition') this._repositionTick(P, ts, W);
    else if (this.state === 'coverage') this._coverageTick(P, track, frame, ts, dt);

    this._drawOverlay(P, frame, track, ts, W, H);
    this._drawMinimap(ts);
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
      return fail(
        'Tourne-toi, dos à la caméra.',
        'turn',
        'ORIENTATION : PAS ENCORE DOS — ATTENDS / AVANCE LA VIDÉO',
      );
    }

    const distM = estimateSubjectDistance(shoulderW, W);
    this.distSamples.push(distM);
    if (this.distSamples.length > 40) this.distSamples.shift();

    this.onHud(0, `CALIBRAGE… DIST. ${formatDistance(distM)}`);
    if (!this.placementOkSince) this.placementOkSince = ts;
    // Placement OK ~0.4 s → phase « reste immobile » (pas la photo tout de suite).
    if (ts - this.placementOkSince > 400) this._beginStandStill(frame);
  }

  /** Voix + stand-still + compte à rebours, photo seulement si toujours immobile. */
  _beginStandStill(frame) {
    this._finalizeCalibration();
    this.state = 'locking';
    this.lockSub = 'still';
    this.lockStartedAt = performance.now();
    this.calibrationFrame = frame ? cloneFrame(frame) : null;
    this.maskLock = null;
    this.tracker.aiSegEnabled = false;
    this.stillState = { lastCloud: null, stillSince: null, fired: false };
    this.countdownEndsAt = 0;
    this.countdownSaid = null;
    this.onHud(0, 'RESTE IMMOBILE');
    this.voice.say(
      'Parfait. Reste bien droit et immobile, dos à la caméra. '
      + 'Je compte jusqu’à trois, puis je prends la photo.',
      { interrupt: true },
    );
  }

  _abortStandStill(msg, status) {
    this.lockSub = 'still';
    this.stillState = { lastCloud: null, stillSince: null, fired: false };
    this.countdownEndsAt = 0;
    this.countdownSaid = null;
    this.onHud(0, status);
    this.voice.say(msg, { id: 'still:abort', cooldown: 3500, interrupt: true });
  }

  _lockingTick(P, track, frame, ts, W, H) {
    if (this.lockSub === 'done') return;

    if (!P || !isBackTurned(P, W)) {
      this._abortStandStill(
        'Je ne te vois plus bien de dos. Remets-toi droit, dos à la caméra.',
        'DOS REQUIS',
      );
      return;
    }

    const cloud = torsoCornersFromPose(P, LM);
    if (!cloud) {
      this.onHud(0, 'ÉPAULES / HANCHES…');
      return;
    }

    if (this.lockSub === 'still') {
      const result = updateStandStill(this.stillState, cloud, ts, {
        durationMs: STILL_DURATION_MS,
      });
      this.onHud(result.progress, `RESTE IMMOBILE ${Math.round(result.progress * 100)} %`);
      if (result.justFired) {
        this.lockSub = 'countdown';
        this.countdownEndsAt = ts + PHOTO_COUNTDOWN_MS;
        this.countdownSaid = 3;
        this.onHud(0.2, 'PHOTO DANS 3…');
        this.voice.say('Trois.', { interrupt: true });
        this.beeper.beep(660, 0.08, 0.12);
      }
      return;
    }

    if (this.lockSub !== 'countdown') return;

    // Annuler si mouvement trop fort pendant le compte à rebours.
    const motion = torsoMotionFrac(this.stillState.lastCloud, cloud);
    this.stillState.lastCloud = cloud.map((p) => ({ x: p.x, y: p.y }));
    if (Number.isFinite(motion) && motion > 0.045) {
      this._abortStandStill(
        'Tu as bougé. Remets-toi droit et reste immobile.',
        'BOUGÉ — RECOMMENCE',
      );
      return;
    }

    const left = this.countdownEndsAt - ts;
    const sec = Math.max(1, Math.ceil(left / 1000));
    if (sec !== this.countdownSaid && sec >= 1 && left > 0) {
      this.countdownSaid = sec;
      const words = { 3: 'Trois.', 2: 'Deux.', 1: 'Un.' };
      this.voice.say(words[sec] || String(sec), { interrupt: true });
      this.beeper.beep(sec === 1 ? 880 : 660, 0.08, 0.12);
    }
    this.onHud(
      Math.min(1, 1 - left / PHOTO_COUNTDOWN_MS),
      left > 0 ? `PHOTO DANS ${sec}…` : 'PHOTO…',
    );

    if (left > 0) return;

    this.lockSub = 'done';
    try {
      this._completePhotoLock(P, frame, W, H);
    } catch (err) {
      console.error('[SunCoach] photo lock failed:', err);
      this.lockSub = 'still';
      this._emergencyAdjust(P, W, H);
    }
  }

  /**
   * Photo + ancres auto (pose + snap peau). Skip 8 points sauf `?adjust=1`.
   */
  _completePhotoLock(P, frame, W, H) {
    const calFrame = this.calibrationFrame || (frame ? cloneFrame(frame) : null);
    this.calibrationFrame = calFrame;

    this.lockPoseP = P.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));
    this.frozenPoseP = this.lockPoseP;
    const ls = P[LM.L_SHOULDER];
    const rs = P[LM.R_SHOULDER];
    if (ls && rs) {
      this.lockedShoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
      this.lockedMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    }
    if (calFrame) {
      this.lockedPoseSignature = capturePoseSignature(P, calFrame);
    }

    try {
      this._captureSnapshot();
      this.lockSnapshotDone = true;
    } catch (err) {
      console.warn('[SunCoach] snapshot failed:', err);
      this.lockSnapshotDone = false;
    }

    let anchors = defaultAnchorsPx(P, W, H) || {};
    try {
      const maxSide = 512;
      const scale = Math.min(1, maxSide / Math.max(W, H));
      const rw = Math.max(1, Math.round(W * scale));
      const rh = Math.max(1, Math.round(H * scale));
      const scaled = {};
      for (const [id, p] of Object.entries(anchors)) {
        if (p) scaled[id] = { x: p.x * scale, y: p.y * scale };
      }
      const skin = refineBackAnchorsFromFrame(this.video, rw, rh, scaled);
      if (skin?.ok && skin.anchors) {
        anchors = {};
        for (const [id, p] of Object.entries(skin.anchors)) {
          if (p) anchors[id] = { x: p.x / scale, y: p.y / scale };
        }
      }
    } catch (err) {
      console.warn('[SunCoach] skin refine skipped:', err);
    }

    this.frozenMask = null;
    this.smoothMask = null;
    this.backContour = null;
    this.maskLock = null;
    this.tracker.pause();

    if (wantManualAdjust()) {
      this.draftAnchorsPx = anchors;
      this.onHud(1, 'AJUSTE LES POINTS');
      this.voice.say('Photo prise. Ajuste les points verts si besoin, puis valide.', {
        interrupt: true,
      });
      this._startAdjusting(P, W, H);
      return;
    }

    // Auto : pas d’écran 8 points.
    this.draftAnchorsPx = anchors;
    if (calFrame) {
      const { calibrationAnchors } = applyCalibration(anchors, calFrame);
      this.calibrationAnchors = calibrationAnchors;
    } else {
      this.calibrationAnchors = {};
    }

    this.beeper.beep(1047, 0.12, 0.14);
    this.onHud(1, 'PHOTO OK');
    this.voice.say(
      'Photo prise. Tourne-toi vers l’écran et replace-toi approximativement.',
      { interrupt: true },
    );
    this._startReposition();
  }

  /** Dernier recours : écran 8 points même si silhouette / masque plante. */
  _emergencyAdjust(P, W, H) {
    this.tracker.aiSegEnabled = false;
    this.tracker.pause();
    this.maskLock = null;
    this.frozenMask = null;
    this.smoothMask = null;
    this.backContour = null;
    if (P) {
      this.frozenPoseP = P.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));
      const ls = P[LM.L_SHOULDER];
      const rs = P[LM.R_SHOULDER];
      if (ls && rs) {
        this.lockedShoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
        this.lockedMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
      }
    }
    try {
      if (!this.lockSnapshotDone || !this.snapshotDataUrl) this._captureSnapshot();
    } catch { /* ignore */ }
    this._startAdjusting(P, W, H);
  }

  _finalizeLock(calFrame, P, W, H) {
    // Legacy path — unused after instant lock; keep for harness / safety.
    this.tracker.aiSegEnabled = false;
    this.frozenMask = null;
    this.smoothMask = null;
    this.backContour = null;
    if (P) {
      this.frozenPoseP = P.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));
      const ls = P[LM.L_SHOULDER];
      const rs = P[LM.R_SHOULDER];
      if (ls && rs) {
        this.lockedShoulderW = Math.hypot(rs.x - ls.x, rs.y - ls.y);
        this.lockedMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
      }
      this.lockedPoseSignature = capturePoseSignature(P, calFrame);
    }
    this.maskLock = null;
    this._startAdjusting(P, W, H);
  }

  /**
   * Photo légère pour l’UI (max ~512 px). Ancres restent en coords vidéo pleine
   * (même aspect → % sur l’image affichée).
   */
  _captureSnapshot() {
    const srcW = this.video.videoWidth;
    const srcH = this.video.videoHeight;
    if (!srcW || !srcH) return;
    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(srcW * scale));
    c.height = Math.max(1, Math.round(srcH * scale));
    c.getContext('2d').drawImage(this.video, 0, 0, c.width, c.height);
    this.snapshotDataUrl = c.toDataURL('image/jpeg', 0.48);
    // Logical size for anchors = live overlay (full), not the JPEG pixels.
    this.snapshotW = this.overlay.width || srcW;
    this.snapshotH = this.overlay.height || srcH;
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
    if (!this.lockSnapshotDone || !this.snapshotDataUrl) {
      try {
        this._captureSnapshot();
      } catch (err) {
        console.warn('[SunCoach] late snapshot failed:', err);
      }
    }
    this.tracker.pause();
    this.state = 'adjusting';
    const pose = this.lockPoseP || P || this.frozenPoseP;
    const adjW = this.snapshotW || W;
    const adjH = this.snapshotH || H;
    if (!this.draftAnchorsPx || !Object.keys(this.draftAnchorsPx).length) {
      this.draftAnchorsPx = defaultAnchorsPx(pose, adjW, adjH)
        ?? defaultAnchorsPx(this.frozenPoseP, adjW, adjH)
        ?? {};
    }
    this.calibrationAnchors = {};
    this.onHud(0, 'GLISSE LES 8 POINTS SUR LE BORD DU DOS');
    this._notifyPhase();
  }

  _startReposition() {
    this.state = 'reposition';
    this.repositionOkSince = 0;
    this.repositionStableFrames = 0;
    this.repositionStartedAt = performance.now();
    this.tracker.resume();
    this.onHud(0, 'REPLACE-TOI (APPROX. OK)');
    this.voice.say(calibrationVoice('reposition_intro'), { interrupt: true });
    this._notifyPhase();
  }

  _repositionTick(P, ts, W) {
    const locked = this.calibrationFrame;
    const elapsed = performance.now() - this.repositionStartedAt;
    const fallbackMs = 12000;

    // Le repositionnement guide mais ne doit jamais bloquer la couverture.
    if (elapsed >= fallbackMs) {
      this.voice.say(calibrationVoice('reposition_approx_ok'), { interrupt: true });
      this._startCoverage();
      return;
    }

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

  /** Contact → UV peinture (legacy helper — paint path labo n’utilise plus ceci). */
  _toPaintUv(warpedPx, backU, backV) {
    return paintUvFromWarpedPixel(warpedPx, backU, backV, getMinimapLayout());
  }

  _startCoverage() {
    this._finalizeCalibration();
    this.tracker.resume();
    this.backOrient.reset();
    this.orientWarnTs = 0;
    this.contactGate.reset();
    this.coachMode = 'precise';
    this.filters.gauche.u.reset();
    this.filters.gauche.v.reset();
    this.filters.droite.u.reset();
    this.filters.droite.v.reset();

    // Lock torse sur la pose LIVE (après reposition), pas la photo figée
    const pose = this._lastP || this.lockPoseP || this.frozenPoseP;
    const corners = pose ? torsoCornersFromPose(pose, LM) : null;
    this.torsoLock = {
      corners,
      lastXf: null,
      xfSmooth: null,
    };

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

  // ---------------------------------------------------------------- couverture (stack labo — source de vérité : ?vidhands=1)

  /** Affine lock→live (met à jour torsoLock.lastXf). */
  _resolveTorsoXf(P) {
    const lock = this.torsoLock;
    if (!lock?.corners || !P) return lock?.lastXf || null;
    const liveCorners = torsoCornersFromPose(P, LM);
    if (!liveCorners) return lock.lastXf || null;
    let xf = torsoAttachTransform(lock.corners, liveCorners);
    if (xf?.ok) {
      if (xf.kind === 'affine') {
        xf = blendAffineParams(lock.xfSmooth, xf, 0.25) || xf;
        if (xf.kind === 'affine') lock.xfSmooth = xf;
      } else {
        lock.xfSmooth = null;
      }
      lock.lastXf = xf;
      return xf;
    }
    return lock.lastXf || null;
  }

  /**
   * Contacts Hand Landmarker → UV générique via affine inverse (labo).
   * Pas de Holistic / warpToLocked / cascade poignet-coude.
   */
  _getCoverageContactsLab(track, P, W, H, ts) {
    const warp = getBackWarp();
    if (!warp || !P) return [];

    const xf = this._resolveTorsoXf(P);
    const toWarpPixel = xf?.inv ? (p) => xf.inv(p) : (p) => p;

    const out = contactsFromHandLandmarker(
      track.handLandmarkerResult,
      W,
      H,
      warp,
      'session-lab',
      { toWarpPixel },
    );

    const painting = [];
    for (const c of out.contacts) {
      if (!c.uv) continue;
      const name = c.name === 'gauche' || c.name === 'droite' ? c.name : 'droite';
      const f = this.filters[name] || this.filters.droite;
      const sm = this.contactGate.clamp(
        name,
        f.u.filter(c.uv.u, ts),
        f.v.filter(c.uv.v, ts),
      );
      painting.push({ name, u: sm.u, v: sm.v });
    }
    return painting;
  }

  _coverageTick(P, track, frame, ts, dt) {
    const W = this.overlay.width;
    const H = this.overlay.height;

    if (!P) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.paintedRatio, 'RECHERCHE DU TORSE…');
      return;
    }

    const backNow = isBackTurned(P, W);
    const backStable = this.backOrient.update(P, W);
    if (!backNow || !backStable) {
      this.beeper.setPaintActivity('off');
      this.onHud(this.grid.paintedRatio, 'TOURNE LE DOS — PEINTURE EN PAUSE');
      if (ts - this.orientWarnTs > 7000) {
        this.orientWarnTs = ts;
        this.voice.say(
          'Tourne le dos à la caméra. La couverture est en pause.',
          { id: 'stayback', cooldown: 7000 },
        );
      }
      return;
    }

    // Si pas de corners au start, tente un lock tardif (reposture)
    if (this.torsoLock && !this.torsoLock.corners) {
      const late = torsoCornersFromPose(P, LM);
      if (late) this.torsoLock.corners = late;
    }

    const contacts = this._getCoverageContactsLab(track, P, W, H, ts);
    this.coachMode = contacts.length ? 'precise' : 'precise';

    const painting = contacts.filter((h) => nearBackShape(h.u, h.v));
    const { added, crossed } = this.grid.update(painting, dt);

    if (crossed > 0 || added > dt * 0.25) this.lastPaintTs.new = ts;
    else if (painting.length > 0) this.lastPaintTs.old = ts;
    if (ts - this.lastPaintTs.new < 350) this.beeper.setPaintActivity('new');
    else if (ts - this.lastPaintTs.old < 350) this.beeper.setPaintActivity('old');
    else this.beeper.setPaintActivity('off');
    this.beeper.tick(ts);

    if (
      (track.handLandmarkerResult?.landmarks?.length > 0) &&
      painting.length === 0 &&
      (this.lastPaintTs.new === 0 || ts - this.lastPaintTs.new > 8000) &&
      ts - this.lastCaptureHintTs > 12000
    ) {
      this.lastCaptureHintTs = ts;
      this.voice.say(
        'Je vois une main mais pas sur le dos enregistré. Reste dos à la caméra, frotte lentement.',
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

    if (pct >= 0.5 && this.lastMilestone < 0.5) {
      this.lastMilestone = 0.5;
      this.voice.say('La moitié du dos est couverte, continue !', { queue: true });
    }

    if (this.grid.done) {
      const elapsedSec = (performance.now() - this.coverageStartedAt) / 1000;
      if (elapsedSec >= MIN_COVERAGE_SEC) return this._finish();
    }

    this.onHud(painted, gap ? gapShort(gap) : `${pct} % COUVERT`);

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
    const warp = getBackWarp();
    return {
      aborted,
      seconds: Math.round((performance.now() - this.coverageStartedAt) / 1000),
      paintedRatio: this.grid.paintedRatio,
      zonesCovered,
      zonesTotal: ZONE_COUNT,
      heat: this.grid.snapshot(),
      paths: this.paths,
      outline: customBackOutlineUV(),
      displayAnchors: warp?.displayAnchors ?? null,
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

  /** État sérialisable pour le panneau test (?test=1) — sans refs DOM. */
  getDebugBundle() {
    const outline = customBackOutlineUV();
    const warp = getBackWarp();
    return {
      state: this.state,
      coachMode: this.coachMode,
      paintedRatio: this.grid?.paintedRatio ?? 0,
      warpActive: !!warp,
      outlineSpace: 'display_uv',
      calibrationAnchorSpace: 'generic_uv',
      outlinePointCount: outline?.length ?? 0,
      outline: outline?.map((p) => ({ u: p.u, v: p.v })) ?? null,
      draftAnchorsPx: this.draftAnchorsPx ? { ...this.draftAnchorsPx } : null,
      calibrationAnchors: this.calibrationAnchors
        ? Object.fromEntries(
            Object.entries(this.calibrationAnchors).map(([k, v]) => [k, { u: v.u, v: v.v }])
          )
        : null,
      minimap: this.minimap
        ? {
            bufferW: this.minimap.width,
            bufferH: this.minimap.height,
            cssW: this.minimap.style?.width ?? null,
            cssH: this.minimap.style?.height ?? null,
            logicalW: this.minimapLogicalW ?? null,
            logicalH: this.minimapLogicalH ?? null,
            debugInfo: minimapDebugInfo(this.minimap),
          }
        : null,
      snapshotSize: this.snapshotW && this.snapshotH
        ? { w: this.snapshotW, h: this.snapshotH }
        : null,
      calibrationFrame: this.calibrationFrame
        ? {
            origin: { ...this.calibrationFrame.origin },
            width: this.calibrationFrame.width,
            height: this.calibrationFrame.height,
          }
        : null,
      zonesCovered: (() => {
        let n = 0;
        for (let i = 0; i < ZONE_COUNT; i++) if (this.grid?.isCovered?.(i)) n++;
        return n;
      })(),
      zonesTotal: ZONE_COUNT,
    };
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
    const warp = getBackWarp();
    const pad = 6;
    const labelH = 14;
    const availW = W - 2 * pad;
    const availH = H - 2 * pad - labelH;
    const aspect = warp?.displayAspect ?? layout?.aspect ?? 0.55;

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
      customShape: !!(warp || layout),
    };
  }

  _drawMinimap(ts) {
    if (!this.minimapCtx) return;
    const c = this.minimapCtx;
    const W = this.minimapLogicalW ?? this.minimap.width;
    const H = this.minimapLogicalH ?? this.minimap.height;
    const activeWarp = getBackWarp();

    if (activeWarp) {
      const gap = this.state === 'coverage' ? this.grid.biggestGap() : null;
      const scene = drawMinimapScene(c, {
        width: W,
        height: H,
        warp: activeWarp,
        heat: {
          w: HEAT_W,
          h: HEAT_H,
          isBody: (index) => this.grid.isBody(index),
          fractionAt: (index) => this.grid.pixelFraction(index),
        },
        colorForFraction: coverageHeatRGBA,
        paths: {
          gauche: this.paths.gauche.slice(-50),
          droite: this.paths.droite.slice(-50),
        },
        gapZone: gap?.zone ?? null,
      });

      const cx = W / 2;
      if (this.state === 'reposition') {
        c.font = 'bold 12px Fira Code, monospace';
        c.textAlign = 'center';
        c.fillStyle = '#FF9900';
        c.fillText('REPLACE-TOI', cx, H - 5);
      } else if (this.state === 'coverage') {
        const pct = Math.round(this.grid.paintedRatio * 100);
        c.font = 'bold 18px Fira Code, monospace';
        c.textAlign = 'center';
        c.fillStyle = '#00FF00';
        c.strokeStyle = 'rgba(0,0,0,0.9)';
        c.lineWidth = 3;
        c.strokeText(pct + '%', cx, H - 5);
        c.fillText(pct + '%', cx, H - 5);
      }

      if (isDebugMinimap() && scene) {
        c.font = '7px Fira Code, monospace';
        c.fillStyle = '#FFFF00';
        c.textAlign = 'left';
        [
          minimapDebugInfo(this.minimap),
          `state ${this.state} · coach ${this.coachMode}`,
          `warp on · body ${this.grid.heat.length}`,
        ].forEach((line, index) => c.fillText(line, 3, 9 + index * 8));
        activeWarp.outline.forEach((point, index) => {
          const x = scene.toX(point.u);
          const y = scene.toY(point.v);
          c.beginPath();
          c.arc(x, y, 2, 0, Math.PI * 2);
          c.fill();
          c.fillText(BACK_ANCHOR_ORDER[index], x + 3, y);
        });
      }
      return;
    }

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

    c.save();
    this._traceBackPath(c, toX, toY);
    c.clip();
    const warp = getBackWarp();
    if (warp) {
      drawMappedHeatCells(
        c,
        {
          w: HEAT_W,
          h: HEAT_H,
          isBody: (index) => this.grid.isBody(index),
          fractionAt: (index) => this.grid.pixelFraction(index),
        },
        warp,
        toX,
        toY,
        coverageHeatRGBA,
      );
    } else {
      this._renderMiniHeat();
      c.imageSmoothingEnabled = true;
      c.drawImage(this.miniCanvas, vp.ox, vp.oy, vp.mapW, vp.mapH);
    }

    if (this.paths) {
      const trail = (path, color) => {
        const pts = path.slice(-50);
        c.globalAlpha = 0.85;
        strokeMappedPath(c, pts, warp, toX, toY, color, 2);
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
        c.setLineDash([4, 3]);
        strokeMappedZone(c, z, warp, toX, toY, 'rgba(255, 50, 50, 0.95)', 2.5);
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
      if (warp?.outline?.length === BACK_ANCHOR_ORDER.length) {
        warp.outline.forEach((point, index) => {
          const x = toX(point.u);
          const y = toY(point.v);
          c.beginPath();
          c.arc(x, y, 2, 0, Math.PI * 2);
          c.fillStyle = '#FFFF00';
          c.fill();
          c.fillText(BACK_ANCHOR_ORDER[index], x + 3, y);
        });
      }
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

    if (this.state === 'coverage') {
      this._drawCoverageLiveOverlay(P, W, H);
      this._drawHandHints(ctx, P, track, W, H);
      return;
    }

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
        grid: null,
        frame: paintFrame,
        showCoverage: false,
      });
    }

    this._drawHandHints(ctx, P, track, W, H);
  }

  /**
   * Projection live (labo ?vidhands=1) : heat + contour accroché au dos via affine.
   */
  _drawCoverageLiveOverlay(P, W, H) {
    const ctx = this.ctx;
    const warp = getBackWarp();
    if (!warp?.fromGenericUv || !this.grid) return;

    const xf = P ? this._resolveTorsoXf(P) : this.torsoLock?.lastXf;
    const mapToLive = xf?.apply ? (p) => xf.apply(p) : (p) => p;

    const srcOutline = warp.pixelOutline;
    const outline = srcOutline?.length >= 4
      ? srcOutline.map((p) => mapToLive(p)).filter((p) => p && Number.isFinite(p.x))
      : null;

    if (outline?.length >= 4) {
      ctx.save();
      ctx.beginPath();
      outline.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.clip();
    }

    // Sous-échantillon si énorme résolution (tél.) — sinon chaque cellule heat.
    const step = (W * H > 900_000) ? 2 : 1;
    for (let y = 0; y < HEAT_H; y += step) {
      for (let x = 0; x < HEAT_W; x += step) {
        const i = y * HEAT_W + x;
        if (!this.grid.isBody(i)) continue;
        const frac = this.grid.pixelFraction(i);
        if (frac < 0.05) continue;
        const u0 = x / HEAT_W;
        const v0 = y / HEAT_H;
        const u1 = Math.min(1, (x + step) / HEAT_W);
        const v1 = Math.min(1, (y + step) / HEAT_H);
        const corners = [
          { u: u0, v: v0 },
          { u: u1, v: v0 },
          { u: u1, v: v1 },
          { u: u0, v: v1 },
        ].map((uv) => {
          const locked = warp.fromGenericUv(uv);
          return locked ? mapToLive(locked) : null;
        });
        if (corners.some((p) => !p)) continue;
        const [r, g, b, a] = coverageHeatRGBA(frac);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let k = 1; k < 4; k++) ctx.lineTo(corners[k].x, corners[k].y);
        ctx.closePath();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(a / 255) * 0.7})`;
        ctx.fill();
      }
    }

    if (outline?.length >= 4) {
      ctx.restore();
      ctx.beginPath();
      outline.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0, 255, 90, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  _drawHandHints(ctx, P, track, W, H) {
    if (P) {
      for (const idx of [LM.L_WRIST, LM.R_WRIST]) {
        const p = P[idx];
        if (!p || p.visibility < 0.4) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 255, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#00FFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    const hands = track?.handLandmarkerResult?.landmarks ?? [];
    const handed = track?.handLandmarkerResult?.handedness ?? [];
    for (let i = 0; i < hands.length; i++) {
      const hand = hands[i];
      const label = handed[i]?.[0]?.categoryName?.toLowerCase?.() || '';
      const color = label.includes('left')
        ? 'rgba(0, 255, 255, 0.45)'
        : 'rgba(255, 0, 255, 0.45)';
      const palm = palmFromHand(hand.map((p) => ({
        x: p.x * W, y: p.y * H, z: p.z ?? 0,
        visibility: p.visibility ?? p.presence ?? 1,
      })));
      if (!palm) continue;
      ctx.beginPath();
      ctx.arc(palm.x, palm.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
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
