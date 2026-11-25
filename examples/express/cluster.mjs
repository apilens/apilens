// Runs server.mjs in EXAMPLE_CLUSTER_WORKERS (default 2) node:cluster workers
// that share the port, the way a production Node API uses its cores. The
// primary only supervises: it serves nothing and does not load the SDK. Each
// worker is its own process, so it samples itself and reports as its own
// instance; all of them report the same container numbers, which APILens
// keeps once per container (never summed).
import cluster from "node:cluster";

const workers = Math.max(1, Number.parseInt(process.env.EXAMPLE_CLUSTER_WORKERS || "2", 10) || 2);

cluster.setupPrimary({ exec: new URL("./server.mjs", import.meta.url).pathname });
for (let i = 0; i < workers; i += 1) {
  cluster.fork();
}

let stopping = false;
cluster.on("exit", (worker, code, signal) => {
  if (stopping) {
    if (Object.keys(cluster.workers ?? {}).length === 0) {
      process.exit(0);
    }
    return;
  }
  // A worker that died (an OOM kill, a crash) is replaced, as PM2 would.
  console.log(`worker ${worker.process.pid} exited (${signal || code}); forking a new one`);
  cluster.fork();
});

const stop = () => {
  stopping = true;
  for (const worker of Object.values(cluster.workers ?? {})) {
    worker?.process.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
