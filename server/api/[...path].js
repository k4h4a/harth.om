// Vercel serverless entry point. Vercel's Node runtime accepts an Express
// app directly as a request handler — no wrapper needed. server.js (the
// always-on entry point for local dev / Render) is not used here.
module.exports = require("../src/app");
