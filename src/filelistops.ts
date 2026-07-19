// Partea PURA a cailor si listelor de fisiere schimbate cu slang (fara
// vscode) — testabila in Node (scripts/test-filelist.mjs). Trei capcane
// reale traiesc aici (CLAUDE.md):
// - slang relativizeaza loc.file fata de cwd-ul procesului (poate iesi
//   ..\..\...); host-ul reconstituie calea absoluta prin join cu radacina
//   workspace-ului (resolveLocPath, folosit de openLoc);
// - slang desparte linia de comanda pe spatii: caile din .f se citeaza
//   integral, iar la +incdir+ se citeaza doar calea (`+incdir+"cale"`,
//   validat cu slang 11 pe cai cu spatii);
// - dosarul de iesire quick-uvm se exclude din glob-ul de surse: testbench-ul
//   generat contine un stub al DUT-ului (definitie duplicata care castiga
//   rezolutia slang) si surse care cer uvm_macros.svh — altfel extensia isi
//   otraveste singura modelul dupa primul "Genereaza testbench" (regresie
//   reala pe examples/, unde test:e2e lasase tb/).

import * as path from "path";

/**
 * Citeaza liniile unui flist pentru parserul slang (desparte pe spatii).
 * Caile se citeaza integral; la +incdir+ se citeaza doar calea (forma
 * `+incdir+"cale"`, validata cu slang 11 pe cai cu spatii). Bender emite un
 * singur director per linie +incdir+; +define+ nu contine spatii.
 */
export function quoteFlistLine(line: string): string {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("#")) {
    return t;
  }
  const inc = /^\+incdir\+(?!")(.+)$/.exec(t);
  if (inc) {
    return `+incdir+"${inc[1]}"`;
  }
  if (t.startsWith("+")) {
    return t;
  }
  return t.startsWith('"') ? t : `"${t}"`;
}

/** textul fisierului .f: liniile citate, fara cele ramase goale */
export function renderFlist(lines: string[]): string {
  return lines.map(quoteFlistLine).filter(Boolean).join("\n") + "\n";
}

/**
 * Sablonul de exclude pentru dosarul de iesire quick-uvm, sau null cand
 * excluderea relativa nu are sens (gol, "." = radacina, cale absoluta).
 * Normalizeaza \ -> / si taie separatorii finali.
 */
export function outputDirExclude(outputDir: string): string | null {
  const outDir = outputDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!outDir || outDir === "." || path.isAbsolute(outDir)) {
    return null;
  }
  return `${outDir}/**`;
}

/**
 * Calea absoluta a unui `loc.file` emis de slang: absoluta ramane cum e, iar
 * cea relativa (slang o relativizeaza fata de cwd-ul procesului — poate iesi
 * `..\\..\\...`) se reconstituie prin join cu radacina workspace-ului
 * (path.join normalizeaza segmentele `..`).
 */
export function resolveLocPath(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(root, file);
}
