"""
Hang cables in the Engine Room.

    python tools/engine-cables.py      (with `pip install bpy`), or
    Blender --background --factory-startup --python tools/engine-cables.py

Loads the engine-room scan (tools/source/engine-room.glb), finds the deckhead
and the undersides of the pipes by casting rays straight up, and strings
cables between them: hundreds, mostly in loose bundles that sag in parallel,
like a theatre rig or a ship mid-refit. Each cable is checked against the
scan along its length, and kept above head height wherever it crosses the
walk (shaders/scene-engine-room.ts PATH). A few are cut and left dangling
near the walk, at about head height: those are where the sparks come from.

Writes shaders/engine-cables.json in glTF axes:
  cables:   [ax, ay, az, bx, by, bz, sag, radius, colour, seed]  (sag in m, down)
  dangling: [ax, ay, az, length, sway, radius, colour]
"""
import bpy, json, math, os, random, sys
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'tools', 'source', 'engine-room.glb'))
sc = bpy.context.scene
dg = bpy.context.evaluated_depsgraph_get()
random.seed(7)

import re
_ts = open(os.path.join(ROOT, 'shaders', 'scene-engine-room.ts')).read()
PATH = json.loads(re.search(r'const PATH: number\[\]\[\] = (\[.*?\]\]);', _ts, re.S).group(1))
# glTF (x, y, z) -> Blender (x, -z, y)
WALK = [Vector((p[0], -p[2], p[1])) for p in PATH]
EYE = sum(p.z for p in WALK) / len(WALK)


def to_gltf(v):
    return [round(v.x, 3), round(v.z, 3), round(-v.y, 3)]


def up_hit(x, y, z0=EYE):
    hit, loc, n, *_ = sc.ray_cast(dg, Vector((x, y, z0)), Vector((0, 0, 1)), distance=6)
    return loc if hit and loc.z > z0 + 0.6 else None


def near_walk(p, r):
    return min(((p.x - w.x) ** 2 + (p.y - w.y) ** 2) ** 0.5 for w in WALK) < r


def curve(a, b, sag, n=12):
    pts = []
    for i in range(n + 1):
        t = i / n
        p = a.lerp(b, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    return pts


def clear(pts):
    for i in range(len(pts) - 1):
        d = pts[i + 1] - pts[i]
        # Start a hair inside the segment so the anchors' own surfaces don't count.
        hit = sc.ray_cast(dg, pts[i] + d * 0.02, d.normalized(), distance=d.length * 0.96)[0]
        if hit:
            return False
    return True


# The reference's cable colours: greens, teals, cream, red, orange, pale blue.
PALETTE = 7
cables, dangling = [], []
tries = 0
while len(cables) < 760 and tries < 40000:
    tries += 1
    x, y = random.uniform(-10, 10.5), random.uniform(-9, 9.3)
    a = up_hit(x, y)
    if a is None:
        continue
    ang = random.uniform(0, math.tau)
    span = random.uniform(1.5, 6.5)
    b = up_hit(x + math.cos(ang) * span, y + math.sin(ang) * span)
    if b is None:
        continue
    count = random.choice([1, 2, 4, 6, 8, 10, 12, 16])
    base_sag = random.uniform(0.8, 3.0)
    colour = random.randrange(PALETTE)
    made = 0
    for k in range(count):
        off = Vector((random.gauss(0, 0.08), random.gauss(0, 0.08), 0))
        aa, bb = a + off, b + off
        sag = base_sag * random.uniform(0.8, 1.25)
        pts = curve(aa, bb, sag)
        low = min(pts, key=lambda p: p.z)
        # Never across the camera's face: over the walk, stay above head height.
        if any(near_walk(p, 0.9) and p.z < EYE + 0.45 for p in pts):
            sag = max(0.15, min(aa.z, bb.z) - (EYE + 0.5))
            pts = curve(aa, bb, sag)
        if low.z < 2.0 or not clear(pts):
            continue
        cables.append(to_gltf(aa) + to_gltf(bb) + [round(sag, 3), round(random.uniform(0.012, 0.03), 4),
                      colour if random.random() > 0.25 else random.randrange(PALETTE), round(random.random(), 3)])
        made += 1
print('[cables]', len(cables), 'tries', tries)

tries = 0
while len(dangling) < 16 and tries < 20000:
    tries += 1
    w = random.choice(WALK)
    ang = random.uniform(0, math.tau)
    d = random.uniform(0.9, 2.2)
    a = up_hit(w.x + math.cos(ang) * d, w.y + math.sin(ang) * d)
    if a is None or near_walk(a, 0.75):
        continue
    end_z = EYE + random.uniform(-0.2, 0.7)
    length = a.z - end_z
    if length < 0.6:
        continue
    end = Vector((a.x, a.y, end_z))
    if not clear([a, end]):
        continue
    dangling.append(to_gltf(a) + [round(length, 3), round(random.uniform(0.05, 0.25), 3),
                    round(random.uniform(0.015, 0.03), 4), random.randrange(PALETTE)])
print('[dangling]', len(dangling))
json.dump({'cables': cables, 'dangling': dangling}, open(os.path.join(ROOT, 'shaders', 'engine-cables.json'), 'w'), separators=(',', ':'))
