import { statSync } from "node:fs";
import { basename, extname } from "node:path";

import { CliError } from "./errors.ts";

export type MultipartPart =
  | { kind: "text"; name: string; value: string }
  | {
      kind: "file";
      name: string;
      path: string;
      filename: string;
      contentType: string;
      size: number;
    };

const mimeTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

function pair(input: string, flag: string): [string, string] {
  const separator = input.indexOf("=");
  if (separator <= 0) throw new CliError(`${flag} requires a nonempty field name and '='.`);
  return [input.slice(0, separator), input.slice(separator + 1)];
}

export function parseMultipart(options: {
  form: string[];
  file: string[];
  fileType: string[];
}): MultipartPart[] {
  const overrides = new Map<string, string>();
  for (const input of options.fileType) {
    const [name, value] = pair(input, "--file-type");
    if (overrides.has(name)) throw new CliError(`Duplicate MIME override: ${name}`);
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value)) {
      throw new CliError(`Invalid MIME type for ${name}. Use type/subtype.`);
    }
    overrides.set(name, value);
  }
  const names = new Set<string>();
  const parts: MultipartPart[] = [];
  for (const [kind, inputs] of [
    ["text", options.form],
    ["file", options.file],
  ] as const) {
    for (const input of inputs) {
      const [name, value] = pair(input, kind === "text" ? "--form" : "--file");
      if (names.has(name)) throw new CliError(`Duplicate multipart field: ${name}`);
      names.add(name);
      if (kind === "text") {
        parts.push({ kind, name, value });
      } else {
        let size: number;
        try {
          const stat = statSync(value);
          if (!stat.isFile()) throw new Error("not a regular file");
          size = stat.size;
        } catch {
          throw new CliError(`Multipart file must be an existing regular file: ${value}`);
        }
        parts.push({
          kind,
          name,
          path: value,
          filename: basename(value),
          contentType:
            overrides.get(name) ??
            mimeTypes[extname(value).toLowerCase()] ??
            "application/octet-stream",
          size,
        });
        overrides.delete(name);
      }
    }
  }
  if (overrides.size)
    throw new CliError(
      `--file-type requires a matching --file: ${[...overrides.keys()].join(", ")}`,
    );
  return parts;
}
