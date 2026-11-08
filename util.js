//@ts-check
"use strict"

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const littleEndian = (() => {
    const u16 = new Uint16Array(1);
    const u8 = new Uint8Array(u16.buffer);
    u16[0] = 1;
    return u8[0] == 1;
})()

const ctz32 = (/** @type {number} */ x) => {
    x >>>= 0;
    return x ? 31 - Math.clz32(x & -x) : 32;
}

const mod = (/** @type {number} */ a, /** @type {number} */ b) => a % b + (a / b < 0 ? b : 0);

/**
 * @param {number} x 
 * @returns {number}
 */
const bitReverse = (x) => {
    x = (((x & 0xaaaaaaaa) >>  1) | ((x & 0x55555555) <<  1));
    x = (((x & 0xcccccccc) >>  2) | ((x & 0x33333333) <<  2));
    x = (((x & 0xf0f0f0f0) >>  4) | ((x & 0x0f0f0f0f) <<  4));
    x = (((x & 0xff00ff00) >>  8) | ((x & 0x00ff00ff) <<  8));
    x = (((x & 0xffff0000) >> 16) | ((x & 0x0000ffff) << 16));
    return x;
}

const bitReverse8 = (/** @type {number} */ n) => bitReverse(n) >>> 24;

export { sleep, littleEndian, ctz32, mod, bitReverse8 }