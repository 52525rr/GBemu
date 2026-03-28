//@ts-check
"use strict"
import { GameBoyCore, INTERRUPT_SOURCES } from "./cpu.js";
import { Scheduler } from "./scheduler.js";

const IO_LABELS = Object.freeze({
    IF:     0x0F,
    DIV:    0x04,
    TIMA:   0x05,
    TMA:    0x06,
    TAC:    0x07,
})

const SCHEDULER_EVENTS = Object.freeze({
    DIV_INCREMENT: 0,
    TIMA_INTERRUPT: 1
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

        this.IO = this.cpu.MMU.IO;
        this.#initScheduler();
    }

    /**
     * @param {number} ticks
     */
    step(ticks){
        const Mcycles = ticks / this.cpu.cyclesPerTick;

        this.scheduler.advance(ticks);

        this.#updateTimer(Mcycles);
        this.checkSchedulerEvents();
    }

    checkSchedulerEvents(){
        while(this.scheduler.timeUntilNext <= 0){
            const E = this.scheduler.peekNextEvent();

            switch(E.event){
                case SCHEDULER_EVENTS.TIMA_INTERRUPT:{
                    // do nothing
                    // this event only exists to make sure that the stepper runs before a TIMA interrupt fires.
                }break;

                default:{
                    debugger
                }break;
            }
            this.scheduler.removeNextEvent();
        }
    }


    /**
     * @param {number} addr
     * @param {number} byte
     */
    trapIOwrite(addr, byte){
        const ioLower = addr & 0xFF;
        const a = addr >> 8;
        if(a !== 0xFF) return;

        switch(ioLower){
            case IO_LABELS.DIV:{
                debugger;
            }break;

            case IO_LABELS.TIMA:{
                this.#rescheduleTIMAevent();
            }break;

            case IO_LABELS.TMA:{
                this.#rescheduleTIMAevent();
            }break;

            case IO_LABELS.TAC:{
                this.#rescheduleTIMAevent();
            }break;
        }
    }

    #getTIMAspeed(){
        let TIMAspeed = this.TAC & 0b11;
        if(TIMAspeed == 0) TIMAspeed = 4;
        return 4 ** TIMAspeed; // 4, 16, 64, or 256 M cycles
    }

    #rescheduleTIMAevent(){
        // DIV should be up to date when this is called
        const TIMAenabled = this.TAC >> 2 & 1;
        this.scheduler.removeFirstWithEventID(SCHEDULER_EVENTS.TIMA_INTERRUPT);

        if(!TIMAenabled){
            return;
        }
        let untilOverflow = 0xFF - this.TIMA;

        let TIMAspeed = this.#getTIMAspeed(); // M cycles
        let DIVclocked = TIMAspeed - (this.DIV % TIMAspeed); // time until next increment??

        let ticksUntilInterrupt = (DIVclocked + untilOverflow*TIMAspeed) * this.cpu.cyclesPerTick;

        this.scheduler.addEventOffset(ticksUntilInterrupt, SCHEDULER_EVENTS.TIMA_INTERRUPT);
    }

    /**
     * @param {number} normalizedCycles
     */
    #updateTimer(normalizedCycles){
        let TIMAspeed = this.#getTIMAspeed();
        const TIMAenabled = this.TAC >> 2 & 1;

        for(let i = 0; i < normalizedCycles; i++){
            this.DIV += 1;

            if(TIMAenabled && this.DIV % TIMAspeed === 0){
                let TIMA = this.TIMA;
                this.TIMA++;
                //console.log(`TIMA is now ${TIMA}`);

                if(TIMA + 1 >= 0x100){
                    this.TIMA = this.TMA;
                    this.cpu.IFreg |= 1 << INTERRUPT_SOURCES.TIMER;
                }
            }
        }
        this.IO[IO_LABELS.DIV] = this.DIV >> 6;
    }

    #initScheduler(){
        
    }

    get TIMA(){
        return this.IO[IO_LABELS.TIMA];
    }
    set TIMA(v){
        this.IO[IO_LABELS.TIMA] = v;
    }

    get TMA(){
        return this.IO[IO_LABELS.TMA];
    }
    set TMA(v){
        this.IO[IO_LABELS.TMA] = v;
    }

    get TAC(){
        return this.IO[IO_LABELS.TAC];
    }
    set TAC(v){
        this.IO[IO_LABELS.TAC] = v;
    }
}

export { IOManager, IO_LABELS }