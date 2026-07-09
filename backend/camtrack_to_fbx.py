"""
camtrack_to_fbx.py

Runs inside Blender's Python (bpy) to convert a PVCam (PVC Studio) JSON timeline
into a real, valid FBX camera animation.

USAGE (from your backend, e.g. a Node/Python service):

    blender --background --python camtrack_to_fbx.py -- input.json output.fbx

The backend's HTTP handler should:
  1. Save the incoming JSON POST body to a temp file (input.json)
  2. Shell out to the command above (subprocess)
  3. Stream the resulting output.fbx back as the response body

This script deliberately has ZERO dependencies beyond Blender itself,
so it runs identically in a Docker container with headless Blender
installed (recommended: official Blender Docker image or
`apt install blender` on a headless Linux box with an X-less GL driver
like Mesa llvmpipe, which Blender's background mode uses fine).
"""

import bpy
import json
import sys
import math
import os


def get_args():
    """Blender passes its own args before '--'; ours come after."""
    argv = sys.argv
    if "--" not in argv:
        raise RuntimeError(
            "No arguments passed after '--'. Usage: "
            "blender --background --python camtrack_to_fbx.py -- input.json output.fbx"
        )
    idx = argv.index("--")
    user_args = argv[idx + 1:]
    if len(user_args) < 2:
        raise RuntimeError("Expected: <input.json> <output.fbx>")
    return user_args[0], user_args[1]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def build_camera_animation(data, fps=30):
    """
    data: parsed PVCam JSON payload, shape:
      {
        "meta": {...},
        "keyframes": [ {"time": float_seconds, "position": {x,y,z}, "rotation": {x,y,z}}, ... ]
      }
    Rotation values are degrees (Euler XYZ) as emitted by the web app.
    """
    keyframes = data["keyframes"]
    if not keyframes:
        raise ValueError("No keyframes in input JSON.")

    meta = data.get("meta", {})
    scene_fps = meta.get("fps_estimate") or fps
    scene = bpy.context.scene
    scene.render.fps = int(round(scene_fps))

    # Create the camera object
    cam_data = bpy.data.cameras.new("PVCamCamera")
    cam_obj = bpy.data.objects.new("PVCamCamera", cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    # Blender's rotation_euler is in radians; input is degrees.
    for kf in keyframes:
        frame = kf["time"] * scene_fps
        pos = kf["position"]
        rot = kf["rotation"]

        cam_obj.location = (pos["x"], pos["y"], pos["z"])
        cam_obj.rotation_euler = (
            math.radians(rot["x"]),
            math.radians(rot["y"]),
            math.radians(rot["z"]),
        )

        cam_obj.keyframe_insert(data_path="location", frame=frame)
        cam_obj.keyframe_insert(data_path="rotation_euler", frame=frame)

    # Use linear or bezier interpolation — bezier gives smoother camera
    # moves for cinematic use, which is usually desired for a camera track.
    if cam_obj.animation_data and cam_obj.animation_data.action:
        for fcurve in cam_obj.animation_data.action.fcurves:
            for kp in fcurve.keyframe_points:
                kp.interpolation = 'BEZIER'
                kp.handle_left_type = 'AUTO_CLAMPED'
                kp.handle_right_type = 'AUTO_CLAMPED'

    scene.frame_start = int(keyframes[0]["time"] * scene_fps)
    scene.frame_end = int(math.ceil(keyframes[-1]["time"] * scene_fps))

    return cam_obj


def export_fbx(output_path):
    bpy.ops.export_scene.fbx(
        filepath=output_path,
        use_selection=False,
        object_types={'CAMERA'},
        bake_anim=True,
        bake_anim_use_all_bones=False,
        bake_anim_use_all_actions=False,
        bake_anim_force_startend_keying=True,
        bake_anim_step=1.0,
        bake_anim_simplify_factor=1.0,
        axis_forward='-Z',
        axis_up='Y',
        global_scale=1.0,
        apply_unit_scale=True,
    )


def main():
    input_path, output_path = get_args()

    with open(input_path, "r") as f:
        data = json.load(f)

    clear_scene()
    build_camera_animation(data)
    export_fbx(output_path)

    print(f"PVCam: wrote {output_path} "
          f"({len(data['keyframes'])} keyframes)")


if __name__ == "__main__":
    main()
