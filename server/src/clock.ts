// All engine code reads time through here so tests can control it and the
// demo can run faster than real time (DEMO_SPEED=600 makes a day pass in ~2.4 minutes).
export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

// Starts at `base` and runs `speed` times faster than the wall clock.
export function acceleratedClock(speed: number, base = Date.now()): Clock {
  const t0 = Date.now();
  return { now: () => base + (Date.now() - t0) * speed };
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
