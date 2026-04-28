"""Pure-Python geometry spec builders.

Runs in dev AND prod — never touches RhinoCommon. The spec dicts emitted
are JSON-serializable so dev can forward them verbatim to prod's /solve-frame
endpoint for Brep construction + GH solve.

Spec shapes (all boxes/extrusions/solids the frontend renders):
    {"kind": "box",          "x": [x0,x1], "y": [y0,y1], "z": [z0,z1]}
    {"kind": "extruded",     "pts": [[x,y,z], ...], "dir": [dx,dy,dz], "cap": bool}
    {"kind": "planar_solid", "profile": [[x,y,z]]*4,  "dir": [dx,dy,dz]}
"""

# Opening dimensions (must match frontend constants)
WINDOW_W, WINDOW_H, WINDOW_SILL = 1000, 1000, 900
DOOR_W, DOOR_H = 900, 2100


def opening_spec(x0, y0, x1, y1, t, wall_idx, pos_along, opening_type,
                 interior_walls=None, iw_t=None,
                 width=None, height=None, sill=None):
    """Axis-aligned box spec for a door or window cutter."""
    default_w = WINDOW_W if opening_type == "window" else DOOR_W
    default_h = WINDOW_H if opening_type == "window" else DOOR_H
    default_sill = WINDOW_SILL if opening_type == "window" else 0
    ow = float(width) if width is not None else default_w
    oh = float(height) if height is not None else default_h
    z_base = float(sill) if (opening_type == "window" and sill is not None) else default_sill
    i_t = float(iw_t) if iw_t is not None else t
    # Extrude 50 mm past each face of the host wall so the cutter overshoots.
    pad = 50.0

    if wall_idx == 0:  # south wall, along +X
        cx = x0 + pos_along
        return {"kind": "box", "wall_idx": wall_idx,
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [y0 - pad, y0 + t + pad],
                "z": [z_base, z_base + oh]}
    if wall_idx == 1:  # north wall, along +X
        cx = x0 + pos_along
        return {"kind": "box", "wall_idx": wall_idx,
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [y1 - t - pad, y1 + pad],
                "z": [z_base, z_base + oh]}
    if wall_idx == 2:  # west wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        return {"kind": "box", "wall_idx": wall_idx,
                "x": [x0 - pad, x0 + t + pad],
                "y": [cy - ow / 2, cy + ow / 2],
                "z": [z_base, z_base + oh]}
    if wall_idx == 3:  # east wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        return {"kind": "box", "wall_idx": wall_idx,
                "x": [x1 - t - pad, x1 + pad],
                "y": [cy - ow / 2, cy + ow / 2],
                "z": [z_base, z_base + oh]}

    # Interior wall: wall_idx 4+ indexes into interior_walls list
    if not interior_walls:
        return None
    idx = wall_idx - 4
    if idx < 0 or idx >= len(interior_walls):
        return None
    iw = interior_walls[idx]
    ix0, iy0 = float(iw["x0"]), float(iw["y0"])
    ix1, iy1 = float(iw["x1"]), float(iw["y1"])
    is_horiz = abs(iy1 - iy0) < 1
    if is_horiz:
        xMin = min(ix0, ix1)
        cx = xMin + pos_along
        return {"kind": "box", "wall_idx": wall_idx,
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [iy0 - i_t / 2 - pad, iy0 + i_t / 2 + pad],
                "z": [z_base, z_base + oh]}
    yMin = min(iy0, iy1)
    cy = yMin + pos_along
    return {"kind": "box", "wall_idx": wall_idx,
            "x": [ix0 - i_t / 2 - pad, ix0 + i_t / 2 + pad],
            "y": [cy - ow / 2, cy + ow / 2],
            "z": [z_base, z_base + oh]}


def _ensure_outward_polygon(pts, direction):
    """Reverse a polygon's vertex order if its computed normal opposes the
    outward direction (= -direction).

    The profile face must have its normal pointing OUTWARD from the brep
    solid; otherwise GH can identify the wrong face as the wall's outer
    reference, and the framed studs end up offset inward by one wall
    thickness on those walls.
    """
    if len(pts) < 3:
        return pts
    p0, p1, p2 = pts[0], pts[1], pts[2]
    e1 = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    e2 = (p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
    nx = e1[1] * e2[2] - e1[2] * e2[1]
    ny = e1[2] * e2[0] - e1[0] * e2[2]
    nz = e1[0] * e2[1] - e1[1] * e2[0]
    # Outward = -direction; polygon normal should point along outward.
    dot = -(nx * direction[0] + ny * direction[1] + nz * direction[2])
    if dot < 0:
        return list(reversed(pts))
    return pts


def roof_specs(x0, y0, x1, y1, h, roof_type, ridge_h=None, flat_slope=None,
               t=0, roof_t=295, eave_oh=0, gable_oh=0):
    """Roof geometry specs.

    eave_oh / gable_oh extend the gable slab outward past the wall footprint
    (perpendicular to and along the ridge, respectively). Both default to 0
    which means flush with the outer wall faces.
    """
    # "none" → walls only, no roof members generated.
    if roof_type == "none":
        return []
    w = x1 - x0
    d = y1 - y0
    if flat_slope is None:
        flat_slope = [0, 0]

    if roof_type == "gable":
        if ridge_h is None:
            ridge_h = min(w, d) * 0.35
        slab = roof_t
        specs = []
        if w >= d:
            # Ridge along X. s lifts the slab so its bottom plane passes
            # through the inner-top corner of the long walls.
            mid_y = (y0 + y1) / 2
            half_span = d / 2
            s = slab - ridge_h * t / half_span
            ridge_z = h + ridge_h + s
            slope = ridge_h / half_span                # vertical drop per unit y past ridge
            y_eave_s = y0 - eave_oh
            y_eave_n = y1 + eave_oh
            eave_z = h + s - eave_oh * slope           # extrapolated past the wall edge
            x_ref = x0 - gable_oh
            x_len = w + 2 * gable_oh
            direction = [x_len, 0, 0]
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x_ref, y_eave_s, eave_z],
                [x_ref, mid_y,    ridge_z],
                [x_ref, mid_y,    ridge_z - slab],
                [x_ref, y_eave_s, eave_z - slab],
            ]})
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x_ref, mid_y,    ridge_z],
                [x_ref, y_eave_n, eave_z],
                [x_ref, y_eave_n, eave_z - slab],
                [x_ref, mid_y,    ridge_z - slab],
            ]})
        else:
            # Ridge along Y.
            mid_x = (x0 + x1) / 2
            half_span = w / 2
            s = slab - ridge_h * t / half_span
            ridge_z = h + ridge_h + s
            slope = ridge_h / half_span
            x_eave_w = x0 - eave_oh
            x_eave_e = x1 + eave_oh
            eave_z = h + s - eave_oh * slope
            y_ref = y0 - gable_oh
            y_len = d + 2 * gable_oh
            direction = [0, y_len, 0]
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x_eave_w, y_ref, eave_z],
                [mid_x,    y_ref, ridge_z],
                [mid_x,    y_ref, ridge_z - slab],
                [x_eave_w, y_ref, eave_z - slab],
            ]})
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [mid_x,    y_ref, ridge_z],
                [x_eave_e, y_ref, eave_z],
                [x_eave_e, y_ref, eave_z - slab],
                [mid_x,    y_ref, ridge_z - slab],
            ]})
        return specs

    # Flat roof. eave_oh extends along the slope axis (where rain runs off);
    # gable_oh extends along the perpendicular axis. For w >= d the slope axis
    # is Y; for d > w it's X.
    slab = roof_t
    f, b = flat_slope[0], flat_slope[1]
    if f == 0 and b == 0:
        if w >= d:
            return [{"kind": "box",
                     "x": [x0 - gable_oh, x1 + gable_oh],
                     "y": [y0 - eave_oh,  y1 + eave_oh],
                     "z": [h, h + slab]}]
        else:
            return [{"kind": "box",
                     "x": [x0 - eave_oh,  x1 + eave_oh],
                     "y": [y0 - gable_oh, y1 + gable_oh],
                     "z": [h, h + slab]}]

    # Sloped flat roof: tilted slab. Eave_oh extends past the slope ends and
    # extrapolates the same slope outward (so the slab plane stays continuous).
    if w >= d:
        # Slope along Y, extrude along X.
        slope_y = (b - f) / d
        f_oh = f - eave_oh * slope_y
        b_oh = b + eave_oh * slope_y
        x_ref = x0 - gable_oh
        x_len = w + 2 * gable_oh
        profile = [
            [x_ref, y0 - eave_oh, h + f_oh],
            [x_ref, y0 - eave_oh, h + slab + f_oh],
            [x_ref, y1 + eave_oh, h + slab + b_oh],
            [x_ref, y1 + eave_oh, h + b_oh],
        ]
        direction = [x_len, 0, 0]
    else:
        # Slope along X, extrude along Y.
        slope_x = (b - f) / w
        f_oh = f - eave_oh * slope_x
        b_oh = b + eave_oh * slope_x
        y_ref = y0 - gable_oh
        y_len = d + 2 * gable_oh
        profile = [
            [x0 - eave_oh, y_ref, h + f_oh],
            [x0 - eave_oh, y_ref, h + slab + f_oh],
            [x1 + eave_oh, y_ref, h + slab + b_oh],
            [x1 + eave_oh, y_ref, h + b_oh],
        ]
        direction = [0, y_len, 0]
    return [{"kind": "planar_solid", "profile": profile, "dir": direction}]


def exterior_wall_specs(x0, y0, x1, y1, h, t, roof_type, flat_slope,
                        roof_t, ridge_h, ridge_along_x):
    """Exterior wall specs. Matches frontend buildRoom layout."""
    w = x1 - x0
    d = y1 - y0

    if ridge_along_x:
        # perp = W/E (full depth); long = S/N (inset)
        wall_specs_raw = [
            (x0 + t, y0,       w - 2 * t, t),  # south
            (x0 + t, y1 - t,   w - 2 * t, t),  # north
            (x0,     y0,       t,         d),  # west
            (x1 - t, y0,       t,         d),  # east
        ]
    else:
        # perp = S/N (full width); long = W/E (inset)
        wall_specs_raw = [
            (x0,     y0,       w,         t),
            (x0,     y1 - t,   w,         t),
            (x0,     y0 + t,   t,         d - 2 * t),
            (x1 - t, y0 + t,   t,         d - 2 * t),
        ]

    is_flat_sloped = roof_type == "flat" and (flat_slope[0] != 0 or flat_slope[1] != 0)

    if roof_type == "gable":
        gbl_half_span = (d / 2) if ridge_along_x else (w / 2)
        gbl_eave_lift = roof_t - ridge_h * t / gbl_half_span
        h_eave = h + gbl_eave_lift
        h_apex = h + ridge_h + gbl_eave_lift
    else:
        h_eave = h_apex = 0  # unused

    specs = []
    for i, (ox, oy, sx, sy) in enumerate(wall_specs_raw):
        if sx <= 0 or sy <= 0:
            continue
        is_gable_wall = roof_type == "gable" and (
            (ridge_along_x and i in (2, 3)) or
            (not ridge_along_x and i in (0, 1))
        )

        if is_gable_wall:
            # Pentagonal wall (rectangle + triangle to ridge). Both gable walls
            # place their profile at the OUTER face and extrude INWARD, so GH
            # sees a consistent reference face on every gable. (Earlier bug:
            # east/north profiles sat on the inner face and extruded outward,
            # which offset the framing by one wall thickness on those sides.)
            if ridge_along_x:
                # West (i=2) outer = ox; east (i=3) outer = ox+sx.
                far_side = (i == 3)
                outer_x = (ox + sx) if far_side else ox
                dir_x = -sx if far_side else sx
                mid = sy / 2
                pts = [
                    [outer_x, oy,        0],
                    [outer_x, oy + sy,   0],
                    [outer_x, oy + sy,   h_eave],
                    [outer_x, oy + mid,  h_apex],
                    [outer_x, oy,        h_eave],
                    [outer_x, oy,        0],
                ]
                direction = [dir_x, 0, 0]
            else:
                # South (i=0) outer = oy; north (i=1) outer = oy+sy.
                far_side = (i == 1)
                outer_y = (oy + sy) if far_side else oy
                dir_y = -sy if far_side else sy
                mid = sx / 2
                pts = [
                    [ox,        outer_y, 0],
                    [ox + sx,   outer_y, 0],
                    [ox + sx,   outer_y, h_eave],
                    [ox + mid,  outer_y, h_apex],
                    [ox,        outer_y, h_eave],
                    [ox,        outer_y, 0],
                ]
                direction = [0, dir_y, 0]
            pts = _ensure_outward_polygon(pts, direction)
            specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
            continue

        if is_flat_sloped:
            is_trap = (ridge_along_x and i in (2, 3)) or (not ridge_along_x and i in (0, 1))
            if is_trap:
                # Same convention as the gable pentagon: profile at OUTER face,
                # extrude INWARD. Far-side walls (East / North) flip outer_x/y
                # to (ox+sx) / (oy+sy) and negate dir.
                if ridge_along_x:
                    far_side = (i == 3)
                    outer_x = (ox + sx) if far_side else ox
                    dir_x = -sx if far_side else sx
                    h_start = h + flat_slope[0]
                    h_end = h + flat_slope[1]
                    pts = [
                        [outer_x, oy, 0],
                        [outer_x, oy + sy, 0],
                        [outer_x, oy + sy, h_end],
                        [outer_x, oy, h_start],
                        [outer_x, oy, 0],
                    ]
                    direction = [dir_x, 0, 0]
                else:
                    far_side = (i == 1)
                    outer_y = (oy + sy) if far_side else oy
                    dir_y = -sy if far_side else sy
                    h_start = h + flat_slope[0]
                    h_end = h + flat_slope[1]
                    pts = [
                        [ox, outer_y, 0],
                        [ox + sx, outer_y, 0],
                        [ox + sx, outer_y, h_end],
                        [ox, outer_y, h_start],
                        [ox, outer_y, 0],
                    ]
                    direction = [0, dir_y, 0]
                pts = _ensure_outward_polygon(pts, direction)
                specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
                continue
            # Constant-height wall at the roof edge height
            if ridge_along_x:
                wall_h = h + flat_slope[0] if i == 0 else h + flat_slope[1]
            else:
                wall_h = h + flat_slope[0] if i == 2 else h + flat_slope[1]
            specs.append({"kind": "box",
                          "x": [ox, ox + sx], "y": [oy, oy + sy], "z": [0, wall_h]})
            continue

        # Default flat roof with no slope — simple box at wall height
        specs.append({"kind": "box",
                      "x": [ox, ox + sx], "y": [oy, oy + sy], "z": [0, h]})

    return specs


def compute_iw_joints(interior_walls_list, iw_t,
                      ix0=None, iy0=None, ix1=None, iy1=None):
    """Per-interior-wall retraction per end (side 0 = (x0,y0), side 1 = (x1,y1)).

    Matches the frontend's computeIwJoints. Retracts by iw_t / 2 when the wall
    end butts into (T) another interior wall's mid-span, or coincides with
    another's endpoint and loses the longer-wall tiebreak. Ends flush with an
    exterior inner face stay put.
    """
    EPS = 1.0

    def on_ext_face(x, y):
        if ix0 is None:
            return False
        on_v = (abs(x - ix0) < EPS or abs(x - ix1) < EPS) and iy0 - EPS <= y <= iy1 + EPS
        on_h = (abs(y - iy0) < EPS or abs(y - iy1) < EPS) and ix0 - EPS <= x <= ix1 + EPS
        return on_v or on_h

    def point_vs_wall(px, py, w):
        wy0, wy1 = float(w["y0"]), float(w["y1"])
        wx0, wx1 = float(w["x0"]), float(w["x1"])
        is_horiz = abs(wy1 - wy0) < 1
        if is_horiz:
            if abs(py - wy0) > EPS:
                return None
            xmn, xmx = min(wx0, wx1), max(wx0, wx1)
            if abs(px - xmn) < EPS or abs(px - xmx) < EPS:
                return "endpoint"
            if xmn + EPS < px < xmx - EPS:
                return "mid"
            return None
        if abs(px - wx0) > EPS:
            return None
        ymn, ymx = min(wy0, wy1), max(wy0, wy1)
        if abs(py - ymn) < EPS or abs(py - ymx) < EPS:
            return "endpoint"
        if ymn + EPS < py < ymx - EPS:
            return "mid"
        return None

    def wall_len(w):
        return ((float(w["x1"]) - float(w["x0"])) ** 2 +
                (float(w["y1"]) - float(w["y0"])) ** 2) ** 0.5

    retractions = [[0.0, 0.0] for _ in interior_walls_list]
    for i, w in enumerate(interior_walls_list):
        my_len = wall_len(w)
        my_is_horiz = abs(float(w["y1"]) - float(w["y0"])) < 1
        ends = [(float(w["x0"]), float(w["y0"]), 0), (float(w["x1"]), float(w["y1"]), 1)]
        for x, y, side in ends:
            if on_ext_face(x, y):
                continue
            mid = 0
            endpoint_hits = []  # (idx, len)
            for j, w2 in enumerate(interior_walls_list):
                if j == i:
                    continue
                rel = point_vs_wall(x, y, w2)
                if rel == "mid":
                    mid += 1
                elif rel == "endpoint":
                    # Only perpendicular L-corners — collinear end-to-end walls
                    # don't conflict and need no retraction.
                    w2_is_horiz = abs(float(w2["y1"]) - float(w2["y0"])) < 1
                    if my_is_horiz != w2_is_horiz:
                        endpoint_hits.append((j, wall_len(w2)))
            if mid > 0:
                retractions[i][side] = iw_t / 2
                continue
            if endpoint_hits:
                winner_idx, winner_len = i, my_len
                for j, L in endpoint_hits:
                    if L > winner_len + EPS or (abs(L - winner_len) < EPS and j < winner_idx):
                        winner_idx, winner_len = j, L
                # Loser retracts by t/2 (stops at winner's face).
                # Winner extends by t/2 into the corner to close the gap.
                retractions[i][side] = iw_t / 2 if winner_idx != i else -iw_t / 2
    return retractions


def interior_wall_specs(interior_walls_list, iw_t, h, iw_to_ridge,
                        ridge_along_x, ridge_h,
                        gbl_half_span, gbl_h_eave_under, gbl_h_apex_under,
                        gbl_center_x, gbl_center_y,
                        ext_ix0=None, ext_iy0=None, ext_ix1=None, ext_iy1=None):
    """Interior wall specs (simple boxes, or gable-profile when iw_to_ridge).

    Applies joint retractions at each end so T-junctions and L-corners render
    cleanly against the current iw_t (and automatically re-resolve on change).
    """
    joints = compute_iw_joints(interior_walls_list, iw_t,
                               ix0=ext_ix0, iy0=ext_iy0, ix1=ext_ix1, iy1=ext_iy1)
    specs = []
    for i, iw in enumerate(interior_walls_list):
        ix0, iy0 = float(iw["x0"]), float(iw["y0"])
        ix1, iy1 = float(iw["x1"]), float(iw["y1"])
        is_horiz = abs(iy1 - iy0) < 1
        r0, r1 = joints[i]
        # Retractions at the lower / upper coord ends.
        if is_horiz:
            low_retract  = r0 if ix0 <= ix1 else r1
            high_retract = r1 if ix0 <= ix1 else r0
            bx0 = min(ix0, ix1) + low_retract
            bx1 = max(ix0, ix1) - high_retract
            by0 = iy0 - iw_t / 2
            by1 = iy0 + iw_t / 2
        else:
            low_retract  = r0 if iy0 <= iy1 else r1
            high_retract = r1 if iy0 <= iy1 else r0
            bx0 = ix0 - iw_t / 2
            bx1 = ix0 + iw_t / 2
            by0 = min(iy0, iy1) + low_retract
            by1 = max(iy0, iy1) - high_retract
        if bx1 - bx0 < 1 or by1 - by0 < 1:
            continue

        if iw_to_ridge:
            # Pentagon/trapezoid profile that follows the gable underside.
            def _underside(xw, yw):
                if ridge_along_x:
                    dist = min(gbl_half_span, abs(yw - gbl_center_y))
                else:
                    dist = min(gbl_half_span, abs(xw - gbl_center_x))
                return gbl_h_eave_under + ridge_h * (1 - dist / gbl_half_span)

            if is_horiz:
                y_wall = iy0
                z_left = _underside(bx0, y_wall)
                z_right = _underside(bx1, y_wall)
                pts = [
                    [bx0, by0, 0],
                    [bx1, by0, 0],
                    [bx1, by0, z_right],
                ]
                # Peak only if ridge is perpendicular to the wall and crosses it
                if (not ridge_along_x) and bx0 + 1 < gbl_center_x < bx1 - 1:
                    pts.append([gbl_center_x, by0, gbl_h_apex_under])
                pts.append([bx0, by0, z_left])
                pts.append([bx0, by0, 0])
                direction = [0, iw_t, 0]
            else:
                x_wall = ix0
                z_bot = _underside(x_wall, by0)
                z_top = _underside(x_wall, by1)
                pts = [
                    [bx0, by0, 0],
                    [bx0, by1, 0],
                    [bx0, by1, z_top],
                ]
                if ridge_along_x and by0 + 1 < gbl_center_y < by1 - 1:
                    pts.append([bx0, gbl_center_y, gbl_h_apex_under])
                pts.append([bx0, by0, z_bot])
                pts.append([bx0, by0, 0])
                direction = [iw_t, 0, 0]
            pts = _ensure_outward_polygon(pts, direction)
            specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
        else:
            specs.append({"kind": "box",
                          "x": [bx0, bx1], "y": [by0, by1], "z": [0, h]})
    return specs


def compute_geometry_specs(data):
    """Parse request data and return the full spec bundle for /solve-frame.

    The output is JSON-serializable so dev can forward it verbatim to prod's
    /solve-frame endpoint.
    """
    x0 = float(data["x0"])
    y0 = float(data["y0"])
    x1 = float(data["x1"])
    y1 = float(data["y1"])
    h = float(data.get("height", 2400))
    t = float(data.get("thickness", 150))
    roof_t = float(data.get("roofThickness", 295))

    w = x1 - x0
    d = y1 - y0

    roof_type = data.get("roofType", "flat")
    default_ridge = min(w, d) * 0.35
    ridge_h = float(data.get("ridgeH", default_ridge)) if roof_type == "gable" else 0
    ridge_along_x = w >= d

    flat_slope = data.get("flatSlopeH", [0, 0])

    iw_t = float(data.get("interiorThickness", t))
    iw_to_ridge = bool(data.get("iwToRidge")) and roof_type == "gable"
    interior_walls = data.get("interiorWalls", [])

    # Gable parameters (shared by exterior walls AND iw-to-ridge interior walls)
    if roof_type == "gable":
        gbl_half_span = (d / 2) if ridge_along_x else (w / 2)
        gbl_eave_lift = roof_t - ridge_h * t / gbl_half_span
        # Interior walls with iwToRidge stop at the roof UNDERSIDE (one slab
        # below roof top), matching the frontend. The exterior gable pentagon
        # walls go all the way up to the roof TOP and compute their own apex
        # locally in exterior_wall_specs.
        gbl_h_eave_under = h + gbl_eave_lift - roof_t
        gbl_h_apex_under = h + ridge_h + gbl_eave_lift - roof_t
        gbl_center_x = (x0 + x1) / 2
        gbl_center_y = (y0 + y1) / 2
    else:
        gbl_half_span = gbl_h_eave_under = gbl_h_apex_under = 0
        gbl_center_x = gbl_center_y = 0

    wall_specs = exterior_wall_specs(x0, y0, x1, y1, h, t, roof_type, flat_slope,
                                     roof_t, ridge_h, ridge_along_x)
    # Inner footprint (where interior walls actually live) — used to detect "end
    # lands on exterior face" for joint retraction.
    wall_specs += interior_wall_specs(interior_walls, iw_t, h, iw_to_ridge,
                                      ridge_along_x, ridge_h,
                                      gbl_half_span, gbl_h_eave_under, gbl_h_apex_under,
                                      gbl_center_x, gbl_center_y,
                                      ext_ix0=x0 + t, ext_iy0=y0 + t,
                                      ext_ix1=x1 - t, ext_iy1=y1 - t)

    door_specs = []
    window_specs = []
    for op in data.get("openings", []):
        spec = opening_spec(x0, y0, x1, y1, t,
                            int(op["wallIdx"]), float(op["posAlong"]), op["type"],
                            interior_walls=interior_walls, iw_t=iw_t,
                            width=op.get("width"), height=op.get("height"),
                            sill=op.get("sill"))
        if spec is None:
            continue
        (door_specs if op["type"] == "door" else window_specs).append(spec)

    eave_oh = max(0.0, float(data.get("eaveOH", 0)))
    gable_oh = max(0.0, float(data.get("gableOH", 0)))
    roof_spec_list = roof_specs(x0, y0, x1, y1, h, roof_type,
                                ridge_h=ridge_h if roof_type == "gable" else None,
                                flat_slope=flat_slope, t=t, roof_t=roof_t,
                                eave_oh=eave_oh, gable_oh=gable_oh)

    try:
        material_factor = float(data.get("materialFactor", 3.1))
    except (TypeError, ValueError):
        material_factor = 3.1
    try:
        fab_factor = float(data.get("fabFactor", 1.0))
    except (TypeError, ValueError):
        fab_factor = 1.0
    return {
        "walls": wall_specs,
        "roof": roof_spec_list,
        "doors": door_specs,
        "windows": window_specs,
        "material_factor": material_factor,
        "fab_factor": fab_factor,
    }
