//@ts-check
import { GameBoyCore } from "./cpu.js";
import { IO_LABELS } from "./io.js";
import { decodeCartHeader, MAPPERS, createMapperCallbackBinding } from "./mappers.js";

"use strict"
/**
 * @param {Uint8Array} romData
 */
function assertRomSize(romData){
    const length = romData.byteLength;
    const frac = Math.log2(length) % 1;
    if(frac != 0){
        throw new RangeError("ROM size is not a power of 2.");
    }
}

/**
 * @param {number} addr
 */
function isUnsafeAddress(addr){
    return addr >= 0xFF00 && addr <= 0xFF7F;
}

class Memory{
    /**
     * @param {Uint8Array} romFile
     * @param {boolean} isGBC
     * @param {GameBoyCore} cpuInstance
     */
    constructor(cpuInstance, romFile, isGBC = false){
        this.serialOutput = "";
        this.cpu = cpuInstance;
        this.ioAccessor = cpuInstance.IOhandler

        assertRomSize(romFile);
        this.ROM  = new Uint8Array(romFile);
        this.WRAM = new Uint8Array(0x2000);
        this.VRAM = new Uint8Array(0x2000);
        this.SRAM = new Uint8Array(0x2000);
        this.OAM  = new Uint8Array(0xA0);
        this.IO   = new Uint8Array(0x80);
        this.HRAM = new Uint8Array(0x80);
        this.romBank = 1;

        this.CART_DATA = decodeCartHeader(romFile);
        const CART_MAPPER = this.CART_DATA.MBC;

        const mapperCallbackBinding = createMapperCallbackBinding(this);
        this.mapperCallback = mapperCallbackBinding[CART_MAPPER];
    }

    /**
     * @param {number} addr
     */
    loadByteDirect(addr){
        if(addr >= 0x0000 && addr <= 0x3FFF){
            return this.ROM[addr];

        } else if(addr >= 0x4000 && addr <= 0x7FFF){
            return this.ROM[(addr - 0x4000) + this.romBank * 0x4000];

        } else if(addr >= 0x8000 && addr <= 0x9FFF){
            return this.VRAM[addr - 0x8000];

        } else if (addr >= 0xA000 && addr <= 0xBFFF){
            return this.SRAM[addr - 0xA000];

        } else if (addr >= 0xC000 && addr <= 0xFDFF){
            return this.WRAM[(addr - 0xC000) % 0x2000];

        } else if(addr >= 0xFE00 && addr <= 0xFE9F){
            return this.OAM[addr - 0xFE00];

        } else if(addr >= 0xFF00 && addr <= 0xFF7F){
            return this.IO[addr - 0xFF00];

        } else if(addr >= 0xFF80 && addr <= 0xFFFF){
            return this.HRAM[addr - 0xFF80];
            
        } else return 0xFF;
    }

    /**
     * @param {number} addr
     * @param {number} byte
     */
    storeByteDirect(addr, byte){
        if(addr == 0xFF01){
            this.serialOutput += String.fromCharCode(byte);
        }

        if(addr >= 0x0000 && addr <= 0x7FFF){
            this.mapperCallback(addr, byte);

        } else if(addr >= 0x8000 && addr <= 0x9FFF){
            this.VRAM[addr - 0x8000] = byte;

        } else if (addr >= 0xA000 && addr <= 0xBFFF){
            this.SRAM[addr - 0xA000] = byte;

        } else if (addr >= 0xC000 && addr <= 0xFDFF){
            this.WRAM[(addr - 0xC000) % 0x2000] = byte;

        } else if(addr >= 0xFE00 && addr <= 0xFE9F){
            this.OAM[addr - 0xFE00] = byte;

        } else if(addr >= 0xFF00 && addr <= 0xFF7F){
            this.IO[addr - 0xFF00] = byte;

        } else if(addr >= 0xFF80 && addr <= 0xFFFF){
            this.HRAM[addr - 0xFF80] = byte;
        }
    }

    /**
     * @param {number} addr
     */
    loadByteMMU(addr){
        this.cpu.incrCycleCounter();
        if(isUnsafeAddress(addr)){
            this.cpu.runAllCachedCycles();
            
        }
        return this.loadByteDirect(addr);
    }

    /**
     * @param {number} addr
     * @param {number} byte
     */
    storeByteMMU(addr, byte){
        this.cpu.incrCycleCounter();
        if(isUnsafeAddress(addr)) this.cpu.runAllCachedCycles();
        this.storeByteDirect(addr, byte);
        this.cpu.IOhandler.trapIOwrite(addr, byte);
        
    }
}

export { Memory }