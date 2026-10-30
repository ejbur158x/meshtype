# Vendored libraries

Copied unmodified from npm so Meshtype runs offline and doesn't depend on a CDN. All MIT licensed.

| Library | Version | Files |
| --- | --- | --- |
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | `three/three.module.js`, `three/three.core.js`, `three/addons/` (OrbitControls, TransformControls, GLTFExporter, OBJExporter) |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | 0.9.17 | `three-mesh-bvh.module.js` (source map comment removed) |
| [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | 0.0.18 | `three-bvh-csg.module.js` (source map comment removed) |

The import map in `index.html` points the bare specifiers (`three`, `three/addons/`, `three-mesh-bvh`, `three-bvh-csg`) at these files.

To update, install the newer versions with npm and copy the same files over.
