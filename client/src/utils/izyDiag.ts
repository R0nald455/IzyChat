/** Temporary first-turn wipe diagnostics. Filter the console by `[IzyDiag]`. */
export function izyDiag(event: string, data?: Record<string, unknown>) {
  if (typeof window === 'undefined') {
    return;
  }
  console.log(`[IzyDiag] ${event}`, {
    t: Date.now(),
    href: window.location.href,
    ...data,
  });
}
