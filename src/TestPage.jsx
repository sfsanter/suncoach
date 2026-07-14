import { useCallback, useMemo, useState } from 'react';
import { Button, Card, EmergencyBanner, TerminalDisplay } from '@mdrbx/nerv-ui';
import {
  DEFAULT_RECEIVER_PORT,
  loadReceiverConfig,
  saveReceiverConfig,
  normalizeIpInput,
} from './lib/testMode.js';
import { minimapDebugInfo } from './lib/minimapCanvas.js';

const INSTRUCTIONS = [
  '01. SUR LE MAC : node test-receiver.mjs (déjà actif si curl OK).',
  '02. IP MAC : 172.20.10.9 si partage iPhone (voir curl sur Mac).',
  '03. SAISIS L’IP CI-DESSOUS — ou ajoute &mac=172.20.10.9 dans l’URL.',
  '04. ATTENDS « MODÈLE IA : PRÊT » puis LANCE LA SESSION.',
  '05. APRÈS TEST : CAPTURER → ENVOYER AU MAC.',
];

function staticMeta() {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return {
    build: typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : null,
    url: typeof window !== 'undefined' ? window.location.href : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    dpr,
    capturedAt: new Date().toISOString(),
  };
}

function minimapSnapshotJpeg(engine) {
  const canvas = engine?.minimap;
  if (!canvas || canvas.width < 1 || canvas.height < 1) return null;
  try {
    return canvas.toDataURL('image/jpeg', 0.55);
  } catch {
    return null;
  }
}

export function buildCapturePayload(engine) {
  const meta = staticMeta();
  const bundle = engine?.getDebugBundle?.() ?? null;
  const minimapCanvas = engine?.minimap ?? null;

  return {
    ...meta,
    engine: bundle,
    minimapDebug: minimapCanvas ? minimapDebugInfo(minimapCanvas) : null,
    minimapJpeg: minimapSnapshotJpeg(engine),
    hasActiveSession: !!engine && engine.state !== 'idle',
  };
}

export default function TestPage({ engine, onBack, onStartSession, sessionActive, modelStatus, lastError }) {
  const initial = useMemo(() => loadReceiverConfig(), []);
  const [macIp, setMacIp] = useState(initial.ip);
  const [macPort, setMacPort] = useState(initial.port || DEFAULT_RECEIVER_PORT);
  const [payload, setPayload] = useState(null);
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const buildId = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : '?';
  const minimap = engine?.minimap;

  const handleCapture = useCallback(() => {
    const data = buildCapturePayload(engine);
    setPayload(data);
    setStatus('État capturé — prêt à envoyer ou exporter.');
  }, [engine]);

  const handleSend = useCallback(async () => {
    if (!payload) {
      setStatus('Capture d’abord l’état debug.');
      return;
    }
    const ip = macIp.trim();
    if (!ip) {
      setStatus('Saisis l’IP du Mac (ex. 192.168.1.42).');
      return;
    }
    const port = parseInt(String(macPort), 10) || DEFAULT_RECEIVER_PORT;
    saveReceiverConfig(ip, port);
    setSending(true);
    setStatus(`Envoi vers http://${ip}:${port}/capture…`);
    try {
      const res = await fetch(`http://${ip}:${port}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setStatus(`OK — sauvegardé : ${body.file ?? 'capture'}`);
    } catch (err) {
      setStatus(`Échec envoi : ${err.message}. Vérifie IP, WiFi, node test-receiver.mjs.`);
    } finally {
      setSending(false);
    }
  }, [payload, macIp, macPort]);

  const handleCopy = useCallback(async () => {
    if (!payload) {
      setStatus('Capture d’abord l’état debug.');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatus('JSON copié dans le presse-papiers.');
    } catch {
      setStatus('Copie impossible — utilise Télécharger JSON.');
    }
  }, [payload]);

  const handleDownload = useCallback(() => {
    if (!payload) {
      setStatus('Capture d’abord l’état debug.');
      return;
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `suncoach-debug-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('JSON téléchargé.');
  }, [payload]);

  return (
    <div className="relative min-h-full overflow-y-auto bg-nerv-black">
      <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
        <EmergencyBanner
          text="TEST MODE — LAN SYNC"
          subtext={`BUILD ${buildId} · dpr ${dpr} · transmission debug vers Mac`}
          severity="warning"
          visible
        />

        <Card eyebrow="NERV // DIAGNOSTIC" title="Panneau test SunCoach" variant="default">
          <TerminalDisplay lines={INSTRUCTIONS} color="orange" prompt=">" title="PROCÉDURE" />
        </Card>

        {lastError && (
          <EmergencyBanner text="DERNIÈRE ERREUR SESSION" subtext={lastError} severity="warning" visible />
        )}

        <div
          className="rounded border border-nerv-orange/30 bg-nerv-panel p-3 text-xs text-nerv-green/90"
          style={{ fontFamily: 'var(--font-nerv-mono)' }}
        >
          <div>BUILD : {buildId}</div>
          <div>DPR : {dpr}</div>
          <div>
            MINIMAP :{' '}
            {minimap
              ? `${minimap.width}×${minimap.height} buf · ${minimap.style?.width}×${minimap.style?.height} css`
              : '— (pas de session)'}
          </div>
          <div>MODÈLE IA : {modelStatus === 'ok' ? 'PRÊT' : modelStatus === 'fail' ? 'ÉCHEC — vérifie 4G/WiFi' : 'CHARGEMENT…'}</div>
          <div>SESSION : {sessionActive ? (engine?.state ?? 'active') : 'inactive'}</div>
        </div>

        <div className="flex flex-col gap-2">
          <label
            className="text-xs tracking-wider text-nerv-orange/80"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            IP DU MAC
          </label>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            lang="en"
            placeholder="172.20.10.9"
            value={macIp}
            onChange={(e) => setMacIp(normalizeIpInput(e.target.value))}
            className="rounded border border-nerv-orange/40 bg-black px-3 py-2 text-lg tracking-wider text-nerv-green outline-none focus:border-nerv-orange"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          />
          <p className="text-[10px] text-nerv-white/50" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
            Astuce : tape les points via la barre de suggestions, ou ouvre
            {' '}<span className="text-nerv-orange">?test=1&amp;mac=172.20.10.9</span>
          </p>
          <label
            className="text-xs tracking-wider text-nerv-orange/80"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            PORT (défaut {DEFAULT_RECEIVER_PORT})
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={macPort}
            onChange={(e) => setMacPort(normalizeIpInput(e.target.value))}
            className="rounded border border-nerv-orange/40 bg-black px-3 py-2 text-lg text-nerv-green outline-none focus:border-nerv-orange"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          />
        </div>

        <Button variant="primary" size="lg" fullWidth onClick={handleCapture}>
          CAPTURER ÉTAT DEBUG
        </Button>

        {payload?.minimapJpeg && (
          <img
            src={payload.minimapJpeg}
            alt="Snapshot minimap"
            className="mx-auto rounded border border-nerv-green/40"
            style={{ maxWidth: 110 }}
          />
        )}

        <Button variant="primary" size="lg" fullWidth onClick={handleSend} disabled={sending}>
          {sending ? 'ENVOI…' : 'ENVOYER AU MAC'}
        </Button>

        <div className="flex gap-2">
          <Button variant="ghost" fullWidth onClick={handleCopy}>
            COPIER JSON
          </Button>
          <Button variant="ghost" fullWidth onClick={handleDownload}>
            TÉLÉCHARGER JSON
          </Button>
        </div>

        {!sessionActive && onStartSession && (
          <Button
            variant="terminal"
            size="lg"
            fullWidth
            onClick={onStartSession}
            disabled={modelStatus !== 'ok'}
          >
            {modelStatus === 'ok' ? 'LANCER UNE SESSION TEST' : modelStatus === 'fail' ? 'MODÈLE IA INDISPONIBLE' : 'CHARGEMENT MODÈLE…'}
          </Button>
        )}

        {onBack && (
          <Button variant="ghost" fullWidth onClick={onBack}>
            RETOUR
          </Button>
        )}

        {status && (
          <p
            className="text-center text-xs text-nerv-orange/90"
            style={{ fontFamily: 'var(--font-nerv-mono)' }}
          >
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
