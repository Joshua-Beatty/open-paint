/**
 * zlib (RFC 1950) compression through the platform streams. `CompressionStream` and
 * `DecompressionStream` exist in browsers and in Node.
 */

export async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new CompressionStream("deflate"));
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new DecompressionStream("deflate"));
}

/** Raw DEFLATE (RFC 1951), the method ZIP entries use. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new CompressionStream("deflate-raw"));
}

/**
 * Inflates raw DEFLATE data. The output may not exceed `limit` bytes, so a stream that expands past its
 * declared size stops early with a RangeError.
 */
export async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("Inflated data is larger than its declared size.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function throughStream(
  data: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Blob([data.slice()]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(output).arrayBuffer());
}
