/**
 * What `/` and `/join` show when no Simple Games web build is installed
 * (README「Web build」): one sentence, instead of a 404, on both deployments.
 */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simple Games Club</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 36rem; padding: 0 1rem; color: #232a33; }
  code { background: #f2f0ea; padding: 0.1em 0.3em; border-radius: 4px; }
</style>
</head>
<body>
<h1>Simple Games Club</h1>
<p>This server is running, but the Simple Games web build is not installed, so there is nothing to play here yet.</p>
<p>The API answers at <code>/api/v1/health</code>. To serve the games from this address, put the web build in the directory named by <code>CLUB_WEB_DIR</code> (see the README).</p>
</body>
</html>
`;
