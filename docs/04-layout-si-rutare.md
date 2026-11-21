# 04 — Layout, poziții deținute de utilizator și rutare

## Strategia de layout (decizie închisă)

Combinație a două mecanisme, cu roluri precise:

1. **Layout inițial de calitate** — la prima deschidere a unei vederi sau la
   comanda explicită "Re-aranjează tot": ELK `layered` complet
   (minimizarea încrucișărilor, `portConstraints: FIXED_SIDE`, intrări pe
   stânga, ieșiri pe dreapta, ceas/reset grupate stânga-jos, rutare ortogonală
   de pornire).
2. **Pozițiile aparțin utilizatorului** — după layoutul inițial, nodurile se
   pot trage liber; pozițiile (calculate sau mutate) se persistă. La modificări
   de design, ELK rulează în **mod interactiv**
   (`layering/crossingMinimization/nodePlacement: INTERACTIVE`) cu
   pozițiile existente ca semințe: nodurile cunoscute rămân pe loc, doar cele
   noi primesc poziții, inserate în context. Niciun re-layout total implicit,
   niciodată.

   **Semințele sunt totale sau deloc** (iul. 2026, D21): primul gest de
   poziție face aranjamentul *întregii* vederi al utilizatorului — la finalul
   oricărui drag se persistă TOATE pozițiile curente (noduri, pliaje, steaguri
   de graniță; mesajul `layout/snapshot`, docs/05), nu doar elementele trase;
   iar la randarea unei vederi deja aranjate, elementele rămase fără sămânță
   (noi din recompilare, membri de pliaj proaspăt expandați, sidecar parțial
   moștenit) se pin-uiesc imediat, la poziția în care ELK interactiv tocmai
   le-a inserat. Motivul: modul interactiv plasează elementele fără sămânță
   *altfel* decât layoutul complet pe care îl vede utilizatorul — cu semințe
   parțiale, steagurile granițelor săreau cu sute de pixeli la redeschidere
   (regresie reală). Vederile neatinse (fără nicio sămânță) rămân complet
   automate: nu se persistă nimic pentru simpla vizitare a unei vederi.

Rezolvarea poziției unui nod, în ordine: override manual → poziția persistată
din sesiunea anterioară → poziție calculată de ELK interactiv în jurul celor de
mai sus.

The edges are **automatic by default**: the routes are recomputed from the
current positions of the nodes (the user arranges blocks and pins, and does not
have to maintain routes). A wire the user DID place by hand (level 3 of the
routing overrides below, D27) is the user's, like a position: it is kept
relative to its pins, follows them, and goes back to the router only on an
explicit reset.

## Fișierul sidecar de layout

Un fișier per proiect, textual, diff-abil, în git lângă YAML-ul QuickUVM.
Calea implicită: `.vscode/quickuvm-architect.yaml` (nu aglomerează rădăcina;
`.vscode/` e deja convenția pentru starea de proiect a editorului);
configurabilă prin setarea `quickuvm.layoutFile` (relativă la rădăcina
workspace-ului).

```yaml
schema_version: 1
views:
  demo_top.u_soc:                 # cheia vederii = calea instantei
    nodes:
      u_add:        {x: 120, y: 80}
      u_inv:        {x: 120, y: 220, flipH: true}
      "g_ch[0..2]": {x: 320, y: 150, collapsed: true}
    ports:                         # override de ordine/latura a pinilor
      din:   {side: west, order: 1}
      clk:   {side: west, order: 90}
    edges:                         # level 3: hand-routed wires, by edge id
      "sum:u_add.dout-><port>.sum":
        route: source+16 source-40 target-16   # offsets from the pins, never absolute
    nets:
      din:   {render: label}       # nivel 4: fir <-> eticheta
      clk:   {render: label}
orphans: []                        # override-uri cu tinte disparute (v. mai jos)
```

Reguli:

- toate cheile sunt ID-urile stabile din model (doc. 02); pliajele generate
  folosesc notația `nume[lo..hi]`;
- fișierul conține *doar* override-uri și poziții — niciodată date derivate din
  model (lățimi, direcții etc.);
- scriere atomică (temp + rename), o singură instanță scriitoare (host-ul);
- camera (pan/zoom) NU se persistă: e stare de sesiune a webview-ului —
  prima deschidere a unei vederi se încadrează mereu în fereastră, iar
  cadrul se păstrează doar la comutarea între vederi în aceeași sesiune
  (decizie revenită în iul. 2026: cadrele moștenite între sesiuni au produs
  constant deschideri „pe jumătate în afara ferestrei").
- docs/08 R18 (Oct 2026): two more overrides, both VIEW state. On a TB level's
  node (`tb:<config>|<focus>`), `collapsed: true` = the block drawn as its header
  only (expanded = absent; the RTL meaning of the key — a generated fold's
  `collapsed: false` = expanded — is unchanged). On an RTL view, `hidePins: true`
  = its nc / ignored pins hidden (shown = absent; the serializer copies it next
  to `nodes` and `nets`, and a view with nothing but this key is kept).
- docs/08 R21 (Nov 2026, decision D26): **secondary notation** — annotations of
  the view, on the schematic views and on every TB level, never in the YAML:

  ```yaml
  views:
    demo_top.u_soc:
      nodes:
        u_add: {x: 120, y: 80, color: green}     # a tint: a palette NAME
      frames:
        "frame:1":
          title: arith
          color: blue                            # optional
          members: [u_add, u_inv, "note:1"]      # ids of this view
      notes:
        "note:1": {x: 80, y: 392, text: "din fans out to 9 loads"}
  ```

  A **frame** stores WHO is in it, not a rectangle: its box is the members'
  bounding box plus padding, recomputed on every draw, so it survives a
  re-arrangement, a collapse and a rename, and dragging its title tab drags its
  members (one ordinary multi-node move: one total snapshot, D21). A member
  belongs to one frame; an item dragged INTO a frame's box joins it (the
  containment test at a drag's end: its centre outside before, inside after),
  leaving is an explicit action, and a frame left without members is deleted. A **note** is text at an absolute position
  (fixed width, the height follows the wrapped lines); creating one pins an
  un-arranged view first, like any gesture that fixes a place. A **colour** is
  one of six names from the theme's chart palette (`blue`, `green`, `yellow`,
  `orange`, `red`, `purple`) on a node entry, a frame or a note — a fill wash,
  so a TB box's stroke keeps saying what kind of component it is. "Re-arrange
  all" keeps all three. The webview sends the view's whole set after each
  gesture (`view/annotations`, docs/05); the host SANITISES it
  (`setAnnotations`: ids, palette names, one frame per member — on a double
  claim the lower-NUMBERED frame keeps it —, no empty frame, no empty note, a
  title of at most 80 characters and a note of 2000), and `parseSidecar` reads
  a file through the same reduction: the file is hand-editable and merged by
  git, and a frame without `members` must not be able to throw later.

- docs/08 R23 (Nov 2026): a view's **filter rules** —
  `filters: {rules: [{effect: hide, kind: agent, name: "^rsp"}], off: true}` — a
  view-level key like `hidePins`: the rule ORDER is meaning (the first match
  decides) and is never sorted; `off` keeps the rules without applying them; a
  view holding nothing but rules is kept. They are presentation, like the
  positions: no rule changes the layout or the YAML.

## Invalidarea grațioasă

The secondary notation (docs/08 R21) follows the same rule, by kind: a node's
**colour** lives on its node entry and migrates into `orphans` with it; a
**frame** stays while at least ONE of its members is a key of the view — its
dead member ids are left in place, inert, and are drawn again when their nodes
return — and migrates whole (`kind: frame`: title, colour, members) when none
is, to be restored when a member reappears; a **note** has no target and stays
while its view exists. When the view itself disappears, its frames and notes
migrate (`kind: frame` / `kind: note`) and return with it — the notes first,
so a frame around notes only comes back too. A frame's or a note's id is a
COUNTER, not a model key: an orphan whose id was reused meanwhile is restored
under the next free id (and a frame follows its note's new id), never dropped. A verification
(`tb:`) view is never invalidated against the RTL model, so its annotations
are never touched; a leaf instance's boundary view keeps its notes and frames
as it keeps `hidePins`. A view's filter rules (docs/08 R23) have no target of
their own and stay while the view exists; when it disappears they migrate
(`kind: filters`) and return with it, unless newer rules were written
meanwhile.

A hand-placed route (level 3, D27) is keyed by its EDGE, and an edge's id
names its two pins: when the edge no longer exists — a pin or a net gone, the
view itself gone — the route migrates into `orphans` (`kind: edge`) and returns
when the edge does, unless a newer route was written for it meanwhile. The same
wire has ONE id while a generate fold is folded and others when it is expanded
(the fold's pin is not its members' pins), so the valid ids are taken over the
fold combinations of the view (`validEdgeIds`: all of them up to five folds),
and every net is taken as a wire — a net shown as a label has no edges now, but
its routes wait for the day it is a wire again. A verification (`tb:`) level is
never invalidated: a route whose edge is gone from the configuration stays in
the file, inert, and is drawn again if the edge comes back (an undo of the YAML
edit); "Re-arrange all" clears it.

Când o cheie din sidecar nu mai există în model (redenumire, eroare temporară
de compilare), intrarea se mută în `orphans` cu data ultimei vederi valide; nu
se șterge. UI-ul oferă "Curăță override-urile orfane" și, la redenumiri
detectabile (același modul + aceiași parametri + aceeași poziție în părinte),
propune migrarea cheii. Este același principiu fail-closed din QuickUVM
(secțiunile pragma), aplicat layoutului.

## Ruterul de interconexiuni

Consecință a pozițiilor libere: rutarea nu mai poate veni din ELK (care rutează
doar propriile plasări). Componentă separată de rutare ortogonală cu evitare de
obstacole, cu două implementări candidate:

- **libavoid** (Adaptagrams, ruterul din Inkscape) prin build WASM — obstacole,
  puncte de trecere, penalizări; de evaluat mărimea build-ului în webview;
- **ruter propriu** pe grilă (Lee / A* cu cost pe direcție și pe apropierea de
  obstacole) — la scara diagramei (zeci de obstacole, sute de muchii) e simplu
  și suficient; avantaj: zero dependențe, control total al esteticii
  (spațiere între trasee paralele, joncțiuni).

Decizia se ia în faza 3 pe un prototip comparativ; interfața ruterului e fixă:
`route(obstacles, pins, constraints) -> polylines`, ca implementarea să fie
interschimbabilă.

## The hierarchy of routing overrides

| Level | What it controls | Persistence | Fragility |
|---|---|---|---|
| 1 | style (orthogonal / direct / curves), spacing, per view or per edge | a declarative attribute | none |
| 2 | the side / order of the pins on a node; the exit direction of an edge | relative to the node | none (it moves with the node) |
| 3 | the route of an edge, placed by hand | **relative**: each segment an offset from the pin at one end of the edge — never an absolute coordinate | small, with dormancy and graceful invalidation |
| 4 | wire ↔ net label | per net | none |

Level 4 is the first line of defence of readability: the nets with a fan-out
above the threshold (default > 4; `render` already comes suggested by the model)
and the nets with a clock / reset role are shown as labels on the pins, not as
routes. Applied properly it takes most of the demand for level 3 away — which
is why the order of implementation was 1 → 4 → 2 → 3, and 3 only on
demonstrated demand (D7). That demand came in Nov 2026, from the user arranging
diagrams by hand: level 3 is implemented (D27, below). Level 2 is still open.

**Level 4, implemented (Jul 2026)**: a net is selected by a click on its route
or on its label, and the inspector offers the "Show as label" / "Show as wire"
switch (the `net/render` message, docs/05). On a selection of ONE pin / flag the
inspector derives its net (from the edges or `pin.nets` / `bport.nets`) and
shows the same switch — discoverable from either end, not only from the route or
the label (a refinement from validation). The override is persisted in the
sidecar under `views.<view>.nets.<net>.render` only when it differs from the
model's suggestion — going back to the suggestion deletes the entry (the file
holds only deviations). On invalidation, the overrides of the nets that
disappeared migrate into `orphans` with `kind: net` and are restored when the
net reappears, like the positions. Level 1 (the style of the routes) is
deferred: there is one style — orthogonal on the grid, through our own router
(D20) — so it has no parameter to expose yet.

### Level 3 — hand-routed wires (D27, Nov 2026)

In the schematic views and on every level of the verification view, a wire can
be moved by hand. Six decisions shape it, each asked of the user: both view
families; the full gesture set (segments, corners / junctions, a jog out of a
pin stub); reset from the context menu, the inspector and "Re-arrange all"; a
skeleton anchored to the pins; an invalid route falls back to the router and
stays stored; a hand-placed segment may cross texts and other wires, never a
block. The rules are pure — `src/webview/wireroute.ts`, `npm run test:wireroute`
— and the webview only draws and forwards the gestures.

**The model: a skeleton anchored to the pins.** A wire leaves and enters its
pins horizontally, so between the two pin stubs its interior segments alternate
vertical, horizontal, …, vertical: an odd count. A hand-placed route is that
list, source to target, and each segment stores ONE number — the offset of its
line from the pin at one end of the edge, on the segment's own axis (x for a
vertical segment, y for a horizontal one). The file form is one line per edge,
a token per segment:

```yaml
views:
  demo_top.u_soc:
    edges:
      "sum:u_add.dout-><port>.sum":
        route: source+16 source-40 target-16
```

— a vertical 16 px out of the source pin, a horizontal 40 px above it, a
vertical 16 px before the target pin. Moving a block therefore carries the
segments measured from its pin, and the ones in between stretch; moving both
ends by the same amount moves the whole route. Nothing absolute is stored, and
nothing derived: the polyline is rebuilt from the pins on every draw
(`resolveRoute`). The sketch this document carried before (`waypoints:
[{segment, offset}]`, an offset from the AUTOMATIC route) was rejected: the
automatic route changes its number of segments on almost any move, so "segment
1" would mean something else each time.

Which pin a segment follows is decided when the route is first frozen: the
first half of the segments follow the source pin, the second half the target
pin, the middle one the nearer pin (`freezeRoute`). A later drag keeps it,
except for the middle segment, which is put on the pin it was dragged next to.

**Per edge in the file, per wire in the hand.** The override is stored per
EDGE (the id names two pins: that is what orphaning needs), but the eye sees
wires, not edges: a net with fan-out is several edges on one trunk. A gesture
therefore works on the **wire group** — the edges connected through a shared
net or a shared pin (`wireGroup`; in the verification view the differently
named wires that leave one analysis port are one group) — and:

- the first gesture **freezes the whole group** as it is drawn (each automatic
  route becomes a skeleton; a net drawn as a comb is frozen as what each edge
  is in the comb — its two taps and its part of the trunk), so what the user
  saw is what stays, and only the dragged part moves. A branch drawn as one
  straight line has a trunk without length: it is frozen ON the group's
  vertical that touches its row, not at mid-span, and moves with that run —
  or the trunk would appear twice the day its pins stop being level;
- a segment takes its whole straight **run** with it — the segments of the
  group's other edges on the same line that touch it, directly or through one
  another: a trunk is one line wherever along it the branches leave;
- segments of different edges that share a run follow the **same pin** — the
  one all those edges leave (fan-out) or all enter (fan-in) — or moving a
  single block would split the trunk (`shareAnchors`).

**Gestures.** A press on a wire and a drag past the click threshold (the cursor
says what would move):

- on a **segment**: it moves perpendicular to itself — a vertical one left /
  right, a horizontal one up / down;
- on a **corner or a junction**: both segments that meet there move, each on
  its axis — whichever edges of the group they belong to (the nearest vertical
  and the nearest horizontal within reach, over the whole group). Beside a pin
  the stub stays (its line is the pin's): the corner where a stub meets the
  trunk moves the trunk only;
- on a **pin stub**: the stub is lifted into a **jog** that leaves 16 px at the
  pin (`JOG_STUB`); a straight pin-to-pin wire becomes a bump with a stub at
  each pin. This is how a detour is made where the router drew a straight line.

Every moved line is snapped to the grid as an ABSOLUTE line (so a line that was
off the grid lands on it at its first move — a drag of less than half a cell
on an axis moves nothing on it), a bend dragged flat disappears
(`normalizeRoute`), and the preview is always computed from the press, never
from the previous frame. A result the file form cannot say (more than 41
segments) is not made. A click without a drag still selects the net; Shift
(the cone) and Ctrl (the selection toggle) keep their meaning — with either the
press is never a drag. `Escape` cancels a drag in flight. The wires have a
wide, unpainted hit stroke (`.wire-hit`: 9 px on screen at any zoom, stripped
from the SVG export), so a 1.3 px line can be selected and grabbed without
pixel hunting. In the verification view the wires are drawn above the boxes,
and that stroke reaches over the port hotspot its stub ends in: a press there
still starts the temporary wire of docs/08 R10 (`belowWires`).

**What a hand may cross.** Texts (pin labels, annotations) and the wires of
other nets: yes — it is the user's hand. A block: no. The walls are the boxes
of the nodes and of the boundary flags, and the select / concat chips, with a
clearance of half a grid cell (`WALL_CLEAR`: a segment one cell from a box is
clear, one ON its edge is not); the two pin stubs may touch the box of their
own node and its chips (with a wide bus label the chip ends 2 px from the stub's
tip). In the verification view a boundary flag is no obstacle of the router's,
so an automatic wire may bend right at the flag it ends at: that edge may touch
its own flag with any segment (`WireRect.flag`). "Backwards" has half a cell of
slack (`REVERSE_SLACK`) for the same view's off-grid anchors. The rule behind
all three: an automatic route, frozen, must never be invalid where it stands. While a drag would cut a wall, or leave a pin backwards, the wire is
drawn as invalid (red, dashed), and such a drop is **refused** with a message —
nothing is stored. Two hand-placed wires of DIFFERENT nets on the same line are
not prevented.

**Dormant, not deleted.** A stored skeleton is checked against the blocks on
every draw (`routeState`): if a later move (or a flip, or a new block) makes it
leave its pin backwards or cut a wall, that edge is routed automatically for as
long as it stays so — its tooltip and its context menu say "hand-placed route
suspended" and why — and the skeleton, still in the file, is drawn again the
moment it fits (un-flip the block and it is back). The other edges of the net
keep their routes, and a gesture on one of THEM does not write the dormant
edge: it is drawn — and frozen for the drag — from the router's line, but its
own skeleton keeps waiting in the file; only dragging the dormant wire itself
replaces it. Nothing is deleted without a gesture of the user's.

**The router knows about them.** The hand-placed routes are placed first and
occupy their cells in the router (`RouteConstraints.fixed`): the automatic wires
of other nets keep off them the way they keep off each other, and the ones of
the same net may share them. A net with a hand-placed edge is never redrawn as
a comb.

**Back to automatic.** "Reset wire route" in the wire's context menu and in the
action palette, "Reset route" in the inspector's Net section (schematic views),
and "Wires: reset all hand-placed routes" in the palette; a reset works on the
whole wire group. "Re-arrange all" (⟲) discards the view's routes with its
positions — they describe the arrangement being discarded. A wire gesture is
one step of the layout history (`Ctrl+Z` / `Ctrl+Y`, shared with the moves and
the annotations), and so is a reset; an undone ⟲ brings the routes back with
the positions. A step holds the routes of the edges ITS gesture changed, as a
patch — never the view's whole set, which would write back over a route another
surface added since. The first wire gesture on an un-arranged view pins it (the D21
total snapshot), like any gesture that fixes a place.

**Known limits.** A component renamed in the verification view gets new edge
ids: its wires go back to automatic and the old entries stay inert (a
composition's connection is named by its two endpoints, `e:conn:<from>-><to>`,
so removing another connection does not move its route). On a trunk shared by
edges with NO pin in common (two drivers and two sinks) each segment follows
its own edge's pin, and moving one block can split the trunk. The suspended
state is shown on the wire (tooltip, context menu), not in the sidebar
inspector, which has no geometry; the inspector's "Reset route" exists in the
schematic views only (the verification view has no Net section — context menu
and palette there). There are no visible handles — the cursor is the
affordance.

## Randare

SVG generat manual în webview (nu canvas, nu framework de diagramming):
hit-testing nativ pe elemente, stilizare CSS pentru overlay-ul de agenți
(schimbare de clasă, nu re-randare), export vectorial trivial (SVG → PDF pentru
documentație și materiale didactice). The gesture map: zoom on the wheel,
**pan on the middle button**, left-click on the background = the **selection
lasso** (on the symbol it selects pins — the gesture behind "Agent from
selection"; on a schematic it selects blocks and flags). The modifiers held
when the lasso starts choose what it does to the existing selection (docs/08
R7): none replaces it, **Shift** adds, **Ctrl** toggles — the same thing
Ctrl+click does to one element — and **Ctrl+Shift** subtracts (not Alt: Alt
held alone around a mouse gesture hands the focus to the workbench's menu bar
on Windows and Linux). By default only the objects
fully enclosed are picked; `quickuvm.lassoMode: intersect` switches to a
crossing selection (also what the rectangle touches), and `direction` lets
the drag choose — left-to-right a window, right-to-left a crossing, drawn
long-dashed. A click on an element selects it (+Ctrl toggles), a drag moves
nodes with grid snap (dragging a member of the selection moves the whole
selection), hover shows a tooltip.

**Arranging a multi-selection** (docs/08 R7, Nov 2026): align on an edge or a
centre line of the common bounding box, distribute with equal gaps, and
straighten the wires between the selected blocks — from the icon row of the
context menu or the action palette's "Arrange" group. All three are positions
on the grid and nothing else: only the axis an operation works on is snapped
(a centre line is pinned to the largest block sitting on the grid, so aligning
twice moves nothing the second time; blocks that overlap are not distributed),
the result is persisted as ONE total `layout/snapshot` (D21) with one
position-undo entry, like a drag end, and an un-arranged view becomes the
user's in that one step. Straighten moves a block only vertically, until the
pin centres of a wire are level (pins sit on the grid by construction, so the
wire becomes one straight segment), and refuses a move that would land on
another box — the block stays where it is. The geometry is pure:
`src/webview/arrange.ts`, `test:arrange`.

**Level of detail** (docs/08 R6, Nov 2026): below `quickuvm.lodZoomThreshold`
the multi-node views draw only boxes, enlarged titles, wires, flags and
badges. It is a CSS switch on one attribute of the root `<svg>`
(`data-lod="low"`), never a re-layout: positions, sizes and routes are the
same at both levels, so the camera can cross the threshold freely (with
hysteresis, docs/05).
**Minimap** (navigatorul de ansamblu; cererea utilizatorului, iul. 2026):
miniatura întregii scene într-un colț (dreapta-jos, 180×120) + dreptunghiul
zonei vizibile; click sau drag pe minimap **centrează camera** pe punctul
respectiv (zoomul se păstrează), tasta **M** îl comută. Doar în vederile-schemă
(RTL + TB) — simbolul încape mereu; nu apare în exportul SVG (e chrome de UI,
nu conținut). Implementare: miniatura e o **copie vie** prin
`<use href="#viewport">` — zero re-randare, orice schimbare (drag, selecție,
ghidaje) apare instant; transformul `U = M ∘ V⁻¹` anulează camera copiată și
aduce lumea la scara minimapului. Toată geometria (încadrare, dreptunghi de
vedere, salt de cameră) e în modulul **pur** `src/webview/minimap.ts`
(`test:minimap`); `refreshMinimap`/`updateMinimap` în `main.ts` o leagă de DOM
(refresh la randare/drag-end/resize/toggle; update ieftin per cadru din
`applyTransform`, cu auto-corecția ancorării — prima randare poate rula cu
canvasul încă ascuns de ecranul de bun-venit, `clientWidth=0`). Gesturile pe
minimap nu ajung la canvas (altfel porneau lasso-ul / goleau selecția).
**Ghidaje de aliniere la drag, pe CAPETELE PINILOR** (`alignSnap`, pur,
`test:router`; cererea utilizatorului, iul. 2026): alinierea ține cont DOAR de
pini, nu de marginile blocului — două capete de pini la același y ⇒ fir
orizontal drept, exact ce contează pentru o schemă curată. Punctul de aliniere e
CAPĂTUL pinului (vârful stub-ului, unde se leagă firul și stă marcajul `{}`/`[]`),
nu marginea blocului: la `cx − stubLen` pe vest / `cx + cw + stubLen` pe est, cu
`stubLen = MARKER_STUB` pentru pinii cu marcator concat/select (firul se leagă
dincolo de chip), altfel `STUB` — deci ghidajul vertical trece prin vârfurile
pinilor, nu prin marginea blocului (`pinTipOffsets` pur în `schematic.ts`,
`test:router`; latura vine din geometrie, ca ancora din `routeEdges`, deci
răsturnările o urmează). Pe fiecare axă, dacă un capăt de pin al nodului APUCAT
ajunge în ~6px (ecran) de un capăt de pin al altui bloc, blocul se mută ca ele să
se alinieze EXACT (peste snap-ul de grilă) și apare o linie de ghidaj punctată
(`.align-guide`, 1px la orice zoom) de la capătul tras la cel potrivit, cu un mic
surplus pe capete (`ALIGN_GUIDE_PAD`) ca să rămână vizibilă chiar când capetele
coincid pe axă; pe axa fără potrivire rămâne snap-ul de grilă. Steagurile de
graniță (porturile modulului, fără stub) folosesc centrul lor. Se caută cel mai
apropiat capăt, deci snap-ul poate fi la orice vecin, nu doar la frați. Ghidajele
se curăță la drag-end. Grupul se mută cu nodul primar (offseturile relative se
păstrează). `nodeAlignPts`/`nodePortPoints` în `main.ts` extrag punctele (RTL:
capetele din `pinTipOffsets`; TB: `TbPlaced.ports`, fără stub-uri).
**Ctrl+Z / Ctrl+Shift+Z (sau Ctrl+Y)** = undo/redo de **poziții** (din
validarea quick wins, iul. 2026): istoric de sesiune per cheie de layout
(RTL per vedere, TB per nivel) care anulează mutările de blocuri/steaguri și
re-aranjările ⟲ — fiecare pas aplicat se persistă normal prin
`layout/snapshot` (sidecar-ul rămâne sursa persistată; flip-ul și pliajele
nu intră în istoric). **Săgețile** derulează viewport-ul (pan din tastatură,
cererea utilizatorului, iul. 2026): convenție de scroll (jos = vezi conținut
dedesubt), pas mai mare cu Shift, ținut apăsat = derulare continuă; camera
devine a utilizatorului și se salvează ca la pan-ul cu mouse-ul (stare de
sesiune). Nu declanșează în câmpurile inspectorului (bail pe INPUT/SELECT/…).
**Keyboard parity with node editors** (docs/08 R5, Oct 2026): `Home` fits all
like `F`; `G` fits the selection (blocks and flags; pins alone fall back to fit
all); `U` / `PageUp` go up one level (TB: agent → env → root; RTL: the parent
view, skipping generate segments, and the top's schematic climbs to its symbol);
`Ctrl+[` / `Ctrl+]` walk the session's view history (recorded on every render of
a different view, so re-renders add nothing; a new visit after going back drops
the forward branch, like a browser); `Ctrl+F` opens a find box at the top of the
canvas — exact label, then prefix, then word-start, then substring of label or
id — `Enter` selects and centers the match, keeping the zoom; `Alt+arrows` nudge
the selection by one grid step (`Shift` ×5) through the same path as a drag end
(undo entry + total snapshot, D21), while the plain arrows keep scrolling;
`Shift+1..5` store a camera quick mark of the current level and `1..5` jump to
it (session state, like the camera; an empty slot never moves the camera).
`F2` rename waits for the rename mutation (docs/08 R14). The pure rules live in
`src/webview/navfind.ts` (`test:navfind`).
**Trasare interactivă** (faza 4, implementată): în vederea-schemă,
**Shift+click** pe un net (fir sau etichetă) sau pe un bloc/steag selectează
**conul aval** (tot ce e condus, tranzitiv, de element), iar
**Shift+Alt+click** — **conul amonte** (tot ce îl conduce). Traversarea
(`netCone` în `scene.ts`, pură, `test:scene`) urmează exact ce e desenat:
muchiile wire după direcție, interfețele în ambele sensuri, iar net-urile
afișate ca **etichetă** prin conectivitatea pinilor și a **steagurilor de
graniță** (`pin.nets`/`bport.nets` — etichetele nu au muchii; un net-etichetă
care atinge un port al vederii NU-și pierde capătul de graniță din con);
pliajele generate sunt un singur nod, ca pe ecran. Clasificarea semínței
(`coneOf`) e robustă la ținta clicului: un click pe interiorul unui pin
(numele portului, adnotarea) pornește din net-urile pinului, nu dintr-un net
inexistent, iar un Shift+click pe ceva nerecunoscut păstrează selecția (nu o
golește).
**Cross-probing la hover** (faza 4, implementată): staționarea pe un pin
(~300 ms) revelează declarația portului în editoarele **deja vizibile**, cu
o evidențiere tranzitorie a liniei — ne-intruziv prin construcție (nu
deschide tab-uri, nu fură focusul, nu mută cursorul; `openSource` cu
`peek: true`, docs/05); saltul complet rămâne pe dublu-click. Setarea
`quickuvm.hoverCrossProbe` îl stinge. **Cross-probing editor→diagramă**
(reciproca; faza 4, implementată): host-ul urmărește cursorul din sursele SV
(debounced 150ms) și, prin `probe/highlight` (docs/05), webview-ul aprinde un
**halou galben persistent** (`.xprobe`) pe elementul de sub cursor — DISTINCT
de selecție (selecția de lucru nu e atinsă) și DOAR în vederea curentă
(non-invaziv: fără navigare, fără mișcare de cameră; ținta absentă = niciun
halou). Rezoluția (fișier,linie)→țintă e pură (`buildLocIndex`/`resolveLoc` în
`src/locmap.ts`, `test:locmap`): potrivire exactă pe linie (portul bate
instanța bate antetul de modul — stil ANSI pe o linie), altfel cel mai
apropiat element care CUPRINDE de deasupra (instanțe/module; porturile doar
exact); instanțele generate împart linia sursă → toate se aprind (pliajul, o
dată — maparea pe id-urile vederii e tot pură, `probeIds`, cu `memberPaths`
pe nodurile-pliaj). Căile se compară normalizat (lower+slash — capcana
Windows din `isComposedChild`). Navigarea explicită: comanda **„Reveal in
Diagram"** din meniul contextual al editorului (`.sv/.svh/.v/.vh`, insensibil
la caz) deschide diagrama la element — instanță → schema vederii-conținătoare
+ selecție (generate: toți membrii; cu pliajul închis, id-urile membrilor se
remapează pe pliaj prin `remapSelection` în `presentScene` — pur, `test:locmap`
— altfel navigarea reușea dar selecția era goală); top fără vedere-părinte →
schema lui dacă există (antetul unui modul dezvăluie interiorul, consecvent);
port/modul → vederea instanței modulului (preferă instanța vederii curente) cu
steagul/pinul selectat; ținta lipsă → mesaj, nu eșec tăcut. `select/reveal`
face și ecou `select/changed` spre host (altfel comenzile din paletă care
citesc selecția acționau pe nimic). Haloul `.xprobe` NU intră în exportul SVG
(stare de sesiune, nu conținut — scos de pe clonă ca `.selected`).
**Limitare cunoscută** (recenzia adversarială, structurală — modelul n-are
sfârșiturile elementelor): „cel mai apropiat deasupra" nu vede granițele
dintre module — cursorul într-o construcție ne-elaborată (pachet, modul
nefolosit) care URMEAZĂ în fișier unor instanțe poate cădea pe ultima
instanță de deasupra; inofensiv (doar halou/reveal aproximativ) și
nedeclanșabil pe fixture-urile actuale, corectabil doar cu end-loc în model.
**Decorațiile de stare quick-uvm** (faza 4, implementată; deciziile prin
AskUserQuestion: ambele surse, badge în colț + tooltip): validările
model↔YAML (`checkConfig`) ajung pe diagramă ca **badge-uri** ⚠ (warning) /
✕ (error) în colțul dreapta-sus al elementului vizat, cu mesajele în tooltip
— pinii RTL ai DUT-ului (lățime greșită, revendicare dublă, ignorat+mapat;
steagul `<port>.X` pe vederea DUT-ului însuși, pinii instanțelor de DUT în
vederea-părinte) și blocurile TB (`agent:<nume>`; hibrid/dut-missing pe
Env). La nivelul-rădăcină TB, problemele agenților se **agregă pe Env**
(bubble-up cu prefixul agentului, severitatea maximă) — rădăcina nu pare
curată cu agenți stricați dedesubt. Portul orfan NU țintește pinul (a
dispărut din model), doar agentul. Rezultatul ultimului „Generează
testbench" e un **cip în antet** (`✓/✕ generate`, tooltip cu detaliul
Pydantic + momentul; ✕ și la eșecul de lansare ENOENT); absent până la prima
rulare. Mesajul `status/decorations` (docs/05), derivarea și maparea pure în
`src/status.ts` (`decosFromFindings`/`statusIdsRtl`/`statusIdsTb`,
`test:status`); badge-urile se re-desenează după fiecare randare
(idempotent, poziționate pe `getBBox`) și NU intră în exportul SVG
(diagnostic de sesiune, nu conținut). **Export SVG** (faza 4, implementată):
butonul ⤓ din header (orice vedere) sau comanda `quickuvm.exportSvg` scrie
un SVG **autonom**: stilurile calculate se inline-uiesc (culorile temei
curente se coc în fișier — CSS-ul tematizat prin `var(--vscode-*)` nu
călătorește), camera de sesiune devine `viewBox` pe conținut, fundalul temei
se coace într-un rect. Exportul PDF e amânat: SVG-ul se convertește curat cu
unelte externe (browser, Inkscape), iar o bibliotecă de PDF în webview nu-și
justifică greutatea (D5 anticipa exportul vectorial — corect pe fond, dar
„trivial" doar după inline-area stilurilor).

**Vocabular de desen — core** (faza 4, implementat): **busele** poartă
lățimea (`ScenePin`/`SceneBPort`/`SceneEdge` au `width`): pinul/steagul arată
`/N` deasupra stub-ului (combinat `/16×3` la tabloul unpacked), iar
firul/stub-ul se îngroașă pe **clase de lățime** (`widthClass` →
w-s 2-8 / w-m 9-16 / w-l >16). Lățimea netului pe muchie e derivată prin
`netWidth` (reutilizat din `probe.ts`) — DOAR de la un capăt cu **același
semnal** (portul propriu al vederii sau un pin de copil cu `conn.kind==="net"`),
niciodată prin select/concat (invariantul de lățime din CLAUDE.md).
**Eticheta portului** (`portLabel`, pur, `test:scene`) urmează ordinea de
declarare SystemVerilog: dimensiunile **packed înaintea numelui** (din
`elem_width`), **unpacked după** (din sufixul `type` de după separatorul intern
`$`, ca să păstreze intervalul exact declarat) — `[15:0]ch_out[0:2]` pentru un
tablou unpacked, `[15:0]din` pentru un vector packed, doar numele la 1 bit.
Corectează `ch_out[15:0]` vechi (iul. 2026, cererea utilizatorului), care
prezenta un tablou unpacked ca vector plat de 16 biți și contrazicea selecturile
`[0]`/`[1]`/`[2]` care-l alimentează. Eticheta e **compactă (fără spații** între
dimensiuni și nume, ca să economisească lățime); lizibilitatea vine din
**colorarea diferită**: la desen (`portLabelText` + `splitLabel`, ambele pure)
numele stă în culoarea plină, iar dimensiunile în tspan-uri `.dim` cu
`fill-opacity: 0.55` — o nuanță care urmează culoarea numelui la
hover/select/iface, ca numele să rămână proeminent. **Măsurarea** blocului
folosește șirul compact cu fontul editorului (monospace, `measurer(mono)` —
altfel etichetele monospace mai late erau subestimate și porturile vest/est se
suprapuneau). **Junction
dots** (`junctionDots`, pur, consumat în `routeEdges` după rutare): un punct
unde un net se contopește — pentru fiecare vârf al netului se numără direcțiile
cardinale distincte în care pleacă un segment al netului, iar **≥3 direcții la
un vârf** = joncțiune reală (T cu 3, sau contopire 4-way ca la fan-in-ul unei
magistrale — 3 `dout`-uri într-un port `ch_out`; cererea utilizatorului, iul.
2026). Un **cot** (2 direcții) nu primește punct. **Nu** se marchează
încrucișările periculoase: (1) net-uri DIFERITE care se ating — detecția e
**grupată pe net**, deci nu-s în același grup; (2) o încrucișare a aceluiași net
fără cot (două fire drepte) nu are vârf la intersecție, deci nu ajunge la
verificare. Trunchiul comun al unui fan-out (waive-ul) se dedup pe vârf.
**Pieptenele de magistrală** (`combPolys`, pur, `test:router`): un net cu fan
(≥2 muchii wire, capete pe rânduri diferite) se redesenează ca un **trunchi
vertical + o priză orizontală per capăt**, nu ca o STEA în care toate muchiile
converg în sink (care făcea un 4-way — un singur punct). `trunkX` = x-ul vertical
dominant din rutarea A* (ocolește obstacolele), iar `routeEdges` aplică pieptenele
DOAR dacă prizele/trunchiul nu taie vreun bloc (`combClear`) — altfel rămâne
rutarea per-muchie. Priza de sus + trunchiul + priza de jos se desenează ca **o
SINGURĂ polilinie** (spina), ca cele două colțuri de capăt să aibă jonctiune
(miter), nu două capete „butt" separate care lăsau un gol la îmbinare (observația
utilizatorului); prizele interioare rămân separate — ating latura groasă a
trunchiului, acoperite de el. Rezultatul: prize separate, fiecare cu punctul ei de T
(sink-ul dincolo de surse = capăt de trunchi, deci capetele-priză sunt coturi
fără punct; cererea utilizatorului, iul. 2026). **Glife de adnotare** (implementate ulterior): `ScenePin.noteKind`
(`select`/`const`/`concat`/`nc`/`expr`/`mixed`) e discriminatorul care ALEGE
glifa în stratul de desen, fără să reparseze textul notei (`noteOf` în
scene.ts). `drawAnnotation` (schematic.ts) desenează: `const` = cutie tie-cell
cu valoarea, `select`/`concat` = **chip de accent cu parantezele SV** (`{}`
concat, `[]` select — chiar operatorii din sursă) + eticheta, `nc` = cerc,
restul text. Chip-ul înlocuiește pana netlistsvg veche (iul. 2026): pana era
plină și convergea spre bloc, deci se citea ca un al doilea **cap de săgeată**
peste săgeata de direcție a firelor — triaj adversarial pe 8 familii, cererea
explicită a utilizatorului. (Ulterior, tot la cererea utilizatorului, **săgeata
de direcție a firelor RTL a fost scoasă** — `marker-end` eliminat din
`edgeElement` —, direcția fiind implicită din latura portului: intrări pe vest,
ieșiri pe est. Săgețile rămân în vederea TB, unde steagurile disting
in/out/inout; markerul `#arrow` din defs rămâne, folosit acolo.) Chip-ul n-are
vârf orientat de-a lungul firului
(dreptunghi rotunjit, parantezele poartă distincția), iar textul `{…}`/`[hi:lo]`
rămâne purtătorul de sens la „decorations off" (chip-ul e decorație, ascuns
acolo; nota nu se scoate). Chip-ul stă la un `MARKER_GAP` de capătul stub-ului,
spre exterior (nu lipit de port) — altfel colțul lui de sus se suprapunea cu
eticheta de lățime și cu nota. **Firul traversează chip-ul ORIZONTAL**, în
aceeași direcție cu portul (cererea utilizatorului): pentru un pin cu marcator,
stub-ul VIZIBIL se extinde la `MARKER_STUB` (= `STUB+GAP+CW+MARKER_TAIL` = 48)
ȘI ancora de rutare a firului (`routeEdges`) se mută tot la `MARKER_STUB`, așa
că trunchiul fanout-ului se leagă DINCOLO de marcator (la stânga la
intrări/vest, la dreapta la ieșiri/est) și stub-ul orizontal desenat prin chip
îl traversează. **Pinul STRĂPUNGE vizibil chip-ul** (cererea utilizatorului,
iul. 2026): stub-ul iese `MARKER_TAIL` (=12px) dincolo de marginea exterioară a
chip-ului (36), altfel părea ascuns sub el (se oprea exact la margine, firul
părea să izvorască din chip); 36+12=48 e multiplu de 8, deci vârful/ancora cade
PE GRILĂ (pin pe grilă = fir drept). Abordarea cu obstacol de rutare (să împingă
trunchiul) a fost RESPINSĂ — un obstacol respinge și ramura orizontală (firul
ocolea chip-ul, rămânea „pe uscat"); ancora e soluția corectă (fir rutat până la
ancoră + stub-decorație prin chip). **Tranziția de grosime** stub-port (lățimea
portului) → muchie-net (lățimea netului) cade acum la VÂRF, coliniară cu firul
(fără colț), deci nu produce îmbinări rupte; nota veche „tranziția sub chip"
(ancora exact la marginea chip-ului) e ÎNLOCUITĂ de cererea mai nouă — pinul
vizibil dincolo de chip bate ascunderea tranziției. Fundalul e OPAC
(`color-mix` cu `editor-background`), deci maschează firul de dedesubt. Centrarea verticală a parantezelor NU folosește `dominant-baseline`
(getBBox + dominant-baseline diferă între versiuni de Chromium — harness vs
webview VSCode —, iar nudge-ul ieșea greșit): semnul primește un `y` de start
aproximativ centrat, iar `centerChipSigns` (apelat după `drawSchematic`, cu
elementele în DOM) măsoară cutia reală a semnului și a dreptunghiului pe
**baseline alfabetic** (getBBox fiabil peste tot) și nudge-uiește semnul până
coincid centrele. Se re-aplică pe cadrul următor și după `document.fonts.ready`
(primul getBBox poate rula înainte ca fontul editorului să fie aplicat).
Independent de font, idempotent per randare.
Iterația intermediară a fost un romb cu semn de
lățime `+`/`−`, înlocuit fiindcă semnul cerea un mnemonic; parantezele sunt
sintaxa însăși. `estPinText`
adaugă o alocare fixă (`GLYPH_W`) pentru const/select/concat, în AMBELE
consumatoare (marginile ELK și obstacolele ruterului), ca glifele mai late să
nu iasă din zona rezervată.
**Secțiuni de pini pe rol** (vederea-simbol, symbolator): pinii de ceas/reset
(euristica `isClockOrReset`) sunt deja grupați jos-stânga (`buildPins`);
gruparea se face VIZIBILĂ printr-un gap + divizor + titlu — `draw` (main.ts)
detectează granița signals→clock/reset pe vest, deplasează grupul clock/reset
în jos cu `SECTION_GAP` (ELK FIXED_ORDER nu lasă gol per-grup), mărește cutia
și desenează un divizor punctat + eticheta „clock / reset" (grupul de sus e
implicit prin contrast). Doar în vederea-simbol și doar când modulul are
ceas/reset (combinațional pur rămâne plat).
Vocabularul (slash+lățime, junction dots) se poate ascunde cu setarea
`quickuvm.schematicDecorations` (implicit pornit; clasă `decor-off` pe canvas
prin `ui/config` — gradarea grosimii firelor rămâne, e natura firului).
**Firul folosește o culoare OPACĂ amestecată cu fundalul, nu `opacity`**:
firele aceluiași net care împart trunchiul (waive-ul de fan-out) își cumulau
transparența și dădeau un efect de gradient la suprapunere (observat la
validare) — amestecul opac dă aceeași softness fără acumulare.

**Lumea pe grilă e universală**: în orice vedere-schemă, toate pozițiile —
inclusiv steagurile porturilor de graniță, mutabile și ele (chei `<port>.x`
în sidecar) — se rotunjesc la grilă la fiecare randare (pozițiile ELK sunt
fracționare; saltul e sub jumătate de pas). Consecințe: ancorele cad pe
rânduri de grilă (ruterul scoate trasee integral ortogonale pe grid), iar
alinierea pin-la-pin e posibilă între orice două elemente, mutate sau nu.
**Nudge anti-suprapunere la expandare** (din validare): pe o vedere aranjată,
D21 pinuiește TOȚI vecinii, deci ELK interactiv nu-i poate împinge să facă loc
membrilor unui pliaj proaspăt expandat — care pot ateriza peste noduri
pinuite. La randare, elementele FĂRĂ sămânță (membri noi) care s-ar suprapune
se mută la cel mai apropiat loc liber pe grilă (`freeSpot`, pur — scanează pe
cercuri crescătoare, preferă jos), fără să atingă blocurile utilizatorului; o
vedere proaspătă (fără semințe) trece prin ELK complet, deci n-are nevoie de
nudge. `⟲` rămâne calea pentru un aranjament curat.

**Traseele vin întotdeauna din ruterul propriu** — ELK dă doar pozițiile;
un singur comportament de rutare (halou, etichete protejate, ocupanță) în
toate vederile, cu sau fără override-uri.

Suprapunerea paralelă a două net-uri distincte pe același culoar e scumpă
(`overlapPenalty`, implicit 8/celulă) — pe lungime, firele diferite stau pe
culoare separate. **Excepție lângă capetele comune** (`fanoutRadius`, implicit
6 celule): firele care pornesc din aceeași sursă (fan-out — portul de analiză
al unui agent spre scoreboard ȘI coverage) sau converg spre aceeași destinație
(fan-in) au voie să împartă trunchiul chiar lângă capătul comun, în loc să fie
forțate să forcheze la pin. Raza e ancorată la capetele muchiei *care se
rutează* (nu la puncte de trecere arbitrare) și doar *anulează penalizarea*, nu
forțează suprapunerea: la lungime egală ruterul tot preferă culoare separate,
deci net-urile din pini vecini nu se lipesc — waive-ul mușcă doar când
suprapunerea chiar scurtează traseul (adică exact la capăt comun). Nu confunda
cu net-ul unic cu fan-out (`group` comun), unde suprapunerea e liberă pe toată
lungimea.

Nodurile suportă **răsturnare** (flip), persistată în sidecar per nod
(`flipH`/`flipV`): orizontal = laturile vest↔est se schimbă (intrările apar
pe dreapta), vertical = ordinea pinilor se inversează pe fiecare latură.
Flip-ul e o **reatribuire a sloturilor de pini pe grilă, nu o oglindire
geometrică** — textul (nume, etichete) nu se oglindește niciodată, iar pinii
rămân pe aceleași rânduri de grilă. Porturile fiind `FIXED_POS`, ELK primește
pozițiile deja răsturnate, deci traseele lui rămân valabile și pe noduri
răsturnate.

Grila (pas 8) urmează convenția EDA: **pinii se agață de grilă, nu doar
cutia**. Geometria internă a nodurilor e multiplu de grilă prin construcție
(primul centru de pin la +40 sub banda de titlu, pas de pin `PIN_PITCH`=24 —
lărgit de la 16 la validare, ca decorațiile să aibă aer între rânduri; rămâne
multiplu de 8, deci pinii rămân pe grilă —, lățimi și
înălțimi rotunjite la 8, porturi `FIXED_POS` calculate de extensie — nu de
ELK), astfel încât snap-ul colțului stânga-sus pune automat toate punctele de
conexiune pe grilă: pin aliniat cu pin = fir perfect drept. Consecință: pinii
stau în ordinea declarației din modul (norma din schematics); reordonarea vine
din override-urile de nivel 2. Interactive routing of the edges did become a
requirement (Nov 2026) and was built on our own router and SVG (level 3 above,
D27): the re-evaluation towards JointJS that this paragraph used to reserve was
not needed.
