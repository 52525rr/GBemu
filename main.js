//@ts-check

"use strict"

import { GameBoyCore } from "./cpu.js";
import { GameBoyVideoCanvas } from "./framebufferReader.js";
import { ctz32, sleep } from "./util.js";

const CYCLES_PER_FRAME = 1e6;

/**
 * @param {Uint8Array} romData
 */
function _init(romData) {
    const cpuInstance = new GameBoyCore(romData);
    cpuInstance.resetCPU();

    _run(cpuInstance);
}

/**
 * @param {GameBoyCore} cpuInstance
 */
async function _run(cpuInstance) {
    const videoSource = new GameBoyVideoCanvas("canvas");
    const text = document.getElementById("A");

    cpuInstance.resetCPU();
    while(1){
        while(cpuInstance.frameCycles < CYCLES_PER_FRAME){
            cpuInstance.stepSingle();
        }
        cpuInstance.frameCycles -= CYCLES_PER_FRAME;

        videoSource.copyBuffer(cpuInstance.IOhandler.PPU.framebuffer);
        videoSource.updateImage();
        //@ts-ignore
        text.innerText = `cycles ran: ${cpuInstance.IOhandler.scheduler.count}`;

        debugger;
        await sleep(1);
    }
}

export { _init }