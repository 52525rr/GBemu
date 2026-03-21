//@ts-check

"use strict"

import { Memory } from "./mmu.js";

const MAPPERS = Object.freeze({
    MBC0: 0,
    MBC1: 1,
    MBC2: 2,
    MBC3: 3,
    // MBC4 does not exist
    MBC5: 5,
    MBC6: 6,
    MBC7: 7,
})

/**
 * @param {number} mapperByte
 */
function getMBC(mapperByte){
    switch(mapperByte){
        case 0x00: 
            return MAPPERS.MBC0;

        case 0x01: 
        case 0x02: 
        case 0x03: 
            return MAPPERS.MBC1;

        case 0x05: 
        case 0x06: 
            return MAPPERS.MBC2;

        case 0x0F: 
        case 0x10:
        case 0x11: 
        case 0x12: 
        case 0x13: 
            return MAPPERS.MBC3;

        case 0x19: 
        case 0x1A:
        case 0x1B: 
        case 0x1C: 
        case 0x1D:
        case 0x1E: 
            return MAPPERS.MBC5;

        case 0x20:
            return MAPPERS.MBC6;
        
        case 0x22:
            return MAPPERS.MBC7;

        default:
            throw new Error("unknown mapper");
    }
}

/**
 * @param {number} byte
 */
function getBankCount(byte){
    switch(byte){
        case 0x00: return 2;
        case 0x01: return 4;
        case 0x02: return 8;
        case 0x03: return 16;
        case 0x04: return 32;
        case 0x05: return 64;
        case 0x06: return 128;
        case 0x07: return 256;
        case 0x08: return 512;
        default: throw new Error("invalid bank count");
    }
}

const createMapperCallbackBinding = (/** @type {Memory} */ memoryInstance) => ({
    
    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC0](addr, value){
        // MBC0 does nothing on writes to ROM
        return;
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC1](addr, value){
        if(addr >= 0x2000 && addr <= 0x3FFF){
            const bankCount = memoryInstance.CART_DATA.bankCount;

            let selectedBank = value & 0x1F;
            if(selectedBank == 0) selectedBank = 1;
            selectedBank %= bankCount;

            memoryInstance.romBank = selectedBank;
            console.log(`bank switch val = ${value}, bank = ${selectedBank}`)
        }
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC2](addr, value){
        throw new Error("unimplemented mapper callback");
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC3](addr, value){
        throw new Error("unimplemented mapper callback");
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC5](addr, value){
        throw new Error("unimplemented mapper callback");
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC6](addr, value){
        throw new Error("unimplemented mapper callback");
    },


    /**
     * @param {number} addr
     * @param {number} value
     */
    [MAPPERS.MBC7](addr, value){
        throw new Error("unimplemented mapper callback");
    },
})

/**
 * @param {Uint8Array} romData
 */
function decodeCartHeader(romData){    
    return {
        MBC:        getMBC(romData[0x0147]),
        bankCount:  getBankCount(romData[0x148])
    }
}

export { decodeCartHeader, MAPPERS, createMapperCallbackBinding}