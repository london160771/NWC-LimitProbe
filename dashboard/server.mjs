import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dashboardDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(dashboardDirectory, "..");
const routes = new Map([
  ["/", { path: resolve(dashboardDirectory, "index.html"), type: "text/html; charset=utf-8" }],
  ["/dashboard.css", { path: resolve(dashboardDirectory, "dashboard.css"), type: "text/css; charset=utf-8" }],
  ["/dashboard.js", { path: resolve(dashboardDirectory, "dashboard.js"), type: "text/javascript; charset=utf-8" }],
  ["/sandbox/sandbox-runner.js", { path: resolve(dashboardDirectory, "sandbox/sandbox-runner.js"), type: "text/javascript; charset=utf-8" }],
  ["/sandbox/sandbox-evidence.js", { path: resolve(dashboardDirectory, "sandbox/sandbox-evidence.js"), type: "text/javascript; charset=utf-8" }],
  ["/reports/phase6.2-final-evidence.json", { path: resolve(projectDirectory, "reports/phase6.2-final-evidence.json"), type: "application/json; charset=utf-8", report: true }],
]);

export function createDashboardServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Allow": "GET, HEAD", "Content-Length": "0" }).end();
      return;
    }
    let pathname;
    let download = false;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      pathname = url.pathname;
      download = url.searchParams.get("download") === "1";
    } catch {
      response.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    const asset = routes.get(pathname);
    if (!asset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "9" }).end(request.method === "HEAD" ? undefined : "Not found");
      return;
    }
    try {
      const content = await readFile(asset.path);
      const headers = {
        "Content-Type": asset.type,
        "Content-Length": String(content.byteLength),
        "Cache-Control": asset.report ? "no-store" : "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      };
      if (asset.report) headers["Content-Disposition"] = `${download ? "attachment" : "inline"}; filename="phase6.2-final-evidence.json"`;
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "20", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : "Evidence unavailable");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = "127.0.0.1";
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const server = createDashboardServer();
  server.listen(port, host, () => process.stdout.write(`LimitProbe dashboard: http://${host}:${port}\n`));
  server.on("error", (error) => {
    process.stderr.write(error?.code === "EADDRINUSE" ? "Dashboard port is already in use.\n" : "Dashboard server failed to start.\n");
    process.exitCode = 1;
  });
}
