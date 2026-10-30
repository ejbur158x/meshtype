# Meshtype

**v0.2.2.** A tiny browser mesh editor for squircles and glossy Frutiger Aero shapes. Solid and cutter parts, UNION / NEGATE / SPLIT, edge rounding, SVG extrusion, multi-select, and GLB export. No build step. Installable as an app and works offline.

Made because Blender is overkill when all you need is a rounded panel with a dent in it.

## Run it

It uses ES modules, so double-clicking `index.html` won't work in most browsers. Serve the folder:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

Or push it to GitHub Pages as-is. Everything it needs is in this repo, including the libraries (`vendor/`).

**Install it:** in Chrome or Edge use the install button in the address bar (or the Install app button in Meshtype's title bar). After the first load it runs fully offline.

## The combine model

Every shape is either a **solid** or a **cutter** (shown in red). A cutter does nothing on its own. It only cuts when you UNION it with a solid.

| Button | What it does |
| --- | --- |
| **UNION** (`U`) | Blends the selected parts into one solid. Cutters in the selection are subtracted. Two cubes become clearly one part. |
| **NEGATE** (`N`) | Flips the selection between solid and cutter. |
| **SPLIT** (`X`) | Takes a union apart into its separate parts. Each part keeps its solid/cutter state. With nothing selected it splits every union. |
| Intersect | Keeps only where the selected parts overlap. |

A union is one object: it bakes into a single new shape, so selecting it highlights the result, not the cutters inside. NEGATE a union to turn the whole baked shape into a cutter (shown as a red ghost) and union it with something else. The original parts are kept, so SPLIT can always take it back apart. Click it and the gizmo moves the whole thing. Click a part in the Parts list to edit that part alone (its shape, material, position). Unions can nest. Cut faces take the material of the cutter.

## Selecting

- **Click** a shape in the viewport or the Parts list.
- **Ctrl or Shift + click** to add or remove from the selection.
- **Alt + click** in the viewport picks the part inside a union.
- **Right-click** for the context menu: Union, Negate, Split, Center, Align, Duplicate, Hide, Rename, Frame, Select all, Delete. Right-click empty space to add shapes or import an SVG.

With several things selected the gizmo moves them together.

## Camera

| Key | Action |
| --- | --- |
| `W` `S` | Fly forward / back |
| `A` `D` | Strafe left / right |
| `E` `Q` | Up / down |
| `Shift` | Fine movement (held) |
| `Ctrl` | Fast movement (held) |

**Mouse:** right-drag orbits, middle-drag pans, the wheel zooms, and left-drag draws a selection box (an object is selected when at least 80% of it is inside the box; hold Shift or Ctrl to add). Right-click without dragging opens the menu.

**View cube** (top right of the viewport): click a face for that view, or drag it to orbit.

**Sky** (button in the viewport toolbar): the Aero sky, a solid color (swatches or any color), or your own equirectangular panorama (JPG or PNG, shrunk to 2048 px wide). The panorama can also drive the reflections on glass. Ctrl+W closes a browser tab and no page can stop that, but Meshtype asks for confirmation if you hit it while flying, so you don't lose work.

## Other shortcuts

| Key | Action |
| --- | --- |
| `1` `2` `3` | Move, Rotate, Scale gizmo |
| `F` | Focus the camera on the selection (everything if nothing is selected) |
| `C` | Duplicate |
| `Esc` | Deselect |
| `Delete` | Delete the selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |

## Center and Align

In the right panel under **Arrange**:

- **Center** moves the selection so its middle sits at world 0. Untick X, Y or Z to leave an axis alone.
- **Align**: click X, Y or Z and a blue plane shows where things will land. Choose which edge to align (Min, Center, Max) and what to align to (Average, the Active (last picked) item, Lowest, Highest, or World 0), then press Align. A union moves as one thing.

## Round edges

Select a finished solid or union and use **Round edges** in the right panel:

- **Outer edges** rounds convex corners and edges (where a surface bends away). Intersecting shapes usually leave sharp ones.
- **Inner edges** rounds concave corners (where two surfaces meet, or a cut ends).
- **Quality** is the voxel resolution. Higher is smoother and slower.
- **Sander** smooths away the faint ripples the voxel rebuild can leave on curved surfaces (default 3). The rounder also rebuilds each part at a much higher detail first, so the facets of a low-detail shape don't show up as bands.

A green progress bar in the status bar shows how far along it is.

It rebuilds the shape as a smooth mesh in a background worker, so the editor stays responsive. Exports use the rounded mesh. The rebuilt mesh is dense (tens of thousands of triangles), so use Low or Draft when the model is going into a game, and decimate if you need it lighter. Radius is in world units. If it is under about 1.5 voxels the result gets blocky, so raise Quality.

Rounding is applied to a top-level part or union. If you union a rounded part into something else, its round setting is cleared; round the finished union instead.

## SVG import

**SVG** in Add shape (or drag an `.svg` onto the viewport) extrudes it into a part. It is centered, scaled to 2 units on its longest side, and Y-up. Then use Extrude depth and Round edges to finish it.

- Filled shapes and paths work. Strokes are ignored, so convert strokes to filled paths first.
- Holes (even-odd or opposite winding) work.
- Overlapping filled shapes in the same SVG can leave internal faces that confuse booleans. Merge them in your SVG editor first.

## Materials and textures

Aero glass, Gloss plastic, Bubble, Frosted glass, Chrome, Matte, Glow. Pick one, then tint it. With a union selected, the material, tint and texture apply to every part in it.

**Texture**: Image… loads a picture (shrunk to 1024 px) and box-projects it onto the shape. Tile size sets how big one repeat is in world units. The tint multiplies the image, so set it to white to see the image colors as-is. It is a simple box projection, so expect seams where a surface turns between directions. Textures export with the GLB.

## Export

- **Export GLB** writes every visible solid with its materials (transmission, clearcoat, iridescence and so on, as glTF extensions).
- **Geometry only** exports plain white geometry with no materials. Use it when you want to build the materials yourself in Godot or Three.js. Transmission and iridescence don't import everywhere.
- **Export OBJ** exports geometry only.
- **Save / Open** use a `.meshtype.json` file (SVGs are embedded). The editor also autosaves to your browser's local storage.

Cutters alone export nothing. Units: 1 unit = 1 meter. Y is up.

## Layout

```
index.html              page, import map
style.css               the Windows 7 Aero skin
manifest.webmanifest    PWA manifest
sw.js                   service worker (network first, offline fallback)
precache.json           file list for the service worker (generated)
icons/                  app icons
src/main.js             editor: scene, parts, unions, UI, export
src/shapes.js           squircle + pill geometry generators
src/svg.js              SVG -> extruded geometry
src/rounder.js          edge rounder (signed distance field)
src/round-worker.js     runs the rounder off the main thread
src/materials.js        material presets + procedural sky
tools/                  build-precache.mjs, make-icons.mjs
tests/                  rounder.test.mjs, e2e.mjs, e2e-controls.mjs, e2e-union.mjs
vendor/                 three.js, three-mesh-bvh, three-bvh-csg (see vendor/README.md)
```

## Deploying a change

The service worker caches the whole app. After you edit any file, regenerate the file list so returning users get the update:

```sh
node tools/build-precache.mjs
```

## Known limits (v0.2.2)

- Booleans are live, so keep Detail at 2 or 3 on dense scenes.
- Scaling a rotated part from a multi-selection gizmo can introduce shear, which Meshtype can't store. Use Scale on single parts for that.
- Very thin features can misbehave in booleans (a general CSG limit). If you see a sliver, nudge the cutter a little.
- Round edges is global to the unit and produces a dense mesh. It can't round just one edge.
- No sculpting or per-vertex editing. Meshtype is a generator and combiner, not a modeler.
- Projects from v0.1.0 open as one union (cutters become red parts). Intersect layers become plain parts.

## Tests

```sh
node tests/rounder.test.mjs     # fillet volume matches the analytic answer
node tests/e2e.mjs              # real-browser check (needs Playwright); serve the repo on :8123 first
```
