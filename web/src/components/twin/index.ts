/**
 * Public surface of the 3D twin. Load `Twin` with `next/dynamic({ ssr: false })` and use
 * `TwinPoster` as the loading fallback; give the parent element a size (the twin fills it).
 */
export { default as Twin, type TwinProps, type TwinHandle, type TwinView } from "./Twin";
export { TwinLegend } from "./TwinLegend";
export { TwinPoster } from "./Poster";
