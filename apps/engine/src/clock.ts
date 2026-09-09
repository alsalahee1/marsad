/** Injectable time source so ceilings, TTLs and budgets are testable without sleeping. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
