# examples-bender — a real Bender project for validating phase 1

`common_cells/` is a shallow clone (`git clone --depth 1`) of
[pulp-platform/common_cells](https://github.com/pulp-platform/common_cells) —
the canonical project of the Bender ecosystem, with its own licence (Solderpad,
see `common_cells/LICENSE`). It is not part of the extension (it is excluded
through `.vscodeignore`) and it is not distributed; it exists locally only as
the validation ground for the closure criterion of phase 1: "you open a real
Bender project, you see the hierarchy and the context diagram of any module,
with jump-to-source from a pin".

Already prepared:

- the Bender dependencies are resolved (`.bender/`, `Bender.lock` — created by
  `bender script flist-plus`, which also runs automatically from the
  extension);
- `.vscode/settings.json` presets `quickuvm.top = cdc_fifo_gray` (a
  clock-domain-crossing FIFO: 24 instances, 8 views, a hierarchy on 3 levels
  with cells from `tech_cells_generic` — 0 errors, 15 warnings that populate
  Problems).

The interactive step: the launch configuration "Run the extension (Bender:
common_cells)" in the repository's `.vscode/launch.json`, then in the Extension
Development Host: the hierarchy in the QuickUVM Architect view, a click on an
instance → the context view, a double-click on a pin → the port's declaration.

The clone can be deleted at any time; it is recreated with:

```bash
git clone --depth 1 https://github.com/pulp-platform/common_cells.git \
    examples-bender/common_cells
```

## Validating phase 3 (the schematic view, Jul 2026)

`model-cdc.json` is the derived project model (regenerable, not distributed),
used by the automatic sweep in `scripts/harness.html`: all 8 schematic views
and the 24 symbols rendered without exceptions, zero edges through blocks,
drag → total snapshot (D21), wire↔label switching with correct persistence.
Regeneration (mind the pitfall in CLAUDE.md — the `.f` lines with spaces in
their paths are quoted):

```bash
cd examples-bender/common_cells && bender script flist-plus > cc-raw.f
# quote the paths with spaces in cc-raw.f, then, from the repository root:
python backend/svmodel.py -f cc.f --top cdc_fifo_gray \
       -o examples-bender/model-cdc.json
```
