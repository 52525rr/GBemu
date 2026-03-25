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
    DIV_INCREMENT: 0
})

class IOManager{
    /**
     * @param {GameBoyCore} cpuInstance
     */
    constructor(cpuInstance){
        this.cpu = cpuInstance;
        this.DIV = 0;
        this.scheduler = new Scheduler();
        
        this.cyclesPerTimerIncrement = 256;

        this.IOaccessor = this.cpu.MMU.IO;
        this.#initScheduler();
    }

    /**
     * @param {number} cycles
     */
    tick(cycles){
        console.log(cycles);
        this.scheduler.advance(cycles);

        const timerCycles = cycles / this.cpu.cyclesPerTick;
        this.#updateTimer(timerCycles);

        this.checkSchedulerEvents();
    }

    checkSchedulerEvents(){
        
    }

    /**
     * @param {number} normalizedCycles
     */
    #updateTimer(normalizedCycles){
        for(let i = 0; i < normalizedCycles; i++){
            this.DIV += 4;
        }
        this.IOaccessor[IO_LABELS.DIV] = this.DIV >> 8;
    }

    #initScheduler(){
        this.scheduler.addEventOffset(this.cyclesPerTimerIncrement, SCHEDULER_EVENTS.DIV_INCREMENT);
    }
}

export { IOManager, IO_LABELS }