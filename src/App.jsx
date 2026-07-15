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
import { buildBackWarp } from './lib/backWarp.js';
import {
  drawMappedHeatCells,
  strokeMappedPath,
  strokeMappedZone,
} from './lib/minimapRender.js';
import { preloadSessionVision } from './lib/pose.js';
import { isTestMode } from './lib/testMode.js';
import {
  isReplayMode,
  tryAutoLoadDefaultVideo,
  REPLAY_SCENARIO,
  DEFAULT_REPLAY_FILE,
  isLocalDevHost,
} from './lib/replayMode.js';
import { isDebugMinimap } from './lib/minimapCanvas.js';
import { buildDebugPayload, downloadDebugJson } from './lib/debugExport.js';
import TestPage from './TestPage.jsx';
import MinimapLab from './MinimapLab.jsx';
import FrameLab from './FrameLab.jsx';
import VideoHandLab from './VideoHandLab.jsx';

const videoHandLabMode = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('vidhands');
const frameLabMode = !videoHandLabMode && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('frames');
const minimapLabMode = !videoHandLabMode && !frameLabMode && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('lab');
const replayMode = !videoHandLabMode && !frameLabMode && !minimapLabMode && isReplayMode();
const testMode = !videoHandLabMode && !frameLabMode && !minimapLabMode && !replayMode && isTestMode();

function formatSessionStartError(err, isReplay) {
  const msg = String(err?.message || err);
  const name = err?.name || '';
  const detail = msg ? ` (détail: ${msg.slice(0, 120)})` : '';
  if (isReplay) {
    if (name === 'VideoDecodeError' || /decode|MEDIA_DECODE|DECODE_ERR|AppleVTDecoder/i.test(msg)) {
      return 'VIDÉO .MOV IPHONE (HEVC) NON LISIBLE DANS FIREFOX — CHOISIS IMG_3783.mp4 OU UTILISE CHROME/SAFARI.';
    }
    if (/video load|VideoLoadError|dimensions unavailable/i.test(msg)) {
      return 'VIDÉO ILLISIBLE — ESSAIE UN FICHIER .MP4 H.264 (PAS .MOV HEVC IPHONE).';
    }
    if (/fetch|network|Failed to load|Load failed|wasm|model/i.test(msg)) {
      return 'MODÈLE IA NON TÉLÉCHARGÉ — VÉRIFIE LA CONNEXION (1ère fois ~13 Mo).';
    }
    return 'REPLAY IMPOSSIBLE — VÉRIFIE LE FICHIER VIDÉO.';
  }
  if (name === 'NotAllowedError') {
    return 'ACCÈS CAMÉRA REFUSÉ — AUTORISE LA CAMÉRA POUR SAFARI/CHROME (Réglages système sur Mac).';
  }
  if (/fetch|network|Failed to load|Load failed|wasm|model/i.test(msg)) {
    return 'MODÈLE IA NON TÉLÉCHARGÉ — VÉRIFIE LA 4G/WIFI (besoin internet 1ère fois, ~13 Mo).';
  }
  if (
    name === 'CameraTimeoutError' ||
    name === 'OverconstrainedError' ||
    name === 'NotFoundError' ||
    name === 'NotReadableError' ||
    name === 'CameraError' ||
    name === 'AbortError' ||
    name === 'SecurityError' ||
    /camera|getUserMedia|videoinput|dimensions unavailable|videoWidth/i.test(msg)
  ) {
    return 'CAMÉRA INDISPONIBLE — AUTORISE LA CAMÉRA DANS LE NAVIGATEUR.';
  }
  return 'DÉMARRAGE IMPOSSIBLE — RECHARGE LA PAGE ET RÉESSAIE.' + detail;
}

export default function App() {
  const [screen, setScreen] = useState(replayMode ? 'replay' : testMode ? 'test' : 'home');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [modelStatus, setModelStatus] = useState('loading');
  const [replaySource, setReplaySource] = useState(null);
  const [replayLabel, setReplayLabel] = useState('');
  const replayBlobRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => () => {
    if (replayBlobRef.current) URL.revokeObjectURL(replayBlobRef.current);
  }, []);

  const pickVideoFile = (file) => {
    if (!file) return;
    if (replayBlobRef.current) URL.revokeObjectURL(replayBlobRef.current);
    const url = URL.createObjectURL(file);
    replayBlobRef.current = url;
    setReplaySource(url);
    setReplayLabel(file.name);
    setError(null);
  };

  useEffect(() => {
    if (minimapLabMode) return undefined;
    // Accueil caméra : pas de téléchargement IA (~40 Mo) — charge au Start.
    // Mode test / replay / vidéo : précharge pour débloquer les boutons.
    if (!(testMode || replayMode)) {
      setModelStatus('ok');
      return undefined;
    }
    let cancelled = false;
    preloadSessionVision()
      .then(() => { if (!cancelled) setModelStatus('ok'); })
      .catch(() => { if (!cancelled) setModelStatus('fail'); });
    return () => { cancelled = true; };
  }, []);

  if (videoHandLabMode) return <VideoHandLab />;
  if (frameLabMode) return <FrameLab />;
  if (minimapLabMode) return <MinimapLab />;

  return (
    <div className="h-full bg-nerv-black">
      {screen === 'home' && (
        <HomeScreen
          error={error}
          testMode={testMode}
          modelStatus={modelStatus}
          replayLabel={replayLabel}
          onPickVideo={pickVideoFile}
          onStart={() => {
            setError(null);
            setReplaySource(null);
            setReplayLabel('');
            if (replayBlobRef.current) {
              URL.revokeObjectURL(replayBlobRef.current);
              replayBlobRef.current = null;
            }
            setSessionRunning(true);
            setScreen('session');
          }}
          onStartVideo={() => {
            if (!replaySource) {
              setError('CHOISIS D’ABORD UNE VIDÉO (.MOV ou .MP4).');
              return;
            }
            if (modelStatus !== 'ok') {
              setError('MODÈLE IA PAS ENCORE CHARGÉ — ATTENDS OU VÉRIFIE LA CONNEXION.');
              return;
            }
            setError(null);
            setSessionRunning(true);
            setScreen('session');
          }}
          onOpenTest={() => { setError(null); setScreen('test'); }}
        />
      )}
      {screen === 'replay' && replayMode && (
        <ReplayHomeScreen
          error={error}
          modelStatus={modelStatus}
          replayLabel={replayLabel}
          onPickFile={(src, label) => {
            if (replayBlobRef.current) URL.revokeObjectURL(replayBlobRef.current);
            replayBlobRef.current = src.startsWith('blob:') ? src : null;
            setReplaySource(src);
            setReplayLabel(label);
            setError(null);
          }}
          onStart={() => {
            if (!replaySource) {
              setError('CHOISIS D’ABORD UNE VIDÉO (.MOV ou .MP4).');
              return;
            }
            if (modelStatus !== 'ok') {
              setError('MODÈLE IA PAS ENCORE CHARGÉ — ATTENDS OU VÉRIFIE LA CONNEXION.');
              return;
            }
            setError(null);
            setSessionRunning(true);
            setScreen('session');
          }}
        />
      )}
      {screen === 'test' && testMode && (
        <TestPage
          engine={engineRef.current}
          sessionActive={sessionRunning}
          modelStatus={modelStatus}
          lastError={error}
          onBack={() => setScreen(sessionRunning ? 'session' : 'home')}
          onStartSession={() => {
            if (modelStatus !== 'ok') {
              setError('MODÈLE IA PAS ENCORE CHARGÉ — ATTENDS OU VÉRIFIE LA 4G/WIFI.');
              return;
            }
            setError(null);
            setSessionRunning(true);
            setScreen('session');
          }}
        />
      )}
      {(screen === 'session' || (screen === 'test' && sessionRunning)) && (
        <div className={screen === 'test' ? 'hidden' : undefined}>
        <SessionScreen
          engineRef={engineRef}
          testMode={testMode}
          onOpenTest={() => setScreen('test')}
          onAbort={() => {
            setSessionRunning(false);
            setScreen(replaySource ? 'home' : replayMode ? 'replay' : testMode ? 'test' : 'home');
          }}
          onError={(msg) => {
            setError(msg);
            setSessionRunning(false);
            setScreen(replaySource ? 'home' : replayMode ? 'replay' : testMode ? 'test' : 'home');
          }}
          onDone={(res) => { setResult(res); setSessionRunning(false); setScreen('done'); }}
          replayMode={!!replaySource}
          replaySource={replaySource}
        />
        </div>
      )}
      {screen === 'done' && (
        <DoneScreen
          result={result}
          onRestart={() => setScreen(replayMode ? 'replay' : 'home')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- replay (vidéo fichier)

function ReplayHomeScreen({ error, modelStatus, replayLabel, onPickFile, onStart }) {
  const fileRef = useRef(null);
  const [autoStatus, setAutoStatus] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    if (!isLocalDevHost()) {
      setAutoStatus('manual');
      return undefined;
    }
    tryAutoLoadDefaultVideo().then((url) => {
      if (cancelled) return;
      if (url) {
        onPickFile(url, DEFAULT_REPLAY_FILE + ' (auto)');
        setAutoStatus('loaded');
      } else {
        setAutoStatus('missing');
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auto-load une seule fois au montage
  }, []);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    onPickFile(url, file.name);
    setAutoStatus('picked');
    e.target.value = '';
  };

  return (
    <div className="relative min-h-full overflow-hidden">
      <HexGridBackground color="#00FFFF" opacity={0.06} />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-8">
        <EmergencyBanner
          text="MODE REPLAY — VIDÉO FICHIER"
          subtext="Injection locale pour debug Mac · pas de caméra live"
          severity="info"
          visible
        />

        {error && (
          <EmergencyBanner text="ERREUR" subtext={error} severity="warning" visible />
        )}

        <Card
          eyebrow="NERV // REPLAY DEBUG"
          title="Rejouer une vidéo enregistrée sur iPhone"
          variant="default"
        >
          <TerminalDisplay
            lines={[
              '1. Transfère la vidéo (.MOV) sur le Mac.',
              '2. Choisis le fichier ci-dessous (ou auto si ' + DEFAULT_REPLAY_FILE + ' à la racine).',
              '3. Lance le replay — même pipeline que la session réelle.',
              '4. Option : ?debug=1 pour overlay technique.',
            ]}
            color="cyan"
            prompt=">"
            title="WORKFLOW"
          />
        </Card>

        <input
          ref={fileRef}
          type="file"
          accept="video/*,.mov,.mp4"
          className="hidden"
          onChange={handleFile}
        />

        <Button variant="ghost" size="lg" fullWidth onClick={() => fileRef.current?.click()}>
          CHOISIR UNE VIDÉO
        </Button>

        {replayLabel && (
          <p className="text-center text-xs text-nerv-cyan" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Fichier : {replayLabel}
          </p>
        )}

        {autoStatus === 'checking' && (
          <p className="text-center text-[10px] text-nerv-white/40" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Recherche {DEFAULT_REPLAY_FILE} sur ce serveur…
          </p>
        )}
        {autoStatus === 'loaded' && (
          <p className="text-center text-[10px] text-nerv-green/80" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            {DEFAULT_REPLAY_FILE} chargé automatiquement (serveur local).
          </p>
        )}
        {autoStatus === 'missing' && isLocalDevHost() && (
          <p className="text-center text-[10px] text-nerv-orange/70" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Pas de {DEFAULT_REPLAY_FILE} à la racine — utilise le sélecteur de fichier.
          </p>
        )}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={onStart}
          disabled={!replayLabel || modelStatus !== 'ok'}
        >
          {modelStatus === 'ok' ? 'LANCER LE REPLAY' : modelStatus === 'fail' ? 'MODÈLE IA INDISPONIBLE' : 'CHARGEMENT MODÈLE…'}
        </Button>

        <ReplayScenarioLegend />
      </div>
    </div>
  );
}

function ReplayScenarioLegend() {
  return (
    <div className="rounded border border-nerv-cyan/30 bg-nerv-panel/80 px-3 py-2">
      <div className="text-[10px] font-bold tracking-wider text-nerv-cyan" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
        REPÈRES VIDÉO (légende seule — pas de déclenchement auto)
      </div>
      <ul className="mt-1 space-y-0.5 text-[9px] text-nerv-white/60" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
        {REPLAY_SCENARIO.map((m) => (
          <li key={m.t}>
            {String(m.t).padStart(2, '0')}s — {m.label} ({m.phase})
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplayTimeline({ videoRef, duration }) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const tick = () => setCurrent(v.currentTime);
    v.addEventListener('timeupdate', tick);
    return () => v.removeEventListener('timeupdate', tick);
  }, [videoRef, duration]);

  if (!duration || !Number.isFinite(duration)) return null;
  const pct = (t) => Math.min(100, (t / duration) * 100);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 px-3">
      <div className="relative h-2 rounded bg-black/60">
        {REPLAY_SCENARIO.map((m) => (
          <div
            key={m.t}
            className="absolute top-0 h-full w-px bg-nerv-cyan/70"
            style={{ left: `${pct(m.t)}%` }}
            title={`${m.t}s ${m.label}`}
          />
        ))}
        <div
          className="absolute top-0 h-full w-0.5 bg-nerv-orange"
          style={{ left: `${Math.min(100, (current / duration) * 100)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[8px] text-nerv-cyan/80" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
        {REPLAY_SCENARIO.filter((_, i) => i % 2 === 0).map((m) => (
          <span key={m.t}>{m.t}s</span>
        ))}
        <span>{Math.floor(current)}s</span>
      </div>
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

function HomeScreen({
  error, onStart, onStartVideo, onPickVideo, replayLabel, testMode, onOpenTest, modelStatus,
}) {
  const fileRef = useRef(null);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (file) onPickVideo(file);
    e.target.value = '';
  };

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
          text="SUNCOACH · REPLAY MP4 + WARP UV"
          subtext={'BUILD ' + (typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?') + ' · upload vidéo · ?debug=1 · ?cpu=1 si GPU lent'}
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

        {testMode && (
          <>
            <Button variant="primary" size="lg" fullWidth onClick={onOpenTest}>
              OUVRIR PANNEAU TEST (IP + ENVOI MAC)
            </Button>
            <Button variant="ghost" size="lg" fullWidth onClick={onStart} disabled={modelStatus !== 'ok'}>
              {modelStatus === 'ok' ? 'SESSION SANS PANNEAU TEST' : modelStatus === 'fail' ? 'MODÈLE IA INDISPONIBLE' : 'CHARGEMENT MODÈLE…'}
            </Button>
          </>
        )}

        {!testMode && (
        <Button variant="primary" size="lg" fullWidth onClick={onStart}>
          COMMENCER LE PROTOCOLE (CAMÉRA)
        </Button>
        )}

        {!testMode && (
        <>
          <div
            className="text-center text-[10px] tracking-[0.3em] text-nerv-cyan/70"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            — OU TESTER AVEC UNE VIDÉO (MAC) —
          </div>
          <p className="text-center text-[9px] text-nerv-orange/80" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Firefox : préfère .mp4 H.264 (pas .MOV iPhone). Fichier prêt : IMG_3783.mp4
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.mov,.mp4"
            className="hidden"
            onChange={handleFile}
          />
          <Button variant="ghost" size="lg" fullWidth onClick={() => fileRef.current?.click()}>
            CHOISIR UNE VIDÉO
          </Button>
          {replayLabel && (
            <p className="text-center text-xs text-nerv-cyan" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
              Fichier : {replayLabel}
            </p>
          )}
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={onStartVideo}
            disabled={!replayLabel || modelStatus !== 'ok'}
          >
            {modelStatus === 'ok' ? 'LANCER AVEC VIDÉO' : modelStatus === 'fail' ? 'MODÈLE IA INDISPONIBLE' : 'CHARGEMENT MODÈLE…'}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            fullWidth
            onClick={() => { window.location.href = `${window.location.pathname}?vidhands=1`; }}
          >
            LABO VIDÉO MAINS LIVE (8 PTS FIGÉS)
          </Button>
          <Button
            variant="ghost"
            size="lg"
            fullWidth
            onClick={() => { window.location.href = `${window.location.pathname}?frames=1`; }}
          >
            LABO 3 CAPTURES (TEST MINIMAL)
          </Button>
          <Button
            variant="ghost"
            size="lg"
            fullWidth
            onClick={() => { window.location.href = `${window.location.pathname}?lab=1`; }}
          >
            OUVRIR LE LABO MINIMAP (SANS IA)
          </Button>
        </>
        )}

        {testMode && (
          <p className="text-center text-[10px] text-nerv-orange/80" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Mode test : commence par le panneau test pour configurer l’IP Mac.
          </p>
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

function PointAdjustScreen({ payload, engine, debugMode }) {
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
          Photo figée · glisse les points verts sur le bord de ton dos · puis VALIDER
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

      <div className="border-t border-nerv-orange/30 bg-nerv-panel px-4 py-3 space-y-2">
        {debugMode && (
          <Button
            variant="ghost"
            size="lg"
            fullWidth
            onClick={() => engine.confirmAdjustment()}
          >
            PASSER SANS AJUSTER (DEBUG)
          </Button>
        )}
        <Button variant="primary" size="lg" fullWidth onClick={() => engine.confirmAdjustment()}>
          VALIDER LES 8 POINTS
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- session

function SessionScreen({
  onAbort, onError, onDone, engineRef, testMode, onOpenTest,
  replayMode, replaySource,
}) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const minimapRef = useRef(null);
  const localEngineRef = useRef(null);
  const [hud, setHud] = useState({ pct: 0, status: 'INITIALISATION…' });
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPaused, setVideoPaused] = useState(false);

  const [phase, setPhase] = useState('placement');
  const [adjustPayload, setAdjustPayload] = useState(null);
  const debugOverlay = isDebugMinimap();

  useEffect(() => {
    if (minimapRef.current) setupMinimapCanvas(minimapRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const syncPaused = () => setVideoPaused(video.paused);
    video.addEventListener('play', syncPaused);
    video.addEventListener('pause', syncPaused);
    video.addEventListener('ended', syncPaused);
    return () => {
      video.removeEventListener('play', syncPaused);
      video.removeEventListener('pause', syncPaused);
      video.removeEventListener('ended', syncPaused);
    };
  }, []);

  useEffect(() => {
    const engine = new SunCoachEngine({
      video: videoRef.current,
      overlay: overlayRef.current,
      minimap: minimapRef.current,
      replaySource: replaySource || null,
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
      .then(() => {
        if (cancelled) return;
        setReady(true);
        if (replayMode && videoRef.current) {
          setVideoDuration(videoRef.current.duration || 0);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        onError(formatSessionStartError(err, replayMode));
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

  const toggleVideoPause = async () => {
    const v = videoRef.current;
    if (!v || v.error || !Number.isFinite(v.duration)) return;
    if (v.paused) {
      try {
        await v.play();
        setVideoPaused(false);
      } catch {
        onError('LECTURE VIDÉO IMPOSSIBLE — ESSAIE IMG_3783.mp4 (H.264) OU CHROME/SAFARI.');
      }
    } else {
      v.pause();
      setVideoPaused(true);
    }
  };

  const seekVideo = (seconds) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, seconds));
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
          <PointAdjustScreen
            payload={adjustPayload}
            engine={engine()}
            debugMode={debugOverlay}
          />
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
          {replayMode && (
            <div
              className="mt-1 text-center text-[10px] tracking-wider text-nerv-cyan/90"
              style={{ fontFamily: 'var(--font-nerv-mono)' }}
            >
              REPLAY · phase {phase}
              {debugOverlay && ` · ${Math.round(hud.pct * 100)}%`}
            </div>
          )}
        </div>
        )}

        {replayMode && phase !== 'adjusting' && (
          <ReplayTimeline videoRef={videoRef} duration={videoDuration} />
        )}

        <div
          className={`pointer-events-none absolute bottom-3 right-3 z-30 flex flex-col items-center gap-1 rounded border border-nerv-green/40 bg-black/90 p-1 ${
            phase === 'adjusting' ? 'invisible' : ''
          }`}
        >
          <canvas
            ref={minimapRef}
            style={{ display: 'block' }}
          />
          <span
            className="text-[10px] tracking-[0.25em] text-nerv-green/80"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            SCHÉMA DOS · {typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-3 border-t border-nerv-orange/30 bg-nerv-panel px-4 py-3">
        {testMode && (
          <Button variant="ghost" onClick={onOpenTest}>
            ENVOI MAC
          </Button>
        )}
        {replayMode && (
          <>
            <Button variant="ghost" onClick={toggleVideoPause}>
              {videoPaused ? '▶ LECTURE' : '⏸ PAUSE'}
            </Button>
            <Button variant="ghost" onClick={() => seekVideo(0)}>
              ↺ DÉBUT
            </Button>
          </>
        )}
        {!replayMode && phase !== 'adjusting' && (
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
    const displayWarp = result.displayAnchors
      ? buildBackWarp(result.displayAnchors)
      : null;

    // Heatmap fine détourée à la silhouette : hors du corps, rien ;
    // sur le corps, du sombre (raté) au vert (couvert).
    const { w, h, need, data, body } = result.heat;
    const doneColor = (f) => {
      if (f >= 1) return [0, 255, 0, 217];
      if (f > 0.02) return [255, Math.round(60 + f * 140), 0, Math.round((0.25 + f * 0.6) * 255)];
      return [255, 255, 255, 26];
    };
    if (displayWarp) {
      drawMappedHeatCells(
        c,
        {
          w,
          h,
          isBody: (index) => !body || body[index] >= 0.5,
          fractionAt: (index) => Math.min(1, data[index] / need),
        },
        displayWarp,
        toX,
        toY,
        doneColor,
      );
    } else {
      const cw = mapW / w, ch = mapH / h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (body && body[i] < 0.5) continue;
          const [r, g, b, a] = doneColor(Math.min(1, data[i] / need));
          c.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
          c.fillRect(toX(x / w), toY(y / h), cw + 0.5, ch + 0.5);
        }
      }
    }

    // Tracé du parcours des mains (gauche : cyan, droite : magenta).
    const drawPath = (path, color) => {
      c.globalAlpha = 0.7;
      strokeMappedPath(c, path, displayWarp, toX, toY, color, 1.5);
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
      if (displayWarp) {
        strokeMappedZone(c, z, displayWarp, toX, toY, 'rgba(0, 255, 0, 0.35)', 1);
      } else {
        strokeZoneOutline(c, z, toX, toY, 'rgba(0, 255, 0, 0.35)', 1);
      }
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
