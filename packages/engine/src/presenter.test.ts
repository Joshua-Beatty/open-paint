import { describe, expect, it, vi } from "vitest";
import { DISPLAY_TILE_SIZE } from "./display-tiles";
import { DEFAULT_CANVAS_THEME, type FramePlan, frameStyle, type TileDraw } from "./frame";
import { chromeUniform, currentTexture, GpuPresenter, straightPixels, tileQuad } from "./presenter";

function plan(overrides: Partial<FramePlan> = {}): FramePlan {
  return {
    width: 800,
    height: 600,
    zoom: 1,
    canvas: { x: 10, y: 20, width: 300, height: 200 },
    style: frameStyle(DEFAULT_CANVAS_THEME, 2),
    tiles: [],
    wanted: [],
    ...overrides,
  };
}

describe("straightPixels", () => {
  it("divides color back out of coverage and keeps alpha", () => {
    expect([...straightPixels(new Uint8Array([128, 0, 64, 128]))]).toEqual([255, 0, 128, 128]);
  });

  it("leaves fully transparent pixels black", () => {
    expect([...straightPixels(new Uint8Array([0, 0, 0, 0]))]).toEqual([0, 0, 0, 0]);
  });
});

describe("tileQuad", () => {
  it("normalizes the source rectangle by the tile size", () => {
    const draw: TileDraw = {
      tile: { level: 1, tx: 0, ty: 0, pixels: new Uint8Array(0) },
      sampling: "bilinear",
      src: { x: 64, y: 0, width: 64, height: 64 },
      dst: { x: 5, y: 6, width: 30, height: 31 },
    };
    expect(tileQuad(draw)).toEqual([5, 6, 30, 31, 0.5, 0, 1, 0.5]);
    expect(DISPLAY_TILE_SIZE).toBe(128);
  });
});

describe("chromeUniform", () => {
  it("packs the canvas rectangle, checker, shadow and border for the chrome shader", () => {
    const uniform = chromeUniform(plan());
    expect(uniform.length).toBe(20);
    expect([...uniform.slice(0, 8)]).toEqual([10, 20, 300, 200, 800, 600, 8, 8]);
    expect(uniform[8]).toBe(255);
    expect(uniform[9]).toBe(191);
    expect(uniform[15]).toBe(0.5);
    expect([...uniform.slice(16)]).toEqual([0, 0, 0, 0]);
  });

  it("opaque border when a border color is set", () => {
    const style = { ...frameStyle(DEFAULT_CANVAS_THEME, 1), border: [255, 0, 0] as const };
    const uniform = chromeUniform(plan({ style }));
    expect([...uniform.slice(-4)]).toEqual([1, 0, 0, 1]);
  });
});

/** A device that counts tile textures and uploads; every other call returns a stub. */
function countingDevice() {
  const created: { destroyed: boolean }[] = [];
  const uploads: unknown[] = [];
  const stub = (): object =>
    new Proxy(
      {},
      {
        get: (_target, name) => (name === "then" ? undefined : () => stub()),
      },
    );
  const device = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "then") return undefined;
        if (name === "createTexture") {
          return () => {
            const texture = {
              destroyed: false,
              destroy() {
                texture.destroyed = true;
              },
              createView: () => ({}),
            };
            created.push(texture);
            return texture;
          };
        }
        if (name === "popErrorScope") return () => Promise.resolve(null);
        if (name === "queue") {
          return {
            writeBuffer: () => {},
            writeTexture: (destination: { texture: unknown }) => uploads.push(destination.texture),
            submit: () => {},
          };
        }
        return () => stub();
      },
    },
  ) as GPUDevice;
  return { device, created, uploads };
}

describe("GpuPresenter tile textures", () => {
  const tile = (tx: number) => ({ level: 0, tx, ty: 0, pixels: new Uint8Array(128 * 128 * 4) });
  const draw = (t: ReturnType<typeof tile>): TileDraw => ({
    tile: t,
    sampling: "nearest",
    src: { x: 0, y: 0, width: 128, height: 128 },
    dst: { x: 0, y: 0, width: 128, height: 128 },
  });

  it("uploads an edited tile into its texture and reuses the textures of tiles that left the view", async () => {
    const { device, created, uploads } = countingDevice();
    const canvas = { width: 800, height: 600 } as OffscreenCanvas;
    const context = { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const presenter = new GpuPresenter(
      { kind: "direct", canvas, context: context as unknown as GPUCanvasContext },
      device,
      "bgra8unorm",
    );
    await presenter.present(plan({ tiles: [draw(tile(0)), draw(tile(1))] }));
    expect(created).toHaveLength(2);
    // Tile 0 edited (a new tile object): same texture, uploaded again.
    await presenter.present(plan({ tiles: [draw(tile(0)), draw(tile(1))] }));
    expect(created).toHaveLength(2);
    expect(uploads).toHaveLength(4);
    expect(uploads[2]).toBe(created[0]);
    // Tile 1 leaves the view and tile 2 comes in: it takes tile 1's texture.
    await presenter.present(plan({ tiles: [draw(tile(0))] }));
    await presenter.present(plan({ tiles: [draw(tile(0)), draw(tile(2))] }));
    expect(created).toHaveLength(2);
    expect(created.some((texture) => texture.destroyed)).toBe(false);
    presenter.trim();
    expect(created.every((texture) => texture.destroyed)).toBe(true);
  });
});

/** A canvas context that, like Firefox's after `transferToImageBitmap`, forgets its configuration. */
function forgetfulContext(withGetConfiguration: boolean) {
  let configured: GPUCanvasConfiguration | null = null;
  const texture = {} as GPUTexture;
  const context = {
    configure: vi.fn((configuration: GPUCanvasConfiguration) => {
      configured = configuration;
    }),
    getCurrentTexture: vi.fn(() => {
      if (!configured) throw new DOMException("Canvas not configured", "InvalidStateError");
      return texture;
    }),
    ...(withGetConfiguration && { getConfiguration: () => configured }),
    forget: () => {
      configured = null;
    },
  };
  return { context, texture };
}

describe("currentTexture", () => {
  const configuration = { format: "bgra8unorm" } as GPUCanvasConfiguration;

  it.each([true, false])(
    "configures the context again once it lost its configuration (getConfiguration: %s)",
    (withGetConfiguration) => {
      const { context, texture } = forgetfulContext(withGetConfiguration);
      context.configure(configuration);
      const gpuContext = context as unknown as GPUCanvasContext;
      expect(currentTexture(gpuContext, configuration)).toBe(texture);
      expect(context.configure).toHaveBeenCalledTimes(1);
      context.forget();
      expect(currentTexture(gpuContext, configuration)).toBe(texture);
      expect(context.configure).toHaveBeenLastCalledWith(configuration);
      expect(context.configure).toHaveBeenCalledTimes(2);
    },
  );

  it("rethrows other errors", () => {
    const context = {
      configure: vi.fn(),
      getCurrentTexture: () => {
        throw new TypeError("lost");
      },
    } as unknown as GPUCanvasContext;
    expect(() => currentTexture(context, configuration)).toThrow(TypeError);
  });
});
