// Local development only: `npx wrangler dev` (repo root, port 8787) serves the classifier, and this
// proxy keeps the browser on one origin. Not part of the payload published to demos.handsontable.com.
export default {
  server: { proxy: { '/api': 'http://localhost:8787' } },
};
