"""Build the Neapolis synth-drone walkthrough scene.
Usage: python3 build-neapolis.py <out.blend>   (bpy module), or
       blender -b -P build-neapolis.py -- <out.blend>
Set UP below to the folder holding the six source GLBs (credits in README).
"""
import bpy, math, random, sys
import numpy as np
from mathutils import Vector, Matrix, Euler

OUT = sys.argv[-1] if sys.argv[-1].endswith('.blend') else '/home/claude/work/neapolis_synth_drone.blend'
UP = '/mnt/user-data/uploads/'
MAP_SCALE = 2.5          # map comes in ~11.7 units wide -> ~29 m site, ~7 m deep
FPS = 30
random.seed(7)

# name, file, yaw fix so the front panel faces -Y, size rule, extra copies (scenery only)
SYNTHS = [
    ('Minimoog-style', '047e7090-synthesizer.glb',  -90, ('width', 0.72), 1, 0.2),
    ('TR-808',         '2beeef73-tr-808.glb',          0, ('width', 0.77), 1, 0.2),
    ('Grandmother',    'moog_grandmother_semi-modular_analog_synthesizer.glb', 0, ('width', 0.80), 1, 0.2),
    ('Stage keyboard', '1a984d8f-synthgen-v1_o2.glb',  0, ('width', 1.25), 1, 0.2),
    ('Modular cabinet','garys_synthesizer.glb',        0, ('height', 1.45), 0, None),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = FPS


def world_bbox(objs, pct=None):
    """Bounding box over mesh vertices. pct trims stray verts (percentile)."""
    pts = []
    for o in objs:
        if o.type != 'MESH':
            continue
        m = o.matrix_world
        co = np.empty(len(o.data.vertices) * 3)
        o.data.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        if len(co) > 20000:
            co = co[np.random.default_rng(0).choice(len(co), 20000, replace=False)]
        R = np.array(m.to_3x3()); t = np.array(m.translation)
        pts.append(co @ R.T + t)
    P = np.vstack(pts)
    if pct:
        return Vector(np.percentile(P, pct, axis=0)), Vector(np.percentile(P, 100 - pct, axis=0))
    return Vector(P.min(0)), Vector(P.max(0))


def import_glb(path, coll_name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    coll = bpy.data.collections.new(coll_name)
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    return coll, new


def shrink_images(max_px):
    for im in bpy.data.images:
        if im.size[0] > max_px and not im.get('_keep'):
            im.scale(max_px, max(1, int(im.size[1] * max_px / im.size[0])))
            im.file_format = 'JPEG' if im.channels < 4 else 'PNG'
            im.pack()
        im['_keep'] = 1


# ---------------------------------------------------------------- map
map_coll, map_objs = import_glb(UP + 'neapolis_greek_walls.glb', 'MAP_NeapolisWalls')
sc.collection.children.link(map_coll)
for im in bpy.data.images:
    im['_keep'] = 1          # keep the 4K photogrammetry texture
map_root = bpy.data.objects.new('MAP_root', None)
map_coll.objects.link(map_root)
for o in map_objs:
    if o.parent is None:
        o.parent = map_root
map_root.scale = (MAP_SCALE,) * 3
bpy.context.view_layer.update()
mn, mx = world_bbox(map_objs)
map_root.location = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
bpy.context.view_layer.update()
MAP_MIN, MAP_MAX = world_bbox(map_objs)
print('MAP', MAP_MIN, MAP_MAX)
map_meshes = [o for o in map_objs if o.type == 'MESH']

dg = bpy.context.evaluated_depsgraph_get()


def ray(o, d, dist=1e4):
    hit, loc, nor, idx, ob, _ = sc.ray_cast(dg, o, d, distance=dist)
    return (loc, nor) if hit else (None, None)


def down(x, y):
    loc, nor = ray(Vector((x, y, MAP_MAX.z + 5)), Vector((0, 0, -1)))
    if loc is None or nor.z < 0.8:
        return None
    return loc.z


# ---------------------------------------------------------------- synth prototypes
protos = []
lib = bpy.data.collections.new('SYNTH_prototypes')
sc.collection.children.link(lib)
for name, fn, yaw, (rule, val), extra, PCT in SYNTHS:
    coll, objs = import_glb(UP + fn, 'proto_' + name)
    lib.children.link(coll)
    shrink_images(1024)
    root = bpy.data.objects.new('root_' + name, None)
    coll.objects.link(root)
    for o in objs:
        if o.parent is None:
            o.parent = root
    root.rotation_euler = (0, 0, math.radians(yaw))
    bpy.context.view_layer.update()
    a, b = world_bbox(objs, pct=PCT)
    dims = b - a
    s = val / (dims.x if rule == 'width' else dims.z)
    root.scale = (s,) * 3
    bpy.context.view_layer.update()
    a, b = world_bbox(objs, pct=PCT)
    lo, _ = world_bbox(objs, pct=0.01 if PCT else None)
    # origin = centre of footprint, bottom on z=0
    root.location -= Vector(((a.x + b.x) / 2, (a.y + b.y) / 2, lo.z))
    bpy.context.view_layer.update()
    a, b = world_bbox(objs, pct=PCT)
    dims = b - a
    print('PROTO', name, 'dims m', tuple(round(v, 3) for v in dims))
    protos.append(dict(name=name, coll=coll, dims=dims, extra=extra))
bpy.context.view_layer.layer_collection.children['SYNTH_prototypes'].exclude = True


# ---------------------------------------------------------------- placement
def footprint_pts(c, yaw, w, d, nx=6, ny=4, margin=1.0):
    R = Matrix.Rotation(yaw, 2)
    out = []
    for i in range(nx):
        for j in range(ny):
            u = (i / (nx - 1) - 0.5) * w * margin
            v = (j / (ny - 1) - 0.5) * d * margin
            p = R @ Vector((u, v))
            out.append(Vector((c.x + p.x, c.y + p.y)))
    return out


def try_place(c, yaw, dims, tol):
    pts = footprint_pts(c, yaw, dims.x, dims.y)
    hs = []
    for p in pts:
        h = down(p.x, p.y)
        if h is None:
            return None
        hs.append(h)
    hs = np.array(hs)
    # fit a plane z = ax + by + c to the support points
    A = np.c_[[p.x for p in pts], [p.y for p in pts], np.ones(len(pts))]
    coef, *_ = np.linalg.lstsq(A, hs, rcond=None)
    resid = hs - A @ coef
    if resid.max() - resid.min() > tol:
        return None
    n = Vector((-coef[0], -coef[1], 1)).normalized()
    if n.z < math.cos(math.radians(7)):      # too steep for a box to sit still
        return None
    # rest on the highest bump relative to the plane, so nothing sinks in
    base = coef[0] * c.x + coef[1] * c.y + coef[2] + resid.max()
    # clearance: nothing above the footprint within synth height + 0.4 m
    for p in pts[::2] + [c]:
        hz = coef[0] * p.x + coef[1] * p.y + coef[2] + resid.max()
        loc, _ = ray(Vector((p.x, p.y, hz + 0.03)), Vector((0, 0, 1)), dims.z + 0.4)
        if loc is not None:
            return None
    # side clearance at mid height
    mid = Vector((c.x, c.y, base + dims.z * 0.5))
    for k in range(8):
        a = yaw + k * math.pi / 4
        dvec = Vector((math.cos(a), math.sin(a), 0))
        reach = abs(math.cos(a - yaw)) * dims.x / 2 + abs(math.sin(a - yaw)) * dims.y / 2 + 0.25
        loc, _ = ray(mid, dvec, reach)
        if loc is not None:
            return None
    return base, n


placed = []          # dict(proto, loc, rot, hero)
MIN_SEP = 3.2


def place(proto, hero, region_pick):
    dims = proto['dims']
    tol = 0.05 if dims.z < 0.5 else 0.035
    best = None
    for _ in range(4000):
        x = random.uniform(MAP_MIN.x + 1, MAP_MAX.x - 1)
        y = random.uniform(MAP_MIN.y + 1, MAP_MAX.y - 1)
        c = Vector((x, y))
        if any((c - p['c']).length < MIN_SEP for p in placed):
            continue
        yaw = random.uniform(-math.pi, math.pi)
        r = try_place(c, yaw, dims, tol)
        if r is None:
            continue
        base, n = r
        score = region_pick(c, base) + min([(c - p['c']).length for p in placed] + [8]) * 0.6
        if best is None or score > best[0]:
            best = (score, c, yaw, base, n)
        if _ > 600 and best is not None and _ % 200 == 0:
            break
    if best is None:
        raise RuntimeError('no spot for ' + proto['name'])
    _, c, yaw, base, n = best
    tilt = Vector((0, 0, 1)).rotation_difference(n).to_matrix().to_4x4()
    M = Matrix.Translation(Vector((c.x, c.y, base))) @ tilt @ Matrix.Rotation(yaw, 4, 'Z')
    placed.append(dict(proto=proto, c=c, yaw=yaw, base=base, M=M, hero=hero))
    print('PLACED', proto['name'], 'hero' if hero else 'extra', round(c.x, 2), round(c.y, 2), round(base, 2),
          'tilt deg', round(math.degrees(math.acos(min(1, n.z))), 2))


# heroes spread over different parts of the ruin: pit floor, rooms, wall tops
rnd = lambda c, z: random.random()
low = lambda c, z: -z * 0.6 + random.random()
high = lambda c, z: z * 0.6 + random.random()
picks = [low, rnd, high, rnd, low]
order = [4, 3, 1, 2, 0]      # place the big ones first
for i in order:
    place(protos[i], True, picks[i])
for p in protos:
    for _ in range(p['extra']):
        place(p, False, rnd)

synth_coll = bpy.data.collections.new('SYNTHS_placed')
sc.collection.children.link(synth_coll)
heroes = []
for k, p in enumerate(placed):
    inst = bpy.data.objects.new(('HERO_' if p['hero'] else 'extra_') + p['proto']['name'], None)
    inst.instance_type = 'COLLECTION'
    inst.instance_collection = p['proto']['coll']
    inst.matrix_world = p['M']
    synth_coll.objects.link(inst)
    p['obj'] = inst
    if p['hero']:
        heroes.append(p)

# ---------------------------------------------------------------- camera tour
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()


def clear(a, b):
    d = b - a
    L = d.length
    if L < 1e-4:
        return True
    loc, _ = ray(a, d.normalized(), L)
    return loc is None


def free_space(p, r=0.45):
    for d in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
              (.7, .7, 0), (-.7, .7, 0), (.7, -.7, 0), (-.7, -.7, 0)]:
        loc, _ = ray(p, Vector(d).normalized(), r)
        if loc is not None:
            return False
    return True


def viewpoint(p, ang_off, extra=0.0):
    dims = p['proto']['dims']
    size = max(dims.x, dims.y, dims.z)
    tgt = p['M'] @ Vector((0, 0, dims.z * 0.45))
    best = None
    for dist_k in (1.5, 1.25, 1.8, 1.1, 2.2):
        for da in (0, 20, -20, 40, -40, 60, -60, 90, -90, 135, -135, 180):
            a = p['yaw'] - math.pi / 2 + math.radians(da + ang_off)   # front = local -Y
            dist = size * dist_k + 0.6 + extra
            h = size * 0.55 + 0.7 + extra * 0.5
            v = tgt + Vector((math.cos(a) * dist, math.sin(a) * dist, h))
            dvec = tgt - v
            if free_space(v) and clear(v, v + dvec * max(0.0, 1 - (size * 0.6) / dvec.length)):
                return v, tgt
    raise RuntimeError('no viewpoint for ' + p['proto']['name'])


def seg_ok(a, b, n=12):
    if not clear(a, b):
        return False
    return all(free_space(a.lerp(b, i / n), 0.3) for i in range(n + 1))


_hp = {}
def hover_pair(p):
    key_ = id(p)
    if key_ in _hp:
        return _hp[key_]
    for arc in (18, 12, 7):
        try:
            va, t = viewpoint(p, -arc)
            vb, _ = viewpoint(p, arc, extra=-0.25)
        except RuntimeError:
            continue
        if seg_ok(va, vb) and (va - vb).length < 2.5:
            _hp[key_] = (va, vb, t); return _hp[key_]
    va, t = viewpoint(p, 0)
    vb = va.lerp(t, 0.18)              # slow push-in instead of an arc
    _hp[key_] = (va, vb, t)
    return _hp[key_]


# visit order: nearest-neighbour from the corner furthest from site centre
rem = heroes[:]
start = max(rem, key=lambda p: p['c'].length)
tour = [start]; rem.remove(start)
while rem:
    nxt = min(rem, key=lambda p: (p['c'] - tour[-1]['c']).length)
    tour.append(nxt); rem.remove(nxt)
print('TOUR', [p['proto']['name'] for p in tour])

cam_data = bpy.data.cameras.new('DroneCam')
cam_data.lens = 22
cam_data.clip_start = 0.05
cam_data.clip_end = 300
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 11.0
cam = bpy.data.objects.new('DroneCam', cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
look = bpy.data.objects.new('DroneLookTarget', None)
sc.collection.objects.link(look)
tr = cam.constraints.new('TRACK_TO')
tr.target = look
tr.track_axis = 'TRACK_NEGATIVE_Z'
tr.up_axis = 'UP_Y'
cam_data.dof.focus_object = look

INTRO, HOVER, TRANSIT, OUTRO = 150, 105, 95, 150
SITE_C = Vector(((MAP_MIN.x + MAP_MAX.x) / 2, (MAP_MIN.y + MAP_MAX.y) / 2, MAP_MAX.z * 0.4))


def key(obj, f, loc):
    obj.location = loc
    obj.keyframe_insert('location', frame=f)


def max_height_along(a, b, n=30):
    m = -1e9
    for i in range(n + 1):
        p = a.lerp(b, i / n)
        h = down(p.x, p.y)
        if h is None:
            loc, _ = ray(Vector((p.x, p.y, MAP_MAX.z + 5)), Vector((0, 0, -1)))
            h = loc.z if loc else MAP_MIN.z
        m = max(m, h)
    return m


ADJ = []   # adjustable (frame) waypoints
f = 1
first_v, _, first_t = hover_pair(tour[0])
d0 = (first_v - first_t); d0.z = 0; d0.normalize()
intro_start = first_t + d0 * 22 + Vector((0, 0, MAP_MAX.z + 9))
key(cam, f, intro_start); key(look, f, SITE_C)
mid = first_t + d0 * 9 + Vector((0, 0, MAP_MAX.z + 2.5))
key(cam, f + INTRO * 0.55, mid); ADJ.append(f + INTRO * 0.55)
f += INTRO
markers = []
for i, p in enumerate(tour):
    va, vb, t = hover_pair(p)
    key(cam, f, va); key(look, f, t)
    markers.append((f, p['proto']['name']))
    key(look, f + HOVER, t + Vector((0, 0, -0.03)))
    key(cam, f + HOVER, vb)
    f += HOVER
    if i < len(tour) - 1:
        na, _, nt = hover_pair(tour[i + 1])
        top = max(max_height_along(vb, na), vb.z, na.z)
        m1 = vb.lerp(na, 0.5); m1.z = top + 1.6
        key(cam, f + TRANSIT * 0.5, m1); ADJ.append(f + TRANSIT * 0.5)
        key(look, f + TRANSIT * 0.45, nt + Vector((0, 0, 0.4)))
        f += TRANSIT
end_v = SITE_C + (vb - SITE_C).normalized() * 4
key(cam, f + OUTRO * 0.5, Vector((vb.x, vb.y, MAP_MAX.z + 2.0)).lerp(SITE_C, 0.2)); ADJ.append(f + OUTRO * 0.5)
dout = (vb - SITE_C); dout.z = 0; dout.normalize()
key(cam, f + OUTRO, SITE_C + dout * 20 + Vector((0, 0, MAP_MAX.z + 10)))
key(look, f + OUTRO, SITE_C)
sc.frame_start, sc.frame_end = 1, int(f + OUTRO)

for fr, name in markers:
    sc.timeline_markers.new(name, frame=int(fr))

# collision check of the flight path: raise the nearest transit waypoint until clear
def cam_fcurves(ob):
    act = ob.animation_data.action
    if hasattr(act, 'fcurves'):
        return list(act.fcurves)
    return [fc for l in act.layers for st in l.strips for cb in st.channelbags for fc in cb.fcurves]

for fc in cam_fcurves(cam) + cam_fcurves(look):
    for kp in fc.keyframe_points:
        kp.interpolation = 'BEZIER'
        kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
    fc.update()

def cam_at(fr):
    return Vector([fc.evaluate(fr) for fc in sorted([c for c in cam_fcurves(cam) if c.data_path == 'location'], key=lambda c: c.array_index)])

for it in range(25):
    blocked = []
    prev = cam_at(sc.frame_start)
    for fr in np.arange(sc.frame_start + 1, sc.frame_end + 1, 1.0):
        p = cam_at(fr)
        if not clear(prev, p) or not free_space(p, 0.25):
            blocked.append(fr)
        prev = p
    if not blocked:
        break
    bumped = set()
    for fr in blocked:
        k = min(ADJ, key=lambda a: abs(a - fr))
        if abs(k - fr) > 70 or k in bumped:
            continue
        bumped.add(k)
        zc = [c for c in cam_fcurves(cam) if c.data_path == 'location' and c.array_index == 2][0]
        for kp in zc.keyframe_points:
            if abs(kp.co.x - k) < 0.5:
                kp.co.y += 0.7
        zc.update()
    print('PATH iter', it, 'blocked frames', len(blocked), 'first', blocked[:6])
print('PATH blocked after fix:', len(blocked), blocked[:10])

# drone hand-held feel: tiny noise on the look target and camera
for ob, amp, scale in ((cam, 0.025, 35), (look, 0.02, 50)):
    for fc in cam_fcurves(ob):
        if fc.data_path == 'location':
            mod = fc.modifiers.new('NOISE')
            mod.strength = amp * 2
            mod.scale = scale
            mod.phase = random.uniform(0, 100)

# ---------------------------------------------------------------- light + world
sun_d = bpy.data.lights.new('Sun', 'SUN')
sun_d.energy = 4.0
sun_d.angle = math.radians(1.5)
sun_d.color = (1.0, 0.9, 0.78)
sun = bpy.data.objects.new('Sun', sun_d)
sun.rotation_euler = Euler((math.radians(42), 0, math.radians(35)))
sc.collection.objects.link(sun)

world = bpy.data.worlds.new('Sky')
sc.world = world
world.use_nodes = True
nt = world.node_tree
bg = nt.nodes['Background']
grad = nt.nodes.new('ShaderNodeTexGradient')
tc = nt.nodes.new('ShaderNodeTexCoord')
mp = nt.nodes.new('ShaderNodeMapping')
mp.inputs['Rotation'].default_value = (0, math.radians(-90), 0)
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color = (0.85, 0.72, 0.6, 1)
ramp.color_ramp.elements[1].position = 0.65
ramp.color_ramp.elements[1].color = (0.33, 0.5, 0.78, 1)
nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
nt.links.new(mp.outputs['Vector'], grad.inputs['Vector'])
nt.links.new(grad.outputs['Fac'], ramp.inputs['Fac'])
nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
bg.inputs['Strength'].default_value = 1.1

# photogrammetry has the sun baked in: make it less shiny so the added sun doesn't double up
for o in map_meshes:
    for slot in o.material_slots:
        m = slot.material
        if m and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    n.inputs['Roughness'].default_value = 0.95
                    if 'Specular IOR Level' in n.inputs:
                        n.inputs['Specular IOR Level'].default_value = 0.1

# ---------------------------------------------------------------- render settings
sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE_NEXT'
sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
sc.render.resolution_percentage = 100
try:
    sc.eevee.taa_render_samples = 32
    sc.eevee.use_shadows = True
except Exception:
    pass
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Medium High Contrast'
try:
    sc.render.image_settings.media_type = 'VIDEO'
except Exception:
    pass
sc.render.image_settings.file_format = 'FFMPEG'
sc.render.ffmpeg.format = 'MPEG4'
sc.render.ffmpeg.codec = 'H264'
sc.render.ffmpeg.constant_rate_factor = 'HIGH'
sc.render.filepath = '//render/neapolis_synth_drone_'

for im in bpy.data.images:
    if im.is_dirty or im.size[0] <= 1024:
        im.file_format = 'JPEG'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True)
print('SAVED', OUT, 'frames', sc.frame_end)
