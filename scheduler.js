//@ts-check
"use strict"
/**@typedef {{event: number, timestamp: number}} SchedulerEvent */

class Scheduler{
    /**
     * @type {SchedulerEvent[]}
     */
    #eventList;
    
    constructor(){
        this.cycleCount = 0;
        this.totalCycleCount = 0n;
        
        this.#eventList = [];
    }

    /**
     * @param {number} count
     */
    advance(count){
        this.cycleCount += count;
    }

    /**
     * @param {number} timestamp
     * @param {number} event
     */
    addEventAbsolute(timestamp, event){
        const obj = { timestamp, event };
        let spliceIndex = 0;
        for (let i = 0; i < this.#eventList.length; i++) {
            spliceIndex = i;
            const element = this.#eventList[i];
            if(timestamp < element.timestamp) break;
        }
        this.#eventList.splice(spliceIndex, 0, obj);
    }

    /**
     * @param {number} timestampPlus
     * @param {number} event
     */
    addEventRelative(timestampPlus, event){

    }
}

export { Scheduler }