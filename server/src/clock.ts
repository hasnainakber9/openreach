// All engine code reads time through here so tests can control it and the
// demo can run faster than real time (DEMO_SPEED=600 makes a day pass in ~2.4 minutes).
export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

export function acceleratedClock(speed: number, origin = Date.now()): Clock {
  return { now: () => origin + (Date.now() - origin) * speed };
}

export class ManualClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
