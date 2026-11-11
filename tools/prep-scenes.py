"""
Prepare the Leviathan, Seawall and Engine Room models.

    python tools/prep-scenes.py            (with `pip install bpy`, or)
    Blender --background --factory-startup --python tools/prep-scenes.py

Reads tools/source/{control-room,ocean,engine-room}.glb (the Sketchfab downloads;
links in README > Credits) and writes public/scenes/{leviathan,seawall,
engine-room}.glb with Meshopt geometry and WebP textures:

  control-room  as it is: 47k triangles and 256px textures already
  ocean         as it is, its specular-glossiness materials converted on the way
                through Blender (three.js no longer reads them)
  engine-room   a 1M-triangle photoscan, welded and decimated to half; its two
                8192 textures come down to 4096

Two steps follow the export. Blender's WebP writer fails on a few of the
textures (glass and packed roughness maps), so references to those are dropped
here; and where Blender's Meshopt is missing (the pip build), run

    npx @gltf-transform/cli meshopt public/scenes/<name>.glb public/scenes/<name>.glb

The walks through Leviathan and the Engine Room were surveyed and planned with
tools/walk-survey.py and tools/walk-plan.py (raycast a grid of standing
positions, then shortest paths between waypoints through the ones with room).
"""
import bpy, os, sys

import json, struct


def drop_missing_textures(path):
    """Remove material slots that point at a texture with no image behind it."""
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    rest = b[20 + jl:]
    bad = {i for i, t in enumerate(j.get('textures', []))
           if 'source' not in t and 'source' not in t.get('extensions', {}).get('EXT_texture_webp', {})}
    if not bad:
        return
    for m in j['materials']:
        pb = m.get('pbrMetallicRoughness', {})
        for d, k in ((pb, 'baseColorTexture'), (pb, 'metallicRoughnessTexture'), (m, 'normalTexture'),
                     (m, 'occlusionTexture'), (m, 'emissiveTexture')):
            if k in d and d[k]['index'] in bad:
                del d[k]
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + len(rest)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js + rest)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS = [
    ('control-room', 'leviathan', 0, 1.0),
    ('ocean', 'seawall', 0, 1.0),
    ('engine-room', 'engine-room', 4096, 0.5),
]
only = [a for a in sys.argv[1:] if not a.startswith('-') and not a.endswith('.py')]
for src, dst, tex, ratio in JOBS:
    if only and dst not in only:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'tools', 'source', src + '.glb'))
    if tex:
        for img in bpy.data.images:
            w, h = img.size
            if max(w, h) > tex:
                f = tex / max(w, h)
                img.scale(max(1, int(w * f)), max(1, int(h * f)))
    if ratio < 1:
        for o in bpy.context.scene.objects:
            if o.type == 'MESH' and len(o.data.polygons) > 2000:
                # Weld first: the scan's chunks are unwelded triangles, and
                # decimating those tears holes along every seam.
                w = o.modifiers.new('Weld', 'WELD')
                w.merge_threshold = 0.0005
                m = o.modifiers.new('Decimate', 'DECIMATE')
                m.ratio = ratio
    out = os.path.join(ROOT, 'public', 'scenes', dst + '.glb')
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_apply=True,
        export_image_format='WEBP', export_image_quality=82,
        export_meshopt_compression_enable=True,
        export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
    )
    drop_missing_textures(out)
    print(f'[prep] {dst}: {os.path.getsize(out) / 1e6:.2f} MB', flush=True)
