import { Surface } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { NEIGHBORHOOD_TILE_PIXELS, runTiledBlur, TILES_PER_BATCH } from "./gpu-neighborhood-blur";

/**
 * A device that records submissions and waits. Submitted work is done one task later, as on a GPU
 * that keeps up; `queued` counts tile command buffers submitted but not yet done.
 */
function recordingDevice() {
  const log = { submits: [] as number[], waits: 0, maxQueued: 0, queued: 0 };
  const buffer = (size: number) => ({
    size,
    mapAsync: async () => undefined,
    getMappedRange: (_offset = 0, length = size) => new ArrayBuffer(length),
    unmap: () => undefined,
    destroy: () => undefined,
  });
  const device = {
    createBuffer: ({ size }: { size: number }) => buffer(size),
    createBindGroup: () => ({}),
    createCommandEncoder: () => {
      let tiles = 0;
      return {
        beginComputePass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => {
            tiles += 1;
          },
          end: () => undefined,
        }),
        copyBufferToBuffer: () => undefined,
        finish: () => ({ tiles }),
      };
    },
    queue: {
      writeBuffer: () => undefined,
      submit: (buffers: { tiles: number }[]) => {
        const tiles = buffers.reduce((sum, item) => sum + item.tiles, 0);
        log.submits.push(buffers.length);
        log.queued += tiles;
        log.maxQueued = Math.max(log.maxQueued, log.queued);
        setTimeout(() => {
          log.queued -= tiles;
        }, 0);
      },
      onSubmittedWorkDone: () => {
        log.waits += 1;
        return new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 0));
      },
    },
  };
  return { device: device as unknown as GPUDevice, log };
}

describe("runTiledBlur", () => {
  it("submits tiles in batches, with at most two batches queued and one wait per batch", async () => {
    const { device, log } = recordingDevice();
    const pipeline = { getBindGroupLayout: () => ({}) } as unknown as GPUComputePipeline;
    const width = NEIGHBORHOOD_TILE_PIXELS * 9 + 5;
    const height = NEIGHBORHOOD_TILE_PIXELS * 7;
    const tiles = 10 * 7;
    const out = await runTiledBlur(
      device,
      pipeline,
      new Surface(width, height),
      32,
      () => new ArrayBuffer(32),
    );
    expect(out.width).toBe(width);
    const batches = Math.ceil(tiles / TILES_PER_BATCH);
    // One submission per batch (each tile its own command buffer), then the readback.
    expect(log.submits.slice(0, -1)).toEqual([
      ...Array<number>(batches - 1).fill(TILES_PER_BATCH),
      tiles - (batches - 1) * TILES_PER_BATCH,
    ]);
    expect(log.waits).toBe(batches);
    expect(log.maxQueued).toBeLessThanOrEqual(2 * TILES_PER_BATCH);
  });
});
