const UINT32_RANGE = 4_294_967_296;

/**
 * Small deterministic generator suitable for reproducible model variation.
 * @param {number} seed
 * @returns {{ next(): number }}
 */
export function createMulberry32(seed) {
  let state = seed >>> 0;

  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
    },
  };
}
