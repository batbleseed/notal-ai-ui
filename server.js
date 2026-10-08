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
  const route = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let file = path.resolve(__dirname, "." + (route === "/" ? "/index.html" : route));
  if (!file.startsWith(__dirname + path.sep)) {
    res.writeHead(403);
    res.end("Outside the app folder");
    return;
  }
  fs.stat(file, (statErr, stats) => {
    if (!statErr && stats.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
}).listen(PORT, () => {
  console.log(`Notal AI running at http://127.0.0.1:${PORT}/  (close this window to stop)`);
});
