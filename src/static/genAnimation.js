// genAnimation.js — scan-plane + stud-preview animation during frame generation.
// Self-contained: no globals read directly; all Three.js state passed via start().
import * as THREE from 'three';

window.GenAnimation = (() => {
  const _u = {
    u_scanZ:      { value: 0 },
    u_scanActive: { value: 0 },
    u_scanMode:   { value: 0 }, // 0 = sweep, 1 = sections
  };

  let _scene = null, _mesh = null, _raf = null;
  let _studGroups = [];
  let _studMat = null;
  let _animId = 0;

  // ── Material patching ────────────────────────────────────────────────────
  function _patch(mat) {
    if (!mat || mat._genAnimPatched) return;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhongMaterial)) return;
    mat._genAnimPatched = true;
    mat.onBeforeCompile = shader => {
      shader.uniforms.u_scanZ      = _u.u_scanZ;
      shader.uniforms.u_scanActive = _u.u_scanActive;
      shader.uniforms.u_scanMode   = _u.u_scanMode;
      shader.vertexShader =
        'varying float vScanWorldZ;\n' +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvScanWorldZ = (modelMatrix * vec4(position,1.0)).z;'
        );
      shader.fragmentShader =
        'varying float vScanWorldZ;\nuniform float u_scanZ;\nuniform float u_scanActive;\nuniform float u_scanMode;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
if (u_scanActive > 0.5) {
  float _dist;
  if (u_scanMode < 0.5) {
    _dist = abs(vScanWorldZ - u_scanZ);
  } else {
    float _m = mod(vScanWorldZ, 600.0);
    _dist = min(_m, 600.0 - _m);
  }
  float _core  = smoothstep(15.0,  0.0, _dist);
  float _inner = smoothstep(80.0,  0.0, _dist) * 0.7;
  float _outer = smoothstep(300.0, 0.0, _dist) * 0.35;
  float _g = clamp(_core + _inner + _outer, 0.0, 1.0);
  vec3  _hot = mix(vec3(1.0, 0.55, 0.08), vec3(1.0, 0.95, 0.7), _core);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, _hot, _g);
  gl_FragColor.rgb += _hot * _outer * 0.6;
  gl_FragColor.a   = max(gl_FragColor.a, _g * 0.9);
}`
        );
    };
    mat.needsUpdate = true;
  }

  function _patchGroups(groups) {
    groups.forEach(g => {
      if (!g) return;
      g.traverse(o => {
        if (!o.isMesh) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(_patch);
      });
    });
  }

  // ── Box geometry helpers ─────────────────────────────────────────────────
  function _getMat() {
    if (!_studMat) {
      _studMat = new THREE.MeshBasicMaterial({
        color: 0xFF8010, transparent: true, opacity: 0.85,
        depthTest: false, blending: THREE.AdditiveBlending,
      });
    }
    return _studMat;
  }

  // Creates a box with `w` along wall.along, `d` along wall.outward, `h` along Z.
  // `angle` = atan2(along.y, along.x) pre-computed per wall.
  function _addBox(w, d, h, px, py, pz, angle) {
    const geo = new THREE.BoxGeometry(w, d, h);
    const mesh = new THREE.Mesh(geo, _getMat());
    mesh.rotation.z = angle;
    mesh.position.set(px, py, pz);
    mesh.renderOrder = 11;
    _scene.add(mesh);
    _studGroups.push(mesh);
  }

  function _clearStuds() {
    _studGroups.forEach(g => {
      _scene.remove(g);
      g.geometry.dispose();
    });
    _studGroups = [];
    if (_studMat) { _studMat.dispose(); _studMat = null; }
  }

  // ── Raycasting ───────────────────────────────────────────────────────────
  function _shootRoof(rx, ry, wallH, roofGroup) {
    if (!roofGroup) return wallH;
    const rc = new THREE.Raycaster(
      new THREE.Vector3(rx, ry, 0),
      new THREE.Vector3(0, 0, 1),
      wallH * 0.3,
      wallH * 4
    );
    const hits = rc.intersectObject(roofGroup, true);
    return hits.length > 0 ? hits[0].point.z : wallH;
  }

  // ── Stud-box sequence ────────────────────────────────────────────────────
  function _runStudSequence(walls, wallH, roofGroup) {
    const myId = ++_animId;

    const roofBox = new THREE.Box3();
    if (roofGroup) roofBox.setFromObject(roofGroup);
    const hasGable    = !roofBox.isEmpty() && (roofBox.max.z - wallH) > 100;
    const ridgeAlongX = (roofBox.max.x - roofBox.min.x) >= (roofBox.max.y - roofBox.min.y);
    const cx = (roofBox.min.x + roofBox.max.x) / 2;
    const cy = (roofBox.min.y + roofBox.max.y) / 2;

    const SW = 90, SD = 140, PH = 45; // stud width, outward depth, plate height (mm)

    // Pre-compute stud positions + heights for every wall
    const wallData = walls.map(wall => {
      const wallAlongX = Math.abs(wall.along.x) > 0.5;
      const isGable = hasGable && (ridgeAlongX ? !wallAlongX : wallAlongX);
      const angle = Math.atan2(wall.along.y, wall.along.x);

      const studs = [];
      for (let u = 0; u <= wall.length + 1; u += 600) {
        const uc = Math.min(u, wall.length);
        const x = wall.origin.x + wall.along.x * uc;
        const y = wall.origin.y + wall.along.y * uc;

        let topZ;
        if (wall.isInterior) {
          topZ = wallH;
        } else if (isGable) {
          // Shift ray to house centre along the ridge so it hits the slope interior.
          const rx = ridgeAlongX ? cx : x;
          const ry = ridgeAlongX ? y  : cy;
          topZ = _shootRoof(rx, ry, wallH, roofGroup);
        } else {
          topZ = _shootRoof(x, y, wallH, roofGroup);
        }
        studs.push({ x, y, topZ });
      }
      return { wall, angle, studs };
    });

    // Phase 1: bottom plates (all walls simultaneously)
    wallData.forEach(({ wall, angle }) => {
      if (wall.length < 1) return;
      const mx = wall.origin.x + wall.along.x * wall.length / 2;
      const my = wall.origin.y + wall.along.y * wall.length / 2;
      _addBox(wall.length, SD, PH, mx, my, PH / 2, angle);
    });

    // Phase 2: top plates
    setTimeout(() => {
      if (_animId !== myId) return;
      wallData.forEach(({ wall, angle }) => {
        if (wall.length < 1) return;
        const mx = wall.origin.x + wall.along.x * wall.length / 2;
        const my = wall.origin.y + wall.along.y * wall.length / 2;
        _addBox(wall.length, SD, PH, mx, my, wallH - PH / 2, angle);
      });

      // Phase 3: studs, one column per tick across all walls in parallel
      setTimeout(() => {
        if (_animId !== myId) return;
        const maxStuds = Math.max(0, ...wallData.map(d => d.studs.length));
        let step = 0;

        function tick() {
          if (_animId !== myId || step >= maxStuds) return;
          wallData.forEach(({ studs, angle }) => {
            if (step >= studs.length) return;
            const s = studs[step];
            const h = Math.max(s.topZ - PH, 1);
            _addBox(SW, SD, h, s.x, s.y, PH + h / 2, angle);
          });
          step++;
          setTimeout(tick, 30);
        }
        tick();
      }, 150);
    }, 150);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    active() { return _raf !== null || _studGroups.length > 0; },

    start({ scene, groups, wallInfo, inH, houseMode, footprintWalls, interiorWalls, FF_WALL_OFFSET }) {
      _scene = scene;
      _patchGroups(groups);

      const box = new THREE.Box3();
      groups.forEach(g => { if (g) box.expandByObject(g); });
      const topZ = box.isEmpty() ? 6000 : box.max.z + 300;

      const geo = new THREE.PlaneGeometry(80000, 80000);
      geo.rotateX(-Math.PI / 2);
      _mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xFF8010, transparent: true, opacity: 0.18,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      _mesh.renderOrder = 10;
      scene.add(_mesh);

      _u.u_scanMode.value   = 0;
      _u.u_scanActive.value = 1;
      _u.u_scanZ.value      = topZ;

      const t0 = performance.now();

      function tick(now) {
        const t = Math.min((now - t0) / 750, 1);
        const z = topZ * (1 - t);
        _u.u_scanZ.value = z;
        _mesh.position.z = z;

        if (t < 1) {
          _raf = requestAnimationFrame(tick);
          return;
        }

        // Sweep done — remove plane, start box sequence
        _raf = null;
        scene.remove(_mesh); _mesh.geometry.dispose(); _mesh.material.dispose(); _mesh = null;
        _u.u_scanActive.value = 0;

        const walls = [];
        if (houseMode === 'free') {
          for (let i = 0; i < footprintWalls.length; i++) {
            const w = wallInfo(FF_WALL_OFFSET + i); if (w) walls.push(w);
          }
        } else {
          for (let i = 0; i < 4; i++) {
            const w = wallInfo(i); if (w) walls.push(w);
          }
        }
        for (let i = 0; i < interiorWalls.length; i++) {
          const w = wallInfo(4 + i); if (w) walls.push(w);
        }
        _runStudSequence(walls, +inH.value, groups[3]); // groups[3] = roofGroup
      }
      _raf = requestAnimationFrame(tick);
    },

    stop() {
      _animId++; // cancel any pending stud timeouts
      if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
      if (_mesh && _scene) { _scene.remove(_mesh); _mesh.geometry.dispose(); _mesh.material.dispose(); _mesh = null; }
      _u.u_scanActive.value = 0;
      _clearStuds();
    },
  };
})();
