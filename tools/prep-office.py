"""
Prepare the Overtime scene's model.

    Blender --background --factory-startup --python tools/prep-office.py -- \
        [--in tools/source/office.glb] [--out public/scenes/office.glb] [--tex 2048]

"office is old abandoned FREE" by dasy444 (CC-BY-4.0, see tools/source/
office-license.txt) is a photoscanned-texture room with fourteen dead CRT
monitors. To light them up in the app, their glass has to be its own surface
with its own 0..1 UV, which the scanned atlases do not give. So, per monitor:

  - its front is the horizontal axis that faces into the room;
  - the screen is every face that looks out of that front, sits in the front
    half of the monitor, and falls inside the bezel (the inner part of the
    front's outline);
  - those faces move to a material of their own — CRT_Screen for the beige
    monitors with intact glass, CRT_Broken for the black ones with smashed
    glass — with a planar UV across the screen in TEXCOORD_0, and the
    monitor's index in TEXCOORD_1.x, so each screen can show something
    different.

Then the two 4096² atlases come down to the --tex size, and the GLB is
exported with Meshopt geometry and WebP textures (both decoded by the app's
loader), which takes it from 42 MB to a few.
"""
import bpy
import bmesh
import json
import os
import sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    if f'--{name}' in argv:
        return type(default)(argv[argv.index(f'--{name}') + 1])
    return default


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, arg('in', 'tools/source/office.glb'))
DST = os.path.join(ROOT, arg('out', 'public/scenes/office.glb'))
TEX = arg('tex', 2048)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene

KINDS = {'Material.006': ('CRT_Screen', 0), 'Material.007': ('CRT_Broken', 1)}


def screen_material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.02, 0.025, 0.03, 1)
    b.inputs['Roughness'].default_value = 0.15
    return m


report = []
index = 0
monitors = []
for o in scene.objects:
    if o.type != 'MESH' or not o.material_slots:
        continue
    src = o.material_slots[0].material
    if src is None or src.name not in KINDS:
        continue
    monitors.append(o)
# A stable order, so a screen keeps its index from one prep to the next.
monitors.sort(key=lambda o: o.name)

for o in monitors:
    mat_name, kind = KINDS[o.material_slots[0].material.name]
    me = o.data
    mw = o.matrix_world
    nm = mw.to_3x3().inverted().transposed()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    wc = [mw @ v.co for v in bm.verts]
    lo = Vector((min(c.x for c in wc), min(c.y for c in wc), min(c.z for c in wc)))
    hi = Vector((max(c.x for c in wc), max(c.y for c in wc), max(c.z for c in wc)))
    cen = (lo + hi) / 2

    # Front: of the four horizontal directions, the one facing most nearly
    # into the room that the monitor actually has front faces for.
    to_room = Vector((-cen.x, -cen.y, 0)).normalized()
    best = None
    for d in (Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 1, 0)), Vector((0, -1, 0))):
        area = sum(f.calc_area() for f in bm.faces if (nm @ f.normal).normalized().dot(d) > 0.8)
        score = area * (0.25 + max(0.0, d.dot(to_room)))
        if best is None or score > best[0]:
            best = (score, d)
    front = best[1]
    side = Vector((-front.y, front.x, 0))  # screen's horizontal axis, left to right as you face it
    up = Vector((0, 0, 1))

    # The front's outline, from the faces looking out of it.
    fronts = [f for f in bm.faces if (nm @ f.normal).normalized().dot(front) > 0.55]
    def proj(p):
        return (p - cen).dot(side), (p - cen).dot(up), (p - cen).dot(front)
    pts = [proj(mw @ v.co) for f in fronts for v in f.verts]
    s0, s1 = min(p[0] for p in pts), max(p[0] for p in pts)
    u0, u1 = min(p[1] for p in pts), max(p[1] for p in pts)
    depth = max((hi - lo).dot(Vector(map(abs, front))), 1e-6)
    # Inside the bezel: the inner part of the front, a little higher than
    # centre (a CRT's bezel is deeper at the bottom).
    sm, um = 0.13 * (s1 - s0), 0.12 * (u1 - u0)
    screen_faces = []
    for f in fronts:
        c = proj(mw @ f.calc_center_median())
        if not (s0 + sm < c[0] < s1 - sm and u0 + um * 1.4 < c[1] < u1 - um * 0.8):
            continue
        if c[2] < -0.05 * depth:  # the back half is not the screen
            continue
        screen_faces.append(f)

    if not screen_faces:
        report.append((o.name, 'no screen found'))
        bm.free()
        continue

    # Screen extents, for its 0..1 UV.
    sp = [proj(mw @ v.co) for f in screen_faces for v in f.verts]
    a0, a1 = min(p[0] for p in sp), max(p[0] for p in sp)
    b0, b1 = min(p[1] for p in sp), max(p[1] for p in sp)

    sm_mat = screen_material(mat_name)
    if sm_mat.name not in [s.material.name for s in o.material_slots if s.material]:
        o.data.materials.append(sm_mat)
    slot = [s.material.name if s.material else '' for s in o.material_slots].index(sm_mat.name)

    uv0 = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.active or bm.loops.layers.uv.new('UVMap')
    uv1 = bm.loops.layers.uv.get('ScreenId') or bm.loops.layers.uv.new('ScreenId')
    for f in bm.faces:
        for l in f.loops:
            l[uv1].uv = (-1.0, 0.0)  # not a screen
    for f in screen_faces:
        f.material_index = slot
        for l in f.loops:
            p = proj(mw @ l.vert.co)
            l[uv0].uv = ((p[0] - a0) / max(a1 - a0, 1e-6), (p[1] - b0) / max(b1 - b0, 1e-6))
            l[uv1].uv = (float(index), float(kind))
    bm.to_mesh(me)
    bm.free()
    report.append((o.name, mat_name, index, len(screen_faces), round(a1 - a0, 3), round(b1 - b0, 3),
                   [round(v, 2) for v in cen], [round(v, 2) for v in front]))
    index += 1

for r in report:
    print('[prep]', r, flush=True)
print(f'[prep] {index} screens', flush=True)

# --- Textures: the two 4096² atlases come down to TEX. --------------------------
for img in bpy.data.images:
    if img.size[0] > TEX or img.size[1] > TEX:
        w, h = img.size
        f = TEX / max(w, h)
        img.scale(int(w * f), int(h * f))
        print('[prep] scaled', img.name, (w, h), '->', tuple(img.size), flush=True)

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=DST, export_format='GLB',
    export_texcoords=True, export_normals=True,
    export_materials='EXPORT', export_image_format='WEBP', export_image_quality=85,
    export_meshopt_compression_enable=True,
    export_cameras=False, export_lights=False, export_extras=False, export_animations=False,
    export_yup=True,
)
print(f'[prep] wrote {DST}: {os.path.getsize(DST) / 1e6:.2f} MB', flush=True)
json.dump(report, open(os.path.join(ROOT, '.bake', 'office', 'prep-report.json'), 'w'), indent=1)
