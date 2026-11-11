import bpy, sys, json, math
from mathutils import Vector
src, out, grid = sys.argv[1], sys.argv[2], int(sys.argv[3])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene; dg = bpy.context.evaluated_depsgraph_get()
lo = Vector((1e9,)*3); hi = Vector((-1e9,)*3)
for o in sc.objects:
    if o.type != 'MESH': continue
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c); lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
size = hi - lo
H = [Vector((math.cos(a), math.sin(a), 0)) for a in [i * math.pi / 8 for i in range(16)]]
pts = []
for ix in range(grid):
    for iy in range(grid):
        x = lo.x + size.x * (ix + 0.5) / grid; y = lo.y + size.y * (iy + 0.5) / grid
        z = hi.z - 0.05
        for _ in range(8):
            hit, loc, nrm, *_ = sc.ray_cast(dg, Vector((x, y, z)), Vector((0, 0, -1)), distance=z - lo.z + 1)
            if not hit: break
            if nrm.z > 0.7:
                eye = loc + Vector((0, 0, 1.6))
                # headroom above the floor point, and horizontal clearance at eye height
                up, uloc, *_ = sc.ray_cast(dg, loc + Vector((0, 0, 0.05)), Vector((0, 0, 1)), distance=1.8)
                if not up:
                    cl = min(((sc.ray_cast(dg, eye, d, distance=3)[1] - eye).length if sc.ray_cast(dg, eye, d, distance=3)[0] else 3) for d in H)
                    cl2 = min(((sc.ray_cast(dg, loc + Vector((0,0,0.8)), d, distance=3)[1] - loc - Vector((0,0,0.8))).length if sc.ray_cast(dg, loc + Vector((0,0,0.8)), d, distance=3)[0] else 3) for d in H)
                    # enclosed: something above (ceiling) and around
                    ceil = sc.ray_cast(dg, eye, Vector((0, 0, 1)), distance=size.z * 2)[0]
                    if min(cl, cl2) > 0.35 and ceil:
                        pts.append([round(eye.x, 2), round(eye.y, 2), round(eye.z, 2), round(min(cl, cl2), 2)])
            z = loc.z - 0.05
json.dump({'lo': list(lo), 'hi': list(hi), 'pts': pts}, open(out + '_walk.json', 'w'))
print('WALK', len(pts))
