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
import { SunCoachEngine, ROWS, COLS } from './lib/engine.js';
import { preloadPose } from './lib/pose.js';

export default function App() {
  const [screen, setScreen] = useState('home'); // home | session | done
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Télécharge WASM + modèle de pose dès l'accueil : quand l'utilisateur
  // appuie sur "Commencer", tout est déjà prêt (fini le chargement qui traîne).
  useEffect(() => {
    preloadPose().catch(() => { /* sera retenté au lancement de la session */ });
  }, []);

  return (
    <div className="h-full bg-nerv-black">
      {screen === 'home' && (
        <HomeScreen error={error} onStart={() => { setError(null); setScreen('session'); }} />
      )}
      {screen === 'session' && (
        <SessionScreen
          onAbort={() => setScreen('home')}
          onError={(msg) => { setError(msg); setScreen('home'); }}
          onDone={(res) => { setResult(res); setScreen('done'); }}
        />
      )}
      {screen === 'done' && (
        <DoneScreen result={result} onRestart={() => setScreen('home')} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- accueil

const BRIEFING = [
  '01. CALE TON TÉLÉPHONE À HAUTEUR DE POITRINE.',
  '02. MONTE LE VOLUME AU MAXIMUM.',
  '03. RECULE À ENVIRON 2 MÈTRES, DOS À LA CAMÉRA.',
  '04. SUIS LE GUIDAGE VOCAL, ZONE PAR ZONE.',
  '05. JINGLE FINAL = DOS ENTIÈREMENT PROTÉGÉ.',
];

function HomeScreen({ error, onStart }) {
  return (
    <div className="relative min-h-full overflow-hidden">
      <HexGridBackground color="#FF9900" opacity={0.07} />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-8">
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

        <p
          className="text-center text-xs text-nerv-white/50"
          style={{ fontFamily: 'var(--font-nerv-mono)' }}
        >
          100 % LOCAL — LA VIDÉO NE QUITTE JAMAIS TON APPAREIL
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- session

function SessionScreen({ onAbort, onError, onDone }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const minimapRef = useRef(null);
  const engineRef = useRef(null);
  const [hud, setHud] = useState({ pct: 0, status: 'INITIALISATION…' });
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const engine = new SunCoachEngine({
      video: videoRef.current,
      overlay: overlayRef.current,
      minimap: minimapRef.current,
      onHud: (pct, status) => setHud({ pct, status }),
      onDone,
    });
    engineRef.current = engine;
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

  const toggleMute = () => {
    const m = !muted;
    engineRef.current?.setMuted(m);
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

        {/* Schéma fixe du dos : reste lisible même quand on se retourne. */}
        <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-center gap-1">
          <canvas ref={minimapRef} width={126} height={168} />
          <span
            className="text-[10px] tracking-[0.25em] text-nerv-green/80"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            SCHÉMA DOS
          </span>
        </div>
      </div>

      <div className="flex justify-center gap-3 border-t border-nerv-orange/30 bg-nerv-panel px-4 py-3">
        <Button variant="ghost" onClick={() => engineRef.current?.flip()}>
          CAMÉRA
        </Button>
        <Button variant="ghost" onClick={toggleMute}>
          {muted ? 'SON : OFF' : 'SON : ON'}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            const res = engineRef.current?.stopEarly();
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

    // Contour des zones de guidage.
    c.strokeStyle = 'rgba(0, 255, 0, 0.4)';
    c.lineWidth = 1;
    for (let col = 0; col <= COLS; col++) {
      c.beginPath(); c.moveTo(toX(col / COLS), toY(0)); c.lineTo(toX(col / COLS), toY(1)); c.stroke();
    }
    for (let row = 0; row <= ROWS; row++) {
      c.beginPath(); c.moveTo(toX(0), toY(row / ROWS)); c.lineTo(toX(1), toY(row / ROWS)); c.stroke();
    }

    c.fillStyle = '#00FF00';
    c.font = '12px Fira Code, monospace';
    c.textAlign = 'center';
    c.fillText('ÉPAULES', W / 2, 16);
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
          ZONES VALIDÉES : {result?.zonesCovered ?? 0} / {result?.zonesTotal ?? ROWS * COLS}
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
