import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3000);
const RELAY_TARGET = process.env.RELAY_TARGET;
const RELAY_TOKEN = process.env.RELAY_TOKEN;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function getTargetUrl(requestUrl) {
  const target = new URL(RELAY_TARGET);

  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password
  ) {
    throw new Error("RELAY_TARGET must be a valid HTTPS URL");
  }

  const incomingUrl = new URL(requestUrl, "https://relay.invalid");
  const targetBasePath = target.pathname.replace(/\/+$/, "");
  const requestPath = incomingUrl.pathname;

  target.pathname = `${targetBasePath}${requestPath}` || "/";
  target.search = incomingUrl.search;
  target.hash = "";

  return target;
}

function getForwardHeaders(requestHeaders) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalizedName = name.toLowerCase();

    if (
      value === undefined ||
      normalizedName === "authorization" ||
      normalizedName.startsWith("x-relay-") ||
      HOP_BY_HOP_HEADERS.has(normalizedName)
    ) {
      continue;
    }

    headers.set(
      name,
      Array.isArray(value) ? value.join(", ") : value,
    );
  }

  return headers;
}

function getResponseHeaders(upstreamHeaders) {
  const headers = new Headers(upstreamHeaders);

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  return headers;
}

const server = createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    return sendJson(response, 200, { status: "ok" });
  }

  if (!RELAY_TARGET || !RELAY_TOKEN) {
    return sendJson(response, 500, {
      error: "Relay is not configured",
    });
  }

  if (request.headers.authorization !== `Bearer ${RELAY_TOKEN}`) {
    return sendJson(response, 401, { error: "Unauthorized" });
  }

  let targetUrl;

  try {
    targetUrl = getTargetUrl(request.url || "/");
  } catch {
    return sendJson(response, 500, {
      error: "Invalid RELAY_TARGET configuration",
    });
  }

  const controller = new AbortController();

  request.on("aborted", () => controller.abort());
  response.on("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });

  try {
    const method = request.method || "GET";
    const init = {
      method,
      headers: getForwardHeaders(request.headers),
      redirect: "manual",
      signal: controller.signal,
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = request;
      init.duplex = "half";
    }

    const upstreamResponse = await fetch(targetUrl, init);
    const responseHeaders = getResponseHeaders(upstreamResponse.headers);

    response.writeHead(upstreamResponse.status, Object.fromEntries(responseHeaders));

    if (!upstreamResponse.body || method === "HEAD") {
      return response.end();
    }

    for await (const chunk of upstreamResponse.body) {
      if (response.destroyed) {
        break;
      }

      if (!response.write(chunk)) {
        await new Promise((resolve) => response.once("drain", resolve));
      }
    }

    if (!response.destroyed) {
      response.end();
    }
  } catch (error) {
    if (response.destroyed) {
      return;
    }

    if (response.headersSent) {
      response.destroy();
      return;
    }

    sendJson(response, 502, { error: "Upstream request failed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`API relay listening on port ${PORT}`);
});
