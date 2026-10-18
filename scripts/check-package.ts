#!/usr/bin/env bun
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const scratch = await mkdtemp(path.join(tmpdir(), "vanta-package-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
);

async function run(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);
    if (exitCode !== 0) throw new Error(`${args[0]} failed (${exitCode}): ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const expected = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const archive = path.join(scratch, "vanta-cli.tgz");
  await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], root);
  await writeFile(
    path.join(scratch, "package.json"),
    JSON.stringify({ private: true, dependencies: { [expected.name]: `file:${archive}` } }),
  );
  await run([process.execPath, "install", "--ignore-scripts"], scratch);
  const installed = path.join(scratch, "node_modules", expected.name);
  const binary = path.join(scratch, "node_modules/.bin/vanta");
  const cliEnv = {
    VANTA_CONFIG_PATH: path.join(scratch, "missing.json"),
    VANTA_TOKEN_CACHE_PATH: path.join(scratch, "missing-token.json"),
  };
  const version = (await run([binary, "--version"], scratch, cliEnv)).trim();
  if (version !== expected.version) throw new Error(`Packaged version mismatch: ${version}`);
  const help = await run([binary, "--help"], scratch, cliEnv);
  if (!help.includes("--timeout-ms")) throw new Error("Packaged CLI help is incomplete");
  const doctor = JSON.parse(await run([binary, "doctor", "--json"], scratch, cliEnv));
  if (doctor.configured !== false || doctor.api.checked !== false)
    throw new Error("Offline package smoke test unexpectedly used credentials");
  const dryRun = JSON.parse(
    await run([binary, "vendors", "create", "--body", "{}", "--json"], scratch, cliEnv),
  );
  if (dryRun.dryRun !== true) throw new Error("Packaged mutation did not default to dry-run");
  for (const file of [
    "SKILL.md",
    "references/command-guide.md",
    "references/test-descriptions.md",
  ]) {
    await access(path.join(installed, ".agents/skills/vanta", file));
  }
  console.log(
    `Installed vanta ${version} from its tarball; help, offline doctor, dry-run, and bundled skill passed outside the checkout.`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
