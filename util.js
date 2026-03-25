"use strict"

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const littleEndian = (() => {
    const u16 = new Uint16Array(1);
    const u8 = new Uint8Array(u16.buffer);
    u16[0] = 1;
    return u8[0] == 1;
})()

const ctz32 = (x) => {
    x = x >>> 0; 
    return x ? 31 - Math.clz32(x & -x) : 32;
}

export { sleep, littleEndian, ctz32 }