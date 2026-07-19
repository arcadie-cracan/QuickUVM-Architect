// Ruterul de interconexiuni (docs/04): rutare ortogonala cu evitare de
// obstacole pe grila de 8, prototipul propriu A* (varianta Lee cu costuri).
// Modul pur, fara DOM — testabil in Node (scripts/test-router.mjs).
//
// Interfata e fixa (docs/04), ca implementarea sa fie interschimbabila cu
// alternativa libavoid-WASM la prototipul comparativ:
//   route(obstacles, pins, constraints) -> polylines
//
// Alegeri de proiectare, la scara diagramei (zeci de obstacole, sute de
// muchii):
// - A* pe celule de grila cu stare (x, y, directie): penalizarea coturilor
//   e parte din cost, deci traseele ies drepte cand pot fi drepte;
// - obstacolele se umfla cu o celula (traseele nu ating peretii);
// - ancorele au directie de iesire/intrare impusa (pin vest iese spre
//   stanga etc.), cu un culoar liber prin obstacolul propriu;
// - fara evitare muchie-muchie in v1 — doar obstacole si coturi minime.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** haloul propriu, in px (implicit: haloul global din constrangeri) */
  pad?: number;
  /** obstacol MOALE: traversarea costa `cost` per celula in loc sa fie
   *  interzisa — folosit la texte (etichete/adnotari): cand canalele se
   *  strang, ruterul trece peste o eticheta in loc sa cada pe fallback
   *  prin blocuri */
  cost?: number;
}

/** ancora unei muchii: punctul de pe granita nodului + directia de iesire */
export interface RouteAnchor {
  x: number;
  y: number;
  /** directia orizontala a iesirii din nod: +1 est, -1 vest */
  dir: 1 | -1;
}

export interface RouteRequest {
  id: string;
  source: RouteAnchor;
  target: RouteAnchor;
  /** grupul (net-ul) cererii: muchiile aceluiasi grup au voie sa imparta
   *  trunchiul comun (fan-out), fara penalizare de suprapunere */
  group?: string;
}

export interface RouteConstraints {
  /** pasul grilei (implicit 8, ca restul geometriei — docs/04) */
  grid?: number;
  /** costul unui cot, in celule de mers drept (implicit 4) */
  bendPenalty?: number;
  /** costul suprapunerii paralele cu traseul altui net, per celula
   *  (implicit 8 — practic interzisa cand exista alt culoar) */
  overlapPenalty?: number;
  /** costul traversarii perpendiculare a traseului altui net (implicit 2 —
   *  intersectiile sunt permise, dar mai rare cand exista alternativa) */
  crossPenalty?: number;
  /** haloul din jurul obstacolelor, in px (implicit 16): traseele nu intra
   *  in halou, deci nu ating stub-urile si etichetele lipite de blocuri;
   *  ancorele primesc un culoar propriu prin haloul blocului lor */
  halo?: number;
  /** costul mersului prin inelul de o celula din jurul haloului (implicit
   *  1): la egalitate de lungime si coturi, traseul prefera canalul larg
   *  in locul lipirii de blocuri — strambarile obligatorii raman ieftine */
  hugPenalty?: number;
  /** costul mersului PRIN halou (implicit 6): haloul e scump, nu interzis —
   *  cand blocurile stau mai aproape decat doua halouri, firul se strecoara
   *  prin gol platind costul, in loc sa cada pe fallback prin blocuri;
   *  doar cutiile propriu-zise raman ziduri absolute */
  haloPenalty?: number;
  /** raza (in celule) in jurul ancorelor proprii in care suprapunerea paralela
   *  cu alt net NU se penalizeaza (implicit 6): firele care pornesc din aceeasi
   *  sursa (fan-out) sau converg spre aceeasi destinatie (fan-in) se suprapun
   *  langa capatul comun, in loc sa fie fortate pe culoare separate; departe de
   *  capete, penalizarea ramane (net-urile distincte nu se lipesc pe lungime) */
  fanoutRadius?: number;
}

interface Point {
  x: number;
  y: number;
}

const DIRS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/**
 * Ruteaza fiecare cerere ortogonal, ocolind obstacolele. Intoarce id ->
 * polilinie (in coordonatele diagramei); cererile fara drum lipsesc din
 * rezultat (apelantul decide fallback-ul).
 */
export function route(
  obstacles: readonly Rect[],
  requests: readonly RouteRequest[],
  constraints?: RouteConstraints
): Map<string, Point[]> {
  const grid = constraints?.grid ?? 8;
  const bendPenalty = constraints?.bendPenalty ?? 4;
  const overlapPenalty = constraints?.overlapPenalty ?? 8;
  const crossPenalty = constraints?.crossPenalty ?? 2;
  const halo = constraints?.halo ?? 16;
  const hugPenalty = constraints?.hugPenalty ?? 1;
  const haloPenalty = constraints?.haloPenalty ?? 6;
  const fanoutRadius = constraints?.fanoutRadius ?? 6;

  // -- terenul: bbox-ul obstacolelor si ancorelor + margine de 4 celule
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const o of obstacles) {
    extend(o.x, o.y);
    extend(o.x + o.w, o.y + o.h);
  }
  for (const r of requests) {
    extend(r.source.x, r.source.y);
    extend(r.target.x, r.target.y);
  }
  if (minX === Infinity) {
    return new Map();
  }
  const M = 4; // margine, in celule
  const gx0 = Math.floor(minX / grid) - M;
  const gy0 = Math.floor(minY / grid) - M;
  const gw = Math.ceil(maxX / grid) - gx0 + 2 * M;
  const gh = Math.ceil(maxY / grid) - gy0 + 2 * M;
  if (gw <= 0 || gh <= 0 || gw * gh > 1_000_000) {
    return new Map(); // teren degenerat sau absurd de mare
  }

  // -- harti de teren: cutiile obstacolelor dure sunt ziduri; haloul din
  // jurul lor e COST mare (traversabil in inghesuiala), inelul de dincolo
  // de halou e cost mic (estetica), textele au costul lor propriu
  const inflate = Math.max(1, Math.round(halo / grid));
  const blocked = new Uint8Array(gw * gh);
  const softCost = new Uint16Array(gw * gh);
  for (const o of obstacles) {
    const soft = o.cost !== undefined;
    const inf = soft
      ? Math.max(0, Math.round((o.pad ?? 0) / grid))
      : o.pad !== undefined
        ? Math.max(0, Math.round(o.pad / grid))
        : inflate;
    // cutia propriu-zisa (zid pentru obstacole dure)
    const bx1 = Math.floor(o.x / grid) - gx0;
    const by1 = Math.floor(o.y / grid) - gy0;
    const bx2 = Math.ceil((o.x + o.w) / grid) - gx0;
    const by2 = Math.ceil((o.y + o.h) / grid) - gy0;
    // halou + inel de proximitate (doar obstacole dure)
    const ring = soft ? 0 : 1;
    const x1 = bx1 - inf;
    const y1 = by1 - inf;
    const x2 = bx2 + inf;
    const y2 = by2 + inf;
    for (let y = Math.max(0, y1 - ring); y <= Math.min(gh - 1, y2 + ring); y++) {
      for (let x = Math.max(0, x1 - ring); x <= Math.min(gw - 1, x2 + ring); x++) {
        const idx = y * gw + x;
        if (soft) {
          softCost[idx] = Math.max(softCost[idx], o.cost ?? 0);
        } else if (x >= bx1 && x <= bx2 && y >= by1 && y <= by2) {
          blocked[idx] = 1;
        } else if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
          softCost[idx] = Math.max(softCost[idx], haloPenalty);
        } else {
          softCost[idx] = Math.max(softCost[idx], hugPenalty);
        }
      }
    }
  }

  // ocupanta traseelor deja rutate, pe orientari: proprietarul (indexul de
  // grup) al fiecarei celule; -1 = libera, -2 = folosita de mai multe grupuri
  const ownH = new Int32Array(gw * gh).fill(-1);
  const ownV = new Int32Array(gw * gh).fill(-1);
  const groupIdx = new Map<string, number>();
  const groupOf = (req: RouteRequest): number => {
    const key = req.group ?? req.id;
    let g = groupIdx.get(key);
    if (g === undefined) {
      g = groupIdx.size;
      groupIdx.set(key, g);
    }
    return g;
  };

  // cele scurte primele: isi iau traseele directe, cele lungi ocolesc
  const ordered = [...requests].sort(
    (a, b) =>
      Math.abs(a.source.x - a.target.x) + Math.abs(a.source.y - a.target.y) -
      (Math.abs(b.source.x - b.target.x) + Math.abs(b.source.y - b.target.y))
  );

  const result = new Map<string, Point[]>();
  for (const req of ordered) {
    const group = groupOf(req);
    const out = routeOne(req, {
      grid, bendPenalty, overlapPenalty, crossPenalty,
      corridor: inflate + 4,
      fanoutRadius,
      gx0, gy0, gw, gh, blocked, softCost, ownH, ownV, group,
    });
    if (out) {
      result.set(req.id, out.points);
      // marcheaza celulele traseului, pe orientarea fiecarui pas
      for (let i = 0; i < out.cells.length - 1; i++) {
        const a = out.cells[i];
        const b = out.cells[i + 1];
        const own = a.y === b.y ? ownH : ownV;
        for (const c of [a, b]) {
          const idx = c.y * gw + c.x;
          if (own[idx] === -1) {
            own[idx] = group;
          } else if (own[idx] !== group) {
            own[idx] = -2;
          }
        }
      }
    }
  }
  return result;
}

interface Terrain {
  grid: number;
  bendPenalty: number;
  overlapPenalty: number;
  crossPenalty: number;
  /** lungimea culoarului liber de la ancore, in celule */
  corridor: number;
  /** raza in jurul ancorelor unde suprapunerea nu se penalizeaza (fan-out/in) */
  fanoutRadius: number;
  gx0: number;
  gy0: number;
  gw: number;
  gh: number;
  blocked: Uint8Array;
  softCost: Uint16Array;
  ownH: Int32Array;
  ownV: Int32Array;
  group: number;
}

interface RouteResult {
  /** polilinia finala, in coordonatele diagramei */
  points: Point[];
  /** celulele de grila traversate (pentru marcarea ocupantei) */
  cells: Point[];
}

function routeOne(req: RouteRequest, t: Terrain): RouteResult | null {
  const {
    grid, bendPenalty, overlapPenalty, crossPenalty, corridor, fanoutRadius,
    gx0, gy0, gw, gh, blocked, softCost, ownH, ownV, group,
  } = t;
  const sx = Math.round(req.source.x / grid) - gx0;
  const sy = Math.round(req.source.y / grid) - gy0;
  const tx = Math.round(req.target.x / grid) - gx0;
  const ty = Math.round(req.target.y / grid) - gy0;
  const sDir = req.source.dir > 0 ? 0 : 1; // indexul in DIRS
  const tDir = req.target.dir > 0 ? 1 : 0; // directia de MERS spre pin

  // culoar liber la ancore: celule pe directia de iesire/intrare care
  // raman traversabile chiar daca stau in haloul obstacolului propriu
  const free = new Set<number>();
  for (let i = 0; i <= corridor; i++) {
    free.add((sy) * gw + (sx + Math.sign(DIRS[sDir].x) * i));
    free.add((ty) * gw + (tx - Math.sign(DIRS[tDir].x) * i));
  }
  const isBlocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= gw || y >= gh) {
      return true;
    }
    const idx = y * gw + x;
    return blocked[idx] === 1 && !free.has(idx);
  };

  // A* cu stare (celula, directie); cost: 1/celula + bendPenalty/cot
  const stateCount = gw * gh * 4;
  const dist = new Float64Array(stateCount).fill(Infinity);
  const prev = new Int32Array(stateCount).fill(-1);
  const sid = (sy * gw + sx) * 4 + sDir;
  dist[sid] = 0;
  // coada de prioritati minimala (heap binar pe perechi [f, stateId])
  const heap: number[] = [];
  const push = (f: number, id: number): void => {
    heap.push(f, id);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= heap[i * 2]) {
        break;
      }
      swap(i, p);
      i = p;
    }
  };
  const swap = (a: number, b: number): void => {
    const f = heap[a * 2];
    const v = heap[a * 2 + 1];
    heap[a * 2] = heap[b * 2];
    heap[a * 2 + 1] = heap[b * 2 + 1];
    heap[b * 2] = f;
    heap[b * 2 + 1] = v;
  };
  const pop = (): number => {
    const top = heap[1];
    const n = heap.length / 2 - 1;
    swap(0, n);
    heap.length -= 2;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && heap[l * 2] < heap[m * 2]) {
        m = l;
      }
      if (r < n && heap[r * 2] < heap[m * 2]) {
        m = r;
      }
      if (m === i) {
        break;
      }
      swap(i, m);
      i = m;
    }
    return top;
  };
  const h = (x: number, y: number): number =>
    Math.abs(x - tx) + Math.abs(y - ty);

  push(h(sx, sy), sid);
  const goal = (ty * gw + tx) * 4 + tDir;
  let found = false;
  while (heap.length) {
    const cur = pop();
    if (cur === goal) {
      found = true;
      break;
    }
    const d = dist[cur];
    const cdir = cur % 4;
    const cell = (cur - cdir) / 4;
    const cx = cell % gw;
    const cy = (cell - cx) / gw;
    for (let nd = 0; nd < 4; nd++) {
      // fara intoarcere la 180 de grade
      if ((cdir ^ nd) === 1 && (cdir >> 1) === (nd >> 1)) {
        continue;
      }
      const nx = cx + DIRS[nd].x;
      const ny = cy + DIRS[nd].y;
      if (isBlocked(nx, ny)) {
        continue;
      }
      // suprapunerea paralela cu traseul altui net costa scump; traversarea
      // perpendiculara e permisa, dar usor penalizata (docs/04). EXCEPTIE: langa
      // ancorele PROPRII (fan-out la sursa / fan-in la destinatie) suprapunerea
      // e gratuita — firele care impart un capat se strang acolo, in loc sa fie
      // fortate pe culoare separate (cererea utilizatorului la validare)
      const idx = ny * gw + nx;
      const along = nd < 2 ? ownH[idx] : ownV[idx];
      const across = nd < 2 ? ownV[idx] : ownH[idx];
      const nearAnchor =
        Math.abs(nx - sx) + Math.abs(ny - sy) <= fanoutRadius ||
        Math.abs(nx - tx) + Math.abs(ny - ty) <= fanoutRadius;
      let occupancy = softCost[idx];
      if (along !== -1 && along !== group && !nearAnchor) {
        occupancy += overlapPenalty;
      }
      if (across !== -1 && across !== group) {
        occupancy += crossPenalty;
      }
      const cost = d + 1 + (nd === cdir ? 0 : bendPenalty) + occupancy;
      const nid = (ny * gw + nx) * 4 + nd;
      if (cost < dist[nid]) {
        dist[nid] = cost;
        prev[nid] = cur;
        push(cost + h(nx, ny), nid);
      }
    }
  }
  if (!found) {
    return null;
  }

  // reconstructie + simplificare coliniara, inapoi in coordonate diagrama
  const cells: Point[] = [];
  for (let cur = goal; cur !== -1; cur = prev[cur]) {
    const cell = (cur - (cur % 4)) / 4;
    const x = cell % gw;
    cells.push({ x, y: (cell - x) / gw });
    if (cur === sid) {
      break;
    }
  }
  cells.reverse();
  const pts: Point[] = [];
  const emit = (p: Point): void => {
    const n = pts.length;
    if (n >= 1 && pts[n - 1].x === p.x && pts[n - 1].y === p.y) {
      return; // duplicat exact
    }
    if (
      n >= 2 &&
      ((pts[n - 1].x === pts[n - 2].x && p.x === pts[n - 1].x) ||
        (pts[n - 1].y === pts[n - 2].y && p.y === pts[n - 1].y))
    ) {
      pts[n - 1] = p; // prelungeste segmentul coliniar
    } else {
      pts.push(p);
    }
  };
  // ancorele exacte se INSEREAZA la capete (nu inlocuiesc punctele de
  // grila): ancora imparte y-ul cu celula sa, deci stub-ul ramane
  // orizontal chiar si cu x fractionar — niciodata segmente oblice
  emit({ x: req.source.x, y: req.source.y });
  for (const c of cells) {
    emit({ x: (c.x + gx0) * grid, y: (c.y + gy0) * grid });
  }
  emit({ x: req.target.x, y: req.target.y });
  return { points: pts, cells };
}
