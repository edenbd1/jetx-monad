/** Fun, stable pilot names for anonymous managed wallets: same address, same name, on every phone. */
const WHO = [
  "Pilote", "Astronaute", "Cosmonaute", "Commandant", "Capitaine", "Martien", "Alien", "Baron",
  "Kaaris", "Pesquet", "Jacquouille", "Nils", "Brogniart", "Otis", "Morsay", "Boss",
] as const;
const HOW = [
  "Fou", "Sauvage", "Lunaire", "Doré", "Turbo", "Givré", "Survolté", "Chanceux",
  "Téméraire", "Galactique", "Intrépide", "Supersonique", "Cramé", "Légendaire", "Maudit", "Paro",
] as const;

export function pilotName(address: string) {
  const a = parseInt(address.slice(-4), 16) || 0;
  const b = parseInt(address.slice(-8, -4), 16) || 0;
  return `${WHO[a % WHO.length]} ${HOW[b % HOW.length]}`;
}

/** Short tag to tell two pilots with the same name apart. */
export const pilotTag = (address: string) => address.slice(2, 6).toLowerCase();
