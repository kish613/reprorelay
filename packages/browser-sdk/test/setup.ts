const noop = () => undefined;
const context = new Proxy<Record<string, unknown>>({}, {
  get: () => noop,
  set: () => true,
}) as unknown as CanvasRenderingContext2D;

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => context,
});
