//@ts-check
"use strict"

/** @typedef {{code: string, pushedDown: boolean}} KeyCode */

const BUTTON_MAPPINGS = Object.freeze({
    UP: 0,
    DOWN: 1,
    LEFT: 2,
    RIGHT: 3,
    A: 4,
    B: 5,
    START: 6,
    SELECT: 7,
});

/**
 * @type {{[index: string]: number}}
 */

const KEYCODE_MAPPINGS = {
    "ArrowUp": BUTTON_MAPPINGS.UP,
    "ArrowDown": BUTTON_MAPPINGS.DOWN,
    "ArrowLeft": BUTTON_MAPPINGS.LEFT,
    "ArrowRight": BUTTON_MAPPINGS.RIGHT,
    "KeyZ": BUTTON_MAPPINGS.A,
    "KeyX": BUTTON_MAPPINGS.B,
    "ShiftLeft": BUTTON_MAPPINGS.START,
    "Space": BUTTON_MAPPINGS.SELECT,
}

class KeyHandler {
    constructor() {
        /**
         * @type {KeyCode[]}
         */
        this.keyBuffer = [];

        /**
         * @type {boolean[]}
         */
        this.isButtonPressed = new Array(8).fill(false);

        const input = window;

        if (input === null) {
            console.error("Couldn't get keyboard input!");
            return;
        }

        input.addEventListener("keydown", (event) => {
            this.keyBuffer.push({
                code: event.code,
                pushedDown: true,
            })
        })

        input.addEventListener("keyup", (event) => {
            this.keyBuffer.push({
                code: event.code,
                pushedDown: false,
            })
        })
    }

    updateButtonState() {
        for (const k of this.keyBuffer) {
            const mapping = KEYCODE_MAPPINGS?.[k.code];
            if (mapping === undefined) continue;

            this.isButtonPressed[mapping] = k.pushedDown;
        }

        this.keyBuffer = [];
    }
}

export { KeyHandler, BUTTON_MAPPINGS }