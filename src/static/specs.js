// Geometry spec builders — the single source of truth.
//
// computeGeometrySpecs(uiState) → bundle of { walls, roof, doors, windows,
// material_factor, fab_factor }. The bundle is JSON-serialized and POSTed
// to /solve-frame, where it becomes RhinoCommon Breps that GH frames into
// timber members. The same bundle drives the on-screen preview (specMesher).

export const WINDOW_W = 1000, WINDOW_H = 1000, WINDOW_SILL = 900;
export const DOOR_W = 900, DOOR_H = 2100;


export function openingSpec(x0, y0, x1, y1, t, wallIdx, posAlong, openingType,
                            interiorWalls, iwT, width, height, sill) {
  const defaultW = openingType === "window" ? WINDOW_W : DOOR_W;
  const defaultH = openingType === "window" ? WINDOW_H : DOOR_H;
  const defaultSill = openingType === "window" ? WINDOW_SILL : 0;
  const ow = (width != null) ? Number(width) : defaultW;
  const oh = (height != null) ? Number(height) : defaultH;
  const zBase = (openingType === "window" && sill != null) ? Number(sill) : defaultSill;
  const iT = (iwT != null) ? Number(iwT) : t;
  const pad = 50.0;

  if (wallIdx === 0) {
    const cx = x0 + posAlong;
    return { kind: "box", wall_idx: wallIdx,
             x: [cx - ow/2, cx + ow/2],
             y: [y0 - pad, y0 + t + pad],
             z: [zBase, zBase + oh] };
  }
  if (wallIdx === 1) {
    const cx = x0 + posAlong;
    return { kind: "box", wall_idx: wallIdx,
             x: [cx - ow/2, cx + ow/2],
             y: [y1 - t - pad, y1 + pad],
             z: [zBase, zBase + oh] };
  }
  if (wallIdx === 2) {
    const cy = y0 + t + posAlong;
    return { kind: "box", wall_idx: wallIdx,
             x: [x0 - pad, x0 + t + pad],
             y: [cy - ow/2, cy + ow/2],
             z: [zBase, zBase + oh] };
  }
  if (wallIdx === 3) {
    const cy = y0 + t + posAlong;
    return { kind: "box", wall_idx: wallIdx,
             x: [x1 - t - pad, x1 + pad],
             y: [cy - ow/2, cy + ow/2],
             z: [zBase, zBase + oh] };
  }

  if (!interiorWalls || interiorWalls.length === 0) return null;
  const idx = wallIdx - 4;
  if (idx < 0 || idx >= interiorWalls.length) return null;
  const iw = interiorWalls[idx];
  const ix0 = Number(iw.x0), iy0 = Number(iw.y0);
  const ix1 = Number(iw.x1), iy1 = Number(iw.y1);
  const isHoriz = Math.abs(iy1 - iy0) < 1;
  if (isHoriz) {
    const xMin = Math.min(ix0, ix1);
    const cx = xMin + posAlong;
    return { kind: "box", wall_idx: wallIdx,
             x: [cx - ow/2, cx + ow/2],
             y: [iy0 - iT/2 - pad, iy0 + iT/2 + pad],
             z: [zBase, zBase + oh] };
  }
  const yMin = Math.min(iy0, iy1);
  const cy = yMin + posAlong;
  return { kind: "box", wall_idx: wallIdx,
           x: [ix0 - iT/2 - pad, ix0 + iT/2 + pad],
           y: [cy - ow/2, cy + ow/2],
           z: [zBase, zBase + oh] };
}


function ensureOutwardPolygon(pts, dir) {
  // Reverse a polygon's vertex order if its computed normal opposes the
  // outward direction (= -dir). The profile face must have its normal
  // pointing OUTWARD from the brep solid; otherwise GH can identify the
  // wrong face as the wall's outer reference, and the framed studs end up
  // offset inward by one wall thickness on those walls.
  if (pts.length < 3) return pts;
  const p0 = pts[0], p1 = pts[1], p2 = pts[2];
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const dot = -(nx * dir[0] + ny * dir[1] + nz * dir[2]);
  if (dot < 0) return pts.slice().reverse();
  return pts;
}


export function roofSpecs(x0, y0, x1, y1, h, roofType,
                          { ridgeH = null, flatSlope = null, t = 0, roofT = 295,
                            eaveOH = 0, gableOH = 0 } = {}) {
  if (roofType === "none") return [];
  const w = x1 - x0;
  const d = y1 - y0;
  if (flatSlope == null) flatSlope = [0, 0];

  if (roofType === "gable") {
    if (ridgeH == null) ridgeH = Math.min(w, d) * 0.35;
    const slab = roofT;
    const specs = [];
    if (w >= d) {
      const midY = (y0 + y1) / 2;
      const halfSpan = d / 2;
      const s = slab - ridgeH * t / halfSpan;
      const ridgeZ = h + ridgeH + s;
      const slope = ridgeH / halfSpan;
      const yEaveS = y0 - eaveOH;
      const yEaveN = y1 + eaveOH;
      const eaveZ = h + s - eaveOH * slope;
      // Gable-axis: roof is bounded by the INSIDE face of the gable walls so
      // the wall pentagon stays visible up to the apex from outside. gableOH
      // measures overhang past the inside face (so gableOH = t lines the roof
      // edge up with the outer face; gableOH > t is real verge overhang).
      const xRef = x0 + t - gableOH;
      const xLen = w - 2 * t + 2 * gableOH;
      const direction = [xLen, 0, 0];
      specs.push({ kind: "planar_solid", dir: direction, profile: [
        [xRef, yEaveS, eaveZ],
        [xRef, midY,   ridgeZ],
        [xRef, midY,   ridgeZ - slab],
        [xRef, yEaveS, eaveZ - slab],
      ]});
      specs.push({ kind: "planar_solid", dir: direction, profile: [
        [xRef, midY,   ridgeZ],
        [xRef, yEaveN, eaveZ],
        [xRef, yEaveN, eaveZ - slab],
        [xRef, midY,   ridgeZ - slab],
      ]});
    } else {
      const midX = (x0 + x1) / 2;
      const halfSpan = w / 2;
      const s = slab - ridgeH * t / halfSpan;
      const ridgeZ = h + ridgeH + s;
      const slope = ridgeH / halfSpan;
      const xEaveW = x0 - eaveOH;
      const xEaveE = x1 + eaveOH;
      const eaveZ = h + s - eaveOH * slope;
      // See note above: gable-axis bound is the inside face of the gable wall.
      const yRef = y0 + t - gableOH;
      const yLen = d - 2 * t + 2 * gableOH;
      const direction = [0, yLen, 0];
      specs.push({ kind: "planar_solid", dir: direction, profile: [
        [xEaveW, yRef, eaveZ],
        [midX,   yRef, ridgeZ],
        [midX,   yRef, ridgeZ - slab],
        [xEaveW, yRef, eaveZ - slab],
      ]});
      specs.push({ kind: "planar_solid", dir: direction, profile: [
        [midX,   yRef, ridgeZ],
        [xEaveE, yRef, eaveZ],
        [xEaveE, yRef, eaveZ - slab],
        [midX,   yRef, ridgeZ - slab],
      ]});
    }
    return specs;
  }

  // Flat roof. eaveOH extends along the slope axis (where rain runs off);
  // gableOH extends along the perpendicular axis.
  const slab = roofT;
  const f = flatSlope[0], b = flatSlope[1];
  if (f === 0 && b === 0) {
    if (w >= d) {
      return [{ kind: "box",
                x: [x0 - gableOH, x1 + gableOH],
                y: [y0 - eaveOH,  y1 + eaveOH],
                z: [h, h + slab] }];
    } else {
      return [{ kind: "box",
                x: [x0 - eaveOH,  x1 + eaveOH],
                y: [y0 - gableOH, y1 + gableOH],
                z: [h, h + slab] }];
    }
  }

  // Sloped flat roof: tilted slab. Eave_oh extends past the slope ends and
  // extrapolates the same slope outward (so the slab plane stays continuous).
  let profile, direction;
  if (w >= d) {
    const slopeY = (b - f) / d;
    const fOH = f - eaveOH * slopeY;
    const bOH = b + eaveOH * slopeY;
    const xRef = x0 - gableOH;
    const xLen = w + 2 * gableOH;
    profile = [
      [xRef, y0 - eaveOH, h + fOH],
      [xRef, y0 - eaveOH, h + slab + fOH],
      [xRef, y1 + eaveOH, h + slab + bOH],
      [xRef, y1 + eaveOH, h + bOH],
    ];
    direction = [xLen, 0, 0];
  } else {
    const slopeX = (b - f) / w;
    const fOH = f - eaveOH * slopeX;
    const bOH = b + eaveOH * slopeX;
    const yRef = y0 - gableOH;
    const yLen = d + 2 * gableOH;
    profile = [
      [x0 - eaveOH, yRef, h + fOH],
      [x0 - eaveOH, yRef, h + slab + fOH],
      [x1 + eaveOH, yRef, h + slab + bOH],
      [x1 + eaveOH, yRef, h + bOH],
    ];
    direction = [0, yLen, 0];
  }
  return [{ kind: "planar_solid", profile, dir: direction }];
}


export function exteriorWallSpecs(x0, y0, x1, y1, h, t, roofType, flatSlope,
                                  roofT, ridgeH, ridgeAlongX) {
  const w = x1 - x0;
  const d = y1 - y0;

  let raw;
  if (ridgeAlongX) {
    raw = [
      [x0 + t, y0,       w - 2*t, t],  // south
      [x0 + t, y1 - t,   w - 2*t, t],  // north
      [x0,     y0,       t,       d],  // west
      [x1 - t, y0,       t,       d],  // east
    ];
  } else {
    raw = [
      [x0,     y0,       w,       t],
      [x0,     y1 - t,   w,       t],
      [x0,     y0 + t,   t,       d - 2*t],
      [x1 - t, y0 + t,   t,       d - 2*t],
    ];
  }

  const isFlatSloped = roofType === "flat" && (flatSlope[0] !== 0 || flatSlope[1] !== 0);

  let hEave, hApex;
  if (roofType === "gable") {
    const gblHalfSpan = ridgeAlongX ? d/2 : w/2;
    const gblEaveLift = roofT - ridgeH * t / gblHalfSpan;
    hEave = h + gblEaveLift;
    hApex = h + ridgeH + gblEaveLift;
  } else {
    hEave = hApex = 0;
  }

  const specs = [];
  for (let i = 0; i < raw.length; i++) {
    const [ox, oy, sx, sy] = raw[i];
    if (sx <= 0 || sy <= 0) continue;
    const isGableWall = roofType === "gable" && (
      (ridgeAlongX && (i === 2 || i === 3)) ||
      (!ridgeAlongX && (i === 0 || i === 1))
    );

    if (isGableWall) {
      let pts, direction;
      if (ridgeAlongX) {
        const farSide = (i === 3);
        const outerX = farSide ? (ox + sx) : ox;
        const dirX = farSide ? -sx : sx;
        const mid = sy / 2;
        pts = [
          [outerX, oy,        0],
          [outerX, oy + sy,   0],
          [outerX, oy + sy,   hEave],
          [outerX, oy + mid,  hApex],
          [outerX, oy,        hEave],
          [outerX, oy,        0],
        ];
        direction = [dirX, 0, 0];
      } else {
        const farSide = (i === 1);
        const outerY = farSide ? (oy + sy) : oy;
        const dirY = farSide ? -sy : sy;
        const mid = sx / 2;
        pts = [
          [ox,        outerY, 0],
          [ox + sx,   outerY, 0],
          [ox + sx,   outerY, hEave],
          [ox + mid,  outerY, hApex],
          [ox,        outerY, hEave],
          [ox,        outerY, 0],
        ];
        direction = [0, dirY, 0];
      }
      pts = ensureOutwardPolygon(pts, direction);
      specs.push({ kind: "extruded", pts, dir: direction, cap: true, role: "gable" });
      continue;
    }

    if (isFlatSloped) {
      const isTrap = (ridgeAlongX && (i === 2 || i === 3)) ||
                     (!ridgeAlongX && (i === 0 || i === 1));
      if (isTrap) {
        // Same convention as the gable pentagon: profile at OUTER face,
        // extrude INWARD. Far-side walls (East / North) flip outerX/Y
        // to (ox+sx) / (oy+sy) and negate dir.
        let pts, direction;
        const hStart = h + flatSlope[0];
        const hEnd = h + flatSlope[1];
        if (ridgeAlongX) {
          const farSide = (i === 3);
          const outerX = farSide ? (ox + sx) : ox;
          const dirX = farSide ? -sx : sx;
          pts = [
            [outerX, oy, 0],
            [outerX, oy + sy, 0],
            [outerX, oy + sy, hEnd],
            [outerX, oy, hStart],
            [outerX, oy, 0],
          ];
          direction = [dirX, 0, 0];
        } else {
          const farSide = (i === 1);
          const outerY = farSide ? (oy + sy) : oy;
          const dirY = farSide ? -sy : sy;
          pts = [
            [ox, outerY, 0],
            [ox + sx, outerY, 0],
            [ox + sx, outerY, hEnd],
            [ox, outerY, hStart],
            [ox, outerY, 0],
          ];
          direction = [0, dirY, 0];
        }
        pts = ensureOutwardPolygon(pts, direction);
        specs.push({ kind: "extruded", pts, dir: direction, cap: true });
        continue;
      }
      let wallH;
      if (ridgeAlongX) {
        wallH = h + (i === 0 ? flatSlope[0] : flatSlope[1]);
      } else {
        wallH = h + (i === 2 ? flatSlope[0] : flatSlope[1]);
      }
      specs.push({ kind: "box",
                   x: [ox, ox + sx], y: [oy, oy + sy], z: [0, wallH] });
      continue;
    }

    specs.push({ kind: "box",
                 x: [ox, ox + sx], y: [oy, oy + sy], z: [0, h] });
  }
  return specs;
}


export function computeIwJoints(interiorWallsList, iwT,
                                ix0 = null, iy0 = null, ix1 = null, iy1 = null) {
  const EPS = 1.0;

  const onExtFace = (x, y) => {
    if (ix0 == null) return false;
    const onV = (Math.abs(x - ix0) < EPS || Math.abs(x - ix1) < EPS) &&
                iy0 - EPS <= y && y <= iy1 + EPS;
    const onH = (Math.abs(y - iy0) < EPS || Math.abs(y - iy1) < EPS) &&
                ix0 - EPS <= x && x <= ix1 + EPS;
    return onV || onH;
  };

  const pointVsWall = (px, py, w) => {
    const wy0 = Number(w.y0), wy1 = Number(w.y1);
    const wx0 = Number(w.x0), wx1 = Number(w.x1);
    const isHoriz = Math.abs(wy1 - wy0) < 1;
    if (isHoriz) {
      if (Math.abs(py - wy0) > EPS) return null;
      const xmn = Math.min(wx0, wx1), xmx = Math.max(wx0, wx1);
      if (Math.abs(px - xmn) < EPS || Math.abs(px - xmx) < EPS) return "endpoint";
      if (xmn + EPS < px && px < xmx - EPS) return "mid";
      return null;
    }
    if (Math.abs(px - wx0) > EPS) return null;
    const ymn = Math.min(wy0, wy1), ymx = Math.max(wy0, wy1);
    if (Math.abs(py - ymn) < EPS || Math.abs(py - ymx) < EPS) return "endpoint";
    if (ymn + EPS < py && py < ymx - EPS) return "mid";
    return null;
  };

  const wallLen = (w) =>
    Math.sqrt((Number(w.x1) - Number(w.x0))**2 + (Number(w.y1) - Number(w.y0))**2);

  const retractions = interiorWallsList.map(() => [0.0, 0.0]);
  for (let i = 0; i < interiorWallsList.length; i++) {
    const w = interiorWallsList[i];
    const myLen = wallLen(w);
    const myIsHoriz = Math.abs(Number(w.y1) - Number(w.y0)) < 1;
    const ends = [
      [Number(w.x0), Number(w.y0), 0],
      [Number(w.x1), Number(w.y1), 1],
    ];
    for (const [x, y, side] of ends) {
      if (onExtFace(x, y)) continue;
      let mid = 0;
      const endpointHits = [];
      for (let j = 0; j < interiorWallsList.length; j++) {
        if (j === i) continue;
        const w2 = interiorWallsList[j];
        const rel = pointVsWall(x, y, w2);
        if (rel === "mid") {
          mid++;
        } else if (rel === "endpoint") {
          // Only perpendicular L-corners — collinear end-to-end walls
          // don't conflict and need no retraction.
          const w2IsHoriz = Math.abs(Number(w2.y1) - Number(w2.y0)) < 1;
          if (myIsHoriz !== w2IsHoriz) {
            endpointHits.push([j, wallLen(w2)]);
          }
        }
      }
      if (mid > 0) {
        retractions[i][side] = iwT / 2;
        continue;
      }
      if (endpointHits.length > 0) {
        let winnerIdx = i, winnerLen = myLen;
        for (const [j, L] of endpointHits) {
          if (L > winnerLen + EPS || (Math.abs(L - winnerLen) < EPS && j < winnerIdx)) {
            winnerIdx = j;
            winnerLen = L;
          }
        }
        // Loser retracts by t/2 (stops at winner's face).
        // Winner extends by t/2 into the corner to close the gap.
        retractions[i][side] = (winnerIdx !== i) ? iwT / 2 : -iwT / 2;
      }
    }
  }
  return retractions;
}


export function interiorWallSpecs(interiorWallsList, iwT, h, iwToRidge,
                                  ridgeAlongX, ridgeH,
                                  gblHalfSpan, gblHEaveUnder, gblHApexUnder,
                                  gblCenterX, gblCenterY,
                                  extIx0 = null, extIy0 = null,
                                  extIx1 = null, extIy1 = null) {
  const joints = computeIwJoints(interiorWallsList, iwT,
                                 extIx0, extIy0, extIx1, extIy1);
  const specs = [];
  for (let i = 0; i < interiorWallsList.length; i++) {
    const iw = interiorWallsList[i];
    const ix0 = Number(iw.x0), iy0 = Number(iw.y0);
    const ix1 = Number(iw.x1), iy1 = Number(iw.y1);
    const isHoriz = Math.abs(iy1 - iy0) < 1;
    const [r0, r1] = joints[i];
    let bx0, bx1, by0, by1;
    if (isHoriz) {
      const lowRetract  = (ix0 <= ix1) ? r0 : r1;
      const highRetract = (ix0 <= ix1) ? r1 : r0;
      bx0 = Math.min(ix0, ix1) + lowRetract;
      bx1 = Math.max(ix0, ix1) - highRetract;
      by0 = iy0 - iwT / 2;
      by1 = iy0 + iwT / 2;
    } else {
      const lowRetract  = (iy0 <= iy1) ? r0 : r1;
      const highRetract = (iy0 <= iy1) ? r1 : r0;
      bx0 = ix0 - iwT / 2;
      bx1 = ix0 + iwT / 2;
      by0 = Math.min(iy0, iy1) + lowRetract;
      by1 = Math.max(iy0, iy1) - highRetract;
    }
    if (bx1 - bx0 < 1 || by1 - by0 < 1) continue;

    if (iwToRidge) {
      const underside = (xw, yw) => {
        const dist = ridgeAlongX
          ? Math.min(gblHalfSpan, Math.abs(yw - gblCenterY))
          : Math.min(gblHalfSpan, Math.abs(xw - gblCenterX));
        return gblHEaveUnder + ridgeH * (1 - dist / gblHalfSpan);
      };

      let pts, direction;
      if (isHoriz) {
        const yWall = iy0;
        const zLeft = underside(bx0, yWall);
        const zRight = underside(bx1, yWall);
        pts = [
          [bx0, by0, 0],
          [bx1, by0, 0],
          [bx1, by0, zRight],
        ];
        if ((!ridgeAlongX) && bx0 + 1 < gblCenterX && gblCenterX < bx1 - 1) {
          pts.push([gblCenterX, by0, gblHApexUnder]);
        }
        pts.push([bx0, by0, zLeft]);
        pts.push([bx0, by0, 0]);
        direction = [0, iwT, 0];
      } else {
        const xWall = ix0;
        const zBot = underside(xWall, by0);
        const zTop = underside(xWall, by1);
        pts = [
          [bx0, by0, 0],
          [bx0, by1, 0],
          [bx0, by1, zTop],
        ];
        if (ridgeAlongX && by0 + 1 < gblCenterY && gblCenterY < by1 - 1) {
          pts.push([bx0, gblCenterY, gblHApexUnder]);
        }
        pts.push([bx0, by0, zBot]);
        pts.push([bx0, by0, 0]);
        direction = [iwT, 0, 0];
      }
      pts = ensureOutwardPolygon(pts, direction);
      specs.push({ kind: "extruded", pts, dir: direction, cap: true });
    } else {
      specs.push({ kind: "box",
                   x: [bx0, bx1], y: [by0, by1], z: [0, h] });
    }
  }
  return specs;
}


export function computeGeometrySpecs(data) {
  const x0 = Number(data.x0);
  const y0 = Number(data.y0);
  const x1 = Number(data.x1);
  const y1 = Number(data.y1);
  const h = Number(data.height ?? 2400);
  const t = Number(data.thickness ?? 150);
  const roofT = Number(data.roofThickness ?? 295);

  const w = x1 - x0;
  const d = y1 - y0;

  const roofType = data.roofType ?? "flat";
  const defaultRidge = Math.min(w, d) * 0.35;
  const ridgeH = (roofType === "gable") ? Number(data.ridgeH ?? defaultRidge) : 0;
  const ridgeAlongX = w >= d;

  const flatSlope = data.flatSlopeH ?? [0, 0];

  const iwT = Number(data.interiorThickness ?? t);
  const iwToRidge = Boolean(data.iwToRidge) && roofType === "gable";
  const interiorWalls = data.interiorWalls ?? [];

  // Gable parameters (shared by exterior walls AND iw-to-ridge interior walls)
  let gblHalfSpan, gblHEaveUnder, gblHApexUnder, gblCenterX, gblCenterY;
  if (roofType === "gable") {
    gblHalfSpan = ridgeAlongX ? d/2 : w/2;
    const gblEaveLift = roofT - ridgeH * t / gblHalfSpan;
    // Interior walls with iwToRidge stop at the roof UNDERSIDE (one slab
    // below roof top). The exterior gable pentagon walls go all the way up
    // to the roof TOP and compute their own apex locally.
    gblHEaveUnder = h + gblEaveLift - roofT;
    gblHApexUnder = h + ridgeH + gblEaveLift - roofT;
    gblCenterX = (x0 + x1) / 2;
    gblCenterY = (y0 + y1) / 2;
  } else {
    gblHalfSpan = gblHEaveUnder = gblHApexUnder = 0;
    gblCenterX = gblCenterY = 0;
  }

  const wallSpecs = exteriorWallSpecs(x0, y0, x1, y1, h, t, roofType, flatSlope,
                                      roofT, ridgeH, ridgeAlongX);
  // Inner footprint (where interior walls actually live) — used to detect "end
  // lands on exterior face" for joint retraction.
  wallSpecs.push(...interiorWallSpecs(interiorWalls, iwT, h, iwToRidge,
                                      ridgeAlongX, ridgeH,
                                      gblHalfSpan, gblHEaveUnder, gblHApexUnder,
                                      gblCenterX, gblCenterY,
                                      x0 + t, y0 + t, x1 - t, y1 - t));

  const doorSpecs = [];
  const windowSpecs = [];
  for (const op of (data.openings ?? [])) {
    const spec = openingSpec(x0, y0, x1, y1, t,
                             parseInt(op.wallIdx, 10), Number(op.posAlong), op.type,
                             interiorWalls, iwT,
                             op.width, op.height, op.sill);
    if (spec === null) continue;
    if (op.type === "door") doorSpecs.push(spec);
    else windowSpecs.push(spec);
  }

  const eaveOH = Math.max(0.0, Number(data.eaveOH ?? 0));
  const gableOH = Math.max(0.0, Number(data.gableOH ?? 0));
  const roofSpecList = roofSpecs(x0, y0, x1, y1, h, roofType,
                                 { ridgeH: roofType === "gable" ? ridgeH : null,
                                   flatSlope, t, roofT,
                                   eaveOH, gableOH });

  let materialFactor = Number(data.materialFactor ?? 3.1);
  if (!Number.isFinite(materialFactor)) materialFactor = 3.1;
  let fabFactor = Number(data.fabFactor ?? 1.0);
  if (!Number.isFinite(fabFactor)) fabFactor = 1.0;

  return {
    walls: wallSpecs,
    roof: roofSpecList,
    doors: doorSpecs,
    windows: windowSpecs,
    material_factor: materialFactor,
    fab_factor: fabFactor,
  };
}
