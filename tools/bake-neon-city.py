"""
Bake the Neon City lightmap.

    Blender --background --factory-startup --python tools/bake-neon-city.py -- \
        [--res 4096] [--samples 128] [--in tools/source/cyberpunk_city.glb] \
        [--out public/scenes/cyberpunk_city.glb] [--work <dir>]

Imports the city, rebuilds the lighting setupNeonCity uses (shaders/scene-neon-city.ts),
packs a second UV map for the lightmap, and bakes three light groups into the
channels of one texture, each in white so the app can tint it live:

    R  the moon and the sky
    G  neon group A (the even lights, tinted by the Neon colour)
    B  neon group B (the odd lights, tinted by the Glow colour)

Each channel is diffuse lighting only (direct and indirect, no albedo), denoised,
then divided by its own scale and gamma-encoded into an 8-bit PNG. The GLB is
exported with Meshopt, the lightmap UV as TEXCOORD_1, and the lightmap embedded as
every lit material's occlusionTexture on texCoord 1 — the one glTF slot that takes
a second UV set and that GLTFLoader loads without help (it becomes aoMap). The
channel scales go in each material's extras as lightmapScale; the app decodes
pow(texel, 2.2) * scale.
"""
import bpy
import bmesh
import json
import math
import os
import struct
import sys
import time

import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    if f'--{name}' in argv:
        return type(default)(argv[argv.index(f'--{name}') + 1])
    return default


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = arg('res', 4096)
SAMPLES = arg('samples', 128)
# The un-baked model (with its vertex AO) lives in tools/source, so a re-bake
# never starts from a file that already carries a lightmap UV.
SRC = os.path.join(ROOT, arg('in', 'tools/source/cyberpunk_city.glb'))
DST = os.path.join(ROOT, arg('out', 'public/scenes/cyberpunk_city.glb'))
WORK = arg('work', os.path.join(ROOT, '.bake'))
os.makedirs(WORK, exist_ok=True)
t0 = time.time()


def log(*a):
    print(f'[bake {time.time() - t0:7.1f}s]', *a, flush=True)


# --- Import. -------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
src_bytes = open(SRC, 'rb').read()
src_tmp = os.path.join(WORK, 'source.glb')
with open(src_tmp, 'wb') as f:
    f.write(src_bytes)
bpy.ops.import_scene.gltf(filepath=src_tmp, merge_vertices=False)

meshes = [o for o in scene.objects if o.type == 'MESH']
faces = [o for o in meshes if len(o.data.polygons) > 0]
lines = [o for o in meshes if len(o.data.polygons) == 0]
log(f'{len(faces)} face meshes ({sum(len(o.data.polygons) for o in faces)} faces), {len(lines)} line meshes')

# --- The app's frame: centred, on the ground, 100 units across. ----------------
# Blender is Z-up; glTF (x, y, z) arrives as Blender (x, -z, y).
lo = Vector((1e30, 1e30, 1e30))
hi = Vector((-1e30, -1e30, -1e30))
for o in meshes:
    mw = o.matrix_world
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(mw)
    w = co @ M[:3, :3].T + M[:3, 3]
    lo = Vector(np.minimum(lo, w.min(0)))
    hi = Vector(np.maximum(hi, w.max(0)))
size = hi - lo
cen = (hi + lo) / 2
S = 100.0 / max(size.x, size.y)
log(f'app scale {S:.6g}, height {size.z * S:.2f}')


def app_to_blender(x, y, z):
    """A point in the app's scene space, in Blender's world."""
    return Vector((x / S + cen.x, cen.y - z / S, y / S + lo.z))


def app_dir(x, y, z):
    return Vector((x, -z, y)).normalized()


# --- Lightmap UV. --------------------------------------------------------------
for o in faces:
    me = o.data
    if len(me.uv_layers) == 0:
        # Keep the lightmap on TEXCOORD_1 everywhere, even on the untextured
        # meshes, so one material patch reads one attribute.
        me.uv_layers.new(name='UVMap')
    lm = me.uv_layers.new(name='Lightmap')
    me.uv_layers.active = lm

bpy.ops.object.select_all(action='DESELECT')
for o in faces:
    o.select_set(True)
bpy.context.view_layer.objects.active = faces[0]
# Margin 0.05 → 1/2000 of the map, two texels at 4096, which the bake's own
# margin then fills.
bpy.ops.uv.lightmap_pack(PREF_CONTEXT='ALL_FACES', PREF_PACK_IN_ONE=True,
                         PREF_NEW_UVLAYER=False, PREF_BOX_DIV=24,
                         PREF_MARGIN_DIV=0.05 * 4096 / RES)
log('lightmap UVs packed')

# --- Bake materials: the app's dark metallic night cladding. -----------------
# Copies, swapped in for the bake and out again before export, so the GLB keeps
# its own materials (clearcoat included).
target = bpy.data.images.new('Lightmap', RES, RES, alpha=False, float_buffer=True)
target.colorspace_settings.name = 'Non-Color'
originals = {}
bake_mats = {}


def bake_copy(mat):
    if mat.name in bake_mats:
        return bake_mats[mat.name]
    m = mat.copy()
    m.name = mat.name + '.bake'
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    textured = bsdf.inputs['Base Color'].is_linked
    lights = mat.name.lower().startswith('lights')
    if lights:
        for l in list(bsdf.inputs['Base Color'].links):
            nt.links.remove(l)
        bsdf.inputs['Base Color'].default_value = (0.05, 0.05, 0.06, 1)
    elif textured:
        mul = nt.nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        mul.inputs[7].default_value = (0.2, 0.2, 0.2, 1)
        src = bsdf.inputs['Base Color'].links[0].from_socket
        nt.links.new(src, mul.inputs[6])
        nt.links.new(mul.outputs[2], bsdf.inputs['Base Color'])
    else:
        c = bsdf.inputs['Base Color'].default_value
        bsdf.inputs['Base Color'].default_value = (c[0] * 0.2, c[1] * 0.2, c[2] * 0.2, 1)
    for name in ('Metallic', 'Roughness', 'Alpha'):
        for l in list(bsdf.inputs[name].links):
            nt.links.remove(l)
    bsdf.inputs['Metallic'].default_value = 0.2 if lights else (0.7 if textured else 0.4)
    bsdf.inputs['Roughness'].default_value = 0.6 if lights else (0.34 if textured else 0.55)
    bsdf.inputs['Alpha'].default_value = 1.0
    img = nt.nodes.new('ShaderNodeTexImage')
    img.image = target
    for n in nt.nodes:
        n.select = False
    img.select = True
    nt.nodes.active = img
    bake_mats[mat.name] = m
    return m


for o in faces:
    originals[o.name] = [s.material for s in o.material_slots]
    for s in o.material_slots:
        s.material = bake_copy(s.material)

# --- Ground: large and dark, for occlusion and the little it bounces. --------
bpy.ops.mesh.primitive_plane_add(size=600 / S, location=app_to_blender(0, -0.02, 0))
ground = bpy.context.active_object
ground.name = 'BakeGround'
gm = bpy.data.materials.new('BakeGround')
gm.use_nodes = True
gb = gm.node_tree.nodes['Principled BSDF']
gb.inputs['Base Color'].default_value = (0.0016, 0.0016, 0.0024, 1)   # 0x050508
gb.inputs['Metallic'].default_value = 0.6
gb.inputs['Roughness'].default_value = 0.5
ground.data.materials.append(gm)

# --- Lights. -------------------------------------------------------------------
# Moon: the app's DirectionalLight at (-40, 80, -30), aimed at the origin. Sky:
# the hemisphere light, here a uniform world. Both white, in the proportion of
# the app's own intensities by luminance — hemi 2.2 × lum(#3a4f9a) = 0.194 of
# irradiance on an open roof, moon 0.9 × lum(#9fb4ff) = 0.426 face on. A
# world of strength k gives a roof π·k.
SKY_E, MOON_E = 0.194, 0.426
bpy.ops.object.light_add(type='SUN')
moon = bpy.context.active_object
moon.data.energy = MOON_E
moon.data.angle = math.radians(1.5)
travel = app_dir(40, -80, 30)
moon.rotation_euler = travel.to_track_quat('-Z', 'Y').to_euler()

world = bpy.data.worlds.new('Sky')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (1, 1, 1, 1)
scene.world = world

# The ten neon lights, exactly where setupNeonCity puts them.
neon = []
N = 10
for i in range(N):
    ang = (i / N) * math.pi * 2 + (i % 2) * 0.4
    r = 12 + i * 4 if i < 4 else 28 + (i % 3) * 8
    p = app_to_blender(math.cos(ang) * r, 1.2 + (i % 3) * 2.2, math.sin(ang) * r)
    bpy.ops.object.light_add(type='POINT', location=p)
    L = bpy.context.active_object
    L.name = f'Neon{i}{"A" if i % 2 == 0 else "B"}'
    L.data.shadow_soft_size = 0.3 / S
    # Watts scale with the square of the model's units; any value works, since
    # each channel is normalised, but keep the floats in a sane range.
    L.data.energy = 1000.0 / (S * S)
    neon.append((L, i % 2 == 0))

# --- Cycles. -------------------------------------------------------------------
scene.render.engine = 'CYCLES'
cy = scene.cycles
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    cy.device = 'GPU'
except Exception as e:  # noqa: BLE001
    log('GPU unavailable, baking on the CPU:', e)
cy.samples = SAMPLES
cy.use_adaptive_sampling = False
cy.use_denoising = False
cy.max_bounces = 6
cy.diffuse_bounces = 3
cy.glossy_bounces = 2
scene.render.bake.margin = max(2, RES // 1024)
scene.render.bake.margin_type = 'EXTEND'

bpy.ops.object.select_all(action='DESELECT')
for o in faces:
    o.select_set(True)
bpy.context.view_layer.objects.active = faces[0]


def bake(label, sky, moon_on, group):
    bg.inputs['Strength'].default_value = SKY_E / math.pi if sky else 0.0
    moon.hide_render = not moon_on
    for L, a in neon:
        L.hide_render = not (group is not None and a == group)
    log(f'baking {label} at {RES}² × {SAMPLES} samples')
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, use_clear=True,
                        margin=scene.render.bake.margin, margin_type='EXTEND')
    px = np.empty(RES * RES * 4, dtype=np.float32)
    target.pixels.foreach_get(px)
    raw = os.path.join(WORK, f'{label}.raw.exr')
    target.filepath_raw = raw
    target.file_format = 'OPEN_EXR'
    target.save()
    return px.reshape(RES, RES, 4)[..., 0].copy(), raw


# --- Denoise: the compositor's OIDN, on each baked image. --------------------
def denoise(raw, label):
    cs = bpy.data.scenes.new('Denoise' + label)
    cs.render.resolution_x = RES
    cs.render.resolution_y = RES
    cs.render.resolution_percentage = 100
    cs.render.engine = 'BLENDER_WORKBENCH'
    cam = bpy.data.objects.new('DenoiseCam', bpy.data.cameras.new('DenoiseCam'))
    cs.collection.objects.link(cam)
    cs.camera = cam
    tree = bpy.data.node_groups.new('Denoise' + label, 'CompositorNodeTree')
    tree.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    cs.compositing_node_group = tree
    img = bpy.data.images.load(raw, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'
    n_in = tree.nodes.new('CompositorNodeImage')
    n_in.image = img
    n_dn = tree.nodes.new('CompositorNodeDenoise')
    for inp in n_dn.inputs:
        if inp.identifier.lower() in ('hdr',):
            inp.default_value = True
    try:
        n_dn.use_hdr = True
    except AttributeError:
        pass
    n_out = tree.nodes.new('NodeGroupOutput')
    tree.links.new(n_in.outputs['Image'], n_dn.inputs['Image'])
    tree.links.new(n_dn.outputs['Image'], n_out.inputs[0])
    cs.view_settings.view_transform = 'Standard'
    out = os.path.join(WORK, f'{label}.denoised.exr')
    cs.render.filepath = out
    cs.render.image_settings.file_format = 'OPEN_EXR'
    cs.render.image_settings.color_depth = '32'
    # The EXR is written linear, untouched by the view transform.
    with bpy.context.temp_override(scene=cs):
        bpy.ops.render.render(write_still=True, scene=cs.name)
    d = bpy.data.images.load(out, check_existing=False)
    px = np.empty(RES * RES * 4, dtype=np.float32)
    d.pixels.foreach_get(px)
    return px.reshape(RES, RES, 4)[..., 0].copy()


channels = []
covered = None
for label, sky, moon_on, group in (('moon', True, True, None),
                                   ('neonA', False, False, True),
                                   ('neonB', False, False, False)):
    raw_px, raw = bake(label, sky, moon_on, group)
    try:
        dn = denoise(raw, label)
        if not np.isfinite(dn).all() or dn.max() <= 0:
            raise RuntimeError('denoiser returned nothing')
    except Exception as e:  # noqa: BLE001
        log(f'denoise failed for {label} ({e}); keeping it noisy')
        dn = raw_px
    m = raw_px > 0
    covered = m if covered is None else (covered | m)
    # Denoising leaks a little into the empty space between islands; keep it
    # there (it pads the islands) but never let it go negative.
    channels.append(np.maximum(dn, 0.0))
    log(f'{label}: mean {dn[m].mean() if m.any() else 0:.4g}, max {dn.max():.4g}')
scene.render.engine = 'CYCLES'

# --- Encode: per channel scale, gamma 2.2, 8-bit. --------------------------------
scales = []
enc = np.zeros((RES, RES, 4), dtype=np.float32)
enc[..., 3] = 1.0
for c, ch in enumerate(channels):
    vals = ch[covered]
    sc = float(np.percentile(vals, 99.8)) if vals.size else 1.0
    sc = max(sc, 1e-8)
    scales.append(sc)
    enc[..., c] = np.clip(ch / sc, 0, 1) ** (1 / 2.2)
log('channel scales', scales)
out_img = bpy.data.images.new('LightmapPNG', RES, RES, alpha=False, float_buffer=False)
out_img.colorspace_settings.name = 'Non-Color'
out_img.pixels.foreach_set(enc.ravel())
png_path = os.path.join(WORK, 'lightmap.png')
out_img.filepath_raw = png_path
out_img.file_format = 'PNG'
scene.render.image_settings.compression = 100
out_img.save()
log('lightmap written', png_path, os.path.getsize(png_path) // 1024, 'KiB')

# --- Export. -------------------------------------------------------------------
for o in faces:
    for s, m in zip(o.material_slots, originals[o.name]):
        s.material = m
for ob in [ground, moon] + [L for L, _ in neon]:
    bpy.data.objects.remove(ob, do_unlink=True)
bpy.ops.object.select_all(action='DESELECT')

glb_tmp = os.path.join(WORK, 'export.glb')
bpy.ops.export_scene.gltf(
    filepath=glb_tmp, export_format='GLB',
    export_texcoords=True, export_normals=True,
    export_vertex_color='ACTIVE', export_all_vertex_colors=False,
    use_mesh_edges=True, use_mesh_vertices=False,
    export_materials='EXPORT', export_image_format='AUTO', export_jpeg_quality=90,
    export_meshopt_compression_enable=True,
    export_cameras=False, export_lights=False, export_extras=False,
    export_animations=False, export_yup=True,
)
log('exported', glb_tmp, os.path.getsize(glb_tmp) // 1024, 'KiB')


# --- Splice the lightmap in as occlusionTexture on TEXCOORD_1. ---------------
def read_glb(b):
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', b[off:off + 4])[0]
    return j, bytearray(b[off + 8:off + 8 + bl])


def write_glb(j, binc, path):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binc += b'\0' * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binc)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(binc), 0x004E4942) + binc)


j, binc = read_glb(open(glb_tmp, 'rb').read())
png = open(png_path, 'rb').read()
binc += b'\0' * ((4 - len(binc) % 4) % 4)
bin_index = next(i for i, b in enumerate(j['buffers']) if 'uri' not in b)
j.setdefault('bufferViews', []).append({'buffer': bin_index, 'byteOffset': len(binc), 'byteLength': len(png)})
binc += png
j['buffers'][bin_index]['byteLength'] = len(binc)
j.setdefault('images', []).append({'mimeType': 'image/png', 'bufferView': len(j['bufferViews']) - 1, 'name': 'Lightmap'})
# Linear, no mipmaps: the islands are a few texels apart, and a mip would mix them.
j.setdefault('samplers', []).append({'magFilter': 9729, 'minFilter': 9729, 'wrapS': 33071, 'wrapT': 33071})
j.setdefault('textures', []).append({'sampler': len(j['samplers']) - 1, 'source': len(j['images']) - 1})
tex = len(j['textures']) - 1
lit = set()
for me in j['meshes']:
    for p in me['primitives']:
        if p.get('mode', 4) == 4 and 'material' in p:
            if 'TEXCOORD_1' not in p['attributes']:
                raise RuntimeError(f'{me.get("name")} has no TEXCOORD_1')
            lit.add(p['material'])
for mi in lit:
    m = j['materials'][mi]
    m['occlusionTexture'] = {'index': tex, 'texCoord': 1}
    m.setdefault('extras', {})['lightmapScale'] = scales
write_glb(j, binc, DST)
log(f'wrote {DST}: {os.path.getsize(DST) / 1e6:.2f} MB, lightmap on {len(lit)} materials')
