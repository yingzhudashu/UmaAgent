import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { KnowledgeSource } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import { parseDocument } from "./document-parser.js";

const EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".css",
  ".html",
]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

async function collect(root: string, directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(root, path, output);
    else if (
      entry.isFile() &&
      (EXTENSIONS.has(extname(entry.name).toLowerCase()) ||
        DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    )
      output.push(path);
    if (output.length >= 10_000) throw new Error("Knowledge source exceeds 10,000 files");
  }
}

function chunks(content: string, size = 2_000, overlap = 200): string[] {
  const output: string[] = [];
  for (let offset = 0; offset < content.length; offset += size - overlap)
    output.push(content.slice(offset, offset + size));
  return output;
}

export class KnowledgeService {
  private readonly allowedRoots: string[];

  constructor(
    private readonly database: UmaDatabase,
    roots: string[],
    stateDir: string,
  ) {
    this.allowedRoots = [...roots, join(stateDir, "uploads")].map((root) => resolve(root));
  }

  list(): KnowledgeSource[] {
    return this.database.listKnowledgeSources();
  }

  search(query: string, limit = 5): Array<{ filePath: string; content: string }> {
    return this.database.searchKnowledge(query, limit);
  }

  async enqueue(name: string, sourcePath: string): Promise<KnowledgeSource> {
    const canonical = await this.validateSource(sourcePath);
    const source = this.database.createKnowledgeSource({ name, path: canonical });
    void this.process(source.id, name, canonical).catch(() => undefined);
    return source;
  }

  delete(id: string): void {
    this.database.deleteKnowledgeSource(id);
  }

  async index(name: string, sourcePath: string): Promise<KnowledgeSource> {
    const canonical = await this.validateSource(sourcePath);
    const source = this.database.createKnowledgeSource({ name, path: canonical });
    return this.process(source.id, name, canonical);
  }

  private async validateSource(sourcePath: string): Promise<string> {
    const canonical = await realpath(sourcePath);
    const allowed = this.allowedRoots.some((root) => {
      const value = relative(root, canonical);
      return value === "" || (!value.startsWith("..") && !value.includes(":") && !value.startsWith("/"));
    });
    if (!allowed) throw new Error("Knowledge source is outside configured workspace roots and uploads");
    return canonical;
  }

  private async process(id: string, name: string, canonical: string): Promise<KnowledgeSource> {
    this.database.updateKnowledgeSourceStatus(id, "parsing");
    try {
      const info = await stat(canonical);
      const files: string[] = [];
      if (info.isFile()) files.push(canonical);
      else if (info.isDirectory()) await collect(canonical, canonical, files);
      else throw new Error("Knowledge source must be a file or directory");
      const indexed: Array<{ filePath: string; content: string }> = [];
      for (const path of files) {
        const extension = extname(path).toLowerCase();
        const content = DOCUMENT_EXTENSIONS.has(extension)
          ? await parseDocument(path)
          : await readFile(path, "utf8");
        if (content.length > 2_000_000) continue;
        chunks(content).forEach((chunk) => {
          indexed.push({ filePath: info.isFile() ? path : relative(canonical, path), content: chunk });
        });
      }
      return this.database.replaceKnowledgeSource({ name, path: canonical, chunks: indexed });
    } catch (error) {
      this.database.updateKnowledgeSourceStatus(
        id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
