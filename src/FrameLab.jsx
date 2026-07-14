import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, EmergencyBanner } from '@mdrbx/nerv-ui';
import { ANCHOR_ORDER, CALIBRATION_STEPS } from './lib/backCalibration.js';
import { buildBackWarp } from './lib/backWarp.js';
import { drawMinimapScene } from './lib/minimapRender.js';
import { contactFromImageDiff } from './lib/handDiff.js';
import {
  preloadHandLandmarker,
  detectHandsOnImageLab,
  contactsFromHandLandmarker,
} from './lib/handLandmarker.js';

const LABELS = Object.fromEntries(CALIBRATION_STEPS.map((step) => [step.id, step.label]));
const ANCHOR_KEY = 'suncoach-frame-lab-anchors';

const FRAMES = [
  { id: 'vide', label: 'Sans rien', src: '/test-frames/vide.png' },
  { id: 'simple', label: 'Simple', src: '/test-frames/simple.png' },
  { id: 'complexe', label: 'Compliquée', src: '/test-frames/complexe.png' },
];

const BASE_SRC = FRAMES[0].src;

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

const DOT_COLOR = {
  'hand-lm': '#00FFFF',
  'hand-lm-hors': '#FFFF00',
  diff: '#FF9900',
};

export default function FrameLab() {
  const imageRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [frameId, setFrameId] = useState('vide');
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  const [anchors, setAnchors] = useState(loadAnchors);
  const [busy, setBusy] = useState(false);
  const [handsReady, setHandsReady] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [status, setStatus] = useState('Place les 8 points sur « Sans rien », puis teste Hand Landmarker.');

  const frame = FRAMES.find((f) => f.id === frameId) ?? FRAMES[0];
  const placingAnchors = frameId === 'vide';
  const nextId = placingAnchors ? ANCHOR_ORDER.find((id) => !anchors[id]) ?? null : null;
  const warp = useMemo(
    () => (ANCHOR_ORDER.every((id) => anchors[id]) ? buildBackWarp(anchors) : null),
    [anchors],
  );

  useEffect(() => {
    preloadHandLandmarker()
      .then(() => setHandsReady(true))
      .catch(() => setStatus('Hand Landmarker indisponible — vérifie la connexion (?cpu=1 si GPU lent).'));
  }, []);

  const drawMinimap = useCallback((activeContacts) => {
    const canvas = canvasRef.current;
    if (!canvas || !warp) return null;
    const scene = drawMinimapScene(canvas.getContext('2d'), {
      width: canvas.width,
      height: canvas.height,
      warp,
      background: '#050805',
      bottomSpace: 8,
    });
    if (!scene || !activeContacts?.length) return scene;
    const ctx = canvas.getContext('2d');
    for (const c of activeContacts) {
      if (!c.display) continue;
      const x = scene.toX(c.display.u);
      const y = scene.toY(c.display.v);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOR[c.source] ?? '#00FFFF';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    return scene;
  }, [warp]);

  useEffect(() => {
    drawMinimap(contacts.filter((c) => c.display));
  }, [contacts, warp, drawMinimap]);

  useEffect(() => {
    if (ANCHOR_ORDER.every((id) => anchors[id])) saveAnchors(anchors);
  }, [anchors]);

  const pointFromEvent = (event) => {
    const image = imageRef.current;
    if (!image || !imageSize.w || !imageSize.h) return null;
    const rect = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(imageSize.w, ((event.clientX - rect.left) / rect.width) * imageSize.w)),
      y: Math.max(0, Math.min(imageSize.h, ((event.clientY - rect.top) / rect.height) * imageSize.h)),
    };
  };

  const addPoint = (event) => {
    if (!placingAnchors || !nextId || dragRef.current) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [nextId]: point }));
  };

  const movePoint = (event) => {
    const id = dragRef.current;
    if (!id) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [id]: point }));
  };

  const runHands = async () => {
    const image = imageRef.current;
    if (!image?.naturalWidth) return;
    if (!warp) {
      setStatus('Termine les 8 points sur « Sans rien » avant de tester.');
      return;
    }
    setBusy(true);
    setContacts([]);
    try {
      const { result, mode } = await detectHandsOnImageLab(image, anchors);
      const out = contactsFromHandLandmarker(
        result,
        image.naturalWidth,
        image.naturalHeight,
        warp,
        mode,
      );
      setContacts(out.contacts.filter((c) => c.pixel));
      setStatus(out.reason);
    } catch (err) {
      setStatus(`Erreur Hands : ${String(err?.message || err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runDiff = async () => {
    if (!warp) {
      setStatus('Termine les 8 points sur « Sans rien » avant de tester.');
      return;
    }
    setBusy(true);
    setContacts([]);
    try {
      const out = await contactFromImageDiff({
        baseSrc: BASE_SRC,
        poseSrc: frame.src,
        warp,
        width: imageSize.w || undefined,
        height: imageSize.h || undefined,
      });
      setContacts(out.contacts.filter((c) => c.pixel && c.display));
      setStatus(`(diff abandonnée produit) ${out.reason}`);
    } catch (err) {
      setStatus(`Erreur diff : ${String(err?.message || err)}`);
    } finally {
      setBusy(false);
    }
  };

  const switchFrame = (id) => {
    setFrameId(id);
    setContacts([]);
    setStatus(id === 'vide'
      ? (ANCHOR_ORDER.every((a) => anchors[a])
        ? '8 points OK — passe à Simple ou Compliquée.'
        : `Clique : ${LABELS[ANCHOR_ORDER.find((a) => !anchors[a])] ?? '?'}`)
      : 'DÉTECTER (HANDS) = MediaPipe Hand Landmarker seul.');
  };

  return (
    <div className="min-h-screen bg-nerv-black px-4 py-5 text-nerv-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <EmergencyBanner
          text="LABO 3 CAPTURES — HAND LANDMARKER"
          subtext="Test Hands seul (pas Holistic). Session inchangée. Cyan = main dans le warp · Jaune = hors warp · Orange = diff (référence)."
          severity="info"
          visible
        />

        <div className="flex flex-wrap gap-2">
          {FRAMES.map((f) => (
            <Button
              key={f.id}
              variant={frameId === f.id ? 'primary' : 'ghost'}
              onClick={() => switchFrame(f.id)}
            >
              {f.label.toUpperCase()}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => { setAnchors({}); localStorage.removeItem(ANCHOR_KEY); setContacts([]); }}>
            EFFACER LES 8 POINTS
          </Button>
          <Button variant="ghost" onClick={() => { window.location.href = window.location.pathname; }}>
            RETOUR SUNCOACH
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
          <Card
            eyebrow={frame.label.toUpperCase()}
            title={placingAnchors && nextId ? `Clique : ${LABELS[nextId]}` : 'Capture de test'}
            variant="default"
          >
            <div
              className="relative inline-block max-h-[70vh] max-w-full touch-none"
              onPointerDown={addPoint}
            >
              <img
                ref={imageRef}
                key={frame.src}
                src={frame.src}
                alt={frame.label}
                draggable={false}
                className="block max-h-[70vh] max-w-full select-none"
                onLoad={(event) => setImageSize({
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                })}
              />
              {placingAnchors && ANCHOR_ORDER.map((id) => {
                const point = anchors[id];
                if (!point || !imageSize.w) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-nerv-green px-1 text-[8px] font-bold text-black"
                    style={{ left: `${(point.x / imageSize.w) * 100}%`, top: `${(point.y / imageSize.h) * 100}%` }}
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
              {contacts.map((c, i) => (
                <span
                  key={`${c.source}-${i}`}
                  className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black"
                  style={{
                    left: `${(c.pixel.x / imageSize.w) * 100}%`,
                    top: `${(c.pixel.y / imageSize.h) * 100}%`,
                    backgroundColor: DOT_COLOR[c.source] ?? '#00FFFF',
                  }}
                />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || !warp || placingAnchors || !handsReady}
                onClick={runHands}
              >
                {busy ? 'ANALYSE…' : handsReady ? 'DÉTECTER (HANDS)' : 'CHARGEMENT HANDS…'}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !warp || placingAnchors}
                onClick={runDiff}
              >
                DIFF (RÉF.)
              </Button>
            </div>
            <p className="mt-2 text-xs text-nerv-white/70" style={{ fontFamily: 'var(--font-nerv-mono)' }}>
              {status}
            </p>
          </Card>

          <Card eyebrow="MINIMAP" title="Même point ?" variant="default">
            <canvas ref={canvasRef} width="240" height="320" className="mx-auto block max-w-full border border-nerv-green/30" />
            <p className="mt-3 text-xs text-nerv-white/60">
              {warp
                ? 'Le cyan photo doit coller à la main. Si oui, le minimap suit (warp déjà OK).'
                : `${Object.keys(anchors).length}/8 points — calibre sur « Sans rien ».`}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
