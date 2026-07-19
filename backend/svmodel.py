#!/usr/bin/env python3
"""svmodel — extractor de model de proiect din designuri SystemVerilog, pe pyslang.

Produce modelul JSON consumat de extensia VSCode (vezi schema/project-model.schema.json):
  - ierarhia elaborata de instante (ID-uri stabile = cai ierarhice, generate desfacut)
  - module cu porturi (directie normalizata, latimi evaluate numeric) si interfete
  - vederi de interior: pini de instante -> net-uri, expresii de conexiune normalizate,
    fan-out per net cu sugestia fir/eticheta

Utilizare:
  python3 svmodel.py -f lista.f --top demo_top            # lista de fisiere (ex. de la bender)
  python3 svmodel.py file1.sv file2.sv --top demo_top
Optiuni: --label-threshold N (implicit 4), -o out.json (implicit stdout)

Validat cu pyslang 11.0 (slang 11).
"""
import argparse
import json
import sys

from pyslang.driver import Driver
from pyslang import DiagnosticEngine, ast

SK = ast.SymbolKind


# ---------------------------------------------------------------- utilitare

def norm_dir(d):
    """'ArgumentDirection.In' -> 'in' (normalizare enum slang)."""
    return str(d).split(".")[-1].lower()


def type_info(t):
    """Latimea in biti a unui tip, inclusiv tablouri unpacked (element x dimensiuni)."""
    total, dims, elem = None, [], t
    while elem.isUnpackedArray:
        r = elem.fixedRange
        dims.append(abs(r.left - r.right) + 1)
        elem = elem.arrayElementType
    if elem.isFixedSize:
        total = elem.bitWidth
        for d in dims:
            total *= d
    return {"type": str(t), "width": total,
            "unpacked_dims": dims or None,
            "elem_width": elem.bitWidth if dims and elem.isFixedSize else None}


class Extractor:
    def __init__(self, comp, sm, label_threshold=4):
        self.comp, self.sm, self.thr = comp, sm, label_threshold
        self.model = {"schema_version": 1, "tops": [], "modules": {},
                      "instances": [], "views": {}}

    def loc(self, sym):
        l = getattr(sym, "location", None)
        if not l:
            return None
        return {"file": self.sm.getFileName(l), "line": self.sm.getLineNumber(l)}

    # -------------------------------------------------- porturi si module

    def module_entry(self, body):
        name = body.definition.name
        if name in self.model["modules"]:
            return
        ports, ifp = [], []
        for m in body:
            if m.kind == SK.Port:
                ports.append({"name": m.name, "dir": norm_dir(m.direction),
                              **type_info(m.type), "loc": self.loc(m)})
            elif m.kind == SK.InterfacePort:
                ifp.append({"name": m.name, "interface": m.interfaceDef.name,
                            "modport": m.modport, "loc": self.loc(m)})
        self.model["modules"][name] = {"ports": ports, "iface_ports": ifp,
                                       "loc": self.loc(body.definition)}

    def iface_detail(self, inst):
        """Semnale + modporturi ale unei instante de interfata elaborate."""
        sigs, mps = [], {}
        for m in inst.body:
            if m.kind == SK.Variable:
                sigs.append({"name": m.name, **type_info(m.type)})
            elif m.kind == SK.Modport:
                mps[m.name] = {p.name: norm_dir(p.direction) for p in m}
        return {"signals": sigs, "modports": mps}

    # -------------------------------------------------- expresii de conexiune

    def norm_expr(self, e):
        if e is None:
            return None
        k = type(e).__name__
        if k == "AssignmentExpression":            # port de iesire: extern = port
            return self.norm_expr(e.left)
        if k == "ConversionExpression":
            return self.norm_expr(e.operand)
        if k == "NamedValueExpression":
            return {"kind": "net", "net": e.symbol.name}
        if k == "ConcatenationExpression":
            return {"kind": "concat", "parts": [self.norm_expr(o) for o in e.operands]}
        if k == "ElementSelectExpression":
            idx = e.selector.constant              # in context elaborat: index numeric
            return {"kind": "select", "base": self.norm_expr(e.value),
                    "index": str(idx) if idx is not None else None,
                    "text": str(e.syntax).strip() if e.syntax else None}
        if k == "RangeSelectExpression":
            return {"kind": "select", "base": self.norm_expr(e.value),
                    "text": str(e.syntax).strip() if e.syntax else None}
        if k == "ArbitrarySymbolExpression":       # conexiune de interfata
            return {"kind": "iface",
                    "ref": str(e.syntax).strip() if e.syntax else e.symbol.name}
        if e.constant is not None:
            return {"kind": "const", "value": str(e.constant)}
        return {"kind": "expr",
                "text": str(e.syntax).strip() if e.syntax else k}

    def base_nets(self, desc):
        """Net-urile referite de un descriptor (pentru fan-out)."""
        if not desc:
            return
        if desc["kind"] == "net":
            yield desc["net"]
        elif desc["kind"] == "concat":
            for p in desc["parts"]:
                yield from self.base_nets(p)
        elif desc["kind"] == "select" and desc.get("base"):
            yield from self.base_nets(desc["base"])

    # -------------------------------------------------- parcurgere ierarhie

    def walk(self, inst, path):
        body = inst.body
        hpath = f"{path}.{inst.name}" if path else inst.name
        entry = {"path": hpath, "module": body.definition.name,
                 "params": {m.name: str(m.value) for m in body
                            if m.kind == SK.Parameter},
                 "loc": self.loc(inst)}
        if inst.isInterface:
            entry["iface"] = self.iface_detail(inst)
        self.model["instances"].append(entry)
        self.module_entry(body)
        self.view(inst, hpath)
        for child, cpath in self.children(body, hpath):
            self.walk(child, cpath)

    def children(self, scope, hpath, prefix=""):
        for m in scope:
            if m.kind == SK.Instance:
                yield m, hpath + (f".{prefix}" if prefix else "")
            elif m.kind == SK.GenerateBlockArray:
                for blk in m:
                    if blk.kind == SK.GenerateBlock and not blk.isUninstantiated:
                        yield from self.children(
                            blk, hpath, f"{m.name}[{blk.constructIndex}]")

    def view(self, inst, hpath):
        """Vederea de interior: pini -> net-uri, doar daca exista instante copil."""
        pins, nets = [], {}
        for p in inst.body.portList:
            nets.setdefault(p.name, []).append(f"<port>.{p.name}")

        def visit(scope, prefix):
            for m in scope:
                if m.kind == SK.Instance:
                    for c in m.portConnections:
                        d = self.norm_expr(c.expression)
                        ep = f"{prefix}{m.name}.{c.port.name}"
                        pins.append({"pin": ep, "conn": d})
                        for n in self.base_nets(d):
                            nets.setdefault(n, []).append(ep)
                elif m.kind == SK.GenerateBlockArray:
                    for blk in m:
                        if blk.kind == SK.GenerateBlock and not blk.isUninstantiated:
                            visit(blk, f"{prefix}{m.name}[{blk.constructIndex}].")

        visit(inst.body, "")
        if pins:
            self.model["views"][hpath] = {
                "module": inst.body.definition.name, "pins": pins,
                "nets": [{"name": n, "endpoints": eps, "fanout": len(eps),
                          "render": "label" if len(eps) > self.thr else "wire"}
                         for n, eps in nets.items()]}


# ---------------------------------------------------------------- API + CLI

def build_model(files=(), flists=(), top=None, label_threshold=4):
    """Compileaza sursele si intoarce modelul de proiect ca dict.

    Punct de intrare refolosit de CLI si de testele pytest. Decizia de succes
    se ia pe diagnosticele compilarii (reportCompilation le-ar inghiti cu
    quiet=True si intoarce valori neintuitive): toate diagnosticele se scriu
    formatate pe stderr (fisier:linie:coloana: severitate: mesaj — formatul
    parsat de extensie), iar la erori se ridica RuntimeError — modelul unei
    compilari cu erori nu e "valid" si nu se emite (invalidare gratioasa:
    host-ul pastreaza ultimul model valid).
    """
    # caile se citeaza: parseCommandLine desparte pe spatii (cai Windows)
    cmd = "slang " + " ".join(f'"{p}"' for p in files) \
        + "".join(f' -f "{f}"' for f in flists) + f" --top {top}"
    drv = Driver()
    drv.addStandardArgs()
    if not (drv.parseCommandLine(cmd) and drv.processOptions()
            and drv.parseAllSources()):
        raise RuntimeError("eroare: parsarea surselor a esuat")
    comp = drv.createCompilation()
    diags = comp.getAllDiagnostics()      # forteaza elaborarea completa
    if diags:
        sys.stderr.write(DiagnosticEngine.reportAll(drv.sourceManager, diags))
    errors = sum(1 for d in diags if d.isError())
    if errors:
        raise RuntimeError(f"eroare: compilarea are {errors} erori")

    ex = Extractor(comp, drv.sourceManager, label_threshold)
    for t in comp.getRoot().topInstances:
        ex.model["tops"].append(t.name)
        ex.walk(t, "")
    return ex.model


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*")
    ap.add_argument("-f", dest="flists", action="append", default=[],
                    help="fisier .f cu lista de surse (ex. generat de bender)")
    ap.add_argument("--top", required=True)
    ap.add_argument("--label-threshold", type=int, default=4,
                    help="fan-out peste care un net se afiseaza ca eticheta")
    ap.add_argument("-o", dest="out")
    args = ap.parse_args()

    try:
        model = build_model(args.files, args.flists, args.top,
                            args.label_threshold)
    except RuntimeError as e:
        sys.exit(str(e))

    out = json.dumps(model, indent=1)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out)
    else:
        print(out)


if __name__ == "__main__":
    main()
