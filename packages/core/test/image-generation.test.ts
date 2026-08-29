import { describe, expect, it, vi } from "vitest";

const generate = vi.fn();
vi.mock("openai", () => ({
  default: class OpenAI {
    images = { generate };
  },
}));

import { ImageGenerationService } from "../src/image-generation.js";

describe("ImageGenerationService", () => {
  it("requests the fixed image contract and validates PNG output", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    generate.mockResolvedValueOnce({ data: [{ b64_json: png.toString("base64") }] });
    const result = await new ImageGenerationService().generate({
      baseUrl: "https://api.example/v1",
      apiKey: "secret",
      prompt: "a cat",
      signal: new AbortController().signal,
      timeoutMs: 1000,
      maxBytes: 1024,
    });
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.data)).toEqual(png);
    expect(generate).toHaveBeenCalledWith(
      {
        model: "gpt-image-2",
        prompt: "a cat",
        n: 1,
        size: "1024x1024",
        quality: "auto",
        output_format: "png",
      },
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("rejects URL-only or malformed image responses", async () => {
    generate.mockResolvedValueOnce({ data: [{ url: "https://example.invalid/image.png" }] });
    await expect(
      new ImageGenerationService().generate({
        baseUrl: "https://api.example/v1",
        apiKey: "secret",
        prompt: "a cat",
        signal: new AbortController().signal,
        timeoutMs: 1000,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("one base64 image");
  });
});
