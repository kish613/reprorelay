import { ReproRelay } from "./reprorelay.js";

declare global {
  interface Window {
    ReproRelay: typeof ReproRelay;
  }
}

if (typeof window !== "undefined") window.ReproRelay = ReproRelay;

export { ReproRelay };
