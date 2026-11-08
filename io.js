//@ts-check
"use strict"
import { GameBoyCore, INTERRUPT_SOURCES } from "./cpu.js";
import { PPU } from "./ppu.js";
import { Scheduler } from "./scheduler.js";

const IO_LABELS = Object.freeze({
    JOYPAD: 0x00,

    DIV: 0x04,
    TIMA: 0x05,
    TMA: 0x06,
    TAC: 0x07,
    IF: 0x0F,

    LCDC: 0x40,
    STAT: 0x41,
    SCY: 0x42,
    SCX: 0x43,
    LY: 0x44,
    LYC: 0x45,
    OAMDMA: 0x46,
    BGP: 0x47,
    OBP0: 0x48,
    OBP1: 0x49,
    WY: 0x4A,
    WX: 0x4B,
})

const SCHEDULER_EVENTS = Object.freeze({
    DIV_INCREMENT: 0,
    TIMA_INTERRUPT: 1,

    LCD_MODE2: 2,
    LCD_MODE3: 3,
    LCD_MODE0: 4,
    LCD_VBLANK: 5,
    LCD_LY153_BUG: 6,
})

const SCANLINE_LENGTH = 456;
const OAM_SCAN_DOT_COUNT = 80;
const LINE_DOT_COUNT = 160;
const END_DELAY = 20;

const LCD_INTR_START = Object.freeze({
    MODE2: 0,
    MODE3: OAM_SCAN_DOT_COUNT,
    MODE0: OAM_SCAN_DOT_COUNT + LINE_DOT_COUNT + END_DELAY,
    NEXT_LINE: SCANLINE_LENGTH,
})

const LCD_END_TIME = Object.freeze({
    LY_153_BUG: 4,
    OAM: OAM_SCAN_DOT_COUNT,
    RENDERING: OAM_SCAN_DOT_COUNT + LINE_DOT_COUNT + END_DELAY,
    HBLANK: SCANLINE_LENGTH,
})

const modPlus = (/** @type {number} */ a, /** @type {number} */ b) => {
    let r = (a % b + b) % b;
    if (r <= 0) r += b;
    return r;
}

class IOManager {
    /**
     * @param {GameBoyCore} cpuInstance
     */
    constructor(cpuInstance) {
        this.cpu = cpuInstance;
        this.mem = cpuInstance.MMU;

        this.DIV = 0;
        this.scheduler = new Scheduler();
        this.PPU = new PPU(this);

        this.IO = this.cpu.MMU.IO;

        this.ppuEventsActive = false;

        this.OAMDMAactive = false;
        this.OAMDMAsource = 0;
        this.OAMDMAcounter = 0;
    }

    /**
     * @param {number} ticks
     */
    step(ticks) {
        const Mcycles = ticks / this.cpu.cyclesPerTick;
        this.scheduler.advance(ticks);
        this.PPU.advance(ticks);

        this.cpu.totalCycles += ticks;

        this.#updateTimer(Mcycles);
        this.tickOAMDMA(Mcycles);
        this.checkSchedulerEvents();
    }

    checkSchedulerEvents() {
        while (this.scheduler.timeUntilNext <= 0) {
            const E = this.scheduler.peekNextEvent();
            if (E === undefined) {
                break;
            }

            switch (E.event) {
                case SCHEDULER_EVENTS.TIMA_INTERRUPT: {
                    this.#rescheduleTIMAevent();

                } break;

                case SCHEDULER_EVENTS.LCD_MODE2: {
                    if (!this.ppuEventsActive) {
                        return;
                    }

                    let nextEventTime = modPlus(LCD_INTR_START.MODE2 - this.PPU.lineCycles, SCANLINE_LENGTH);
                    this.scheduler.reschedule(nextEventTime, SCHEDULER_EVENTS.LCD_MODE2);

                    if (this.PPU.LY === 153) {
                        const remainingCycles = LCD_END_TIME.LY_153_BUG - this.PPU.lineCycles;

                        this.scheduler.reschedule(remainingCycles, SCHEDULER_EVENTS.LCD_LY153_BUG);
                    }
                } break;

                case SCHEDULER_EVENTS.LCD_MODE0: {
                    if (!this.ppuEventsActive) {
                        return;
                    }

                    let nextEventTime = modPlus(LCD_INTR_START.MODE0 - this.PPU.lineCycles, SCANLINE_LENGTH);
                    this.scheduler.reschedule(nextEventTime, SCHEDULER_EVENTS.LCD_MODE0);

                } break;

                case SCHEDULER_EVENTS.LCD_LY153_BUG: {
                    if (!this.ppuEventsActive) {
                        return;
                    }

                    this.scheduler.reschedule(Infinity, SCHEDULER_EVENTS.LCD_LY153_BUG);
                } break;

                default: {
                    debugger;
                } break;
            }
        }
    }

    /**
     * @param {number} addr
     * @param {number} byte
     */
    trapIOwrite(addr, byte) {
        const ioLower = addr & 0xFF;
        const a = addr >> 8;
        if (a !== 0xFF) return;
        if (addr >= 0xFF80 && addr <= 0xFFFE) return;

        switch (ioLower) {
            case IO_LABELS.JOYPAD: {
                const buttonsSelected = (byte >> 5 & 1) !== 0;
                const dPadSelected = (byte >> 4 & 1) !== 0;

                this.JOYPAD |= 0b1111;
            } break;

            case IO_LABELS.DIV: {
                this.DIV = 0;
                this.#rescheduleTIMAevent();
            } break;

            case IO_LABELS.TIMA: {
                this.#rescheduleTIMAevent();

            } break;

            case IO_LABELS.TMA: {
                this.#rescheduleTIMAevent();

            } break;

            case IO_LABELS.TAC: {
                this.#rescheduleTIMAevent();

            } break;

            case IO_LABELS.LCDC: {
                if ((byte & 0b1000_0000) !== 0) {
                    if (!this.ppuEventsActive) {
                        this.#reenableLCD();
                    }
                } else {
                    if (this.ppuEventsActive) {
                        this.#disableLCD();
                    }
                }
            } break;

            case IO_LABELS.OAMDMA: {
                this.#initOAMDMAtransfer(byte);

            } break;
        }
    }

    #getTIMAspeed() {
        let TIMAspeed = this.TAC & 0b11;
        if (TIMAspeed == 0) TIMAspeed = 4;
        return 4 ** TIMAspeed; // 4, 16, 64, or 256 M cycles
    }

    #rescheduleTIMAevent(useEventTimestamp = false) {
        // DIV should be up to date when this is called
        const TIMAenabled = this.TAC >> 2 & 1;

        if (!TIMAenabled) {
            this.scheduler.reschedule(Infinity, SCHEDULER_EVENTS.TIMA_INTERRUPT);
            return;
        }
        let untilOverflow = 0xFF - this.TIMA;

        let TIMAspeed = this.#getTIMAspeed(); // M cycles
        let DIVclocked = TIMAspeed - (this.DIV % TIMAspeed); // time until next increment??

        let ticksUntilInterrupt = (DIVclocked + untilOverflow * TIMAspeed) * this.cpu.cyclesPerTick;

        this.scheduler.reschedule(ticksUntilInterrupt, SCHEDULER_EVENTS.TIMA_INTERRUPT, useEventTimestamp);
        //debugger
    }

    #reenableLCD() {
        this.ppuEventsActive = true;
        this.PPU.enableLCD();

        this.scheduler.reschedule(0, SCHEDULER_EVENTS.LCD_MODE2);
        this.scheduler.reschedule(0, SCHEDULER_EVENTS.LCD_MODE0);
    }

    #disableLCD() {
        this.ppuEventsActive = false;
        this.PPU.resetLCD();
    }

    /**
     * @param {number} normalizedCycles
     */
    #updateTimer(normalizedCycles) {
        let TIMAspeed = this.#getTIMAspeed();
        const TIMAenabled = this.TAC >> 2 & 1;

        for (let i = 0; i < normalizedCycles; i++) {
            this.DIV += 1;
            this.DIV %= 0x10000;

            if (TIMAenabled && this.DIV % TIMAspeed === 0) {
                let TIMAold = this.TIMA;
                this.TIMA++;

                if (TIMAold + 1 > 0xFF) {
                    this.TIMA = this.TMA;
                    this.cpu.IFreg |= 1 << INTERRUPT_SOURCES.TIMER;
                }
            }
        }
        this.IO[IO_LABELS.DIV] = this.DIV >> 6;
    }

    /**
     * @param {number} byte
     */
    #initOAMDMAtransfer(byte) {
        this.OAMDMAactive = true;
        this.OAMDMAsource = byte << 8;
        this.OAMDMAcounter = 0;

        console.log(`OAM INIT: 0x${byte.toString(16)}00`)
    }

    /**
     * @param {number} Mcycles
     */
    tickOAMDMA(Mcycles) {
        for (let i = 0; i < Mcycles; i++) {
            let b = this.cpu.MMU.loadByteDirect(this.OAMDMAsource++);
            this.cpu.MMU.OAM[this.OAMDMAcounter++] = b;

            if (this.OAMDMAcounter >= 160) {
                this.OAMDMAactive = false;
                break;
            }
        }
    }

    get JOYPAD() {
        return this.IO[IO_LABELS.JOYPAD];
    }
    set JOYPAD(v) {
        this.IO[IO_LABELS.JOYPAD] = v;
    }

    get TIMA() {
        return this.IO[IO_LABELS.TIMA];
    }
    set TIMA(v) {
        this.IO[IO_LABELS.TIMA] = v;
    }

    get TMA() {
        return this.IO[IO_LABELS.TMA];
    }
    set TMA(v) {
        this.IO[IO_LABELS.TMA] = v;
    }

    get TAC() {
        return this.IO[IO_LABELS.TAC];
    }
    set TAC(v) {
        this.IO[IO_LABELS.TAC] = v;
    }
}

export { IOManager, IO_LABELS, SCHEDULER_EVENTS, LCD_INTR_START as LCD_START_TIME, LCD_END_TIME, SCANLINE_LENGTH }