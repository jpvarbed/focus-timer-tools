import { describe, expect, test } from "bun:test";

describe("focus CLI", () => {
  test("rejects an unknown command with the supported command list", async () => {
    const child = Bun.spawn([process.execPath, "cli/src/index.ts", "__invalid_command__"], {
      cwd: import.meta.dir.replace(/\/tests$/, ""),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("usage: focus <status|start");
  });
});
