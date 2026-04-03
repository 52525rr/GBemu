//@ts-check
/**
 * @typedef {"Z" | "N" | "H" | "C"} FLAG
 * @typedef {"BC" | "DE" | "HL" | "AF" | "SP" | "PC"} REG16
 */
"use strict"

import { GameBoyVideoCanvas } from "./framebufferReader.js";
import { IO_LABELS, IOManager } from "./io.js";
import { Memory } from "./mmu.js";
import { ctz32, sleep } from "./util.js";

const REGS = Object.freeze({
    B: 0,
    C: 1,
    D: 2,
    E: 3,
    H: 4,
    L: 5,
    A: 6,
    F: 7,

    HL_DEREF: -1
})

const FLAG_SHIFTS = Object.freeze({
    Z: 7,
    N: 6,
    H: 5,
    C: 4,
})

const INTERRUPT_SOURCES = Object.freeze({
    VBLANK: 0,
    STAT: 1,
    TIMER: 2,
    SERIAL: 3,
    JOYPAD: 4,
})

const CYCLES_PER_FRAME = 1e6;

const asUint16 = (/** @type {number} */ n) => n & 0xFFFF;
const asInt8   = (/** @type {number} */ n) => (n << 24) >> 24;

class GameBoyCore {
    /**
     * @param {Uint8Array} romData
     */
    constructor(romData) {
        this.regs = new Uint8Array(8);
        this.PC = 0;
        this.SP = 0;
        this.MMU = new Memory(this, romData);
        this.IOhandler = new IOManager(this);
        this.halted = false;

        this.flags = {
            Z: 0,
            N: 0,
            H: 0,
            C: 0,
        }

        this.AF = 0x0100;
        this.BC = 0xFF13;
        this.DE = 0x00C1;
        this.HL = 0x8403;

        // used for lazy stepping
        this.bufferedCycles = 0;
        this.opJumpTable = this.#createFunctionArray();
        this.interruptFlag = 0;

        this.cpuSpeed = 1;
        this.cyclesPerTick = 4;

        this.frameCycles = 0;
        this.#initIOregs();
    }

    get BC() {
        return this.regs[REGS.B] << 8 | this.regs[REGS.C];
    }
    get DE() {
        return this.regs[REGS.D] << 8 | this.regs[REGS.E];
    }
    get HL() {
        return this.regs[REGS.H] << 8 | this.regs[REGS.L];
    }
    get AF() {
        this.repackFlags();
        return this.regs[REGS.A] << 8 | this.regs[REGS.F];
    }

    set BC(v) {
        this.regs[REGS.B] = v >>> 8 & 0xFF;
        this.regs[REGS.C] = v >>> 0 & 0xFF;
    }
    set DE(v) {
        this.regs[REGS.D] = v >>> 8 & 0xFF;
        this.regs[REGS.E] = v >>> 0 & 0xFF;
    }
    set HL(v) {
        this.regs[REGS.H] = v >>> 8 & 0xFF;
        this.regs[REGS.L] = v >>> 0 & 0xFF;
    }
    set AF(v) {
        this.regs[REGS.A] = v >>> 8 & 0xFF;
        this.regs[REGS.F] = v >>> 0 & 0xF0;
        this.unpackFlags();
    }

    get HL_DEREF() {
        return this.MMU.loadByteMMU(this.HL);
    }
    set HL_DEREF(v) {
        this.MMU.storeByteMMU(this.HL, v);
    }
    get A() {
        return this.regs[REGS.A];
    }
    set A(v) {
        this.regs[REGS.A] = v;
    }

    get IEreg(){
        return this.MMU.HRAM[0x7F];
    }
    get IFreg(){
        return this.MMU.IO[0x0F];
    }
    set IFreg(v){
        this.MMU.IO[0x0F] = v;
    }

    #initIOregs(){
        this.MMU.writeIOreg(IO_LABELS.BGP,  0b11100100);
        this.MMU.writeIOreg(IO_LABELS.LCDC, 0b10010001);
    }

    resetCPU() {
        this.bufferedCycles = 0;
        this.PC = 0x100; // bootrom skip

        for (let i = 0; i < this.regs.length; i++) {
            this.regs[i] = 0;
        }
    }

    unpackFlags() {
        const flags = this.flags;
        const regF = this.regs[REGS.F];
        flags.Z = regF >> FLAG_SHIFTS.Z & 1;
        flags.N = regF >> FLAG_SHIFTS.N & 1;
        flags.H = regF >> FLAG_SHIFTS.H & 1;
        flags.C = regF >> FLAG_SHIFTS.C & 1;
    }

    repackFlags() {
        const flags = this.flags;
        this.regs[REGS.F] = (
            flags.Z << FLAG_SHIFTS.Z |
            flags.N << FLAG_SHIFTS.N |
            flags.H << FLAG_SHIFTS.H |
            flags.C << FLAG_SHIFTS.C
        );
    }

    #readAndIncrPC() {
        const memVal = this.MMU.loadByteMMU(this.PC);
        this.PC = (this.PC + 1) & 0xFFFF;

        return memVal;
    }

    #loadU8fromPC() {
        const a = this.#readAndIncrPC();
        return a;
    }

    #loadI8fromPC() {
        const a = this.#readAndIncrPC();
        return asInt8(a);
    }

    #loadU16fromPC() {
        const low = this.#readAndIncrPC();
        const high = this.#readAndIncrPC();
        return high << 8 | low;
    }

    /**
     * @param {number} targetAddress
     */
    #executeInterrupt(targetAddress){
        this.incrCycleCounter(2);

        let r = this.PC;
        this.SP = asUint16(this.SP - 1);
        this.MMU.storeByteMMU(this.SP, r >>> 8 & 0xFF);
        this.SP = asUint16(this.SP - 1);
        this.MMU.storeByteMMU(this.SP, r >>> 0 & 0xFF);
        this.PC = targetAddress;
        this.incrCycleCounter(1);
    }

    runAllCachedCycles(){
        this.IOhandler.step(this.bufferedCycles);
        this.bufferedCycles = 0;
    }

    checkForInterrupts(){
        return this.interruptFlag == 1 && (this.IEreg & this.IFreg) !== 0;
    }

    incrCycleCounter(amount = 1){
        this.incrCycleCounterByTicks(amount * this.cyclesPerTick);
    }

    /**
     * @param {number} amount
     */
    incrCycleCounterByTicks(amount){
        this.bufferedCycles += amount;
        this.frameCycles += amount;
    }

    stepSingle() {
        if(this.halted){
            this.haltSkip();
            return;
        }

        if(this.pollScheduler() || this.bufferedCycles >= 10000){
            this.runAllCachedCycles();
        }

        if(this.checkForInterrupts()){
            let interruptTester = this.IEreg & this.IFreg;
            let lowestInterruptBit = ctz32(interruptTester);
            if(lowestInterruptBit > 4) return;

            let interruptTargetAddress = 0x40 + (lowestInterruptBit * 8);
            this.#executeInterrupt(interruptTargetAddress);

            this.interruptFlag = 0;
            this.IFreg &= ~(1 << lowestInterruptBit);
        }

        const opcode = this.#readAndIncrPC();
        const f = this.opJumpTable[opcode];
        if (f == null) {
            //debugger;
            return;
        }
        f();
    }

    pollScheduler(){
        return this.IOhandler.scheduler.timeUntilNext - this.bufferedCycles <= 0;
    }

    haltSkip(){
        this.runAllCachedCycles();

        let skippedCycles = 0;
        while(skippedCycles < 70000){
            if((this.IEreg & this.IFreg) !== 0){
                this.halted = false;
                break;
            }
            const timeUntilNext = this.IOhandler.scheduler.timeUntilNext;
            if(timeUntilNext == Infinity){
                throw new Error("Halted with no scheduler events; Infinite halt");
            }

            skippedCycles += timeUntilNext;
            this.incrCycleCounterByTicks(timeUntilNext);

            this.runAllCachedCycles();
        }
    }

    #createFunctionArray() {
        const getRegFromIndex =
            (/** @type {number} */ index) => {
                switch (index) {
                    case 0: return this.regs[REGS.B];
                    case 1: return this.regs[REGS.C];
                    case 2: return this.regs[REGS.D];
                    case 3: return this.regs[REGS.E];
                    case 4: return this.regs[REGS.H];
                    case 5: return this.regs[REGS.L];
                    case 6: return this.HL_DEREF;
                    case 7: return this.regs[REGS.A];
                    default: throw new Error("unreachable!");
                }
            }

        const setRegFromIndex =
            (/** @type {number} */ index, /** @type {any} */ val) => {
                switch (index) {
                    case 0: this.regs[REGS.B] = val; break;
                    case 1: this.regs[REGS.C] = val; break;
                    case 2: this.regs[REGS.D] = val; break;
                    case 3: this.regs[REGS.E] = val; break;
                    case 4: this.regs[REGS.H] = val; break;
                    case 5: this.regs[REGS.L] = val; break;
                    case 6: this.HL_DEREF = val; break;
                    case 7: this.regs[REGS.A] = val; break;
                    default: throw new Error("unreachable!");
                }
            }

        const getReg = (/** @type {number} */ label) => {
            return label === REGS.HL_DEREF ? this.HL_DEREF : this.regs[label];
        }
        const setReg = (/** @type {number} */ label, /** @type {number} */ value) => {
            label === REGS.HL_DEREF ? (this.HL_DEREF = value) : (this.regs[label] = value);
        }

        const JUMP =
            (/** @type {boolean} */ unconditional, /** @type {FLAG} */ flag, /** @type {0 | 1} */ expectedValue) => {

                return () => {
                    const jumpAddr = this.#loadU16fromPC();
                    if (unconditional || this.flags[flag] === expectedValue) {
                        this.PC = jumpAddr;
                        this.incrCycleCounter(1);
                    }
                }
            }

        const PUSH_R16 = (/** @type {REG16} */ t, includeInternal = false) => {
            this.incrCycleCounter(1);

            const r = this[t];
            this.SP = asUint16(this.SP - 1);
            this.MMU.storeByteMMU(this.SP, r >>> 8 & 0xFF);
            this.SP = asUint16(this.SP - 1);
            this.MMU.storeByteMMU(this.SP, r >>> 0 & 0xFF);
        }

        const POP_R16 = (/** @type {REG16} */ t) => {
            let val = 0;

            val |= this.MMU.loadByteMMU(this.SP) << 0;
            this.SP = asUint16(this.SP + 1);
            val |= this.MMU.loadByteMMU(this.SP) << 8;
            this.SP = asUint16(this.SP + 1);

            this[t] = val;
        }

        const CALL =
            (/** @type {boolean} */ unconditional, /** @type {FLAG} */ flag, /** @type {0 | 1} */ expectedValue) => {
                return () => {
                    const jumpAddr = this.#loadU16fromPC();
                    if (unconditional || this.flags[flag] === expectedValue) {
                        PUSH_R16("PC");
                        this.PC = jumpAddr;
                    }
                }
            }

        const RET =
            (/** @type {boolean} */ unconditional, /** @type {FLAG} */ flag, /** @type {0 | 1} */ expectedValue) => {
                return () => {
                    this.incrCycleCounter(unconditional ? 0 : 1);
                    if (unconditional || this.flags[flag] === expectedValue) {
                        POP_R16("PC");
                        this.incrCycleCounter(1);
                    }
                }
            }

        const RETI = () => {
            POP_R16("PC");
            this.incrCycleCounter(1);
            this.interruptFlag = 1;
        }
        

        const JUMP_RELATIVE =
            (/** @type {boolean} */ unconditional, /** @type {FLAG} */ flag, /** @type {0 | 1} */ expectedValue) => {
                return () => {
                    const jumpAddr = this.#loadI8fromPC();
                    if (unconditional || this.flags[flag] === expectedValue) {
                        this.PC = asUint16(this.PC + jumpAddr);
                        this.incrCycleCounter();
                    }
                }
            }

        const LOAD_REG_IMM8 =
            (/** @type {number} */ regIndex) => {
                return () => {
                    const imm8 = this.#loadU8fromPC();
                    setReg(regIndex, imm8);
                }
            }

        const STORE_ZPAGE_IMM8 = () => {
            const addr = 0xFF00 | this.#loadU8fromPC();
            this.MMU.storeByteMMU(addr, this.A);
        }
        const LOAD_ZPAGE_IMM8 = () => {
            const addr = 0xFF00 | this.#loadU8fromPC();
            this.A = this.MMU.loadByteMMU(addr);
        }

        const STORE_ZPAGE_C = () => {
            const addr = 0xFF00 | this.regs[REGS.C];
            this.MMU.storeByteMMU(addr, this.A);
        }
        const LOAD_ZPAGE_C = () => {
            const addr = 0xFF00 | this.regs[REGS.C];
            this.A = this.MMU.loadByteMMU(addr);
        }

        const LOAD_R16_U16 =
            (/** @type {REG16} */ t) => {
                return () => {
                    const imm16 = this.#loadU16fromPC();
                    this[t] = imm16;
                }
            }

        const CB_PREFIXED = () => {
            const opcode1 = this.#loadU8fromPC();
            const regIndex = opcode1 & 7;
            let val = getRegFromIndex(regIndex);
            const flags = this.flags;
            if(opcode1 < 0x40){
                switch(opcode1 >> 3){
                    case 0:{
                        flags.C = val >> 7 & 1;
                        val = ((val << 1) | (val >> 7 & 1));
                    } break;

                    case 1:{
                        flags.C = val & 1;
                        val = ((val >> 1) | ((val & 1) << 7));
                    } break;

                    case 2:{
                        const cy = flags.C
                        flags.C = val >> 7 & 1;
                        val = ((val << 1) | cy);
                    } break;

                    case 3:{
                        const cy = flags.C;
                        flags.C = val & 1;
                        val = ((val >> 1) | (cy << 7));
                    } break;

                    case 4:{
                        flags.C = val >> 7 & 1;
                        val = (val << 1);
                    } break;

                    case 5:{
                        flags.C = val & 1;
                        val = asInt8(val);
                        val = (val >> 1);
                    } break;

                    case 6:{
                        val = (val >> 4 & 0xF) | ((val >> 0 & 0xF) << 4);
                        flags.C = 0;
                    } break;

                    case 7:{
                        flags.C = val & 1;
                        val >>= 1;
                    } break;

                    default:{
                        throw new Error("unreachable!");
                    }
                }
                val &= 0xFF;
                flags.N = 0;
                flags.H = 0;
                flags.Z = +(val === 0);
            } else if (opcode1 >= 0x40 && opcode1 <= 0x7F) {
                const bitIndex = opcode1 >> 3 & 7;
                flags.Z = +((val >> bitIndex & 1) === 0);
                flags.N = 0;
                flags.H = 1;
                return;
            } else {
                const bitIndex = opcode1 >> 3 & 7;
                const shiftMask = 1 << bitIndex;
                if(opcode1 >= 0x80 && opcode1 <= 0xBF){
                    val &= ~shiftMask;
                }else{
                    val |=  shiftMask;
                }
            }
            setRegFromIndex(regIndex, val & 0xFF);
        }

        const LOAD_A_R15_DEREF = (/** @type {REG16} */t) => {
            return () => {
                this.A = this.MMU.loadByteMMU(this[t]);
            }
        }
        const STORE_A_R15_DEREF = (/** @type {REG16} */t) => {
            return () => {
                this.MMU.storeByteMMU(this[t], this.A);
            }
        }

        const LOAD_A_IMM16_DEREF = () => {
            const addr = this.#loadU16fromPC();
            this.A = this.MMU.loadByteMMU(addr);
        }
        const STORE_A_IMM16_DEREF = () => {
            const addr = this.#loadU16fromPC();
            this.MMU.storeByteMMU(addr, this.A);
        }

        const ADDTO_R16 = ( /** @type {REG16} */ t, /** @type {number} */ amount) => {
            return () => {
                this[t] = asUint16(this[t] + amount);
                this.incrCycleCounter();
            }
        }

        const LOAD_A_ADDTO_HL_DEREF =
            (/** @type {number} */ amount) => {
                return () => {
                    this.A = this.MMU.loadByteMMU(this.HL);
                    this.HL = asUint16(this.HL + amount);
                }
            }
        const STORE_A_ADDTO_HL_DEREF =
            (/** @type {number} */ amount) => {
                return () => {
                    this.MMU.storeByteMMU(this.HL, this.A);
                    this.HL = asUint16(this.HL + amount);
                }
            }


        const ADD_HL_REG16 = (/** @type {REG16} */ t) => {
            return () => {
                const flags = this.flags;
                const B = this[t];
                const R = this.HL + B;
                const Htest = ((this.HL & 0xFFF) + (B & 0xFFF)) & 0xFFFF;
                flags.N = 0;
                flags.H = +(Htest > 0xFFF);
                flags.C = +(R > 0xFFFF);
                this.HL = asUint16(R);
                this.incrCycleCounter();
            }
        }
        const ADDTO_REG = (/** @type {number} */ regIndex, /** @type {number} */ B) => {
            return () => {
                const flags = this.flags;
                const A = getReg(regIndex);
                const R = A + B;
                flags.Z = +((R & 0xFF) === 0);
                flags.N = B < 0 ? 1 : 0;
                const Htest = ((A & 0xF) + (B % 0x10)) & 0xFF;
                flags.H = +(Htest > 0xF);
                setReg(regIndex, R & 0xFF);
            }
        }

        const ALU_ADD = (/** @type {number} */ regIndex, /** @type {boolean} */ includeCarry, useImmediate = false) => {
            return () => {
                const flags = this.flags;
                const A = this.A;
                const B = useImmediate ? this.#loadU8fromPC() : getReg(regIndex);
                const carry = includeCarry ? flags.C : 0;

                const R = A + B + carry;
                const halfTester = ((A & 0xF) + (B & 0xF) + carry) & 0xFF;

                flags.Z = +((R & 0xFF) === 0);
                flags.N = 0;
                flags.H = +(halfTester > 0xF);
                flags.C = +(R > 0xFF);

                this.A = R & 0xFF;
            }
        }

        const ALU_SUB = (/** @type {number} */ regIndex, /** @type {boolean} */ includeCarry, useImmediate = false, storeResult = true) => {
            return () => {
                const flags = this.flags;
                const A = this.A;
                const B = useImmediate ? this.#loadU8fromPC() : getReg(regIndex);
                const carry = includeCarry ? flags.C : 0;

                const R = A - B - carry;
                const halfTester = ((A & 0xF) - (B & 0xF) - carry) & 0xFF;

                flags.Z = +((R & 0xFF) === 0);
                flags.N = 1;
                flags.H = +(halfTester > 0xF);
                flags.C = +(R < 0);

                if (storeResult) {
                    this.A = R & 0xFF;
                }
            }
        }

        const ALU_AND = (/** @type {number} */ regIndex, useImmediate = false) => {
            return () => {
                const flags = this.flags;
                const A = this.A;
                const B = useImmediate ? this.#loadU8fromPC() : getReg(regIndex);

                const R = A & B;
                flags.Z = +(R === 0);
                flags.N = 0;
                flags.H = 1;
                flags.C = 0;
                this.A = R;
            }
        }

        const ALU_OR = (/** @type {number} */ regIndex, useImmediate = false) => {
            return () => {
                const flags = this.flags;
                const A = this.A;
                const B = useImmediate ? this.#loadU8fromPC() : getReg(regIndex);

                const R = A | B;
                flags.Z = +(R === 0);
                flags.N = 0;
                flags.H = 0;
                flags.C = 0;
                this.A = R;
            }
        }

        const ALU_XOR = (/** @type {number} */ regIndex, useImmediate = false) => {
            return () => {
                const flags = this.flags;
                const A = this.A;
                const B = useImmediate ? this.#loadU8fromPC() : getReg(regIndex);

                const R = A ^ B;
                flags.Z = +(R === 0);
                flags.N = 0;
                flags.H = 0;
                flags.C = 0;
                this.A = R;
            }
        }

        const LOAD_REG_REG =
            (/** @type {number} */ regDest, /** @type {number} */ regSource) => {
                return () => {
                    const m = getReg(regSource);
                    setReg(regDest, m);
                }
            }

        const SET_INTR_FLAG = (/** @type {number} */ val) => {
            return () => this.interruptFlag = val;
        }

        const LOAD_R16_DEREF_SP = () => {
            const addr = this.#loadU16fromPC();
            this.MMU.storeByteMMU(asUint16(addr + 0), this.SP >> 0 & 0xFF);
            this.MMU.storeByteMMU(asUint16(addr + 1), this.SP >> 8 & 0xFF);
        }

        const RLA = () => {
            const flags = this.flags;
            const CY = flags.C;
            let val = this.A
            this.A = ((val << 1) | CY) & 0xFF;
            flags.Z = 0;
            flags.N = 0;
            flags.H = 0;
            flags.C = val >> 7 & 1;
        }
        const RRA = () => {
            const flags = this.flags;
            const CY = flags.C;
            let val = this.A
            this.A = (val >> 1) | (CY << 7);
            flags.Z = 0;
            flags.N = 0;
            flags.H = 0;
            flags.C = val & 1;
        }
        const RLCA = () => {
            const flags = this.flags;
            let val = this.A
            this.A = ((val << 1) | (val >> 7 & 1)) & 0xFF;
            flags.Z = 0;
            flags.N = 0;
            flags.H = 0;
            flags.C = val >> 7 & 1;
        }
        const RRCA = () => {
            const flags = this.flags;
            let val = this.A
            this.A = (val >> 1) | ((val & 1) << 7);
            flags.Z = 0;
            flags.N = 0;
            flags.H = 0;
            flags.C = val & 1;
        }
        

        const JUMP_HL = () => {
            this.PC = this.HL;
        }

        const CPL = () => {
            this.A = (~this.A) & 0xFF;
            this.flags.N = 1;
            this.flags.H = 1;
        }

        const SCF = () => {
            this.flags.C = 1;
            this.flags.N = 0;
            this.flags.H = 0;
        }            
        const CCF = () => {
            this.flags.C = 1 - this.flags.C;
            this.flags.N = 0;
            this.flags.H = 0;
        }

        const DAA = () => {
            let A = this.A;
            const flags = this.flags;
            if(flags.N) {
                A -= (0x60*flags.C) + (0x06*flags.H);
            } else {
                if(flags.C || A > 0x99){
                    flags.C = 1;
                    A += 0x60;
                }
                A += 0x06 * +(flags.H || (A & 0xF) > 0x09);
            }
            A &= 0xFF;
            this.A = A;
            flags.Z = +(A === 0);
            flags.H = 0;
        }

        const LOAD_SP_HL = () => {
            this.SP = this.HL;
            this.incrCycleCounter();
        }

        const RST = (/** @type {number} */ addr) => {
            PUSH_R16("PC");
            this.PC = addr;
        }

        const ADD_R16_SP_I8 = (/** @type {REG16} */ t, extraCycles = 0) => {
            const flags = this.flags;
            const A = this.SP;
            const B = this.#loadI8fromPC();
            const R = A + B;
            const Htest = ((A & 0x0F) + (B & 0x0F)) & 0xFFFF;
            const Ctest = ((A & 0xFF) + (B & 0xFF)) & 0xFFFF;

            flags.N = 0;
            flags.H = +(Htest > 0xF);
            flags.C = +(Ctest > 0xFF);
            flags.Z = 0;
            this[t] = asUint16(R);
            this.incrCycleCounter(extraCycles);
        }

        const HALT = () => {
            this.halted = true;
        }

        /**
         * @type {Array<Function | null>}
         */
        const v = new Array(256).fill(null); // function jump table

        v[0xC3] = JUMP(true, "Z", 0);
        v[0xC2] = JUMP(false, "Z", 0);
        v[0xCA] = JUMP(false, "Z", 1);
        v[0xD2] = JUMP(false, "C", 0);
        v[0xDA] = JUMP(false, "C", 1);

        v[0x18] = JUMP_RELATIVE(true, "Z", 0);
        v[0x20] = JUMP_RELATIVE(false, "Z", 0);
        v[0x28] = JUMP_RELATIVE(false, "Z", 1);
        v[0x30] = JUMP_RELATIVE(false, "C", 0);
        v[0x38] = JUMP_RELATIVE(false, "C", 1);

        v[0xC4] = CALL(false, "Z", 0);
        v[0xCC] = CALL(false, "Z", 1);
        v[0xD4] = CALL(false, "C", 0);
        v[0xDC] = CALL(false, "C", 1);
        v[0xCD] = CALL(true, "Z", 0);

        v[0xC0] = RET(false, "Z", 0);
        v[0xC8] = RET(false, "Z", 1);
        v[0xD0] = RET(false, "C", 0);
        v[0xD8] = RET(false, "C", 1);
        v[0xC9] = RET(true, "Z", 0);

        v[0x06] = LOAD_REG_IMM8(REGS.B);
        v[0x0E] = LOAD_REG_IMM8(REGS.C);
        v[0x16] = LOAD_REG_IMM8(REGS.D);
        v[0x1E] = LOAD_REG_IMM8(REGS.E);
        v[0x26] = LOAD_REG_IMM8(REGS.H);
        v[0x2E] = LOAD_REG_IMM8(REGS.L);
        v[0x36] = LOAD_REG_IMM8(REGS.HL_DEREF);
        v[0x3E] = LOAD_REG_IMM8(REGS.A);

        v[0xE0] = STORE_ZPAGE_IMM8;
        v[0xF0] = LOAD_ZPAGE_IMM8;
        v[0xE2] = STORE_ZPAGE_C;
        v[0xF2] = LOAD_ZPAGE_C;

        v[0x01] = LOAD_R16_U16("BC");
        v[0x11] = LOAD_R16_U16("DE");
        v[0x21] = LOAD_R16_U16("HL");
        v[0x31] = LOAD_R16_U16("SP");

        v[0xCB] = CB_PREFIXED;

        v[0x02] = STORE_A_R15_DEREF('BC');
        v[0x0A] = LOAD_A_R15_DEREF('BC');
        v[0x12] = STORE_A_R15_DEREF('DE');
        v[0x1A] = LOAD_A_R15_DEREF('DE');

        v[0x03] = ADDTO_R16("BC", 1);
        v[0x0B] = ADDTO_R16("BC", -1);
        v[0x13] = ADDTO_R16("DE", 1);
        v[0x1B] = ADDTO_R16("DE", -1);
        v[0x23] = ADDTO_R16("HL", 1);
        v[0x2B] = ADDTO_R16("HL", -1);
        v[0x33] = ADDTO_R16("SP", 1);
        v[0x3B] = ADDTO_R16("SP", -1);

        v[0x22] = STORE_A_ADDTO_HL_DEREF(1);
        v[0x2A] = LOAD_A_ADDTO_HL_DEREF(1);
        v[0x32] = STORE_A_ADDTO_HL_DEREF(-1);
        v[0x3A] = LOAD_A_ADDTO_HL_DEREF(-1);

        v[0x04] = ADDTO_REG(REGS.B, 1);
        v[0x0C] = ADDTO_REG(REGS.C, 1);
        v[0x14] = ADDTO_REG(REGS.D, 1);
        v[0x1C] = ADDTO_REG(REGS.E, 1);
        v[0x24] = ADDTO_REG(REGS.H, 1);
        v[0x2C] = ADDTO_REG(REGS.L, 1);
        v[0x34] = ADDTO_REG(REGS.HL_DEREF, 1);
        v[0x3C] = ADDTO_REG(REGS.A, 1);

        v[0x05] = ADDTO_REG(REGS.B, -1);
        v[0x0D] = ADDTO_REG(REGS.C, -1);
        v[0x15] = ADDTO_REG(REGS.D, -1);
        v[0x1D] = ADDTO_REG(REGS.E, -1);
        v[0x25] = ADDTO_REG(REGS.H, -1);
        v[0x2D] = ADDTO_REG(REGS.L, -1);
        v[0x35] = ADDTO_REG(REGS.HL_DEREF, -1);
        v[0x3D] = ADDTO_REG(REGS.A, -1);

        v[0x40] = LOAD_REG_REG(REGS.B, REGS.B);
        v[0x41] = LOAD_REG_REG(REGS.B, REGS.C);
        v[0x42] = LOAD_REG_REG(REGS.B, REGS.D);
        v[0x43] = LOAD_REG_REG(REGS.B, REGS.E);
        v[0x44] = LOAD_REG_REG(REGS.B, REGS.H);
        v[0x45] = LOAD_REG_REG(REGS.B, REGS.L);
        v[0x46] = LOAD_REG_REG(REGS.B, REGS.HL_DEREF);
        v[0x47] = LOAD_REG_REG(REGS.B, REGS.A);
        v[0x48] = LOAD_REG_REG(REGS.C, REGS.B);
        v[0x49] = LOAD_REG_REG(REGS.C, REGS.C);
        v[0x4A] = LOAD_REG_REG(REGS.C, REGS.D);
        v[0x4B] = LOAD_REG_REG(REGS.C, REGS.E);
        v[0x4C] = LOAD_REG_REG(REGS.C, REGS.H);
        v[0x4D] = LOAD_REG_REG(REGS.C, REGS.L);
        v[0x4E] = LOAD_REG_REG(REGS.C, REGS.HL_DEREF);
        v[0x4F] = LOAD_REG_REG(REGS.C, REGS.A);

        v[0x50] = LOAD_REG_REG(REGS.D, REGS.B);
        v[0x51] = LOAD_REG_REG(REGS.D, REGS.C);
        v[0x52] = LOAD_REG_REG(REGS.D, REGS.D);
        v[0x53] = LOAD_REG_REG(REGS.D, REGS.E);
        v[0x54] = LOAD_REG_REG(REGS.D, REGS.H);
        v[0x55] = LOAD_REG_REG(REGS.D, REGS.L);
        v[0x56] = LOAD_REG_REG(REGS.D, REGS.HL_DEREF);
        v[0x57] = LOAD_REG_REG(REGS.D, REGS.A);
        v[0x58] = LOAD_REG_REG(REGS.E, REGS.B);
        v[0x59] = LOAD_REG_REG(REGS.E, REGS.C);
        v[0x5A] = LOAD_REG_REG(REGS.E, REGS.D);
        v[0x5B] = LOAD_REG_REG(REGS.E, REGS.E);
        v[0x5C] = LOAD_REG_REG(REGS.E, REGS.H);
        v[0x5D] = LOAD_REG_REG(REGS.E, REGS.L);
        v[0x5E] = LOAD_REG_REG(REGS.E, REGS.HL_DEREF);
        v[0x5F] = LOAD_REG_REG(REGS.E, REGS.A);

        v[0x60] = LOAD_REG_REG(REGS.H, REGS.B);
        v[0x61] = LOAD_REG_REG(REGS.H, REGS.C);
        v[0x62] = LOAD_REG_REG(REGS.H, REGS.D);
        v[0x63] = LOAD_REG_REG(REGS.H, REGS.E);
        v[0x64] = LOAD_REG_REG(REGS.H, REGS.H);
        v[0x65] = LOAD_REG_REG(REGS.H, REGS.L);
        v[0x66] = LOAD_REG_REG(REGS.H, REGS.HL_DEREF);
        v[0x67] = LOAD_REG_REG(REGS.H, REGS.A);
        v[0x68] = LOAD_REG_REG(REGS.L, REGS.B);
        v[0x69] = LOAD_REG_REG(REGS.L, REGS.C);
        v[0x6A] = LOAD_REG_REG(REGS.L, REGS.D);
        v[0x6B] = LOAD_REG_REG(REGS.L, REGS.E);
        v[0x6C] = LOAD_REG_REG(REGS.L, REGS.H);
        v[0x6D] = LOAD_REG_REG(REGS.L, REGS.L);
        v[0x6E] = LOAD_REG_REG(REGS.L, REGS.HL_DEREF);
        v[0x6F] = LOAD_REG_REG(REGS.L, REGS.A);

        v[0x70] = LOAD_REG_REG(REGS.HL_DEREF, REGS.B);
        v[0x71] = LOAD_REG_REG(REGS.HL_DEREF, REGS.C);
        v[0x72] = LOAD_REG_REG(REGS.HL_DEREF, REGS.D);
        v[0x73] = LOAD_REG_REG(REGS.HL_DEREF, REGS.E);
        v[0x74] = LOAD_REG_REG(REGS.HL_DEREF, REGS.H);
        v[0x75] = LOAD_REG_REG(REGS.HL_DEREF, REGS.L);
        // skipped bc HALT instruction
        v[0x77] = LOAD_REG_REG(REGS.HL_DEREF, REGS.A);
        v[0x78] = LOAD_REG_REG(REGS.A, REGS.B);
        v[0x79] = LOAD_REG_REG(REGS.A, REGS.C);
        v[0x7A] = LOAD_REG_REG(REGS.A, REGS.D);
        v[0x7B] = LOAD_REG_REG(REGS.A, REGS.E);
        v[0x7C] = LOAD_REG_REG(REGS.A, REGS.H);
        v[0x7D] = LOAD_REG_REG(REGS.A, REGS.L);
        v[0x7E] = LOAD_REG_REG(REGS.A, REGS.HL_DEREF);
        v[0x7F] = LOAD_REG_REG(REGS.A, REGS.A);

        // ADD and ADC
        v[0x80] = ALU_ADD(REGS.B, false);
        v[0x81] = ALU_ADD(REGS.C, false);
        v[0x82] = ALU_ADD(REGS.D, false);
        v[0x83] = ALU_ADD(REGS.E, false);
        v[0x84] = ALU_ADD(REGS.H, false);
        v[0x85] = ALU_ADD(REGS.L, false);
        v[0x86] = ALU_ADD(REGS.HL_DEREF, false);
        v[0x87] = ALU_ADD(REGS.A, false);

        v[0x88] = ALU_ADD(REGS.B, true);
        v[0x89] = ALU_ADD(REGS.C, true);
        v[0x8A] = ALU_ADD(REGS.D, true);
        v[0x8B] = ALU_ADD(REGS.E, true);
        v[0x8C] = ALU_ADD(REGS.H, true);
        v[0x8D] = ALU_ADD(REGS.L, true);
        v[0x8E] = ALU_ADD(REGS.HL_DEREF, true);
        v[0x8F] = ALU_ADD(REGS.A, true);

        // SUB and SBC
        v[0x90] = ALU_SUB(REGS.B, false);
        v[0x91] = ALU_SUB(REGS.C, false);
        v[0x92] = ALU_SUB(REGS.D, false);
        v[0x93] = ALU_SUB(REGS.E, false);
        v[0x94] = ALU_SUB(REGS.H, false);
        v[0x95] = ALU_SUB(REGS.L, false);
        v[0x96] = ALU_SUB(REGS.HL_DEREF, false);
        v[0x97] = ALU_SUB(REGS.A, false);

        v[0x98] = ALU_SUB(REGS.B, true);
        v[0x99] = ALU_SUB(REGS.C, true);
        v[0x9A] = ALU_SUB(REGS.D, true);
        v[0x9B] = ALU_SUB(REGS.E, true);
        v[0x9C] = ALU_SUB(REGS.H, true);
        v[0x9D] = ALU_SUB(REGS.L, true);
        v[0x9E] = ALU_SUB(REGS.HL_DEREF, true);
        v[0x9F] = ALU_SUB(REGS.A, true);

        // AND and XOR
        v[0xA0] = ALU_AND(REGS.B);
        v[0xA1] = ALU_AND(REGS.C);
        v[0xA2] = ALU_AND(REGS.D);
        v[0xA3] = ALU_AND(REGS.E);
        v[0xA4] = ALU_AND(REGS.H);
        v[0xA5] = ALU_AND(REGS.L);
        v[0xA6] = ALU_AND(REGS.HL_DEREF);
        v[0xA7] = ALU_AND(REGS.A);

        v[0xA8] = ALU_XOR(REGS.B);
        v[0xA9] = ALU_XOR(REGS.C);
        v[0xAA] = ALU_XOR(REGS.D);
        v[0xAB] = ALU_XOR(REGS.E);
        v[0xAC] = ALU_XOR(REGS.H);
        v[0xAD] = ALU_XOR(REGS.L);
        v[0xAE] = ALU_XOR(REGS.HL_DEREF);
        v[0xAF] = ALU_XOR(REGS.A);

        // OR and CMP
        v[0xB0] = ALU_OR(REGS.B);
        v[0xB1] = ALU_OR(REGS.C);
        v[0xB2] = ALU_OR(REGS.D);
        v[0xB3] = ALU_OR(REGS.E);
        v[0xB4] = ALU_OR(REGS.H);
        v[0xB5] = ALU_OR(REGS.L);
        v[0xB6] = ALU_OR(REGS.HL_DEREF);
        v[0xB7] = ALU_OR(REGS.A);
        v[0xB8] = ALU_SUB(REGS.B, false, false, false);
        v[0xB9] = ALU_SUB(REGS.C, false, false, false);
        v[0xBA] = ALU_SUB(REGS.D, false, false, false);
        v[0xBB] = ALU_SUB(REGS.E, false, false, false);
        v[0xBC] = ALU_SUB(REGS.H, false, false, false);
        v[0xBD] = ALU_SUB(REGS.L, false, false, false);
        v[0xBE] = ALU_SUB(REGS.HL_DEREF, false, false, false);
        v[0xBF] = ALU_SUB(REGS.A, false, false, false);

        v[0xC6] = ALU_ADD(NaN, false, true);
        v[0xCE] = ALU_ADD(NaN, true, true);
        v[0xD6] = ALU_SUB(NaN, false, true);
        v[0xDE] = ALU_SUB(NaN, true, true);
        v[0xE6] = ALU_AND(NaN, true);
        v[0xEE] = ALU_XOR(NaN, true);
        v[0xF6] = ALU_OR(NaN, true);
        v[0xFE] = ALU_SUB(NaN, false, true, false);

        v[0x09] = ADD_HL_REG16("BC");
        v[0x19] = ADD_HL_REG16("DE");
        v[0x29] = ADD_HL_REG16("HL");
        v[0x39] = ADD_HL_REG16("SP");

        v[0xF3] = SET_INTR_FLAG(0);
        v[0xFB] = SET_INTR_FLAG(1);

        v[0xEA] = STORE_A_IMM16_DEREF;
        v[0xFA] = LOAD_A_IMM16_DEREF;

        v[0xC5] = PUSH_R16.bind(this, "BC", true);
        v[0xD5] = PUSH_R16.bind(this, "DE", true);
        v[0xE5] = PUSH_R16.bind(this, "HL", true);
        v[0xF5] = PUSH_R16.bind(this, "AF", true);

        v[0xC1] = POP_R16.bind(this, "BC");
        v[0xD1] = POP_R16.bind(this, "DE");
        v[0xE1] = POP_R16.bind(this, "HL");
        v[0xF1] = POP_R16.bind(this, "AF");

        v[0x07] = RLCA;
        v[0x0F] = RRCA;
        v[0x17] = RLA;
        v[0x1F] = RRA;
        v[0x27] = DAA;
        v[0x2F] = CPL;
        v[0x37] = SCF;
        v[0x3F] = CCF;

        v[0xE9] = JUMP_HL;

        v[0x08] = LOAD_R16_DEREF_SP;
        v[0xD9] = RETI;
        v[0xF9] = LOAD_SP_HL;

        v[0xC7] = RST.bind(this, 0x00);
        v[0xCF] = RST.bind(this, 0x08);
        v[0xD7] = RST.bind(this, 0x10);
        v[0xDF] = RST.bind(this, 0x18);
        v[0xE7] = RST.bind(this, 0x20);
        v[0xEF] = RST.bind(this, 0x28);
        v[0xF7] = RST.bind(this, 0x30);
        v[0xFF] = RST.bind(this, 0x38);

        v[0xE8] = ADD_R16_SP_I8.bind(this, "SP", 2);
        v[0xF8] = ADD_R16_SP_I8.bind(this, "HL", 1);

        v[0x00] = () => 0; // NOP
        v[0x76] = HALT;

        return v;
    }

    debugPrintRegs(){
        const hex = (/** @type {number} */ n) => n.toString(16).padStart(4, '0');
        let r = `BC ${hex(this.BC)} \nDE ${hex(this.DE)}\nHL ${hex(this.HL)}\nAF ${hex(this.AF)}`
            +`\nSP ${hex(this.SP)}\nPC ${hex(this.PC)}`
        console.log(r);
    }
}

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

export { _init, GameBoyCore, INTERRUPT_SOURCES }