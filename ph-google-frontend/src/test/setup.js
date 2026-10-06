import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount whatever a test rendered, so one test's DOM never leaks into the next.
afterEach(() => {
  cleanup();
});
