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
    addEventAbsolute(timestamp, event, timestampAdded = this.count){
        const obj = { timestamp, event, timestampAdded };
        let spliceIndex = this.#eventList.length;

        for (let i = 0; i < this.#eventList.length; i++) {
            const element = this.#eventList[i];
            if(timestamp < element.timestamp){
                spliceIndex = i;
                break;
            };
        }
        this.#eventList.splice(spliceIndex, 0, obj);
    }

    /**
     * @param {number} timestampPlus
     * @param {number} event
     */
    addEventOffset(timestampPlus, event){
        const currentEventTime = this.count;

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
    reschedule(timestampPlus, event, useEventTimestamp = false){
        let e = this.removeFirstWithEventID(event);
        
        let t = useEventTimestamp ? e?.timestamp : this.count;
        t ??= this.count; // if there were no events with the cooresponding event ID before, just use the current scheduler timestamp instead

        let newTimestamp = t + timestampPlus;

        if(newTimestamp < Infinity){
            this.addEventAbsolute(newTimestamp, event);
        }
    }

    /**
     * @param {number} targetEvent
     */
    removeFirstWithEventID(targetEvent){
        for(let i in this.#eventList){
            const e = this.#eventList[i];
            if(e.event === targetEvent){
                this.#eventList.splice(+i, 1);
                return e;
            }
        }
    }
}

export { Scheduler }