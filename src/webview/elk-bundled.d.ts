// Declaratie pentru varianta bundled a elkjs (fara worker), folosita in
// webview. Tipurile vin din pachetul elkjs (lib/main -> elk-api).
declare module "elkjs/lib/elk.bundled.js" {
  export * from "elkjs";
  export { default } from "elkjs";
}
