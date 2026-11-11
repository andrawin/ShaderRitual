"""
Wreck the Seawall town: called by tools/prep-scenes.py on the ocean diorama
before export (or alone, to look: Blender ... --python tools/wreck-seawall.py).

A landslide has come off the cliff. Deterministic (fixed seed):
  - each house subsides and tilts as a whole; inside it, walls crack loose,
    planks fall flat and roofs cave in;
  - the power poles lean;
  - boulders in the cliff's own stone pour down onto the houses and the edge of
    the street, each dropped onto whatever is below it.
"""
import bmesh, bpy, math, random
from mathutils import Matrix, Vector

HOUSE = ('Wood_Grain_Red', 'wood_Grain', 'Wood_Planks', 'Concrete_Soft', 'Trim_One', 'Roof_Tiles',
         'Stone_Concrete_Flaky', 'Interior', 'Lots_of_Objects', 'Stone_Grave', 'bush')
POLE = ('Wood_Stripped_Log', 'Plastic_White')


def _bounds(o):
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs))), \
        Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))


def _turn(o, pivot, axis, angle, drop=0.0):
    m = Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-pivot)
    o.matrix_world = Matrix.Translation((0, 0, -drop)) @ m @ o.matrix_world


def _cluster(objs, radius):
    groups = []
    for o in objs:
        lo, hi = _bounds(o)
        c = (lo + hi) / 2
        for g in groups:
            if (Vector((g['c'].x, g['c'].y)) - Vector((c.x, c.y))).length < radius:
                g['o'].append(o)
                break
        else:
            groups.append({'c': c, 'o': [o]})
    return groups


def wreck(seed=97):
    rnd = random.Random(seed)
    sc = bpy.context.scene
    meshes = [o for o in sc.objects if o.type == 'MESH' and o.material_slots and o.material_slots[0].material]
    mat = lambda o: o.material_slots[0].material.name

    # Houses: east of the street, below the cliff top; not the terrain sheets.
    houses = []
    for o in meshes:
        lo, hi = _bounds(o)
        c, d = (lo + hi) / 2, hi - lo
        if any(k in mat(o) for k in HOUSE) and 1.5 < c.x < 13.8 and -13.5 < c.y < 9.5 and max(d.x, d.y) < 12:
            houses.append(o)
    groups = _cluster(houses, 4.5)
    for g in groups:
        lo = min((_bounds(o)[0] for o in g['o']), key=lambda v: v.z)
        pivot = Vector((g['c'].x, g['c'].y, lo.z))
        a = rnd.uniform(0, math.tau)
        tilt = math.radians(rnd.uniform(4, 11))
        sink = rnd.uniform(0.2, 0.8)
        for o in g['o']:
            _turn(o, pivot, Vector((math.cos(a), math.sin(a), 0)), tilt, sink)
        for o in g['o']:
            olo, ohi = _bounds(o)
            base = Vector(((olo.x + ohi.x) / 2, (olo.y + ohi.y) / 2, olo.z))
            r = rnd.random()
            b = rnd.uniform(0, math.tau)
            ax = Vector((math.cos(b), math.sin(b), 0))
            if 'Roof' in mat(o) and r < 0.65:
                _turn(o, base, ax, math.radians(rnd.uniform(14, 34)), rnd.uniform(0.8, 2.0))  # caved in
            elif r < 0.15 and (ohi - olo).length < 6:
                _turn(o, base, ax, math.radians(rnd.uniform(60, 88)), 0)  # fallen flat
            elif r < 0.55:
                _turn(o, base, ax, math.radians(rnd.uniform(3, 14)), rnd.uniform(0, 0.3))  # cracked loose
                _turn(o, base, Vector((0, 0, 1)), math.radians(rnd.uniform(-10, 10)))
    print(f'[wreck] {len(houses)} house parts in {len(groups)} houses')

    # Poles: every part of a pole leans together, from its foot.
    poles = []
    for o in meshes:
        lo, hi = _bounds(o)
        if any(k in mat(o) for k in POLE) or ('Metal_Rusted' in mat(o) and hi.z - lo.z > 6):
            poles.append(o)
    for g in _cluster(poles, 1.6):
        foot = min((_bounds(o)[0] for o in g['o']), key=lambda v: v.z)
        pivot = Vector((g['c'].x, g['c'].y, foot.z))
        a = rnd.uniform(0, math.tau)
        lean = math.radians(rnd.uniform(9, 22))
        for o in g['o']:
            _turn(o, pivot, Vector((math.cos(a), math.sin(a), 0)), lean)
    print(f'[wreck] {len(poles)} pole parts leaning')

    # The landslide: boulders in the cliff's stone, dropped onto what is below.
    stone = next((m for m in bpy.data.materials if 'Stone_Cliffs' in m.name), None)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    rocks = bmesh.new()
    placed = 0
    for i in range(520):
        # Densest at the cliff's foot (y ~ 4..9), thinning out across the town.
        y = 9.5 - abs(rnd.gauss(0, 6.5))
        x = rnd.uniform(1.0, 13.5)
        if y < -12:
            continue
        big = rnd.random() < 0.18
        r = rnd.uniform(0.6, 1.8) if big else rnd.uniform(0.12, 0.55)
        # The street (x < 2.6) keeps a way through: only pebbles land there.
        if x < 2.6 and r > 0.22:
            continue
        hit, loc, nrm, *_ = sc.ray_cast(dg, Vector((x, y, 40)), Vector((0, 0, -1)), distance=60)
        if not hit:
            continue
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=2, radius=r)
        luv = tmp.loops.layers.uv.verify()
        for v in tmp.verts:
            n = v.co.normalized()
            k = 1 + 0.28 * math.sin(n.x * 5 + i) * math.sin(n.y * 4 - i * 0.7) + rnd.uniform(-0.08, 0.08)
            v.co = n * r * k
            v.co.z *= 0.7
        rot = Matrix.Rotation(rnd.uniform(0, math.tau), 4, 'Z') @ Matrix.Rotation(rnd.uniform(-0.4, 0.4), 4, 'X')
        bmesh.ops.transform(tmp, matrix=Matrix.Translation(loc + nrm * r * 0.45) @ rot, verts=tmp.verts)
        # Box-projected UVs, scaled to the cliff texture's grain.
        for f in tmp.faces:
            fn = f.normal
            ax = max(range(3), key=lambda k: abs(fn[k]))
            for l in f.loops:
                c = l.vert.co
                u, v = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][ax]
                l[luv].uv = (u * 0.15, v * 0.15)
        me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(me)
        tmp.free()
        rocks.from_mesh(me)
        bpy.data.meshes.remove(me)
        placed += 1
    me = bpy.data.meshes.new('Landslide')
    rocks.to_mesh(me)
    rocks.free()
    for p in me.polygons:
        p.use_smooth = False
    # The cliff material multiplies its texture by a 'Color' attribute; give the
    # rocks one too, lighter on top and darker underneath, as the cliff is shaded.
    col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
    for poly in me.polygons:
        k = 0.45 + 0.4 * max(0.0, poly.normal.z)
        for li in poly.loop_indices:
            col.data[li].color = (k, k, k, 1.0)
    ob = bpy.data.objects.new('Landslide', me)
    sc.collection.objects.link(ob)
    if stone:
        ob.data.materials.append(stone)
    print(f'[wreck] {placed} boulders')


if __name__ == '__main__':
    import os, sys
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'tools', 'source', 'ocean.glb'))
    wreck()
