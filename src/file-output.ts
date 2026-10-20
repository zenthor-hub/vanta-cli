import { randomUUID } from "node:crypto";
import { lstat, open, link, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CliError } from "./errors.ts";

function existsError(outputPath: string): CliError {
  return new CliError(`Output file already exists: ${outputPath}. Pass --force to overwrite it.`);
}

export async function checkOutputPath(outputPath: string, force?: boolean): Promise<void> {
  if (force) return;
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw existsError(outputPath);
}

export async function publishFile(outputPath: string, bytes: Uint8Array, force?: boolean) {
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    if (force) {
      await rename(temporaryPath, outputPath);
    } else {
      try {
        await link(temporaryPath, outputPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST")
          throw existsError(outputPath);
        throw error;
      }
    }
    return { outputPath, bytes: bytes.byteLength };
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
