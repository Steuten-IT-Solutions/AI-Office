/** Kennzahlen für S2c (docs/etappe-0.md 3.2): Faktor „geschätzte USD → Prozentpunkte“. */

/** Quantil mit linearer Interpolation (Typ 7, wie R und NumPy als Standard). */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? Number.NaN;
  const high = sorted[upper] ?? Number.NaN;
  return low + (high - low) * (position - lower);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Faktor je Block: Δ Prozentpunkte / Σ total_cost_usd. `null`, wenn keine Kosten gebucht sind. */
export function factor(deltaPoints: number, costUsd: number): number | null {
  return costUsd > 0 ? deltaPoints / costUsd : null;
}

export interface Stability {
  blocks: number;
  median: number;
  p90: number;
  /** 90-%-Quantil / Median; `null`, wenn der Median 0 ist (Prozentwerte zu grob). */
  ratio: number | null;
  /** Go-Kriterium S2c: Verhältnis ≤ 1,5. */
  go: boolean | null;
}

export const MAX_RATIO = 1.5;

export function stability(factors: number[]): Stability {
  const m = median(factors);
  const p90 = quantile(factors, 0.9);
  const ratio = factors.length > 0 && m > 0 ? p90 / m : null;
  return {
    blocks: factors.length,
    median: m,
    p90,
    ratio,
    go: ratio === null ? null : ratio <= MAX_RATIO,
  };
}
