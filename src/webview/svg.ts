// Utilitare SVG partajate de vederile webview-ului (simbol si schema):
// creare de elemente cu atribute si masurarea textului cu fontul temei.

export const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  ...children: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** masurator de text cu fontul temei (12px). `mono=true` -> fontul editorului
 *  (--vscode-editor-font-family, monospace), cu care se deseneaza etichetele de
 *  pin/port; masurarea lor cu fontul UI proportional le SUBESTIMA (monospace e
 *  mai lat) si blocurile ieseau prea inguste -> etichete de porturi suprapuse */
export function measurer(): (text: string, mono?: boolean) => number {
  const ctx = document.createElement("canvas").getContext("2d");
  const uiFont = `12px ${getComputedStyle(document.body).fontFamily}`;
  const monoFam =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--vscode-editor-font-family")
      .trim() || "monospace";
  const monoFont = `12px ${monoFam}`;
  return (text, mono) => {
    if (!ctx) {
      return text.length * 7.2;
    }
    ctx.font = mono ? monoFont : uiFont;
    return ctx.measureText(text).width;
  };
}
