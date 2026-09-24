const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveHfToken, hfAuthHeaders } = require("../src/hf-token");

test("resolveHfToken: HF_TOKEN wins over the token file", () => {
  assert.equal(resolveHfToken({ HF_TOKEN: " hf_env ", HF_TOKEN_PATH: "/nonexistent" }), "hf_env");
});

test("resolveHfToken: falls back to the file that `hf auth login` writes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llm3-hf-token-"));
  fs.writeFileSync(path.join(home, "token"), "hf_file\n");
  assert.equal(resolveHfToken({ HF_HOME: home }), "hf_file");
  assert.deepEqual(hfAuthHeaders({ HF_HOME: home }), { authorization: "Bearer hf_file" });
});

test("resolveHfToken: no token anywhere sends no header", () => {
  assert.equal(resolveHfToken({ HF_TOKEN_PATH: "/nonexistent/token" }), "");
  assert.deepEqual(hfAuthHeaders({ HF_TOKEN_PATH: "/nonexistent/token" }), {});
});
