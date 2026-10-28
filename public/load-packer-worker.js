// Runs the Load Packer off the UI thread for public/load-planner.html.
import { simulate, compareContainers } from './load-packer.js';

self.onmessage = e => {
  const { id, task, items, opts } = e.data;
  try {
    const data = task === 'compare' ? compareContainers(items, opts) : simulate(items, opts);
    self.postMessage({ id, ok: true, data });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
