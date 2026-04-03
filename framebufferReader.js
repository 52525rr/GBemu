//@ts-check

"use strict"

const WIDTH = 160;
const HEIGHT = 144;

/**
 * @param {number} n
 * @param {number[]} color
 */


class GameBoyVideoCanvas{
    /**
     * @param {string} elementID
     */
    constructor(elementID){
        /**
         * @type {HTMLCanvasElement}
         */
        // @ts-ignore
        this.screen = document.getElementById(elementID);

        this.screenCTX = this.screen?.getContext("2d", {willReadFrequently: true});
        if(this.screenCTX === null){
            throw new Error("cannot create canvas element");
        }

        this.imageData = this.screenCTX.createImageData(WIDTH, HEIGHT);
        this.imageDataBuffer = this.imageData.data;
    }

    /**
    * @param {number} n
    * @param {number[]} color
     */
    setPixel(n, color){
        let i = n*4;
        this.imageDataBuffer[i++] = color[0];
        this.imageDataBuffer[i++] = color[1];
        this.imageDataBuffer[i++] = color[2];
        this.imageDataBuffer[i++] = 255;
    }

    /**
     * @param {Uint8ClampedArray} buffer
     */
    copyBuffer(buffer){
        for(let i = 0; i < buffer.length; i++){
            this.imageDataBuffer[i] = buffer[i];
        }
    }

    updateImage(){
        this.screenCTX.putImageData(this.imageData, 0, 0);
    }
}

export { GameBoyVideoCanvas }
