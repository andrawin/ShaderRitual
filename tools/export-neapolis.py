"""Export the Neapolis drone scene as a web GLB for ShaderRitual.

Opens the scene .blend that build.py made, makes the synth instances real,
lightens the heavy meshes, and writes one Draco-compressed GLB. The drone's
flight (camera + look target, sampled every 2 frames, noise off) and the five
stops ride along as JSON in the root node's extras, already in glTF's Y-up
axes, so the scene module can fly the same tour.

Usage: blender -b <scene.blend> -P export-neapolis.py -- <out.glb>
   or: python3 export-neapolis.py <scene.blend> <out.glb>   (with the bpy module)
"""
import bpy, json, sys

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
if len(args) == 2:
    bpy.ops.wm.open_mainfile(filepath=args[0])
OUT = args[-1]

sc = bpy.context.scene
cam = sc.camera
look = bpy.data.objects['DroneLookTarget']


def fcurves(ob):
    act = ob.animation_data.action
    if hasattr(act, 'fcurves'):
        return list(act.fcurves)
    return [fc for l in act.layers for st in l.strips for cb in st.channelbags for fc in cb.fcurves]


# the hand-held wobble is redone live in the app, so sample the clean flight
for ob in (cam, look):
    for fc in fcurves(ob):
        for m in fc.modifiers:
            m.mute = True


def gl(v):  # Blender Z-up -> glTF Y-up
    return [round(v.x, 3), round(v.z, 3), round(-v.y, 3)]


STEP = 2
cpos, lpos = [], []
for f in range(sc.frame_start, sc.frame_end + 1, STEP):
    sc.frame_set(f)
    cpos += gl(cam.matrix_world.translation)
    lpos += gl(look.matrix_world.translation)

stops = []
heroes = {o.name[5:]: o for o in bpy.data.objects if o.name.startswith('HERO_')}
for m in sorted(sc.timeline_markers, key=lambda m: m.frame):
    sc.frame_set(m.frame)
    stops.append({'name': m.name, 'frame': m.frame,
                  'at': gl(heroes[m.name].matrix_world.translation),
                  'look': gl(look.matrix_world.translation)})

data = {'fps': sc.render.fps, 'step': STEP, 'frames': sc.frame_end - sc.frame_start + 1,
        'cam': cpos, 'look': lpos, 'stops': stops}

# ---- geometry
bpy.context.view_layer.layer_collection.children['SYNTH_prototypes'].exclude = False
DECIMATE = {'Modular cabinet': 0.16, 'Stage keyboard': 0.18}
for coll in bpy.data.collections['SYNTH_prototypes'].children:
    ratio = DECIMATE.get(coll.name[len('proto_'):])
    if not ratio:
        continue
    for o in coll.objects:
        if o.type == 'MESH' and len(o.data.polygons) > 3000:
            mod = o.modifiers.new('dec', 'DECIMATE')
            mod.ratio = ratio
# The ruin is left at full resolution: decimating the scan collapses triangles
# across its UV seams, which then show slivers of the wrong part of the atlas.

bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.collections['SYNTHS_placed'].objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = o
bpy.ops.object.duplicates_make_real(use_base_parent=True, use_hierarchy=True)
bpy.context.view_layer.layer_collection.children['SYNTH_prototypes'].exclude = True

root = bpy.data.objects.new('NeapolisScene', None)
sc.collection.objects.link(root)
root['sr'] = json.dumps(data, separators=(',', ':'))

keep = set()
for c in ('MAP_NeapolisWalls', 'SYNTHS_placed'):
    for o in bpy.data.collections[c].all_objects:
        keep.add(o)
bpy.ops.object.select_all(action='DESELECT')
for o in keep:
    if o.type in ('MESH', 'EMPTY'):
        o.select_set(True)
root.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True, export_extras=True,
    export_apply=True, export_cameras=False, export_lights=False, export_animations=False,
    export_image_format='WEBP', export_image_quality=82,
    export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14, export_draco_texcoord_quantization=12,
)
print('EXPORTED', OUT, 'path samples', len(cpos) // 3, 'stops', [s['name'] for s in stops])
