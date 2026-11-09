import { randomBytes } from "node:crypto";

export function renderHtml(
  source: string,
  script: string,
  css: string,
  worker: string,
): string {
  const nonce = randomBytes(24).toString("base64");
  const attr = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${attr(source)} 'unsafe-inline'; font-src ${attr(source)}; img-src ${attr(source)} data:; connect-src ${attr(source)}; worker-src blob:;">
<link rel="stylesheet" href="${attr(css)}"><title>JiGit</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${attr(script)}" data-worker="${attr(worker)}" defer></script></body></html>`;
}
