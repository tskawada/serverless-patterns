// A Lambda Web Function runs a standard HTTP server. There is no handler and no
// event object: Lambda forwards requests to the port this server listens on.
//
// The runtime provides the address in AWS_LAMBDA_HTTP_ENDPOINT as host:port. The
// fallback lets the same file run locally with `node index.js`, and binds to
// loopback so a local run is not reachable from the rest of the network.
const http = require("node:http");

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "127.0.0.1:3000").split(":");

// The pipeline sets APP_COMMIT on each revision, so a response identifies the
// commit it was built from. This is what makes the deployment verifiable.
const commit = process.env.APP_COMMIT || "local";
const startedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  const body = {
    commit,
    environmentStartedAt: startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
});

server.listen(Number(port), host, () => {
  console.log(`listening on ${host}:${port} (commit ${commit})`);
});
