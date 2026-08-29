import OpenAI from "openai";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: "image/png";
}

/**
 * OpenAI-compatible image generation boundary. The model and output format are
 * intentionally fixed so callers cannot accidentally create unbounded or
 * provider-specific image requests.
 */
export class ImageGenerationService {
  async generate(input: {
    baseUrl: string;
    apiKey: string;
    prompt: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
  }): Promise<GeneratedImage> {
    const client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: input.baseUrl,
      maxRetries: 0,
    });
    const response = await client.images.generate(
      {
        model: "gpt-image-2",
        prompt: input.prompt,
        n: 1,
        size: "1024x1024",
        quality: "auto",
        output_format: "png",
      },
      { signal: input.signal, timeout: input.timeoutMs },
    );
    const items = response.data ?? [];
    if (items.length !== 1 || !items[0]?.b64_json) {
      throw new Error("Provider contract error: image response must contain one base64 image");
    }
    const encoded = items[0].b64_json;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
      throw new Error("Provider contract error: invalid image base64");
    if (Math.ceil((encoded.length * 3) / 4) > input.maxBytes)
      throw new Error("Provider contract error: generated image exceeds upload limit");
    const data = Buffer.from(encoded, "base64");
    if (data.length === 0 || data.length > input.maxBytes || !data.subarray(0, 8).equals(PNG_SIGNATURE))
      throw new Error("Provider contract error: generated image is not a valid PNG");
    return { data, mimeType: "image/png" };
  }
}
