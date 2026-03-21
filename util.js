"use strict"

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const littleEndian = (() => {
    const u16 = new Uint16Array(1)
    const u8 = new Uint8Array(u16.buffer);
    u16[0] = 1;
    return u8[0] == 1;
})()

export { sleep, littleEndian }
