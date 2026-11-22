# 04 — Layout, user-owned positions and routing

## The layout strategy (closed decision)

A combination of two mechanisms, with precise roles:

1. **A quality initial layout** — at the first opening of a view or at the
   explicit command "Re-arrange all": the full ELK `layered` algorithm
   (crossing minimization, `portConstraints: FIXED_SIDE`, inputs on the
   left, outputs on the right, clock/reset grouped bottom-left, a starting
   orthogonal routing).
2. **The positions belong to the user** — after the initial layout, the nodes
   can be dragged freely; the positions (computed or moved) are persisted. On
   design changes, ELK runs in **interactive mode**
   (`layering/crossingMinimization/nodePlacement: INTERACTIVE`) with the
   existing positions as seeds: the known nodes stay in place, only the new
   ones get positions, inserted in context. No implicit total re-layout,
   ever.

   **The seeds are total or none at all** (Jul 2026, D21): the first position
   gesture makes the arrangement of the *whole* view the user's — at the end
   of any drag ALL the current positions are persisted (nodes, folds, boundary
   flags; the `layout/snapshot` message, docs/05), not only the dragged
   elements; and when a view that is already arranged is rendered, the
   elements left without a seed (new from a recompile, members of a freshly
   expanded fold, a partial inherited sidecar) are pinned immediately, at the
   position where interactive ELK has just inserted them. The reason:
   interactive mode places the elements without a seed *differently* from the
   full layout the user sees — with partial seeds, the boundary flags jumped by
   hundreds of pixels at reopening (a real regression). The untouched views
   (with no seed at all) stay fully automatic: nothing is persisted for merely
   visiting a view.

Resolving the position of a node, in order: manual override → the position
persisted from the previous session → a position computed by interactive ELK
around the ones above.

The edges are **automatic by default**: the routes are recomputed from the
current positions of the nodes (the user arranges blocks and pins, and does not
have to maintain routes). A wire the user DID place by hand (level 3 of the
routing overrides below, D27) is the user's, like a position: it is kept
relative to its pins, follows them, and goes back to the router only on an
explicit reset.

## The layout sidecar file

One file per project, textual, diffable, in git next to the QuickUVM YAML.
The default path: `.vscode/quickuvm-architect.yaml` (it does not clutter the
root; `.vscode/` is already the convention for the editor's project state);
configurable through the `quickuvm.layoutFile` setting (relative to the
workspace root).

```yaml
schema_version: 1
views:
  demo_top.u_soc:                 # the view's key = the instance path
    nodes:
      u_add:        {x: 120, y: 80}
      u_inv:        {x: 120, y: 220, flipH: true}
      "g_ch[0..2]": {x: 320, y: 150, collapsed: true}
    ports:                         # override of the pins' order/side
      din:   {side: west, order: 1}
      clk:   {side: west, order: 90}
    edges:                         # level 3: hand-routed wires, by edge id
      "sum:u_add.dout-><port>.sum":
        route: source+16 source-40 target-16   # offsets from the pins, never absolute
    nets:
      din:   {render: label}       # level 4: wire <-> label
      clk:   {render: label}
orphans: []                        # overrides whose targets disappeared (see below)
```

Rules:

- all the keys are the stable IDs from the model (doc. 02); the generated
  folds use the notation `name[lo..hi]`;
- the file contains *only* overrides and positions — never data derived from
  the model (widths, directions etc.);
- atomic writing (temp + rename), a single writing instance (the host);
- the camera (pan/zoom) is NOT persisted: it is session state of the webview —
  the first opening of a view is always fitted to the window, and the
  frame is kept only when switching between views in the same session
  (a decision reversed in Jul 2026: the frames inherited across sessions
  constantly produced openings "half outside the window").
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

## Graceful invalidation

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

When a key in the sidecar no longer exists in the model (a rename, a temporary
compilation error), the entry is moved into `orphans` with the date of the last
valid view; it is not deleted. The UI offers "Clean Orphaned Layout Overrides"
and, on detectable renames (the same module + the same parameters + the same
position in the parent), proposes migrating the key. It is the same fail-closed
principle as in QuickUVM (the pragma sections), applied to the layout.

## The interconnect router

A consequence of the free positions: the routing can no longer come from ELK
(which routes only its own placements). A separate component for orthogonal
routing with obstacle avoidance, with two candidate implementations:

- **libavoid** (Adaptagrams, the router in Inkscape) through a WASM build —
  obstacles, waypoints, penalties; the size of the build in the webview is to
  be evaluated;
- **our own router** on a grid (Lee / A* with a cost on direction and on the
  proximity to obstacles) — at the scale of the diagram (tens of obstacles,
  hundreds of edges) it is simple and sufficient; the advantage: zero
  dependencies, full control of the aesthetics (spacing between parallel
  routes, junctions).

The decision is taken in phase 3 on a comparative prototype; the router's
interface is fixed: `route(obstacles, pins, constraints) -> polylines`, so
that the implementation is interchangeable.

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

## Rendering

Hand-generated SVG in the webview (no canvas, no diagramming framework):
native hit-testing on the elements, CSS styling for the agent overlay
(a class change, not a re-render), trivial vector export (SVG → PDF for
documentation and teaching materials). The gesture map: zoom on the wheel,
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
**Minimap** (the overview navigator; the user's request, Jul 2026):
a thumbnail of the whole scene in a corner (bottom-right, 180×120) + the
rectangle of the visible area; a click or a drag on the minimap **centres the
camera** on that point (the zoom is kept), the **M** key toggles it. Only in
the schematic views (RTL + TB) — the symbol always fits; it does not appear in
the SVG export (it is UI chrome, not content). Implementation: the thumbnail
is a **live copy** through `<use href="#viewport">` — zero re-rendering, any
change (drag, selection, guides) appears instantly; the transform
`U = M ∘ V⁻¹` cancels the copied camera and brings the world to the minimap's
scale. All the geometry (the fit, the view rectangle, the camera jump) is in
the **pure** module `src/webview/minimap.ts` (`test:minimap`);
`refreshMinimap`/`updateMinimap` in `main.ts` tie it to the DOM (a refresh at
render/drag-end/resize/toggle; a cheap per-frame update from
`applyTransform`, with self-correction of the anchoring — the first render may
run with the canvas still hidden by the welcome screen, `clientWidth=0`). The
gestures on the minimap do not reach the canvas (otherwise they started the
lasso / cleared the selection).
**Alignment guides while dragging, on the PIN ENDS** (`alignSnap`, pure,
`test:router`; the user's request, Jul 2026): the alignment takes ONLY the
pins into account, not the block's edges — two pin ends at the same y ⇒ a
straight horizontal wire, exactly what matters for a clean schematic. The
alignment point is the END of the pin (the tip of the stub, where the wire
attaches and the `{}`/`[]` marker sits), not the block's edge: at
`cx − stubLen` on the west / `cx + cw + stubLen` on the east, with
`stubLen = MARKER_STUB` for the pins with a concat/select marker (the wire
attaches beyond the chip), otherwise `STUB` — so the vertical guide passes
through the tips of the pins, not through the block's edge (`pinTipOffsets`,
pure, in `schematic.ts`, `test:router`; the side comes from the geometry, like
the anchor in `routeEdges`, so the flips follow it). On each axis, if a pin end
of the GRABBED node comes within ~6px (screen) of a pin end of another block,
the block is moved so that they align EXACTLY (over the grid snap) and a dotted
guide line appears (`.align-guide`, 1px at any zoom) from the dragged end to
the matched one, with a small overshoot at the ends (`ALIGN_GUIDE_PAD`) so that
it stays visible even when the ends coincide on the axis; on the axis without a
match the grid snap remains. The boundary flags (the module's ports, without a
stub) use their centre. The nearest end is searched for, so the snap can be to
any neighbour, not only to siblings. The guides are cleared at drag-end. The
group moves with the primary node (the relative offsets are kept).
`nodeAlignPts`/`nodePortPoints` in `main.ts` extract the points (RTL: the ends
from `pinTipOffsets`; TB: `TbPlaced.ports`, without stubs).
**Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y)** = undo/redo of **positions** (from the
validation of the quick wins, Jul 2026): a session history per layout key
(RTL per view, TB per level) that undoes the moves of blocks/flags and the ⟲
re-arrangements — each applied step is persisted normally through
`layout/snapshot` (the sidecar stays the persisted source; the flip and the
folds do not enter the history). **The arrow keys** scroll the viewport (pan
from the keyboard, the user's request, Jul 2026): the scroll convention (down
= see the content below), a larger step with Shift, held down = continuous
scrolling; the camera becomes the user's and is saved as with the mouse pan
(session state). They do not fire in the inspector's fields (a bail on
INPUT/SELECT/…).
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
**Interactive tracing** (phase 4, implemented): in the schematic view,
**Shift+click** on a net (wire or label) or on a block/flag selects the
**downstream cone** (everything driven, transitively, by the element), and
**Shift+Alt+click** — the **upstream cone** (everything that drives it). The
traversal (`netCone` in `scene.ts`, pure, `test:scene`) follows exactly what
is drawn: the wire edges by direction, the interfaces both ways, and the nets
shown as a **label** through the connectivity of the pins and of the
**boundary flags** (`pin.nets`/`bport.nets` — labels have no edges; a label
net that touches a port of the view does NOT lose its boundary end from the
cone); the generated folds are a single node, as on screen. The classification
of the seed (`coneOf`) is robust to the click's target: a click on the inside
of a pin (the port name, the annotation) starts from the pin's nets, not from
a nonexistent net, and a Shift+click on something unrecognized keeps the
selection (it does not clear it).
**Cross-probing on hover** (phase 4, implemented): dwelling on a pin
(~300 ms) reveals the port's declaration in the **already visible** editors,
with a transient highlight of the line — non-intrusive by construction (it
does not open tabs, does not steal the focus, does not move the cursor;
`openSource` with `peek: true`, docs/05); the full jump stays on the
double-click. The `quickuvm.hoverCrossProbe` setting turns it off.
**Cross-probing editor→diagram** (the reciprocal; phase 4, implemented): the
host tracks the cursor in the SV sources (debounced 150ms) and, through
`probe/highlight` (docs/05), the webview lights a **persistent yellow halo**
(`.xprobe`) on the element under the cursor — DISTINCT from the selection (the
working selection is not touched) and ONLY in the current view (non-invasive:
no navigation, no camera movement; an absent target = no halo). The resolution
(file,line)→target is pure (`buildLocIndex`/`resolveLoc` in `src/locmap.ts`,
`test:locmap`): an exact match on the line (the port beats the instance beats
the module header — ANSI style on one line), otherwise the nearest ENCLOSING
element from above (instances/modules; the ports only exactly); the generated
instances share the source line → all of them light up (the fold, once — the
mapping onto the view's ids is pure too, `probeIds`, with `memberPaths` on the
fold nodes). The paths are compared normalized (lower+slash — the Windows
pitfall from `isComposedChild`). Explicit navigation: the **"Reveal in
Diagram"** command in the editor's context menu (`.sv/.svh/.v/.vh`,
case-insensitive) opens the diagram at the element — an instance → the
schematic of the containing view + the selection (generate: all the members;
with the fold closed, the members' ids are remapped onto the fold through
`remapSelection` in `presentScene` — pure, `test:locmap` — otherwise the
navigation succeeded but the selection was empty); a top without a parent
view → its schematic if it exists (a module's header reveals the inside,
consistently); a port/module → the view of the module's instance (it prefers
the instance of the current view) with the flag/pin selected; a missing
target → a message, not a silent failure. `select/reveal` also echoes
`select/changed` to the host (otherwise the palette commands that read the
selection acted on nothing). The `.xprobe` halo does NOT enter the SVG export
(session state, not content — removed from the clone like `.selected`).
**Known limitation** (the adversarial review, structural — the model does not
have the ends of the elements): "the nearest above" does not see the
boundaries between modules — the cursor in a non-elaborated construct (a
package, an unused module) that FOLLOWS some instances in the file may fall on
the last instance above; harmless (only an approximate halo/reveal) and not
triggerable on the current fixtures, correctable only with an end-loc in the
model.
**The quick-uvm status decorations** (phase 4, implemented; the decisions
through AskUserQuestion: both sources, a badge in the corner + a tooltip): the
model↔YAML validations (`checkConfig`) reach the diagram as **badges**
⚠ (warning) / ✕ (error) in the top-right corner of the targeted element, with
the messages in the tooltip — the RTL pins of the DUT (wrong width, double
claim, ignored+mapped; the flag `<port>.X` on the view of the DUT itself, the
pins of the DUT instances in the parent view) and the TB blocks
(`agent:<name>`; hybrid/dut-missing on Env). At the TB root level, the agents'
problems are **aggregated on Env** (a bubble-up with the agent's prefix, the
maximum severity) — the root does not look clean with broken agents
underneath. The orphaned port does NOT target the pin (it has disappeared from
the model), only the agent. The result of the last "Generate Testbench" is a
**chip in the header** (`✓/✕ generate`, a tooltip with the Pydantic detail +
the time; ✕ also on the ENOENT launch failure); absent until the first run.
The `status/decorations` message (docs/05), the derivation and the mapping
pure in `src/status.ts` (`decosFromFindings`/`statusIdsRtl`/`statusIdsTb`,
`test:status`); the badges are redrawn after every render (idempotent,
positioned on `getBBox`) and do NOT enter the SVG export (a session
diagnostic, not content). **SVG export** (phase 4, implemented): the ⤓ button
in the header (any view) or the `quickuvm.exportSvg` command writes a
**self-contained** SVG: the computed styles are inlined (the colours of the
current theme are baked into the file — the CSS themed through
`var(--vscode-*)` does not travel), the session camera becomes a `viewBox` on
the content, the theme's background is baked into a rect. The PDF export is
deferred: the SVG converts cleanly with external tools (browser, Inkscape),
and a PDF library in the webview does not justify its weight (D5 anticipated
the vector export — right in substance, but "trivial" only after inlining the
styles).

**Drawing vocabulary — core** (phase 4, implemented): **buses** carry their
width (`ScenePin`/`SceneBPort`/`SceneEdge` have `width`): the pin/flag shows
`/N` above the stub (combined `/16×3` for an unpacked array), and the
wire/stub thickens by **width classes** (`widthClass` →
w-s 2-8 / w-m 9-16 / w-l >16). The net's width on the edge is derived through
`netWidth` (reused from `probe.ts`) — ONLY from an end with the **same
signal** (the view's own port or a child pin with `conn.kind==="net"`),
never through select/concat (the width invariant in CLAUDE.md).
**The port label** (`portLabel`, pure, `test:scene`) follows the SystemVerilog
declaration order: the **packed dimensions before the name** (from
`elem_width`), the **unpacked ones after** (from the `type` suffix after the
internal separator `$`, so as to keep the exact declared range) —
`[15:0]ch_out[0:2]` for an unpacked array, `[15:0]din` for a packed vector,
only the name at 1 bit. It corrects the old `ch_out[15:0]` (Jul 2026, the
user's request), which presented an unpacked array as a flat 16-bit vector and
contradicted the selects `[0]`/`[1]`/`[2]` that feed it. The label is
**compact (no spaces** between the dimensions and the name, to save width);
the readability comes from the **different colouring**: when drawn
(`portLabelText` + `splitLabel`, both pure) the name is in the full colour,
and the dimensions in `.dim` tspans with `fill-opacity: 0.55` — a shade that
follows the name's colour on hover/select/iface, so that the name stays
prominent. **The measuring** of the block uses the compact string with the
editor's font (monospace, `measurer(mono)` — otherwise the wider monospace
labels were underestimated and the west/east ports overlapped). **Junction
dots** (`junctionDots`, pure, consumed in `routeEdges` after routing): a dot
where a net merges — for each vertex of the net the distinct cardinal
directions in which a segment of the net leaves are counted, and **≥3
directions at a vertex** = a real junction (a T with 3, or a 4-way merge as at
the fan-in of a bus — 3 `dout`s into one `ch_out` port; the user's request,
Jul 2026). A **bend** (2 directions) gets no dot. The dangerous crossings are
**not** marked: (1) DIFFERENT nets that touch — the detection is **grouped
per net**, so they are not in the same group; (2) a crossing of the same net
without a bend (two straight wires) has no vertex at the intersection, so it
does not reach the check. The common trunk of a fan-out (the waive) is
deduplicated per vertex.
**The bus comb** (`combPolys`, pure, `test:router`): a net with a fan
(≥2 wire edges, ends on different rows) is redrawn as a **vertical trunk + one
horizontal tap per end**, not as a STAR in which all the edges converge in the
sink (which made a 4-way — a single dot). `trunkX` = the dominant vertical x
from the A* routing (it goes around the obstacles), and `routeEdges` applies
the comb ONLY if the taps/the trunk do not cut any block (`combClear`) —
otherwise the per-edge routing stays. The top tap + the trunk + the bottom tap
are drawn as **ONE SINGLE polyline** (the spine), so that the two end corners
have a join (miter), not two separate "butt" ends that left a gap at the joint
(the user's observation); the interior taps stay separate — they touch the
thick side of the trunk, covered by it. The result: separate taps, each with its own T dot
(the sink beyond the sources = a trunk end, so the tap ends are bends
without a dot; the user's request, Jul 2026). **Annotation glyphs** (implemented later): `ScenePin.noteKind`
(`select`/`const`/`concat`/`nc`/`expr`/`mixed`) is the discriminator that
CHOOSES the glyph in the drawing layer, without re-parsing the note's text
(`noteOf` in scene.ts). `drawAnnotation` (schematic.ts) draws: `const` = a
tie-cell box with the value, `select`/`concat` = an **accent chip with the SV
brackets** (`{}` concat, `[]` select — the very operators from the source) +
the label, `nc` = a circle, the rest text. The chip replaces the old
netlistsvg wedge (Jul 2026): the wedge was filled and converged towards the
block, so it read as a second **arrowhead** over the wires' direction arrow —
an adversarial triage over 8 families, the user's explicit request. (Later,
again at the user's request, **the direction arrow of the RTL wires was
removed** — `marker-end` dropped from `edgeElement` —, the direction being
implicit from the port's side: inputs on the west, outputs on the east. The
arrows stay in the TB view, where the flags distinguish in/out/inout; the
`#arrow` marker in defs stays, used there.) The chip has no
tip oriented along the wire
(a rounded rectangle, the brackets carry the distinction), and the text
`{…}`/`[hi:lo]` stays the carrier of the meaning at "decorations off" (the
chip is decoration, hidden there; the note is not removed). The chip sits one
`MARKER_GAP` from the end of the stub, outwards (not glued to the port) —
otherwise its top corner overlapped the width label and the note. **The wire
crosses the chip HORIZONTALLY**, in the same direction as the port (the user's
request): for a pin with a marker, the VISIBLE stub extends to `MARKER_STUB`
(= `STUB+GAP+CW+MARKER_TAIL` = 48) AND the wire's routing anchor
(`routeEdges`) moves to `MARKER_STUB` as well, so the fanout's trunk attaches
BEYOND the marker (to the left at inputs/west, to the right at outputs/east)
and the horizontal stub drawn through the chip crosses it. **The pin visibly
PIERCES the chip** (the user's request, Jul 2026): the stub comes out
`MARKER_TAIL` (=12px) beyond the chip's outer edge (36), otherwise it looked
hidden under it (it stopped exactly at the edge, the wire seemed to spring
from the chip); 36+12=48 is a multiple of 8, so the tip/anchor falls ON THE
GRID (pin on the grid = straight wire). The approach with a routing obstacle
(to push the trunk) was REJECTED — an obstacle also repels the horizontal
branch (the wire went around the chip, which was left "high and dry"); the
anchor is the right solution (a wire routed up to the anchor + a decoration
stub through the chip). **The thickness transition** port stub (the port's
width) → net edge (the net's width) now falls at the TIP, collinear with the
wire (no corner), so it produces no broken joins; the old note "the transition
under the chip" (the anchor exactly at the chip's edge) is REPLACED by the
newer request — the pin visible beyond the chip beats hiding the transition.
The background is OPAQUE
(`color-mix` with `editor-background`), so it masks the wire underneath. The vertical centring of the brackets does NOT use `dominant-baseline`
(getBBox + dominant-baseline differ between Chromium versions — harness vs
the VSCode webview —, and the nudge came out wrong): the sign gets a starting
`y` that is approximately centred, and `centerChipSigns` (called after
`drawSchematic`, with the elements in the DOM) measures the real box of the
sign and of the rectangle on the **alphabetic baseline** (getBBox reliable
everywhere) and nudges the sign until the centres coincide. It is re-applied
on the next frame and after `document.fonts.ready` (the first getBBox may run
before the editor's font is applied).
Independent of the font, idempotent per render.
The intermediate iteration was a diamond with a
width sign `+`/`−`, replaced because the sign needed a mnemonic; the brackets
are the syntax itself. `estPinText`
adds a fixed allowance (`GLYPH_W`) for const/select/concat, in BOTH
consumers (the ELK margins and the router's obstacles), so that the wider
glyphs do not leave the reserved area.
**Pin sections by role** (the symbol view, symbolator): the clock/reset pins
(the `isClockOrReset` heuristic) are already grouped bottom-left
(`buildPins`); the grouping is made VISIBLE through a gap + a divider + a
title — `draw` (main.ts) detects the signals→clock/reset boundary on the
west, shifts the clock/reset group down by `SECTION_GAP` (ELK FIXED_ORDER
leaves no per-group gap), enlarges the box and draws a dotted divider + the
label "clock / reset" (the top group is implicit by contrast). Only in the
symbol view and only when the module has a clock/reset (a purely
combinational one stays flat).
The vocabulary (slash+width, junction dots) can be hidden with the
`quickuvm.schematicDecorations` setting (on by default; a `decor-off` class on
the canvas through `ui/config` — the grading of the wire thickness stays, it
is the nature of the wire).
**The wire uses an OPAQUE colour mixed with the background, not `opacity`**:
the wires of the same net that share the trunk (the fan-out waive)
accumulated their transparency and gave a gradient effect where they
overlapped (observed at validation) — the opaque mix gives the same softness
without the accumulation.

**The world on the grid is universal**: in any schematic view, all the
positions — including the flags of the boundary ports, movable too (keys
`<port>.x` in the sidecar) — are rounded to the grid at every render (the ELK
positions are fractional; the jump is under half a step). Consequences: the
anchors fall on grid rows (the router produces fully orthogonal routes on the
grid), and pin-to-pin alignment is possible between any two elements, moved
or not.
**Anti-overlap nudge at expansion** (from validation): on an arranged view,
D21 pins ALL the neighbours, so interactive ELK cannot push them to make room
for the members of a freshly expanded fold — which can land on top of pinned
nodes. At render, the elements WITHOUT a seed (new members) that would overlap
are moved to the nearest free spot on the grid (`freeSpot`, pure — it scans
on growing circles, prefers below), without touching the user's blocks; a
fresh view (without seeds) goes through full ELK, so it needs no
nudge. `⟲` stays the way to a clean arrangement.

**The routes always come from our own router** — ELK gives only the
positions; a single routing behaviour (halo, protected labels, occupancy) in
all the views, with or without overrides.

The parallel overlap of two distinct nets on the same corridor is expensive
(`overlapPenalty`, default 8/cell) — along their length, different wires stay
on separate corridors. **An exception near the common ends** (`fanoutRadius`,
default 6 cells): the wires that start from the same source (fan-out — an
agent's analysis port towards the scoreboard AND the coverage) or converge on
the same destination (fan-in) are allowed to share the trunk right next to the
common end, instead of being forced to fork at the pin. The radius is anchored
at the ends of the edge *being routed* (not at arbitrary waypoints) and only
*cancels the penalty*, it does not force the overlap: at equal length the
router still prefers separate corridors, so the nets from neighbouring pins do
not stick together — the waive bites only when the overlap really shortens the
route (that is, exactly at a common end). Do not confuse it with the single
net with fan-out (a common `group`), where the overlap is free along the whole
length.

The nodes support **flipping** (flip), persisted in the sidecar per node
(`flipH`/`flipV`): horizontal = the west↔east sides are swapped (the inputs
appear on the right), vertical = the order of the pins is reversed on each
side. The flip is a **reassignment of the pin slots on the grid, not a
geometric mirroring** — the text (names, labels) is never mirrored, and the
pins stay on the same grid rows. The ports being `FIXED_POS`, ELK receives the
positions already flipped, so its routes stay valid on flipped nodes
too.

The grid (step 8) follows the EDA convention: **the pins snap to the grid, not
only the box**. The internal geometry of the nodes is a multiple of the grid
by construction (the first pin centre at +40 under the title band, the pin
pitch `PIN_PITCH`=24 — widened from 16 at validation, so that the decorations
have air between the rows; it stays a multiple of 8, so the pins stay on the
grid —, widths and heights rounded to 8, `FIXED_POS` ports computed by the
extension — not by ELK), so that snapping the top-left corner automatically
puts all the connection points on the grid: pin aligned with pin = a perfectly
straight wire. A consequence: the pins sit in the order of the declaration in
the module (the norm in schematics); reordering comes from the level 2
overrides. Interactive routing of the edges did become a
requirement (Nov 2026) and was built on our own router and SVG (level 3 above,
D27): the re-evaluation towards JointJS that this paragraph used to reserve was
not needed.
