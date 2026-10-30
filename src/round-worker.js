// Runs the edge rounder off the main thread.
import { roundMesh } from './rounder.js';

self.onmessage = (e) => {
  const { job, opts } = e.data;
  try {
    const res = roundMesh(opts);
    if (!res) return self.postMessage({ job, result: null });
    if (res.empty) return self.postMessage({ job, result: res });
    self.postMessage({ job, result: res }, [res.positions.buffer, res.normals.buffer, res.index.buffer]);
  } catch (err) {
    self.postMessage({ job, error: String(err && err.message ? err.message : err) });
  }
};
