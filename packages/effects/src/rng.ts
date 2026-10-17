import {
  add_noise_seed,
  crystalize_seed,
  dents_seed,
  frost_map_randoms,
  frost_seed,
  noise_rgba8,
} from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import type { Int32Property } from "@openpaint/properties";

/** The Seed property's range (FX-A-00-05): 0 to 255. */
export const SEED_MAX = 255;

/**
 * The Randomize button (FX-A-00-05): an integer 0-255 seed shown only as a button, which increments
 * the seed on each press and wraps from 255 to 0. Pressing it gives a new pattern.
 */
export function seedProperty(): Int32Property {
  return {
    kind: "int32",
    key: "seed",
    label: "property.noCaption",
    defaultValue: 0,
    min: 0,
    max: SEED_MAX,
    control: {
      controlType: "incrementButton",
      buttonText: "property.randomize",
      rangeWraps: true,
    },
  };
}

/**
 * A fresh instance seed (FX-A-00-05): one 32-bit value per effect instance, so opening an effect
 * again gives a different pattern even at Seed 0. Only the instance seed is random; it is not stored
 * as a parameter.
 */
export function createInstanceSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/**
 * The effective seed of the render effects with an 8-bit Seed (Clouds, Turbulence): the user's Seed
 * XOR the low byte of the instance seed, so each opening gives a fresh pattern (FX-A-00-05).
 */
export function renderSeed(userSeed: number, instanceSeed: number): number {
  return (userSeed ^ instanceSeed) & SEED_MAX;
}

/** The effective seed of Add Noise: `userSeed XOR instanceSeed` (FX-A-00-05). */
export function addNoiseSeed(userSeed: number, instanceSeed: number): number {
  return add_noise_seed(userSeed, instanceSeed);
}

/** The effective seed of Crystalize (FX-A-00-05). */
export function crystalizeSeed(userSeed: number, instanceSeed: number): number {
  return crystalize_seed(userSeed, instanceSeed);
}

/** The effective noise seed of Dents, in 0-255 (FX-A-00-05). */
export function dentsSeed(userSeed: number, instanceSeed: number): number {
  return dents_seed(userSeed, instanceSeed);
}

/** One random value per Frosted Glass sample map, generated once per effect instance. */
export function frostMapRandoms(instanceSeed: number, count: number): Uint32Array {
  return frost_map_randoms(instanceSeed, count);
}

/** The effective seed of one Frosted Glass sample map (FX-A-00-05, FX-DIST-FROST-03). */
export function frostSeed(userSeed: number, instanceSeed: number, mapRandom: number): number {
  return frost_seed(userSeed, instanceSeed, mapRandom);
}

/** The Rust reference of the per-pixel generator: a noise image of the given size and seed. */
export function noiseCpu(width: number, height: number, seed: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(noise_rgba8(width, height, seed)));
}
