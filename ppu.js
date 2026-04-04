// @ts-check
/**
 * @typedef {{x: number, y: number, index: number, attributes: number, oamIndex: number}} Sprite
 */

import { INTERRUPT_SOURCES } from "./cpu.js";
import { IO_LABELS, SCHEDULER_EVENTS, LCD_START_TIME, LCD_END_TIME, IOManager } from "./io.js";
import { bitReverse8 } from "./util.js";

"use strict"

const PPU_MODES = Object.freeze({
    HBLANK: 0,
    VBLANK: 1,
    OAM_SCAN: 2,
    RENDERING: 3, 
})

const SCREEN_WIDTH  = 160;
const SCREEN_HEIGHT = 144;
const BYTES_PER_PIXEL = 4;

const LY_VBLANK = 144;
const LINES_PER_FRAME = 154;

const SCANLINE_LENGTH = 456;

/**
 * @param {Uint8ClampedArray} framebuffer
 * @param {number} x
 * @param {number} y
 * @param {number} color
 */
function setPixelOnFrameBuffer(framebuffer, x, y, color){
    let i = (y * SCREEN_WIDTH + x) * BYTES_PER_PIXEL;
    framebuffer[i++] = color >> 16 & 0xFF; // red
    framebuffer[i++] = color >> 8 & 0xFF;  // green
    framebuffer[i++] = color >> 0 & 0xFF;  // blue
    framebuffer[i++] = 0xFF;  // alpha
}

const DMG_PALETTE = [
    0xFFFFFF,
    0xAAAAAA,
    0x555555,
    0x000000,
]

class PPU {
    #windowIncr;
    #prevStatSignal;
    #shadowLY;

    /**
     * @type {{
     * spriteBuffer: (number | undefined)[] | undefined, 
     * spriteAttributeBuffer: (number | undefined)[] | undefined
     * }}
     */
    #spriteInfo;

    /**
     * @param {IOManager} io
     */
    constructor(io) {
        this.cpu = io.cpu;
        this.mem = this.cpu.MMU;
        this.ioRegs = this.mem.IO;
        this.VRAM = this.mem.VRAM;

        this.LY = 0;
        this.LX = 0;
        this.WLY = 0;
        this.#shadowLY = 0;

        this.LCDenabled = false;
        this.framebuffer = new Uint8ClampedArray(SCREEN_HEIGHT * SCREEN_WIDTH * BYTES_PER_PIXEL);
        this.PPUmode = 0;
        this.lineCycles = 0;
        this.#windowIncr = false;
        this.#prevStatSignal = 0;
        
        this.#spriteInfo = {
            spriteBuffer: undefined,
            spriteAttributeBuffer: undefined,
        }

        this.FIFOpenalty = 0;
    }

    resetLCD(){
        this.LY = 0;
        this.LX = 0;
        this.LCDenabled = false;
        this.PPUmode = 0;
        this.lineCycles = 0;
        this.FIFOpenalty = 0;
        this.#windowIncr = false;
        this.#prevStatSignal = 0;
    }

    enableLCD(){
        this.LCDenabled = true;
    }

    #updateIOregs(){
        const io = this.ioRegs;

        io[IO_LABELS.LY] = this.LY;

        io[IO_LABELS.STAT] &= ~0b00000111; 
        io[IO_LABELS.STAT] |= (this.PPUmode);
    }

    #calculateSTATsignal(){
        const STAT = this.ioRegs[IO_LABELS.STAT];
        const LYC = this.ioRegs[IO_LABELS.LYC]

        const statIntrEnable = STAT >> 3 & 0b1111;

        const condBits = 
            +(this.PPUmode === 0) << 0 | 
            +(this.PPUmode === 1) << 1 | 
            +(this.PPUmode === 2) << 2 | 
            +(this.LY == LYC) << 3;

        const enabledIntrSignal = condBits & statIntrEnable;

        return +(enabledIntrSignal > 0);
    }
    
    /**
     * @param {number} ticks
     */
    advance(ticks){
        /**
         * @param {number} lineCycles 
         * @param {number} LY 
         * @returns {number[]}
         */
        const cyclesUntilNextInterestingThing = 
        (lineCycles, LY) => {
            if(LY >= 144){
                if(LY === 153 && lineCycles < LCD_END_TIME.LY_153_BUG){
                    return [LCD_END_TIME.LY_153_BUG, PPU_MODES.VBLANK];

                }else{
                    return [LCD_END_TIME.HBLANK, PPU_MODES.VBLANK];
                }
            }

            if(lineCycles < LCD_END_TIME.OAM){
                return [LCD_END_TIME.OAM, PPU_MODES.OAM_SCAN];

            }else if(lineCycles < LCD_END_TIME.HBLANK + 0){
                return [LCD_END_TIME.HBLANK, PPU_MODES.RENDERING];

            }else{
                return [LCD_END_TIME.HBLANK, PPU_MODES.HBLANK];
            }
        }

        if(!this.LCDenabled){
            this.#updateIOregs();
            return;
        }

        while(ticks > 0){
            let b = ticks;

            let [nextEventTime, currentPPUMode] = cyclesUntilNextInterestingThing(this.lineCycles, this.LY);    
            nextEventTime -= this.lineCycles;
            
            const batchedCycles = Math.min(nextEventTime, ticks);

            ticks -= batchedCycles;

            let futureLineTime = this.lineCycles + batchedCycles;

            if(futureLineTime >= SCANLINE_LENGTH){
                futureLineTime -= SCANLINE_LENGTH;

                this.LY += 1;
                this.LX = 0;
                this.FIFOpenalty = 0;

                if(this.#windowIncr){
                    this.WLY += 1;
                }
                this.#windowIncr = false;

                if(this.LY === 144){
                    this.cpu.IFreg |= 1 << INTERRUPT_SOURCES.VBLANK;
                }

                if(this.LY >= LINES_PER_FRAME){
                    this.LY = 0;
                    this.WLY = 0;
                }
            }
            
            let [, nextPPUMode] = cyclesUntilNextInterestingThing(futureLineTime, this.LY);
            this.PPUmode = nextPPUMode;

            if(currentPPUMode != nextPPUMode){
                if(currentPPUMode == PPU_MODES.OAM_SCAN){
                    let spriteList = this.#calculateSprites(this.LY);
                    let a = this.#createSpriteOverlay(spriteList, this.LY);
                    this.#spriteInfo.spriteBuffer = a.spriteBuffer;
                    this.#spriteInfo.spriteAttributeBuffer = a.spriteAttributeBuffer;
                }
            }

            if(nextPPUMode === PPU_MODES.RENDERING){
                this.drawPixels(batchedCycles);
            }

            const statSignal = this.#calculateSTATsignal();
            if(statSignal > this.#prevStatSignal){
                this.cpu.IFreg |= 1 << INTERRUPT_SOURCES.STAT;
                //debugger;
            }
            this.#prevStatSignal = statSignal;

            this.lineCycles = futureLineTime;
        }

        this.#updateIOregs();
    }

    /**
     * @param {number} LY
     */
    #calculateSprites(LY){
        const OAM = this.mem.OAM;
        const LCDC = this.ioRegs[IO_LABELS.LCDC];
        const spriteHeight = (LCDC >> 2 & 1) ? 16 : 8;

        /**
         * @type {Sprite[]}
         */
        let spriteList = [];

        for(let i = 0; i < 40; i++){
            let OAMindex = i * 4;
            
            const spriteY = OAM[OAMindex + 0] - 16;
            const spriteX = OAM[OAMindex + 1] - 8;
            const spriteIndex = OAM[OAMindex + 2];
            const spriteAttributes = OAM[OAMindex + 3];

            if(LY >= spriteY && LY < spriteY + spriteHeight){
                spriteList.push({
                    x: spriteX,
                    y: spriteY,
                    index: spriteIndex,
                    attributes: spriteAttributes,
                    oamIndex: i
                })
            }

            if(spriteList.length >= 10){
                break;
            }
        }

        if(true){ 
            spriteList.sort((a, b) => {
                // DMG mode, sprites sorted by X position
                let r = b.x - a.x;
                if(r !== 0) return r;
                r = b.oamIndex - a.oamIndex;
                return r;
            })
        }

        if(spriteList.length > 0){
            debugger
        }

        return spriteList;
    }

    /**
     * @param {Sprite[]} spriteList
     * @param {number} LY 
     * 
     * @returns {{
     * spriteBuffer: (number | undefined)[], 
     * spriteAttributeBuffer: (number | undefined)[]
     * }}
     */
    #createSpriteOverlay(spriteList, LY){
        // creates a buffer and writes sprite pixels to it ahead of time
        // this makes the pixel renderer's job a lot easier

        const LCDC = this.ioRegs[IO_LABELS.LCDC];
        const spriteHeight = (LCDC >> 2 & 1) ? 16 : 8;

        const spriteBuffer = new Array(SCREEN_WIDTH).fill(undefined);
        const spriteAttributeBuffer = new Array(SCREEN_WIDTH).fill(undefined);

        let tileBasePointer = 0x0000; // start of VRAM or add  0x8000

        for(let sprite of spriteList){
            let { x, y, index, attributes } = sprite;

            const yFlip = attributes >> 6 & 1;
            const xFlip = attributes >> 5 & 1;

            let spriteLine = LY - y;

            if(yFlip){
                spriteLine = (spriteHeight - 1) - spriteLine;
            }
            if(spriteHeight == 16){
                index &= ~0b01;
                if(spriteLine >= 8){
                    index |= 0b01;
                }
            }

            let spriteDataIndex = (index * 8 + spriteLine % 8) * 2;

            let tilePlane0 = this.VRAM[tileBasePointer + spriteDataIndex + 0];
            let tilePlane1 = this.VRAM[tileBasePointer + spriteDataIndex + 1];

            if(xFlip){
                tilePlane0 = bitReverse8(tilePlane0);
                tilePlane1 = bitReverse8(tilePlane1);
            }

            for(let i = 0; i < 8; i++){
                let bufferIndex = x + i;
                let pixelShiftAmount = 7 - i;

                let pix = (tilePlane0 >> pixelShiftAmount & 1) + 2*(tilePlane1 >> pixelShiftAmount & 1);

                if(bufferIndex >= 0 && bufferIndex <= SCREEN_WIDTH){
                    spriteBuffer[bufferIndex] = pix;
                    spriteAttributeBuffer[bufferIndex] = attributes;
                }
            }

        }

        return { spriteBuffer, spriteAttributeBuffer }
    }

    /**
     * @param {number} bufferedPixels
     */
    drawPixels(bufferedPixels){
        const unpackDMGpalette = (/** @type {any} */ byte) => {
            return [
                byte >> 0 & 0b11,
                byte >> 2 & 0b11,
                byte >> 4 & 0b11,
                byte >> 6 & 0b11,
            ]
        }

        const asInt8 = (/** @type {number} */ n) => (n << 24 >> 24);

        const LCDC = this.ioRegs[IO_LABELS.LCDC];
        const scrollX  = this.ioRegs[IO_LABELS.SCX];
        const scrollY  = this.ioRegs[IO_LABELS.SCY];
        const windowX  = this.ioRegs[IO_LABELS.WX] - 7;
        const windowY  = this.ioRegs[IO_LABELS.WY];
        const dmgPaletteMap = this.ioRegs[IO_LABELS.BGP];
        const obj0PaletteMap = this.ioRegs[IO_LABELS.OBP0];
        const obj1PaletteMap = this.ioRegs[IO_LABELS.OBP1];

        const tileAddressingMode = !Boolean(LCDC >> 4 & 1);

        const tileMap0Base = 0x1800; 
        const tileMap1Base = 0x1C00; 
        // index into the VRAM array directly, so the address is offset by 0x8000.

        const windowTileMapBase = (LCDC >> 6 & 1) ? tileMap1Base : tileMap0Base;
        const backgroundTileMapBase = (LCDC >> 3 & 1) ? tileMap1Base : tileMap0Base;

        const windowEnabled = Boolean(LCDC >> 5 & 1);
        const backgroundEnabled = Boolean(LCDC >> 0 & 1);

        const spritesEnabled = Boolean(LCDC >> 1 & 1);

        const spriteHeight = (LCDC >> 2 & 1) ? 16 : 8;

        const tileBasePointer = tileAddressingMode ? 0x1000 : 0x0000;
        
        let tileMapBase = backgroundTileMapBase;

        const paletteArray = unpackDMGpalette(dmgPaletteMap);
        const obj0PaletteArray = unpackDMGpalette(obj0PaletteMap);
        const obj1PaletteArray = unpackDMGpalette(obj1PaletteMap);

        let {spriteBuffer, spriteAttributeBuffer} = this.#spriteInfo;

        if(spriteBuffer === undefined || spriteAttributeBuffer === undefined){
            throw new Error("sprite list is undefined");
        }

        while(bufferedPixels-- > 0){
            if(this.LX >= 160){
                break;
            }

            let screenX, screenY;

            if(windowEnabled && this.LX >= windowX && this.LY >= windowY){
                screenX = this.LX - windowX;
                screenY = this.WLY;
                this.#windowIncr = true;
                tileMapBase = windowTileMapBase;

            }else{
                screenX = this.LX + scrollX;
                screenY = this.LY + scrollY;
            }

            /**
             * @type {number}
             */
            let palID;

            if(backgroundEnabled){
                let tileX = Math.floor(screenX / 8) & 0x1F;
                let tileY = Math.floor(screenY / 8) & 0x1F;

                let tileIDIndex = (tileY * 32 + tileX);

                let tileIndex = this.VRAM[tileMapBase + tileIDIndex];
                if(tileAddressingMode) tileIndex = asInt8(tileIndex);

                let tileDataIndex = (tileIndex * 8 + screenY % 8) * 2;

                let tilePlane0 = this.VRAM[tileBasePointer + tileDataIndex + 0];
                let tilePlane1 = this.VRAM[tileBasePointer + tileDataIndex + 1];

                let pixelShiftAmount = 7 - screenX % 8;

                let pix = (tilePlane0 >> pixelShiftAmount & 1) + 2*(tilePlane1 >> pixelShiftAmount & 1);

                palID = paletteArray[pix];
                
            }else{
                palID = 0;
            }

            let spritePalID = spriteBuffer?.[this.LX];
            if(spritesEnabled && spritePalID !== undefined){
                let attributes = spriteAttributeBuffer?.[this.LX] ?? 0;
                let palette = attributes >> 4 & 1;
                let spritePriority = attributes >> 7 & 1;

                let objPal = palette ? obj1PaletteArray : obj0PaletteArray;

                let spriteCanDrawOverBackground = spritePalID !== 0 && (spritePriority ? palID === 0 : true);

                if(spriteCanDrawOverBackground){
                    palID = objPal[spritePalID];
                }
            }

            let color = DMG_PALETTE[palID];

            setPixelOnFrameBuffer(
                this.framebuffer, 
                this.LX, 
                this.LY, 
                color
            );

            this.LX += 1;
        }
    }
}

export { PPU }