import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  EmergencyBanner,
  HexGridBackground,
  StatusStamp,
  SyncProgressBar,
  TerminalDisplay,
} from '@mdrbx/nerv-ui';
import { SunCoachEngine, ZONE_COUNT, ANATOMICAL_ZONES } from './lib/engine.js';
import { setupMinimapCanvas } from './lib/minimapCanvas.js';
import { CALIBRATION_STEPS, ANCHOR_ORDER } from './lib/backCalibration.js';
import { strokeZoneOutline } from './lib/zones.js';
import { preloadPose, preloadBodySegmenter } from './lib/pose.js';
import { isTestMode } from './lib/testMode.js';
import TestPage from './TestPage.jsx';

const testMode = isTestMode();

export default function App() {
  const [screen, setScreen] = useState('home'); // home | session | done | test
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sessionRunning, setSessionRunning] = useState(false);
  const engineRef = useRef(null);

  // Télécharge WASM + modèle de pose dès l'accueil : quand l'utilisateur
  // appuie sur "Commencer", tout est déjà prêt (fini le chargement qui traîne).
  useEffect(() => {
    preloadPose().catch(() => { /* sera retenté au lancement de la session */ });
    preloadBodySegmenter().catch(() => { /* chargé au scan IA */ });
  }, []);

  return (
    <div className="h-full bg-nerv-black">
      {screen === 'home' && (
        <HomeScreen
          error={error}
          testMode={testMode}
          onStart={() => { setError(null); setSessionRunning(true); setScreen('session'); }}
          onOpenTest={() => setScreen('test')}
        />
      )}
      {screen === 'test' && testMode && (
        <TestPage
          engine={engineRef.current}
          sessionActive={sessionRunning}
          onBack={() => setScreen(sessionRunning ? 'session' : 'home')}
          onStartSession={() => { setError(null); setSessionRunning(true); setScreen('session'); }}
        />
      )}
      {(screen === 'session' || (screen === 'test' && sessionRunning)) && (
        <div className={screen === 'test' ? 'hidden' : undefined}>
        <SessionScreen
          engineRef={engineRef}
          testMode={testMode}
          onOpenTest={() => setScreen('test')}
          onAbort={() => { setSessionRunning(false); setScreen('home'); }}
          onError={(msg) => { setError(msg); setSessionRunning(false); setScreen('home'); }}
          onDone={(res) => { setResult(res); setSessionRunning(false); setScreen('done'); }}
        />
        </div>
      )}
      {screen === 'done' && (
        <DoneScreen result={result} onRestart={() => setScreen('home')} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- accueil

const BRIEFING = [
  '01. CALE LE TÉLÉPHONE SUR UN SUPPORT (PAS EN MAIN).',
  '02. CAMÉRA SELFIE (FACE) VERS TON DOS — RECULE À ~2 M.',
  '03. MONTE LE VOLUME AU MAXIMUM.',
  '04. RESTE IMMOBILE — PHOTO + SCAN IA DU DOS.',
  '05. TOURNE-TOI : GLISSE LES 8 POINTS SUR TA PHOTO.',
  '06. REPLACE-TOI (VOIX) → FROTTE — ORANGE → VERT.',
];

function HomeScreen({ error, onStart, testMode, onOpenTest }) {
  return (
    <div className="relative min-h-full overflow-hidden">
      <HexGridBackground color="#FF9900" opacity={0.07} />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-8">
        {testMode && (
          <EmergencyBanner
            text="TEST MODE — LAN SYNC"
            subtext="Panneau debug · transmission vers Mac (même WiFi)"
            severity="warning"
            visible
          />
        )}
        <div className="text-center">
          <div
            className="text-nerv-red text-5xl font-bold tracking-[0.15em] nerv-text-shadow-red"
            style={{ fontFamily: 'var(--font-nerv-display)' }}
          >
            SUNCOACH
          </div>
          <div
            className="mt-1 text-nerv-orange text-sm tracking-[0.35em]"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            PROTOCOLE SOLAIRE — DORSAL
          </div>
        </div>

        {error && (
          <EmergencyBanner
            text="ERREUR SYSTÈME"
            subtext={error}
            severity="warning"
            visible
          />
        )}

        <EmergencyBanner
          text="SUNCOACH · NETTOYAGE V3 — DOCS + DEBUG"
          subtext={'BUILD ' + (typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?') + ' · schéma warp 8 points · reposition continu · ?debug=1'}
          severity="info"
          visible
        />

        <Card
          eyebrow="NERV // BRIEFING DE MISSION"
          title="Crème solaire dans le dos, zéro zone oubliée"
          variant="default"
        >
          <TerminalDisplay
            lines={BRIEFING}
            color="green"
            prompt=">"
            title="INSTRUCTIONS"
          />
        </Card>

        <Button variant="primary" size="lg" fullWidth onClick={onStart}>
          COMMENCER LE PROTOCOLE
        </Button>

        {testMode && (
          <Button variant="ghost" size="lg" fullWidth onClick={onOpenTest}>
            PANNEAU TEST DEBUG
          </Button>
        )}

        <p
          className="text-center text-xs text-nerv-white/50"
          style={{ fontFamily: 'var(--font-nerv-mono)' }}
        >
          100 % LOCAL — LA VIDÉO NE QUITTE JAMAIS TON APPAREIL
          <br />
          BUILD {typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?'} — NETTOYAGE V3
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ajustement points sur photo (pixels image, pas UV)

function useImageFit(imgRef, boxRef) {
  const [fit, setFit] = useState(null);
  const update = () => {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img?.naturalWidth || !box) return;
    const scale = Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight);
    setFit({
      w: img.naturalWidth * scale,
      h: img.naturalHeight * scale,
    });
  };
  useEffect(() => {
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  return { fit, refresh: update };
}

function clientToImagePx(clientX, clientY, imgEl, videoW, videoH) {
  const rect = imgEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * videoW,
    y: ((clientY - rect.top) / rect.height) * videoH,
  };
}

function PointAdjustScreen({ payload, engine }) {
  const imgRef = useRef(null);
  const boxRef = useRef(null);
  const { fit, refresh } = useImageFit(imgRef, boxRef);
  const [anchorsPx, setAnchorsPx] = useState(payload.anchorsPx ?? {});
  const dragIdRef = useRef(null);
  const dragOffsetRef = useRef({ dx: 0, dy: 0 });

  useEffect(() => {
    setAnchorsPx(payload.anchorsPx ?? {});
  }, [payload.imageUrl]);

  const labelFor = (id) => CALIBRATION_STEPS.find((s) => s.id === id)?.label ?? id;

  const pct = (id) => {
    const p = anchorsPx[id];
    if (!p) return { left: 50, top: 50 };
    return {
      left: (p.x / payload.videoW) * 100,
      top: (p.y / payload.videoH) * 100,
    };
  };

  const linePoints = ANCHOR_ORDER.map((id) => {
    const p = pct(id);
    return `${p.left},${p.top}`;
  }).join(' ');

  useEffect(() => {
    const onMove = (e) => {
      const id = dragIdRef.current;
      const img = imgRef.current;
      if (!id || !img) return;
      const pt = clientToImagePx(e.clientX, e.clientY, img, payload.videoW, payload.videoH);
      if (!pt) return;
      const x = pt.x - dragOffsetRef.current.dx;
      const y = pt.y - dragOffsetRef.current.dy;
      const cx = Math.max(8, Math.min(payload.videoW - 8, x));
      const cy = Math.max(8, Math.min(payload.videoH - 8, y));
      engine.setDraftAnchorPx(id, cx, cy);
      setAnchorsPx((prev) => ({ ...prev, [id]: { x: cx, y: cy } }));
    };
    const onUp = () => { dragIdRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [engine, payload.videoW, payload.videoH]);

  const startDrag = (id, e) => {
    e.preventDefault();
    const img = imgRef.current;
    const p = anchorsPx[id];
    if (!img || !p) return;
    const pt = clientToImagePx(e.clientX, e.clientY, img, payload.videoW, payload.videoH);
    if (!pt) return;
    dragOffsetRef.current = { dx: pt.x - p.x, dy: pt.y - p.y };
    dragIdRef.current = id;
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-nerv-black">
      <div
        className="border-b border-nerv-orange/40 bg-nerv-panel px-4 py-3 text-center"
        style={{ fontFamily: 'var(--font-nerv-mono)' }}
      >
        <div className="text-sm font-bold tracking-[0.2em] text-nerv-orange">AJUSTE TON DOS</div>
        <div className="mt-1 text-xs text-nerv-green/80">
          Points sur épaules/nuque au départ · glisse sur le bord du dos
        </div>
      </div>

      <div ref={boxRef} className="relative flex flex-1 items-center justify-center overflow-hidden p-2">
        <div
          className="relative touch-none"
          style={fit ? { width: fit.w, height: fit.h } : undefined}
        >
          <img
            ref={imgRef}
            src={payload.imageUrl}
            alt="Photo de ton dos"
            className="block h-full w-full select-none"
            draggable={false}
            onLoad={refresh}
          />
          {fit && (
            <>
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <polyline
                  points={linePoints}
                  fill="none"
                  stroke="rgba(80,255,120,0.8)"
                  strokeWidth="0.35"
                  strokeDasharray="1.5 1"
                />
              </svg>
              {ANCHOR_ORDER.map((id) => {
                const pos = pct(id);
                return (
                  <div
                    key={id}
                    role="button"
                    tabIndex={0}
                    className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
                    style={{ left: `${pos.left}%`, top: `${pos.top}%`, touchAction: 'none' }}
                    onPointerDown={(e) => startDrag(id, e)}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-nerv-green shadow-md" />
                    <span
                      className="mt-0.5 rounded bg-black/80 px-1.5 py-0.5 text-[7px] font-bold tracking-wider text-nerv-green"
                      style={{ fontFamily: 'var(--font-nerv-mono)' }}
                    >
                      {labelFor(id)}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className="border-t border-nerv-orange/30 bg-nerv-panel px-4 py-3">
        <Button variant="primary" size="lg" fullWidth onClick={() => engine.confirmAdjustment()}>
          VALIDER LES 8 POINTS
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- session

function SessionScreen({ onAbort, onError, onDone, engineRef, testMode, onOpenTest }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const minimapRef = useRef(null);
  const localEngineRef = useRef(null);
  const [hud, setHud] = useState({ pct: 0, status: 'INITIALISATION…' });
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);

  const [phase, setPhase] = useState('placement');
  const [adjustPayload, setAdjustPayload] = useState(null);

  useEffect(() => {
    if (minimapRef.current) setupMinimapCanvas(minimapRef.current);
  }, []);

  useEffect(() => {
    const engine = new SunCoachEngine({
      video: videoRef.current,
      overlay: overlayRef.current,
      minimap: minimapRef.current,
      onHud: (pct, status) => setHud({ pct, status }),
      onDone,
      onPhase: (p, data) => {
        setPhase(p);
        setAdjustPayload(p === 'adjusting' ? data : null);
      },
    });
    localEngineRef.current = engine;
    if (engineRef) engineRef.current = engine;
    let cancelled = false;
    engine
      .start()
      .then(() => { if (!cancelled) setReady(true); })
      .catch((err) => {
        if (cancelled) return;
        onError(
          err && err.name === 'NotAllowedError'
            ? 'ACCÈS CAMÉRA REFUSÉ. AUTORISE LA CAMÉRA DANS LES RÉGLAGES DU NAVIGATEUR.'
            : 'CAMÉRA OU MODÈLE DE POSE INDISPONIBLE. VÉRIFIE TA CONNEXION ET RÉESSAIE.'
        );
      });
    return () => {
      cancelled = true;
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const engine = () => engineRef?.current ?? localEngineRef.current;

  const toggleMute = () => {
    const m = !muted;
    engine()?.setMuted(m);
    setMuted(m);
  };

  return (
    <div className="flex h-screen flex-col bg-nerv-black">
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <video ref={videoRef} playsInline muted autoPlay className="max-h-full max-w-full" />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <canvas ref={overlayRef} className="max-h-full max-w-full" />
        </div>

        {!ready && (
          <StatusStamp
            text="CHARGEMENT"
            subtitle={hud.status}
            color="orange"
            blink
            bordered
            visible
            fullScreen
          />
        )}

        {phase === 'adjusting' && adjustPayload && engine() && (
          <PointAdjustScreen payload={adjustPayload} engine={engine()} />
        )}

        {phase !== 'adjusting' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 to-transparent px-4 pb-8 pt-3">
          <SyncProgressBar
            value={hud.pct * 100}
            label="COUVERTURE DORSALE"
            blocks={24}
          />
          <div
            className="mt-2 text-center text-lg font-bold tracking-[0.2em] text-nerv-orange nerv-text-shadow-orange"
            style={{ fontFamily: 'var(--font-nerv-display)' }}
          >
            {hud.status}
          </div>
        </div>
        )}

        {phase !== 'adjusting' && (
        <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-center gap-1">
          <canvas
            ref={minimapRef}
            style={{ width: 110, height: 150, display: 'block' }}
          />
          <span
            className="text-[10px] tracking-[0.25em] text-nerv-green/80"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            SCHÉMA DOS · {typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?'}
          </span>
        </div>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-3 border-t border-nerv-orange/30 bg-nerv-panel px-4 py-3">
        {testMode && (
          <Button variant="ghost" onClick={onOpenTest}>
            TEST
          </Button>
        )}
        {phase !== 'adjusting' && (
        <Button variant="ghost" onClick={() => engine()?.flip()}>
          CAMÉRA
        </Button>
        )}
        {phase === 'reposition' && (
        <Button variant="primary" onClick={() => engine()?.skipReposition()}>
          C’EST BON — COMMENCER
        </Button>
        )}
        <Button variant="ghost" onClick={toggleMute}>
          {muted ? 'SON : OFF' : 'SON : ON'}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            const res = engine()?.stopEarly();
            if (res) onDone(res);
            else onAbort();
          }}
        >
          STOP
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- fin

function DoneScreen({ result, onRestart }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const c = canvasRef.current.getContext('2d');
    const W = canvasRef.current.width, H = canvasRef.current.height;
    c.clearRect(0, 0, W, H);
    const pad = 26;
    const mapW = W - 2 * pad, mapH = H - 2 * pad;
    const toX = (u) => pad + u * mapW;
    const toY = (v) => pad + v * mapH;

    // Heatmap fine détourée à la silhouette : hors du corps, rien ;
    // sur le corps, du sombre (raté) au vert (couvert).
    const { w, h, need, data, body } = result.heat;
    const cw = mapW / w, ch = mapH / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (body && body[i] < 0.5) continue;
        const f = Math.min(1, data[i] / need);
        c.fillStyle = f >= 1
          ? 'rgba(0, 255, 0, 0.85)'
          : f > 0.02
            ? `rgba(255, ${Math.round(60 + f * 140)}, 0, ${0.25 + f * 0.6})`
            : 'rgba(255, 255, 255, 0.10)';
        c.fillRect(toX(x / w), toY(y / h), cw + 0.5, ch + 0.5);
      }
    }

    // Tracé du parcours des mains (gauche : cyan, droite : magenta).
    const drawPath = (path, color) => {
      if (path.length < 2) return;
      c.beginPath();
      c.moveTo(toX(path[0].u), toY(path[0].v));
      for (let i = 1; i < path.length; i++) c.lineTo(toX(path[i].u), toY(path[i].v));
      c.strokeStyle = color;
      c.lineWidth = 1.5;
      c.globalAlpha = 0.7;
      c.stroke();
      c.globalAlpha = 1;
    };
    drawPath(result.paths.gauche, '#00FFFF');
    drawPath(result.paths.droite, '#FF00FF');

    // Contour du dos (warp 8 points ou silhouette figée).
    const outline = result.outline;
    if (outline?.length >= 4) {
      c.beginPath();
      outline.forEach((p, i) => {
        const x = toX(p.u);
        const y = toY(p.v);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.closePath();
      c.strokeStyle = 'rgba(0, 255, 0, 0.8)';
      c.lineWidth = 1.5;
      c.stroke();
    }

    // Contours des zones anatomiques.
    for (const z of ANATOMICAL_ZONES) {
      strokeZoneOutline(c, z, toX, toY, 'rgba(0, 255, 0, 0.35)', 1);
    }

    c.fillStyle = '#00FF00';
    c.font = '11px Fira Code, monospace';
    c.textAlign = 'center';
    c.fillText('NUQUE', W / 2, 18);
    c.fillText('BAS DU DOS', W / 2, H - 8);
  }, [result]);

  const minutes = result ? Math.floor(result.seconds / 60) : 0;
  const seconds = result ? result.seconds % 60 : 0;
  const painted = result ? Math.round(result.paintedRatio * 100) : 0;
  const aborted = result?.aborted;
  const accent = aborted ? 'orange' : 'green';

  return (
    <div className="relative min-h-full overflow-hidden">
      <HexGridBackground color={aborted ? '#FF9900' : '#00FF00'} opacity={0.07} />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-5 px-4 py-8">
        <StatusStamp
          text={aborted ? 'SESSION INTERROMPUE' : 'MISSION ACCOMPLIE'}
          subtitle={aborted ? 'BILAN PARTIEL' : 'DOS ENTIÈREMENT COUVERT'}
          color={accent}
          bordered
          visible
          rotation={-6}
        />
        <canvas ref={canvasRef} width={300} height={400} className="rounded border border-nerv-green/40 bg-nerv-panel" />
        <div
          className={`text-sm text-center ${aborted ? 'text-nerv-orange' : 'text-nerv-green'}`}
          style={{ fontFamily: 'var(--font-nerv-mono)' }}
        >
          ZONES VALIDÉES : {result?.zonesCovered ?? 0} / {result?.zonesTotal ?? ZONE_COUNT}
          <br />
          SURFACE RÉELLEMENT PEINTE : {painted} %
          <br />
          DURÉE : {minutes} MIN {String(seconds).padStart(2, '0')} S
          <br />
          <span className="text-nerv-cyan">— MAIN GAUCHE</span>{' '}
          <span className="text-nerv-magenta">— MAIN DROITE</span>
        </div>
        <Button variant="terminal" size="lg" fullWidth onClick={onRestart}>
          NOUVELLE SESSION
        </Button>
        <p className="text-center text-xs text-nerv-white/50" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
          {aborted
            ? 'LES ZONES SOMBRES DU SCHÉMA N’ONT PAS REÇU DE CRÈME'
            : 'RAPPEL : REMETS DE LA CRÈME DANS 2 H, OU APRÈS BAIGNADE'}
        </p>
      </div>
    </div>
  );
}
