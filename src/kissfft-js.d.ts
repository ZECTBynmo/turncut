declare module "kissfft-js" {
  export class FFTR {
    constructor(size: number)
    forward(input: Float32Array | number[]): Float32Array
    inverse(input: Float32Array | number[]): Float32Array
    dispose(): void
  }
} 