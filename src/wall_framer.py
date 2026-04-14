"""Generate timber stud framing for a wall defined by two ground-plane points.

Each member is a RhinoCommon Brep built via Extrusion.Create (license-free).
"""
import math
import Rhino.Geometry as rg


def _make_member_brep(origin, x_vec, y_vec, z_vec, x_size, y_size, z_size):
    """Create a Brep box at *origin*, oriented along the given axes.

    Uses Extrusion.Create with a rectangular profile so no Rhino license is
    needed at runtime.  The profile lies in the local XY plane (x_vec, y_vec)
    and is extruded along z_vec.
    """
    # Build a Plane whose X/Y match x_vec/y_vec, origin at the member origin
    plane = rg.Plane(origin, x_vec, y_vec)

    # Rectangular profile on that plane
    rect = rg.Rectangle3d(plane, rg.Interval(0, x_size), rg.Interval(0, y_size))
    profile = rect.ToNurbsCurve()

    # Extrude along z_vec * z_size
    extrusion = rg.Extrusion.Create(profile, z_size, True)
    return extrusion.ToBrep()


def frame_wall(start_x, start_y, end_x, end_y, height=2400,
               stud_spacing=600, stud_width=45, stud_depth=90):
    """Return a list of Rhino Brep objects representing the framed wall.

    Parameters
    ----------
    start_x, start_y : float  – wall start on ground plane (mm)
    end_x, end_y     : float  – wall end on ground plane (mm)
    height           : float  – floor-to-top-of-plate (mm)
    stud_spacing     : float  – on-center spacing (mm)
    stud_width       : float  – stud face along the wall line (mm)
    stud_depth       : float  – stud face perpendicular to wall / wall thickness (mm)

    Returns
    -------
    list[Rhino.Geometry.Brep]
        One Brep per framing member.  Plates first, then studs left-to-right.
    """
    dx = float(end_x - start_x)
    dy = float(end_y - start_y)
    wall_length = math.hypot(dx, dy)
    if wall_length < stud_width:
        raise ValueError("Wall is shorter than one stud width")

    # Local coordinate system
    x_vec = rg.Vector3d(dx / wall_length, dy / wall_length, 0)   # along wall
    y_vec = rg.Vector3d(-dy / wall_length, dx / wall_length, 0)  # wall thickness
    z_vec = rg.Vector3d(0, 0, 1)                                  # up

    origin = rg.Point3d(float(start_x), float(start_y), 0)
    plate_height = stud_width  # plates are same timber laid flat

    members = []

    # ── Bottom plate ──
    members.append(_make_member_brep(origin, x_vec, y_vec, z_vec,
                                     wall_length, stud_depth, plate_height))

    # ── Top plate ──
    top_origin = rg.Point3d(origin) + z_vec * (height - plate_height)
    members.append(_make_member_brep(top_origin, x_vec, y_vec, z_vec,
                                     wall_length, stud_depth, plate_height))

    # ── Studs ──
    stud_height = height - 2 * plate_height

    # First stud flush with wall start
    positions = [0.0]

    # Intermediate studs on-center from wall start
    oc = float(stud_spacing)
    while oc < wall_length - stud_width:
        positions.append(oc - stud_width / 2)
        oc += stud_spacing

    # Last stud flush with wall end
    end_pos = wall_length - stud_width
    if abs(positions[-1] - end_pos) > 1.0:  # avoid duplicate within 1 mm
        positions.append(end_pos)

    for p in positions:
        stud_origin = rg.Point3d(origin) + x_vec * p + z_vec * plate_height
        members.append(_make_member_brep(stud_origin, x_vec, y_vec, z_vec,
                                         stud_width, stud_depth, stud_height))

    return members
