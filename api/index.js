import { Readable } from "node:stream";
import { handleRequest } from "../src/worker.js";

function requestUrl(request) {
  const protocol = request.headers["x-forwarded-proto"]?.split(",")[0] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
  const url = new URL(request.url || "/", `${protocol}://${host}`);
  if (url.searchParams.has("__path")) {
    url.pathname = `/${url.searchParams.get("__path") || ""}`;
    url.searchParams.delete("__path");
  }
  return url.toString();
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export default async function handler(request, response) {
  try {
    const webRequest = new Request(requestUrl(request), {
      method: request.method,
      headers: requestHeaders(request),
    });
    const webResponse = await handleRequest(webRequest, process.env);

    response.statusCode = webResponse.status;
    webResponse.headers.forEach((value, name) => response.setHeader(name, value));
    if (!webResponse.body) {
      response.end();
      return;
    }
    Readable.fromWeb(webResponse.body).pipe(response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.statusCode = 500;
    response.end("Internal server error");
  }
}
