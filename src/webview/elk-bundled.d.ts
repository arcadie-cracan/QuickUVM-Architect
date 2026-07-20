// Declaration for the bundled variant of elkjs (no worker), used in the
// webview. The types come from the elkjs package (lib/main -> elk-api).
declare module "elkjs/lib/elk.bundled.js" {
  export * from "elkjs";
  export { default } from "elkjs";
}
