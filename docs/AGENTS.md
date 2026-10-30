# Building rooms with Meshtype (for Claude, Astra and anyone else)

Meshtype bakes Frutiger Aero shapes, curved walls and boolean cuts into game-ready GLBs, so nobody has to fight Godot's mesh tools for non-standard shapes. Rooms are small JSON files; the CLI turns them into a GLB, a manifest and a preview picture.

## Setup (once)

```sh
git clone https://github.com/ejbur158x/meshtype
cd meshtype
npm install
npx playwright install chromium
```

Node 18 or newer. If Chromium can't be downloaded, point `MESHTYPE_CHROMIUM` at any Chrome or Chromium executable instead. The CLI runs the real editor in a hidden browser, so its output is exactly what the Export button makes.

## Loop

1. Write `rooms/<name>.meshtype.json` (format: `docs/FORMAT.md`; example: `examples/hall-a.meshtype.json`).
2. `node tools/meshtype.mjs check rooms/<name>.meshtype.json` and fix every ERROR. Read the warnings.
3. `node tools/meshtype.mjs build rooms/<name>.meshtype.json --out <game>/assets/rooms`.
4. **Open `<name>.preview.png` and look at it.** Walls touching? Doorways cut through? Nothing floating or sunk into the floor? Fix and rebuild. This is the step that saves the most tokens and rework.
5. Commit the `.meshtype.json` (the source), the `.glb`, the `.room.json` and the preview.

Several files at once: `node tools/meshtype.mjs build rooms/*.meshtype.json --out ...`. Add `--strict` to fail on warnings too.

## Conventions (so rooms snap together like Legos)

- **Origin**: the room's floor center is at `[0, 0, 0]`; floor top at `y = 0`.
- **Grid**: 1 m. Room footprints are whole meters; walls sit on grid lines.
- **Walls**: `box`, 0.2 m thick, centered on the room edge (so the wall's center line is the boundary). Default height 3 m.
- **Doorways**: cutters 1.2 m wide × 2.4 m tall, centered on a whole-meter mark of the wall, cutting all the way through (cutter thickness ≥ wall + 0.2). Tag the union `door` (plus `keycard`, `locked`, ... as needed).
- **Hallways**: tag the room `hall`; curved halls use `bend` on the walls (inner and outer wall share the same angle and center).
- **Names**: unique and readable (`Wall North`, `Door East`), because they become the Godot node names.
- **Lights**: at least one per room, inside the walls, below the ceiling.
- **Keep it light**: plain boxes for structure; squircles, rounding and glass for things people look at. Rounding is dense, so use it on props, not on walls.

## In Godot

Import the GLB as a scene. With the default collision naming, every mesh except `no-collide` ones gets a static collision body. Read `name.room.json` (or the glTF extras) to find doors, triggers and lights by tag and attach scripts. Rooms are placed by their origin, so two rooms built on the same grid with matching doorway positions line up.

## Building in CI (optional)

`docs/rooms-workflow.yml` is a GitHub Actions template for the game repo: on every push it checks and builds `rooms/*.meshtype.json` and commits the GLBs and previews, so an agent that can only edit files still gets built rooms.
