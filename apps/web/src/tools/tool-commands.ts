import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { toolShowsOption } from "./roster";
import { DRAWABLE_SHAPES } from "./shape-catalog";
import type { ToolController } from "./tool-controller";

/** The names the A and Shift+A keys cycle through, in picker order. */
const DRAWABLE_SHAPE_IDS = DRAWABLE_SHAPES.map((shape) => shape.id);

/** Brush size keys (TL-HOTKEY-02): `[` and `]` step by 1, Ctrl by 5. */
const SIZE_COMMANDS: readonly (readonly [BuiltInCommandId, number])[] = [
  ["tools.brushSmaller", -1],
  ["tools.brushSmaller5", -5],
  ["tools.brushLarger", 1],
  ["tools.brushLarger5", 5],
];

/** Pen style keys (TL-HOTKEY-02): `,` start cap, `.` dash style, `/` end cap. */
const PEN_COMMANDS: readonly (readonly [BuiltInCommandId, string])[] = [
  ["tools.penStartCap", "pen.startCap"],
  ["tools.penDash", "pen.dashStyle"],
  ["tools.penEndCap", "pen.endCap"],
];

/** Shape type keys (TL-SHAPE-01): `A` next shape, `Shift+A` previous shape. */
const SHAPE_COMMANDS: readonly (readonly [BuiltInCommandId, 1 | -1])[] = [
  ["tools.nextShape", 1],
  ["tools.previousShape", -1],
];

/**
 * Connects the options-bar keys to the active tool (TL-HOTKEY-02). Each key acts only when the
 * active tool shows the matching option. Returns the function that detaches the commands.
 */
export function registerToolOptionCommands(
  commands: ShortcutController<BuiltInCommandId>,
  controller: ToolController,
): () => void {
  const shows = (name: string) => () => toolShowsOption(controller.active.id, name);
  const detach = [
    ...SIZE_COMMANDS.map(([id, delta]) =>
      commands.register(id, {
        run: () => controller.stepOption("brush.size", delta),
        enabled: shows("brush.size"),
      }),
    ),
    ...PEN_COMMANDS.map(([id, name]) =>
      commands.register(id, {
        run: () => controller.cycleOption(name, 1),
        enabled: shows(name),
      }),
    ),
    ...SHAPE_COMMANDS.map(([id, step]) =>
      commands.register(id, {
        run: () => controller.cycleShape(step, DRAWABLE_SHAPE_IDS),
        enabled: () => controller.active.id === "shapes",
      }),
    ),
  ];
  return () => {
    for (const release of detach) release();
  };
}
