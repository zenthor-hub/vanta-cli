#!/usr/bin/env bun
import { access, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const root = path.resolve(import.meta.dir, "..");
const skillsDir = path.join(root, ".agents/skills");
const names = await readdir(skillsDir);
let checkedLinks = 0;
for (const name of names) {
  const skillDir = path.join(skillsDir, name);
  const text = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter?.[1]) throw new Error(`${name}: missing skill frontmatter`);
  z.object({ name: z.literal(name), description: z.string().min(1) }).parse(
    Bun.YAML.parse(frontmatter[1]),
  );
  const shim = path.join(root, ".claude/skills", name);
  if ((await realpath(shim)) !== (await realpath(skillDir)))
    throw new Error(`Incorrect skill link: ${shim}`);
  for (const file of (await readdir(skillDir, { recursive: true })).filter((file) =>
    file.endsWith(".md"),
  )) {
    const filename = path.join(skillDir, file);
    const markdown = await readFile(filename, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
      const local = decodeURIComponent(target.split("#")[0] ?? "");
      await access(path.resolve(path.dirname(filename), local));
      checkedLinks++;
    }
  }
}
console.log(
  `Checked ${names.length} skills, their Claude links, and ${checkedLinks} local reference links.`,
);
