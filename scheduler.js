//@ts-check
"use strict"
/**@typedef {{event: number, timestamp: number, timestampAdded: number}} SchedulerEvent */

class Scheduler{
    /**
     * @type {SchedulerEvent[]}
     */
    #eventList;
    
    constructor(){
        this.count = 0;
        this.totalCount = 0n;
        
        this.#eventList = [];
    }

    /**
     * @param {number} count
     */
    advance(count){
        this.count += count;
    }

    /**
     * @param {number} timestamp
     * @param {number} event
     */
    addEventAbsolute(timestamp, event){
        const obj = { timestamp, event, timestampAdded: this.count };
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
    addEventOffset(timestampPlus, event){
        const currentEventTime = this.#eventList[0]?.timestamp ?? this.count;
        this.addEventAbsolute(currentEventTime + timestampPlus, event);
    }

    get timeUntilNext(){
        return (this.#eventList[0]?.timestamp ?? Infinity) - this.count;
    }

    peekNextEvent(){
        return this.#eventList[0];
    }

    removeNextEvent(){
        return this.#eventList.shift();
    }

    /**
     * @param {number} timestampPlus
     * @param {number} event
     */
    reschedule(timestampPlus, event){
        this.removeFirstWithEventID(event);
        this.addEventOffset(timestampPlus, event);
    }

    /**
     * @param {number} targetEvent
     */
    removeFirstWithEventID(targetEvent){
        for(let i in this.#eventList){
            if(this.#eventList[i].event === targetEvent){
                this.#eventList.splice(+i, 1);
                return;
            }
        }
    }
}

export { Scheduler }