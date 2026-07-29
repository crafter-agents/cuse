// A server whose log is an oracle.
//
// `python3 -m http.server` records the client address and not much else, and on
// a machine where the host and the simulator share a loopback that is not enough
// to answer the only question worth asking: did the request come from a browser
// on the phone, or from something on this Mac? Both arrive as ::1.
//
// So this logs the User-Agent with every path. A request from Mobile Safari says
// iPhone; curl says curl; desktop Chrome says Macintosh. The gate can then be
// specific about which one it requires, instead of counting hits and hoping.
import { appendFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 8741);
const logPath = process.env.REQLOG ?? "requests.tsv";
const sentinel = process.env.SENTINEL ?? "cuse-rig";

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const ua = (req.headers.get("user-agent") ?? "").replace(/\s+/g, " ");
    appendFileSync(logPath, `${pathname}\t${ua}\n`);
    return new Response(
      `<!doctype html><meta name=viewport content="width=device-width">` +
      `<title>cuse rig</title><h1>${sentinel}</h1>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

console.log(`oracle server listening on ${port}, logging to ${logPath}`);
