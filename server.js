const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4173;
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  const file = path.join(__dirname, req.url === "/" ? "index.html" : decodeURIComponent(req.url.slice(1)));
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Notal AI running at http://127.0.0.1:${PORT}/  (close this window to stop)`);
});
