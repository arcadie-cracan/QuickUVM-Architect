/**
 * Minimap math (the overview navigator, docs/04) — PURE MODULE,
 * tested in test:minimap, without DOM.
 *
 * The minimap shows the whole scene in miniature (a live copy via <use> on the
 * #viewport group) plus the rectangle of the visible area; click/drag on it moves the camera.
 * All the geometry is here, in three coordinate systems:
 *   - WORLD: the diagram coordinates (the ELK/drag positions);
 *   - SCREEN: the canvas pixels; camera V(p) = k*p + (tx,ty);
 *   - MINIMAP: the minimap's local pixels; M(p) = s*p + (ox,oy).
 * The scene's <use> copy carries the camera transform (it's #viewport), so its
 * group receives U = M ∘ V⁻¹, which cancels the camera and brings the world to the
 * minimap's scale.
 */

export interface MmBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the view's camera (same fields as state.tx/ty/k) */
export interface MmCam {
  tx: number;
  ty: number;
  k: number;
}

/** the world->minimap mapping: mx = ox + s*wx, my = oy + s*wy */
export interface MmLayout {
  s: number;
  ox: number;
  oy: number;
}

/** the scale+offset that fits the world bounds into the w×h minimap with pad,
 *  centered; the scale is uniform (the world's aspect ratio is preserved) */
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

/** the SVG transform of the group that contains the scene's <use> copy:
 *  U = M ∘ V⁻¹ (cancels the camera, brings the world to the minimap's scale) */
export function minimapUseTransform(l: MmLayout, cam: MmCam): string {
  const f = l.s / cam.k;
  return `translate(${l.ox - f * cam.tx},${l.oy - f * cam.ty}) scale(${f})`;
}

/** the rectangle of the VISIBLE area (the vw×vh canvas seen through the camera), in
 *  minimap coordinates — the view rectangle drawn over the miniature */
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

/** the camera that CENTERS the view on the minimap point (mx,my), keeping the zoom:
 *  the inverse of M back into the world, then centering on the vw×vh canvas */
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
