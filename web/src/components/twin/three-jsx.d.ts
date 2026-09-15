// Makes <mesh>, <cylinderGeometry>, ... known to TypeScript when the R3F augmentation is not picked up automatically.
import type { ThreeElements } from "@react-three/fiber";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicElements extends ThreeElements {}
  }
}
