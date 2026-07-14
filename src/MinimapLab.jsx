import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, EmergencyBanner } from '@mdrbx/nerv-ui';
import { ANCHOR_ORDER, CALIBRATION_STEPS } from './lib/backCalibration.js';
import { buildBackWarp } from './lib/backWarp.js';
import { ANATOMICAL_ZONES } from './lib/zones.js';
import { drawMinimapScene } from './lib/minimapRender.js';

const LABELS = Object.fromEntries(CALIBRATION_STEPS.map((step) => [step.id, step.label]));

function drawPreview(canvas, warp) {
  const ctx = canvas.getContext('2d');
  drawMinimapScene(
    ctx,
    {
      width: canvas.width,
      height: canvas.height,
      warp,
      heat: {
        w: 18,
        h: 24,
        isBody: () => true,
        fractionAt: (index) => Math.floor(index / 18) / 23,
      },
      colorForFraction: (fraction) => [
        Math.round(255 - fraction * 225),
        Math.round(110 + fraction * 145),
        Math.round(25 + fraction * 65),
        190,
      ],
      showZones: ANATOMICAL_ZONES,
      background: '#050805',
    },
  );
}

export default function MinimapLab() {
  const imageRef = useRef(null);
  const fileRef = useRef(null);
  const canvasRef = useRef(null);
  const blobRef = useRef(null);
  const dragRef = useRef(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  const [anchors, setAnchors] = useState({});

  const nextId = ANCHOR_ORDER.find((id) => !anchors[id]) ?? null;
  const warp = useMemo(
    () => (ANCHOR_ORDER.every((id) => anchors[id]) ? buildBackWarp(anchors) : null),
    [anchors],
  );

  useEffect(() => {
    drawPreview(canvasRef.current, warp);
  }, [warp]);

  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
  }, []);

  const pointFromEvent = (event) => {
    const image = imageRef.current;
    if (!image || !imageSize.w || !imageSize.h) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(imageSize.w, ((event.clientX - rect.left) / rect.width) * imageSize.w)),
      y: Math.max(0, Math.min(imageSize.h, ((event.clientY - rect.top) / rect.height) * imageSize.h)),
    };
  };

  const chooseImage = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(file);
    blobRef.current = url;
    setImageUrl(url);
    setAnchors({});
    event.target.value = '';
  };

  const addPoint = (event) => {
    if (!nextId || dragRef.current) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [nextId]: point }));
  };

  const movePoint = (event) => {
    const id = dragRef.current;
    if (!id) return;
    const point = pointFromEvent(event);
    if (point) setAnchors((current) => ({ ...current, [id]: point }));
  };

  return (
    <div className="min-h-screen bg-nerv-black px-4 py-5 text-nerv-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <EmergencyBanner
          text="LABO MINIMAP — SANS MEDIAPIPE"
          subtext="Image + 8 points → warp, zones et aperçu. Aucun impact sur le protocole."
          severity="info"
          visible
        />

        <div className="flex flex-wrap gap-3">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={chooseImage} />
          <Button variant="primary" onClick={() => fileRef.current?.click()}>CHOISIR UNE IMAGE</Button>
          <Button variant="ghost" onClick={() => setAnchors({})} disabled={!imageUrl}>RECOMMENCER LES POINTS</Button>
          <Button variant="ghost" onClick={() => { window.location.href = window.location.pathname; }}>RETOUR SUNCOACH</Button>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
          <Card
            eyebrow="PHOTO FIGÉE"
            title={nextId ? `Clique : ${LABELS[nextId] ?? nextId}` : '8 points placés'}
            variant="default"
          >
            {!imageUrl && <p className="text-sm text-nerv-white/60">Choisis une capture où le dos est visible.</p>}
            {imageUrl && (
              <div className="relative inline-block max-h-[70vh] max-w-full touch-none" onPointerDown={addPoint}>
                <img
                  ref={imageRef}
                  src={imageUrl}
                  alt="Dos pour calibration"
                  draggable={false}
                  className="block max-h-[70vh] max-w-full select-none"
                  onLoad={(event) => setImageSize({
                    w: event.currentTarget.naturalWidth,
                    h: event.currentTarget.naturalHeight,
                  })}
                />
                {ANCHOR_ORDER.map((id) => {
                  const point = anchors[id];
                  if (!point || !imageSize.w || !imageSize.h) return null;
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
              </div>
            )}
          </Card>

          <Card eyebrow="RENDU INDÉPENDANT" title="Minimap" variant="default">
            <canvas ref={canvasRef} width="240" height="320" className="mx-auto block max-w-full border border-nerv-green/30" />
            <p className="mt-3 text-xs text-nerv-white/60">
              {warp
                ? 'Warp actif : contour vert, zones blanches, fausse heatmap orange → verte.'
                : `${Object.keys(anchors).length}/8 points — termine le placement pour générer la minimap.`}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
