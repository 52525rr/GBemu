import { _init } from "./cpu.js"

"use strict"

const input = document.getElementById("input");

let lock = false;

async function readFileAsArray(file) {
    let r = await new Promise((resolve) => {
        let fileReader = new FileReader();
        fileReader.onload = () => resolve(fileReader.result);
        fileReader.readAsArrayBuffer(file);
    });
    return new Uint8Array(r);
}

async function _start(){
    if(lock)return;
    lock = true;

    let ROMfile = await readFileAsArray(input.files[0])
    _init(ROMfile);
}

input.addEventListener("input", _start);