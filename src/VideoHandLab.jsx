/**
 * Labo vidéo :
 * - PLAY / PAUSE · TRACER POINTS · START TRACKING
 * - Peinture couverture + % surface (CoverageGrid produit)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, EmergencyBanner } from '@mdrbx/nerv-ui';
import { ANCHOR_ORDER, CALIBRATION_STEPS } from './lib/backCalibration.js';
import { buildBackWarp } from './lib/backWarp.js';
import { applyCalibration } from './lib/sessionCore.js';
import {
  CoverageGrid,
  HEAT_W,
  HEAT_H,
  THOROUGH_PIXEL_NEED,
  coverageHeatRGBA,
  nearBackShape,
} from './lib/coverage.js';
import { drawMinimapScene } from './lib/minimapRender.js';
import { DEFAULT_REPLAY_FILE } from './lib/replayMode.js';
import { LM } from './lib/pose.js';
import {
  preloadVideoHandLandmarker,
  detectHandsForVideo,
  contactsFromHandLandmarker,
} from './lib/handLandmarker.js';
import {
  preloadVideoPose,
  detectPoseForVideo,
  posePixelsAndFrame,
} from './lib/poseVideo.js';
import {
  torsoAttachTransform,
  torsoCornersFromPose,
  blendAffineParams,
  smoothTorsoCloud,
} from './lib/torsoAffine.js';

const LABELS = Object.fromEntries(CALIBRATION_STEPS.map((step) => [step.id, step.label]));
const ANCHOR_KEY = 'suncoach-frame-lab-anchors';

function loadAnchors() {
  try {
    const raw = localStorage.getItem(ANCHOR_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAnchors(anchors) {
  localStorage.setItem(ANCHOR_KEY, JSON.stringify(anchors));
}

const DOT = {
  'hand-lm': '#00FFFF',
  'hand-lm-hors': '#FFFF00',
};

export default function VideoHandLab() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const minimapRef = useRef(null);
  const fileRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const blobRef = useRef(null);
  const lockRef = useRef(null); // { corners, anchors, warp, lastXf }
  const xfSmoothRef = useRef(null);
  const cloudSmoothRef = useRef(null);
  const gridRef = useRef(null);
  const paintClockRef = useRef(0);
  const tsCounterRef = useRef(0);

  const [videoUrl, setVideoUrl] = useState('');
  const [videoLabel, setVideoLabel] = useState('');
  const [anchors, setAnchors] = useState(loadAnchors);
  const [handsReady, setHandsReady] = useState(false);
  const [poseReady, setPoseReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [placing, setPlacing] = useState(true);
  const [tracking, setTracking] = useState(false);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState('1) Play/Pause · 2) Tracer points · 3) Start tracking');
  const [contacts, setContacts] = useState([]);
  const [backFollow, setBackFollow] = useState(false);
  const [coverPct, setCoverPct] = useState(0);
  const [touchedPct, setTouchedPct] = useState(0);

  const warp = useMemo(
    () => (ANCHOR_ORDER.every((id) => anchors[id]) ? buildBackWarp(anchors) : null),
    [anchors],
  );
  const nextId = ANCHOR_ORDER.find((id) => !anchors[id]) ?? null;
  const anchorsReady = !!warp;

  useEffect(() => {
    preloadVideoHandLandmarker()
      .then(() => setHandsReady(true))
      .catch(() => setStatus('Hands indisponible (?cpu=1).'));
    preloadVideoPose()
      .then(() => setPoseReady(true))
      .catch(() => setStatus('Pose indisponible (?cpu=1).'));
    return () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (ANCHOR_ORDER.every((id) => anchors[id])) saveAnchors(anchors);
  }, [anchors]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = new URL(DEFAULT_REPLAY_FILE, window.location.href).href;
        const head = await fetch(url, { method: 'HEAD' });
        if (!cancelled && head.ok) {
          setVideoUrl(url);
          setVideoLabel(DEFAULT_REPLAY_FILE);
        }
      } catch { /* upload */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const syncOverlaySize = () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || !video.videoWidth) return;
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  };

  const drawMinimap = useCallback((list, activeWarp) => {
    const canvas = minimapRef.current;
    const w = activeWarp || warp;
    if (!canvas || !w) return;
    const grid = gridRef.current;
    const scene = drawMinimapScene(canvas.getContext('2d'), {
      width: canvas.width,
      height: canvas.height,
      warp: w,
      background: '#050805',
      bottomSpace: 8,
      heat: grid
        ? {
          w: HEAT_W,
          h: HEAT_H,
          isBody: (i) => grid.isBody(i),
          fractionAt: (i) => grid.pixelFraction(i),
        }
        : null,
      colorForFraction: coverageHeatRGBA,
    });
    if (!scene) return;
    const ctx = canvas.getContext('2d');
    for (const c of list) {
      if (!c.display) continue;
      ctx.beginPath();
      ctx.arc(scene.toX(c.display.u), scene.toY(c.display.v), 6, 0, Math.PI * 2);
      ctx.fillStyle = DOT[c.source] ?? '#00FFFF';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [warp]);

  /** Heat UV → pixels lock → live (affine). */
  const drawHeatLive = (ctx, activeWarp, mapToLive) => {
    const grid = gridRef.current;
    if (!grid || !activeWarp?.fromGenericUv) return;
    for (let y = 0; y < HEAT_H; y++) {
      for (let x = 0; x < HEAT_W; x++) {
        const i = y * HEAT_W + x;
        if (!grid.isBody(i)) continue;
        const frac = grid.pixelFraction(i);
        if (frac < 0.05) continue;
        const u0 = x / HEAT_W;
        const v0 = y / HEAT_H;
        const u1 = (x + 1) / HEAT_W;
        const v1 = (y + 1) / HEAT_H;
        const corners = [
          { u: u0, v: v0 },
          { u: u1, v: v0 },
          { u: u1, v: v1 },
          { u: u0, v: v1 },
        ].map((uv) => {
          const locked = activeWarp.fromGenericUv(uv);
          if (!locked) return null;
          return mapToLive ? mapToLive(locked) : locked;
        });
        if (corners.some((p) => !p)) continue;
        const [r, g, b, a] = coverageHeatRGBA(frac);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let k = 1; k < 4; k++) ctx.lineTo(corners[k].x, corners[k].y);
        ctx.closePath();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(a / 255) * 0.72})`;
        ctx.fill();
      }
    }
  };

  const drawOverlay = (list, liveOutline, mapToLive = null, activeWarp = null) => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return;
    if (overlay.width !== video.videoWidth) syncOverlaySize();
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const outline = liveOutline?.length >= 4
      ? liveOutline
      : ANCHOR_ORDER.map((id) => anchors[id]).filter(Boolean);

    // Peinture sur le corps live (sous le contour)
    if (activeWarp) {
      if (outline.length >= 4) {
        ctx.save();
        ctx.beginPath();
        outline.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.clip();
        drawHeatLive(ctx, activeWarp, mapToLive);
        ctx.restore();
      } else {
        drawHeatLive(ctx, activeWarp, mapToLive);
      }
    }

    if (outline.length >= 4) {
      ctx.beginPath();
      outline.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.strokeStyle = liveOutline ? 'rgba(0,255,90,0.95)' : 'rgba(0,255,90,0.4)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    for (const c of list) {
      if (!c.pixel) continue;
      ctx.beginPath();
      ctx.arc(c.pixel.x, c.pixel.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = DOT[c.source] ?? '#00FFFF';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  const nextTs = () => {
    tsCounterRef.current += 1;
    return tsCounterRef.current;
  };

  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !tracking || !lockRef.current) {
      rafRef.current = requestAnimationFrame(() => { tick(); });
      return;
    }

    // Tourne même en pause (re-détecte la frame courante)
    const frameChanged = video.currentTime !== lastVideoTimeRef.current;
    if (!frameChanged && !playing) {
      rafRef.current = requestAnimationFrame(() => { tick(); });
      return;
    }
    if (frameChanged) lastVideoTimeRef.current = video.currentTime;

    const W = video.videoWidth;
    const H = video.videoHeight;
    const lock = lockRef.current;

    try {
      const poseRes = await detectPoseForVideo(video, nextTs());
      const { P } = posePixelsAndFrame(poseRes, W, H);
      const rawCorners = torsoCornersFromPose(P, LM);
      const liveCorners = rawCorners
        ? (cloudSmoothRef.current = smoothTorsoCloud(cloudSmoothRef.current, rawCorners, 0.35))
        : null;

      let liveOutline = null;
      let toWarpPixel = (p) => p;
      let follow = false;
      let held = false;
      let mode = 'lock-sans-pose';

      if (liveCorners && lock.corners) {
        let xf = torsoAttachTransform(lock.corners, liveCorners);
        if (xf?.ok) {
          if (xf.kind === 'affine') {
            xf = blendAffineParams(xfSmoothRef.current, xf, 0.25) || xf;
            if (xf.kind === 'affine') xfSmoothRef.current = xf;
          } else {
            xfSmoothRef.current = null;
          }
          lock.lastXf = xf;
        } else if (lock.lastXf) {
          xf = lock.lastXf;
          held = true;
        }

        if (xf) {
          follow = true;
          mode = held ? 'hold+mp' : (xf.kind === 'similarity' ? 'sim+mp' : 'affine+mp');
          liveOutline = ANCHOR_ORDER.map((id) => {
            const a = lock.anchors[id];
            return a ? xf.apply(a) : null;
          }).filter(Boolean);
          toWarpPixel = (p) => xf.inv(p);
        }
      }

      const handRes = await detectHandsForVideo(video, nextTs());
      const out = contactsFromHandLandmarker(
        handRes, W, H, lock.warp, mode,
        { toWarpPixel },
      );
      const list = out.contacts.filter((c) => c.pixel);

      // Peinture surface (UV générique produit)
      const grid = gridRef.current;
      let mapToLive = null;
      if (lock.lastXf) mapToLive = (p) => lock.lastXf.apply(p);

      if (grid) {
        const now = performance.now();
        const dt = paintClockRef.current
          ? Math.min(0.05, Math.max(0, (now - paintClockRef.current) / 1000))
          : 1 / 30;
        paintClockRef.current = now;
        const paintHands = list
          .filter((c) => c.uv && nearBackShape(c.uv.u, c.uv.v))
          .map((c) => ({ u: c.uv.u, v: c.uv.v }));
        if (paintHands.length) grid.update(paintHands, dt);
        setCoverPct(Math.round(grid.paintedRatio * 100));
        setTouchedPct(Math.round(grid.touchedRatio * 100));
      }

      setContacts(list);
      setBackFollow(follow);
      const pct = gridRef.current ? Math.round(gridRef.current.paintedRatio * 100) : 0;
      const touch = gridRef.current ? Math.round(gridRef.current.touchedRatio * 100) : 0;
      setStatus(
        (follow
          ? (held
            ? 'Tracking (garde MP) · '
            : `Tracking OK (${mode}) · `)
          : 'Tracking (dos figé — pose faible) · ')
          + `validé ${pct}% · touché ${touch}% · `
          + (out.reason || ''),
      );
      drawOverlay(list, liveOutline, mapToLive, lock.warp);
      drawMinimap(list.filter((c) => c.display), lock.warp);
    } catch (err) {
      setStatus(`Erreur : ${String(err?.message || err)}`);
    }

    rafRef.current = requestAnimationFrame(() => { tick(); });
  }, [tracking, playing, anchors, drawMinimap]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (tracking) {
      rafRef.current = requestAnimationFrame(() => { tick(); });
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [tracking, tick]);

  const pointFromEvent = (event) => {
    const video = videoRef.current;
    if (!video?.videoWidth || !videoSize.w) return null;
    const rect = video.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(videoSize.w, ((event.clientX - rect.left) / rect.width) * videoSize.w)),
      y: Math.max(0, Math.min(videoSize.h, ((event.clientY - rect.top) / rect.height) * videoSize.h)),
    };
  };

  const addPoint = (event) => {
    if (!placing || tracking || !nextId || dragRef.current) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [nextId]: point }));
  };

  const movePoint = (event) => {
    const id = dragRef.current;
    if (!id || !placing) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [id]: point }));
  };

  const onPlay = async () => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;
    try {
      await video.play();
      setPlaying(true);
    } catch (err) {
      setStatus(`Lecture : ${String(err?.message || err)}`);
    }
  };

  const onPause = () => {
    const video = videoRef.current;
    if (video) video.pause();
    setPlaying(false);
  };

  const clearPaint = () => {
    const grid = gridRef.current;
    if (grid) grid.heat.fill(0);
    setCoverPct(0);
    setTouchedPct(0);
    paintClockRef.current = 0;
  };

  const onTracePoints = () => {
    onPause();
    setPlacing(true);
    setTracking(false);
    lockRef.current = null;
    xfSmoothRef.current = null;
    cloudSmoothRef.current = null;
    clearPaint();
    gridRef.current = null;
    setBackFollow(false);
    setContacts([]);
    setStatus(nextId
      ? `Mode tracer — clique : ${LABELS[nextId]}`
      : 'Mode tracer — glisse les points, puis START TRACKING');
    drawOverlay([], null);
  };

  const onStartTracking = async () => {
    const video = videoRef.current;
    if (!video || !anchorsReady || !handsReady || !poseReady) {
      setStatus('Il manque vidéo / 8 points / modèles Hands+Pose.');
      return;
    }
    if (tracking) return;

    syncOverlaySize();
    onPause();

    try {
      const poseRes = await detectPoseForVideo(video, nextTs());
      const { P } = posePixelsAndFrame(poseRes, video.videoWidth, video.videoHeight);
      const corners = torsoCornersFromPose(P, LM);
      if (!corners) {
        setStatus('Stand still : épaules/hanches pas assez visibles — repose-toi dos caméra et réessaie.');
        return;
      }

      // Calibration produit + seuil exigeant (plusieurs passages → vert)
      const cal = applyCalibration(anchors);
      const grid = new CoverageGrid(THOROUGH_PIXEL_NEED);
      gridRef.current = grid;
      clearPaint();

      lockRef.current = {
        corners,
        anchors: { ...anchors },
        warp: cal.warp || warp,
        lastXf: null,
      };
      lastVideoTimeRef.current = -1;
      xfSmoothRef.current = null;
      cloudSmoothRef.current = null;
      paintClockRef.current = 0;
      setPlacing(false);
      setTracking(true);
      setCoverPct(0);
      setTouchedPct(0);
      setStatus('Tracking + peinture multi-pass. Orangé = touché, vert = validé (plusieurs frottements).');
      drawOverlay([], ANCHOR_ORDER.map((id) => anchors[id]).filter(Boolean), null, cal.warp || warp);
      drawMinimap([], cal.warp || warp);
    } catch (err) {
      setStatus(`Start tracking : ${String(err?.message || err)}`);
    }
  };

  const pickFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(file);
    blobRef.current = url;
    setVideoUrl(url);
    setVideoLabel(file.name);
    setPlaying(false);
    setTracking(false);
    setPlacing(true);
    lockRef.current = null;
    gridRef.current = null;
    clearPaint();
    setContacts([]);
    setBackFollow(false);
    event.target.value = '';
  };

  return (
    <div className="min-h-screen bg-nerv-black px-4 py-5 text-nerv-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <EmergencyBanner
          text="LABO VIDÉO — SUIVI + COUVERTURE LIVE"
          subtext="Heat sur le corps · validé = plusieurs passages. Session produit inchangée."
          severity="info"
          visible
        />

        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept="video/*,.mp4,.mov" className="hidden" onChange={pickFile} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>VIDÉO</Button>

          <Button
            variant="primary"
            disabled={!videoUrl}
            onClick={() => (playing ? onPause() : onPlay())}
          >
            {playing ? 'PAUSE' : 'PLAY'}
          </Button>

          <Button variant="ghost" disabled={!videoUrl} onClick={onTracePoints}>
            TRACER POINTS
          </Button>
          <Button
            variant="primary"
            disabled={!videoUrl || !anchorsReady || !handsReady || !poseReady || tracking}
            onClick={onStartTracking}
          >
            START TRACKING
          </Button>

          <Button
            variant="ghost"
            disabled={!tracking}
            onClick={() => {
              clearPaint();
              if (lockRef.current?.warp) drawMinimap([], lockRef.current.warp);
              setStatus('Couverture remise à 0%.');
            }}
          >
            EFFACER PEINTURE
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setAnchors({});
              localStorage.removeItem(ANCHOR_KEY);
              setContacts([]);
              setTracking(false);
              setPlacing(true);
              lockRef.current = null;
              xfSmoothRef.current = null;
              cloudSmoothRef.current = null;
              gridRef.current = null;
              clearPaint();
              setBackFollow(false);
            }}
          >
            EFFACER POINTS
          </Button>
          <Button variant="ghost" onClick={() => { window.location.href = window.location.pathname; }}>
            RETOUR
          </Button>
        </div>

        <p className="text-xs text-nerv-cyan" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
          {videoLabel || 'pas de vidéo'}
          {placing ? ' · TRACER' : ''}
          {tracking ? (backFollow ? ' · TRACK dos+mains' : ' · TRACK (pose faible)') : ''}
          {tracking ? ` · validé ${coverPct}% · touché ${touchedPct}%` : ''}
          {!anchorsReady && nextId ? ` · manque ${LABELS[nextId]}` : ''}
        </p>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
          <Card
            eyebrow="VIDÉO"
            title={placing && nextId ? `Clique : ${LABELS[nextId]}` : (tracking ? 'Tracking' : 'Prêt')}
            variant="default"
          >
            {!videoUrl && <p className="text-sm text-nerv-white/60">Choisis une vidéo MP4.</p>}
            {videoUrl && (
              <div
                className={`relative inline-block max-h-[70vh] max-w-full ${placing && !tracking ? 'touch-none' : ''}`}
                onPointerDown={addPoint}
              >
                <video
                  ref={videoRef}
                  src={videoUrl}
                  playsInline
                  muted
                  className="block max-h-[70vh] max-w-full"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onLoadedMetadata={(event) => {
                    const v = event.currentTarget;
                    setVideoSize({ w: v.videoWidth, h: v.videoHeight });
                    syncOverlaySize();
                    setStatus('PLAY pour trouver un dos stable → PAUSE → TRACER POINTS → START TRACKING');
                  }}
                />
                <canvas ref={overlayRef} className="pointer-events-none absolute left-0 top-0 h-full w-full" />
                {placing && !tracking && ANCHOR_ORDER.map((id) => {
                  const point = anchors[id];
                  if (!point || !videoSize.w) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-nerv-green px-1 text-[8px] font-bold text-black"
                      style={{
                        left: `${(point.x / videoSize.w) * 100}%`,
                        top: `${(point.y / videoSize.h) * 100}%`,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dragRef.current = id;
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={movePoint}
                      onPointerUp={() => { dragRef.current = null; }}
                      onPointerCancel={() => { dragRef.current = null; }}
                    >
                      {LABELS[id] ?? id}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-nerv-white/70" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
              {status}
            </p>
          </Card>

          <Card
            eyebrow="MINIMAP"
            title={tracking ? `Validé ${coverPct}%` : 'UV dos'}
            variant="default"
          >
            <canvas ref={minimapRef} width="240" height="320" className="mx-auto block max-w-full border border-nerv-green/30" />
            <p className="mt-3 text-xs text-nerv-white/60">
              Orange = touché · vert = validé (×{Math.round(THOROUGH_PIXEL_NEED / 0.2)} frottements)
              {tracking ? ` · touché ${touchedPct}%` : ''}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
