import type { Document, TileCoord, TiledPixelStore } from "@openpaint/document";
import type { EngineHandle, StrokeBegin, StrokeCommit } from "@openpaint/engine";
import { acknowledgeEngineTiles } from "../engine-document";

/**
 * Where a Paintbrush or Eraser stroke goes under engine v2: the engine
 * worker paints it on the GPU, and the main thread only forwards samples and records the result.
 */
export interface EngineStrokeChannel {
  begin(begin: StrokeBegin): void;
  /** A batch of samples, flat `x, y, pressure` in image pixels. The buffer moves. */
  samples(samples: Float32Array): void;
  /** Ends the stroke; resolves with its painted tiles once the engine has read them back. */
  end(): Promise<StrokeCommit | undefined>;
  cancel(): void;
  /** The engine already holds these tiles, so the next document sync leaves them out. */
  acknowledge(document: Document, store: TiledPixelStore, tiles: readonly TileCoord[]): void;
}

/** The stroke channel of a running engine, or undefined unless it is engine v2. */
export function engineStrokeChannel(
  engine: EngineHandle | undefined,
  report: (cause: unknown) => void,
): EngineStrokeChannel | undefined {
  if (engine?.version !== "v2") return undefined;
  return {
    begin: (begin) => void engine.strokeBegin(begin).catch(report),
    samples: (samples) => void engine.strokeSamples(samples).catch(report),
    end: () => engine.strokeEnd(),
    cancel: () => void engine.strokeCancel().catch(report),
    acknowledge: acknowledgeEngineTiles,
  };
}
