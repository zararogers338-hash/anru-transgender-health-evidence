const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ComputerControl, inside, resolveScopedPath } = require("../electron/computer-control.cjs");

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anru-computer-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test("computer scope rejects traversal and credential paths", () => fixture(async (root) => {
  assert.equal(inside(root, path.join(root, "notes")), true);
  assert.equal(inside(root, path.resolve(root, "..", "outside")), false);
  assert.throws(() => resolveScopedPath(root, "..\\outside", { allowMissing: true }), /超出/);
  assert.throws(() => resolveScopedPath(root, ".ssh\\id_rsa", { allowMissing: true }), /凭据/);
  assert.throws(() => resolveScopedPath(root, "secret.pem", { allowMissing: true }), /凭据/);
}));

test("computer scope rejects junctions that escape the authorized root", (context) => fixture(async (root) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "anru-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside", "utf8");
    const junction = path.join(root, "linked-outside");
    try {
      fs.symlinkSync(outside, junction, "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return context.skip("junction creation is unavailable");
      throw error;
    }
    assert.throws(() => resolveScopedPath(root, path.join("linked-outside", "outside.txt")), /链接|联接点/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test("computer file reads are scoped and mutations require approval", () => fixture(async (root) => {
  fs.writeFileSync(path.join(root, "paper.txt"), "Transgender health evidence", "utf8");
  const denied = new ComputerControl({ root, requestApproval: async () => false, shell: {} });
  assert.equal((await denied.read("paper.txt")).text, "Transgender health evidence");
  await assert.rejects(() => denied.write("result.md", "draft"), /拒绝|批准/);
  assert.equal(fs.existsSync(path.join(root, "result.md")), false);

  const approvals = [];
  const allowed = new ComputerControl({
    root,
    requestApproval: async (request) => { approvals.push(request); return true; },
    shell: { trashItem: async (target) => fs.rmSync(target, { force: true }) },
  });
  await allowed.write("result.md", "verified");
  assert.equal(fs.readFileSync(path.join(root, "result.md"), "utf8"), "verified");
  await allowed.trash("result.md");
  assert.equal(fs.existsSync(path.join(root, "result.md")), false);
  assert.deepEqual(approvals.map((item) => item.tool), ["file_write", "file_trash"]);
}));
