import bpy, sys, json, math, heapq
from mathutils import Vector
src, out, targets, zlo, zhi = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene; dg = bpy.context.evaluated_depsgraph_get()
W = json.load(open(out + '_walk.json'))
P = [Vector(p[:3]) for p in W['pts'] if zlo <= p[2] <= zhi]
clear = [p[3] for p in W['pts'] if zlo <= p[2] <= zhi]
def los(a, b, r=0.25):
    d = b - a; L = d.length
    if L < 1e-6: return True
    n = d / L
    side = Vector((-n.y, n.x, 0)).normalized() * r if abs(n.z) < 0.99 else Vector((r, 0, 0))
    for off in (Vector((0, 0, 0)), side, -side, Vector((0, 0, -0.35)), Vector((0, 0, 0.15))):
        if sc.ray_cast(dg, a + off, n, distance=L)[0]: return False
    return True
nb = [[] for _ in P]
for i in range(len(P)):
    for j in range(i + 1, len(P)):
        d = (P[i] - P[j]).length
        if d < 0.95 and abs(P[i].z - P[j].z) < 0.45 and los(P[i], P[j], 0.2):
            nb[i].append((j, d)); nb[j].append((i, d))
def nearest(xy):
    return min(range(len(P)), key=lambda i: (P[i].x - xy[0]) ** 2 + (P[i].y - xy[1]) ** 2)
def dijkstra(s, t):
    dist = {s: 0}; prev = {}; q = [(0, s)]
    while q:
        d, u = heapq.heappop(q)
        if u == t: break
        if d > dist[u]: continue
        for v, w in nb[u]:
            # prefer roomy points: cost grows where clearance is tight
            nd = d + w * (1 + 0.6 / max(0.3, clear[v]))
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = u; heapq.heappush(q, (nd, v))
    if t not in dist: return None
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    return path[::-1]
idx = [nearest(t) for t in targets]
full = []
for k in range(len(idx)):
    seg = dijkstra(idx[k], idx[(k + 1) % len(idx)])
    if seg is None: print('NOPATH', k, targets[k], targets[(k + 1) % len(idx)]); sys.exit(1)
    full += seg[:-1]
pts = [P[i] for i in full]
n = len(pts)
# Smooth the grid staircase (wrapping: it is a loop), then thin it out.
for _ in range(3):
    pts = [(pts[(i - 1) % n] + pts[i] * 2 + pts[(i + 1) % n]) / 4 for i in range(n)]
simp = pts[::2]
bad = sum(1 for i in range(len(simp)) if not los(simp[i], simp[(i + 1) % len(simp)], 0.12))
print('PATH', n, '->', len(simp), 'blocked', bad)
# glTF axes: (x, z, -y)
json.dump([[round(p.x, 2), round(p.z, 2), round(-p.y, 2)] for p in simp], open(out + '_path.json', 'w'))
