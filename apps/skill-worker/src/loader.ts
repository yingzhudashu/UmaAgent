import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface SkillToolManifest {
  name: string;
  description: string;
  export: string;
}
export interface SkillWorkerManifest {
  name: string;
  contentHash: string;
  entry: string;
  tools: SkillToolManifest[];
}

export async function hashDirectory(root: string): Promise<string> {
  const files: Array<{ path: string; data: Uint8Array }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Skill Worker packages cannot contain symlinks");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== "skill-worker.json")
        files.push({ path: relative(root, path).replaceAll("\\", "/"), data: await readFile(path) });
    }
  };
  await visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(file.data);
  }
  return hash.digest("hex");
}

export async function loadApprovedSkills(root: string, allowed: Set<string>) {
  const canonicalRoot = await realpath(resolve(root));
  const output: Array<{ manifest: SkillWorkerManifest; module: Record<string, unknown> }> = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = await realpath(join(canonicalRoot, entry.name));
    if (relative(canonicalRoot, directory).startsWith(".."))
      throw new Error("Skill path escaped package root");
    const manifest = JSON.parse(
      await readFile(join(directory, "skill-worker.json"), "utf8"),
    ) as SkillWorkerManifest;
    const actual = await hashDirectory(directory);
    if (actual !== manifest.contentHash || !allowed.has(actual))
      throw new Error(`Skill ${manifest.name} content hash is not approved`);
    const entryPath = await realpath(join(directory, manifest.entry));
    if (relative(directory, entryPath).startsWith("..") || dirname(entryPath) === canonicalRoot)
      throw new Error(`Skill ${manifest.name} entry escaped its package`);
    output.push({
      manifest,
      module: (await import(new URL(`file://${entryPath.replaceAll("\\", "/")}`).href)) as Record<
        string,
        unknown
      >,
    });
  }
  return output;
}
