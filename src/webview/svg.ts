// SVG utilities shared by the webview's views (symbol and schematic):
// element creation with attributes and text measurement with the theme font.

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

/** text measurer with the theme font (12px). `mono=true` -> the editor font
 *  (--vscode-editor-font-family, monospace), used to draw the pin/port labels;
 *  measuring them with the proportional UI font UNDERESTIMATED them (monospace is
 *  wider) and the blocks came out too narrow -> overlapping port labels */
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
