# Meshtype

**v0.1.0.** A tiny browser mesh editor for squircles and glossy Frutiger Aero shapes, with boolean union, subtract and intersect, and GLB export. No install, no build step, works offline.

Made because Blender is overkill when all you need is a rounded panel with a dent in it.

## Run it

It uses ES modules, so opening `index.html` by double-click won't work in most browsers. Serve the folder instead:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

Or push it to GitHub Pages as-is. Everything it needs is in this repo, including the libraries (`vendor/`).

## How it works

- **Add shape** drops a primitive at the origin: Block, Panel, Disc, Orb, or Pill.
- **Squircle shapes** are superellipsoids with two sliders. *Outline n* shapes the top view, *Edge n* shapes the side profile. `n = 2` is round, `n = 4` is the classic squircle, `n = 20` is nearly a box.
- **Layers** are evaluated top to bottom. The first layer is the base. Every layer after it is **Add** (union), **Subtract** (cut it out of everything above), or **Intersect** (keep only the overlap). Reorder with Move up / Move down.
- **Cut faces take the material of the layer doing the cutting**, so a dark Subtract layer gives you a dark inner recess.
- **Cages** show the wireframe of every layer. Subtract layers show in red and Intersect layers in green, always. **Result** toggles between the boolean result and the raw parts.
- **Materials**: Aero glass, Gloss plastic, Bubble, Frosted glass, Chrome, Matte, Glow. Pick one, then tint it.

## Shortcuts

| Key | Action |
| --- | --- |
| `W` `E` `R` | Move, Rotate, Scale |
| `F` | Center the camera on the selection |
| `Esc` | Deselect |
| `Delete` | Delete the selected layer |
| `Ctrl+D` | Duplicate |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |

Snap is on by default (0.05 units, 15 degrees). Orbit with left-drag, pan with right-drag, zoom with the wheel.

## Export

- **Export GLB** writes the boolean result with its materials (transmission, clearcoat, iridescence and so on, as glTF extensions).
- **Geometry only** exports plain white geometry with no materials. Use it when you want to build the materials yourself in Godot or Three.js. Transmission and iridescence don't import everywhere.
- **OBJ** exports geometry only.
- **Save / Open** use a `.meshtype.json` file. The editor also autosaves to your browser's local storage.

Units are 1 unit = 1 meter. Y is up.

## Layout

```
index.html        page, import map
style.css         the Aero skin
src/shapes.js     squircle + pill geometry generators
src/materials.js  material presets + procedural sky
src/main.js       editor: scene, layers, booleans, UI, export
vendor/           three.js, three-mesh-bvh, three-bvh-csg (see vendor/README.md)
```

## Known limits (v0.1.0)

- Booleans are live, so keep Detail at 2 or 3 on dense scenes.
- Negative scale is not supported (scale is clamped to 0.01 and up).
- Very thin features can misbehave in booleans (a general CSG limit). If you see a sliver, nudge the cutting layer a little.
- One material per layer.
- No sculpting or per-vertex editing. Meshtype is a generator and combiner, not a modeler.
