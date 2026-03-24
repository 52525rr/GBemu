//@ts-check
"use strict"
import { GameBoyCore } from "./cpu.js";
import { Scheduler } from "./scheduler.js";

const IO_LABELS = Object.freeze({
    IF:     0x0F,
    DIV:    0x04,
    TIMA:   0x05,
    TMA:    0x06,
})

const SCHEDULER_EVENTS = Object.freeze({
    
})

class IOManager{
    /**
     * @param {GameBoyCore} cpuInstance
     */
    constructor(cpuInstance){
        this.cpu = cpuInstance;
        this.DIV = 0;
        this.scheduler = new Scheduler();
    }

    /**
     * @param {number} cycles
     */
    tick(cycles){
        const timerCycles = cycles / this.cpu.cyclesPerTick;
        this.#updateTimer(timerCycles);
    }

    /**
     * @param {number} normalizedCycles
     */
    #updateTimer(normalizedCycles){
        for(let i = 0; i < normalizedCycles; i++){
            
        }
    }
}

export { IOManager }