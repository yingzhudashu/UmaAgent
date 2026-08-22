import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { KnowledgeSearchHit, KnowledgeSource } from "@uma-agent/protocol";
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
    private readonly changed: () => void = () => undefined,
  ) {
    this.allowedRoots = [...roots, join(stateDir, "uploads")].map((root) => resolve(root));
  }

  list(ownerId?: string): KnowledgeSource[] {
    return this.database.listKnowledgeSources(ownerId);
  }

  search(query: string, limit = 5, sourceId?: string, ownerId?: string): KnowledgeSearchHit[] {
    return this.database.searchKnowledge(query, limit, sourceId, ownerId);
  }

  async enqueue(name: string, sourcePath: string, ownerId?: string): Promise<KnowledgeSource> {
    const canonical = await this.validateSource(sourcePath);
    const source = this.database.createKnowledgeSource({
      name,
      path: canonical,
      ...(ownerId ? { ownerId } : {}),
    });
    this.changed();
    void this.process(source.id, name, canonical, ownerId).catch(() => undefined);
    return source;
  }

  delete(id: string): void {
    this.database.deleteKnowledgeSource(id);
    this.changed();
  }

  async reindex(id: string, ownerId?: string): Promise<KnowledgeSource> {
    const source = this.database.getKnowledgeSource(id);
    this.database.updateKnowledgeSourceStatus(id, "queued");
    this.changed();
    return this.process(id, source.name, source.path, ownerId);
  }

  async index(name: string, sourcePath: string, ownerId?: string): Promise<KnowledgeSource> {
    const canonical = await this.validateSource(sourcePath);
    const source = this.database.createKnowledgeSource({
      name,
      path: canonical,
      ...(ownerId ? { ownerId } : {}),
    });
    this.changed();
    return this.process(source.id, name, canonical, ownerId);
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

  private async process(
    id: string,
    name: string,
    canonical: string,
    ownerId?: string,
  ): Promise<KnowledgeSource> {
    this.database.updateKnowledgeSourceStatus(id, "parsing");
    this.changed();
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
      const source = this.database.replaceKnowledgeSource({
        name,
        path: canonical,
        chunks: indexed,
        ...(ownerId ? { ownerId } : {}),
      });
      this.changed();
      return source;
    } catch (error) {
      this.database.updateKnowledgeSourceStatus(
        id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.changed();
      throw error;
    }
  }
}
