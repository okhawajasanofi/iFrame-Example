// A minimal event bus, so modules do not import each other in circles.
type Fn = (...a: any[]) => void;
const subs = new Map<string, Set<Fn>>();

export const on = (name: string, fn: Fn) => {
  if (!subs.has(name)) subs.set(name, new Set());
  subs.get(name)!.add(fn);
  return () => subs.get(name)!.delete(fn);
};
export const emit = (name: string, ...a: unknown[]) => subs.get(name)?.forEach((fn) => fn(...a));
