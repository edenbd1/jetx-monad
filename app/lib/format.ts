export const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const mult = (n: number) => `${n.toFixed(2)}x`;

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Pill color bucket for a crash multiplier, like JetX's history strip. */
export const tier = (m: number) => (m >= 10 ? "gold" : m >= 2 ? "purple" : "blue");
