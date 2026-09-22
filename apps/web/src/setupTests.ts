import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// globals are off (see vite.config.ts), so React Testing Library cannot register
// its own auto-cleanup through the global afterEach hook.
afterEach(() => {
  cleanup();
});
