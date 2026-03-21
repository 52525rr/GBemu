"use strict"

const screen = document.getElementById("canvas2");
const screenCTX = screen.getContext("2d", {willReadFrequently: true});

const WIDTH = screen.width ?? 160;
const HEIGHT = screen.height ?? 144;

let imageData = screenCTX.createImageData(WIDTH, HEIGHT)
let imageDataBuffer = imageData.data

function setPixel(n, color){
    let i = (n)*4;
    imageDataBuffer[i++] = color[0]
    imageDataBuffer[i++] = color[1]
    imageDataBuffer[i++] = color[2]
    imageDataBuffer[i++] = 255
}

function updateImage(){
    screenCTX.putImageData(imageData, 0, 0)
}

export { setPixel, updateImage }
