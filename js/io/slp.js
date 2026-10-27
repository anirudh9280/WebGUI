// Main-thread client for slp.worker.js.

let worker = null;
let nextId = 0;
const waiting = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./slp.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) w.resolve(data.slp);
      else w.reject(new Error(data.error));
    };
  }
  return worker;
}

// source: FileSource or UrlSource. Resolves to the parseSlp() result plus { name, size }.
export async function loadSlp(source) {
  const input = await source.all();
  const id = nextId++;
  const slp = await new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, input }, input instanceof ArrayBuffer ? [input] : []);
  });
  return { ...slp, name: source.name, size: source.size };
}
