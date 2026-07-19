/**
 * Matematica minimapului (navigatorul de ansamblu, docs/04) — MODUL PUR,
 * testat in test:minimap, fara DOM.
 *
 * Minimapul arata intreaga scena in miniatura (copie vie prin <use> pe grupul
 * #viewport) plus dreptunghiul zonei vizibile; click/drag pe el muta camera.
 * Toata geometria e aici, in trei sisteme de coordonate:
 *   - LUME: coordonatele diagramei (pozitiile ELK/drag);
 *   - ECRAN: pixelii canvas-ului; camera V(p) = k*p + (tx,ty);
 *   - MINIMAP: pixelii locali ai minimapului; M(p) = s*p + (ox,oy).
 * Copia <use> a scenei poarta transformul camerei (e #viewport), deci grupul
 * ei primeste U = M ∘ V⁻¹, care anuleaza camera si aduce lumea la scara
 * minimapului.
 */

export interface MmBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** camera vederii (aceleasi campuri ca state.tx/ty/k) */
export interface MmCam {
  tx: number;
  ty: number;
  k: number;
}

/** maparea lume->minimap: mx = ox + s*wx, my = oy + s*wy */
export interface MmLayout {
  s: number;
  ox: number;
  oy: number;
}

/** scara+offsetul care incadreaza limitele lumii in minimapul w×h cu pad,
 *  centrat; scara e uniforma (aspectul lumii se pastreaza) */
export function minimapLayout(
  b: MmBounds,
  w: number,
  h: number,
  pad: number
): MmLayout {
  const s = Math.min(
    (w - 2 * pad) / Math.max(b.w, 1),
    (h - 2 * pad) / Math.max(b.h, 1)
  );
  return {
    s,
    ox: (w - b.w * s) / 2 - b.x * s,
    oy: (h - b.h * s) / 2 - b.y * s,
  };
}

/** transformul SVG al grupului care contine copia <use> a scenei:
 *  U = M ∘ V⁻¹ (anuleaza camera, aduce lumea la scara minimapului) */
export function minimapUseTransform(l: MmLayout, cam: MmCam): string {
  const f = l.s / cam.k;
  return `translate(${l.ox - f * cam.tx},${l.oy - f * cam.ty}) scale(${f})`;
}

/** dreptunghiul zonei VIZIBILE (canvas vw×vh vazut prin camera), in
 *  coordonate minimap — dreptunghiul de vedere desenat peste miniatura */
export function minimapViewRect(
  l: MmLayout,
  cam: MmCam,
  vw: number,
  vh: number
): MmBounds {
  const f = l.s / cam.k;
  return {
    x: l.ox - f * cam.tx,
    y: l.oy - f * cam.ty,
    w: f * vw,
    h: f * vh,
  };
}

/** camera care CENTREAZA vederea pe punctul minimap (mx,my), pastrand zoomul:
 *  inversul lui M pana in lume, apoi centrare pe canvasul vw×vh */
export function cameraForMinimapPoint(
  l: MmLayout,
  mx: number,
  my: number,
  k: number,
  vw: number,
  vh: number
): { tx: number; ty: number } {
  const wx = (mx - l.ox) / l.s;
  const wy = (my - l.oy) / l.s;
  return { tx: vw / 2 - k * wx, ty: vh / 2 - k * wy };
}
