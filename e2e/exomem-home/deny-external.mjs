const nativeFetch = globalThis.fetch;
const appPort = String(process.env.HOME_E2E_PORT ?? 3461);
const cellPort = Number(process.env.HOME_E2E_CELL_PORT ?? 3462);
const ports = new Set([appPort, String(cellPort), String(cellPort + 1), String(cellPort + 2)]);
// Write probes can reach only this test stack; a mistaken external call fails before sending.
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
  if (["127.0.0.1", "localhost"].includes(url.hostname) && ports.has(url.port))
    return nativeFetch(input, init);
  throw new Error("External effects are blocked in the Home and viewer tests");
};
