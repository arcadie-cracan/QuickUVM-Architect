# 02 — The project model

The project model is the JSON document emitted by the backend and consumed by
the host and the webview. It is the stable contract of the system: the formal
schema is `schema/project-model.schema.json`, and this document explains the
semantics and the edge cases. The `schema_version` field (an integer, today
`1`) is incremented on any incompatible change; the host refuses unknown
versions.

## Overall structure

```json
{
  "schema_version": 1,
  "tops": ["demo_top"],
  "modules":   { "<definition-name>": { ports, iface_ports, loc } },
  "instances": [ { path, module, params, loc, iface? } ],
  "views":     { "<instance-path>": { module, pins, nets } }
}
```

`modules` describes the *definitions* (one entry per module/interface, with the
ports as they were elaborated at the first instantiation encountered);
`instances` describes the *elaborated tree* (one entry per instance, with the
effective parameter values); `views` describes the internal connectivity of the
instances that have children.

## Stable IDs

Every addressable element is identified by an elaborated hierarchical path:

- an instance: `demo_top.u_soc.g_ch[1].u_ch` (generate blocks appear with the
  name and the index of the construct: `g_ch[1]`);
- an instance pin in a view: `g_ch[1].u_ch.dout` (relative to the view);
- a port of the view's module: `<port>.din` (the `<port>` prefix distinguishes
  it from the pins of the child instances);
- a net: its name in the view's scope.

These keys are used by the layout sidecar file (doc. 04), by the configuration
overlay and by the message protocol (doc. 05). They are stable across
re-parsing as long as the design is not renamed — exactly the property the
user's spatial memory requires.

## Ports and types

Per port: `name`, `dir` (`in` / `out` / `inout` / `ref`), `type` (the text of
the elaborated type, e.g. `logic[15:0]$[0:2]`), `width` (the total width in
bits, numeric — never symbolic, because the model is post-elaboration),
`unpacked_dims` (the list of unpacked dimensions, `null` if it is not an
array), `elem_width` (the element width for arrays), `loc` (file + line).

Documented edge cases:

- **unpacked arrays**: `width` = the product of the dimensions × the element
  width (`ch_out`: 3 × 16 = 48); the UI shows `elem_width` on the pin and the
  multiplicity separately;
- **interface ports**: they do not appear in `ports`, but in `iface_ports`
  (`{name, interface, modport, loc}`); the detail of the interface (signals
  with elaborated widths + modports with directions) is on the interface
  *instance* (`instances[].iface`), because the widths depend on the
  instance's parameters;
- **types without a fixed size** (dynamic array, string etc.): `width: null`;
  the UI shows them without a width label.

## Views and connectivity

A view exists for every instance with child instances. It contains:

- `pins`: the list `{pin, conn}` — every pin of every child instance, with the
  normalized connection expression;
- `nets`: the list `{name, endpoints, fanout, render}` — the endpoints include
  the instance pins and the module's ports (`<port>.x`); `render` is the
  wire/label *suggestion* computed from the fan-out (configurable threshold,
  by default >4 → label).

### Normalized connection expressions

A recursive descriptor with `kind`:

| kind | meaning | fields |
|---|---|---|
| `net` | a plain reference to a net | `net` |
| `concat` | concatenation | `parts[]` (recursive) |
| `select` | element/range selection | `base` (recursive), `index` (numeric, elaborated per instance; the source text in `text` may contain the genvar) |
| `const` | tied to a constant (tie-off) | `value` |
| `iface` | interface connection | `ref` (e.g. `bus_i.slave`) |
| `expr` | an unrecognized general expression | `text` (the source syntax) — the UI shows it as "connection logic", without claiming to draw it |
| `null` | unconnected pin | — (a visual mark of a floating pin) |

The design rule: the descriptors exist so that the UI can draw junctions and
count the fan-out correctly, not to reimplement expression evaluation. Any new
case met in practice is added as a new `kind` only if it has a visual
consequence; otherwise it falls into `expr`.

## Policies that are NOT in the model

The model carries facts about the design; the display policies belong to the
UI:

- the rule "clock/reset is shown as a label whatever the fan-out" is applied in
  the UI based on the roles established at configuration time (or
  heuristically by name), not in the extractor;
- folding the generated instances (`ch[0..2]`) is a view operation: the UI
  groups the instances with the same path prefix and the same
  module/parameters;
- grouping the pins by prefix (`axi_*`) is also in the UI.

## Planned extensions of the schema (not implemented)

- `schema_version: 2`: source-file attributes at definition level for
  multi-library Bender projects (a `library` field);
- compilation diagnostics included in the model (`diags[]`), so that the host
  does not parse stderr.
