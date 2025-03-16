const http = require("http");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK" }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const port = process.env.HEALTH_PORT || 9000;
server.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});

// Keep the process running
process.stdin.resume();
