# Meshtype room format

A room is one JSON file, `name.meshtype.json`. You can write it by hand (or as an agent), open it in the editor (Open), or build it with the CLI (`docs/AGENTS.md`). The editor saves the same format with every field written out; both the editor and the CLI also accept the shorter **authoring form** described here.

## Units and axes

- Meters. **+Y is up.** The floor top is usually at `y = 0`.
- `pos` is the **center** of the thing, `[x, y, z]`. A 3 m tall wall standing on the floor has `y = 1.5`.
- `rot` is Euler degrees `[x, y, z]`, applied in XYZ order. `[0, 90, 0]` turns a thing a quarter turn on the floor.
- `size` (or `scl`) is the size in meters for `box` and `squircle` (their base shape is a 1 m cube). For `pill` and `svg` it is a multiplier.
- A wall runs along its **X** (length), **Y** is height, **Z** is thickness. So a wall along the Z axis gets `rot: [0, 90, 0]`.

## File

```json
{
  "name": "hall-a",
  "floor":  { "grid": 0.5, "show": true },
  "floors": [ { "name": "Floor", "pos": [0, 0, 0], "w": 8, "d": 6, "rotY": 0, "preset": "tile" } ],
  "nodes":  [ ...parts, unions, lights... ],
  "assets": { "logo": "<svg ...>...</svg>" }
}
```

| Key | Meaning |
| --- | --- |
| `name` | Room name. Exports use it (slugged) unless the file name says otherwise. |
| `floor.grid` | Snap size in the editor: `0.05`, `0.25`, `0.5`, `1` or `2`. Rooms that join up should share one. |
| `floor.show` | `false` hides and skips all floors. |
| `floors[]` | Baseplates. `pos` is the center of the **top face**; `w` (along X) and `d` (along Z) in meters; `rotY` degrees; `preset`: `carpet`, `tile`, `lab`, `grid`, `concrete`. Exported as slabs 6 cm thick. |
| `nodes[]` | Everything else, below. |
| `assets` | SVG text for `svg` parts, by key. In the CLI the value can also be a path to an `.svg` file, relative to the room file. |

## Parts

```json
{ "name": "Wall North", "type": "box", "pos": [0, 1.5, -3], "size": [8, 3, 0.2], "mat": "matte", "color": "#e6ebf0", "tags": ["room"] }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | `box` | `box`, `squircle`, `pill`, `svg` |
| `params` | per type | see below |
| `pos`, `rot`, `size` | `[0,0,0]`, `[0,0,0]`, `[1,1,1]` | see Units |
| `neg` | `false` | `true` makes it a **cutter** (only does something inside a union) |
| `mat` | `glass` | `glass`, `gloss`, `bubble`, `frosted`, `chrome`, `matte`, `glow` |
| `color` | per material | `#rrggbb` tint |
| `visible` | `true` | hidden things don't export |
| `tags` | none | see Tags |
| `round` | none | `{ "outer": 0.05, "inner": 0.03, "res": 64, "sand": 3 }` rounds edges (top-level parts and unions only). Radius in meters; `res` 40 (light) to 200 (slow); `sand` 0 to 10 smooths ripples. Rounded meshes are dense: use sparingly. |
| `name` | auto | shows in the editor and becomes the node name in the GLB |

### Shape params

| type | params | notes |
| --- | --- | --- |
| `box` | `bend` -360..360 (deg) | Sharp, 12 triangles at `bend: 0`. `bend` curves the whole length (X) around the vertical axis so the two ends are exactly `bend` degrees apart: 90 = quarter-turn hallway wall, 180 = U. Keep thickness under the curve radius (`length / bend in radians`). Use boxes for walls, floors, ceilings, room shells. |
| `squircle` | `nPlan` 2..20, `nProf` 2..20, `detail` 1..4 | Rounded block. `nPlan` = top-view shape, `nProf` = side profile. 2 = round, 4 = classic squircle, 20 = nearly a box. The Aero look. |
| `pill` | `radius` 0.05..0.5, `length` 0..2, `detail` 1..4 | Capsule along Y; height = `length + 2 × radius`, then × size. |
| `svg` | `depth` 0.02..2, `detail` 1..4, plus `"asset": "key"` | Extruded SVG, centered, longest side 2 m before size. Filled shapes only. |

## Unions (combine)

A node with `children` is a **union**. Its solid children are blended into one mesh and its cutters (`neg: true`) are subtracted. That's how doorways, windows and recesses are made.

```json
{
  "name": "Door Wall", "tags": ["room", "door"],
  "children": [
    { "name": "Wall East", "type": "box", "pos": [4, 1.5, 0], "size": [6, 3, 0.2], "rot": [0, 90, 0], "mat": "matte" },
    { "name": "Doorway", "type": "squircle", "params": { "nPlan": 20, "nProf": 6 }, "neg": true, "pos": [4, 1.1, 0], "size": [0.6, 2.4, 1.2], "mat": "gloss", "color": "#2aa8ff" }
  ]
}
```

- Child `pos`/`rot`/`size` are **world** values, not relative to the union.
- The faces a cutter leaves behind take the **cutter's** material, so a colored cutter makes colored door jambs.
- Make cutters a bit thicker than the wall they cut, so they pass through cleanly.
- `"mode": "int"` keeps only where the children overlap instead.
- A union can be a cutter itself (`"neg": true`) and can sit inside another union.
- Each top-level union exports as **one mesh**.

## Lights

```json
{ "name": "Ceiling Light", "lightType": "point", "pos": [0, 2.5, 0], "intensity": 40, "range": 9, "color": "#eaf6ff" }
{ "name": "Spot", "lightType": "spot", "pos": [0, 2.8, 0], "rot": [-90, 0, 0], "intensity": 80, "range": 10, "angle": 35, "penumbra": 0.3, "shadows": true }
```

`intensity` is candela (try 20 to 150 indoors), `range` meters (0 = no limit). Spots shine along their local -Z; `rot: [-90, 0, 0]` points straight down. They export as glTF lights (Godot `OmniLight3D` / `SpotLight3D`).

## Tags

Short lowercase labels on parts, unions and lights, for whoever wires up the level in Godot: `room`, `hall`, `door`, `archway`, `keycard`, `locked`, `window`, `vent`, `stairs`, `elevator`, `spawn`, `exit`, `trigger`, `alarm`, `camera`, `switch`, `prop`, or anything like `keycard:red`. `no-collide` exports that mesh without collision. Tags land in the GLB (glTF extras `meshtype.tags`) and in `name.room.json`.

## Authoring shortcuts (the editor's Open and the CLI both accept these)

- `id` and `kind` can be left out. A node with `children` is a union, one with `lightType` is a light, anything else is a part.
- `size` instead of `scl`.
- `type` defaults to `box`.
- Nest with `children` instead of `parent` ids.

## What a build produces

- `name.glb`: every visible solid, union, light and floor as **direct children of one root node**, world space, meters, Y up. With collision on (default) mesh names end in `-col`, which Godot turns into a `StaticBody3D` with trimesh collision and strips from the name.
- `name.room.json`: the manifest. For each mesh: `node` (GLB name), `godotName`, `tags`, `position`, `rotationDeg`, `scale`, world `bounds`, `material`. Plus `lights` (type, color, candela, range, angle, shadows), `floors` and `grid`.
- `name.preview.png`: iso, top, front and right views. Look at it before committing.
