"use strict";
/*
Cell resampler module used by submapper and resampler (transform)
main function: resample(options);
*/

window.Submap = (function () {
  const isWater = (pack, id) => pack.cells.h[id] < 20;
  const inMap = (x, y) => x > 0 && x < graphWidth && y > 0 && y < graphHeight;

  function resample(parentMap, options) {
    /*
    generate new map based on an existing one (resampling parentMap)
    parentMap: {seed, grid, pack} from original map
    options = {
          projection: f(Number,Number)->[Number, Number]
                      function to calculate new coordinates
          inverse: g(Number,Number)->[Number, Number]
                    inverse of f
          depressRivers: Bool     carve out riverbeds?
          smoothHeightMap: Bool   run smooth filter on heights
          addLakesInDepressions:  call FMG original funtion on heightmap

          lockMarkers: Bool       Auto lock all copied markers
          lockBurgs: Bool         Auto lock all copied burgs
      }
    */

    const projection = options.projection;
    const inverse = options.inverse;
    const stage = s => INFO && console.log("SUBMAP:", s);
    const timeStart = performance.now();
    invokeActiveZooming();

    // copy seed
    seed = parentMap.seed;
    Math.random = aleaPRNG(seed);
    INFO && console.group("带种子的子地图: " + seed);
    DEBUG && console.log("使用选项:", options);

    // create new grid
    applyMapSize();
    grid = generateGrid();

    drawScaleBar(scale);

    const resampler = (points, qtree, f) => {
      for (const [i, [x, y]] of points.entries()) {
        const [tx, ty] = inverse(x, y);
        const oldid = qtree.find(tx, ty, Infinity)[2];
        f(i, oldid);
      }
    };

    stage("重新采样高程图，温度和降水量.");
    // resample heightmap from old WorldState
    const n = grid.points.length;
    grid.cells.h = new Uint8Array(n); // heightmap
    grid.cells.temp = new Int8Array(n); // temperature
    grid.cells.prec = new Uint8Array(n); // precipitation
    const reverseGridMap = new Uint32Array(n); // cellmap from new -> oldcell

    const oldGrid = parentMap.grid;
    // build cache old -> [newcelllist]
    const forwardGridMap = parentMap.grid.points.map(_ => []);
    resampler(grid.points, parentMap.pack.cells.q, (id, oldid) => {
      const cid = parentMap.pack.cells.g[oldid];
      grid.cells.h[id] = oldGrid.cells.h[cid];
      grid.cells.temp[id] = oldGrid.cells.temp[cid];
      grid.cells.prec[id] = oldGrid.cells.prec[cid];
      if (options.depressRivers) forwardGridMap[cid].push(id);
      reverseGridMap[id] = cid;
    });
    // TODO: add smooth/noise function for h, temp, prec n times

    // smooth heightmap
    // smoothing should never change cell type (land->water or water->land)

    if (options.smoothHeightMap) {
      const gcells = grid.cells;
      gcells.h.forEach((h, i) => {
        const hs = gcells.c[i].map(c => gcells.h[c]);
        hs.push(h);
        gcells.h[i] = h >= 20 ? Math.max(d3.mean(hs), 20) : Math.min(d3.mean(hs), 19);
      });
    }

    if (options.depressRivers) {
      stage("产生河床");
      const rbeds = new Uint16Array(grid.cells.i.length);

      // and erode riverbeds
      parentMap.pack.rivers.forEach(r =>
        r.cells.forEach(oldpc => {
          if (oldpc < 0) return; // ignore out-of-map marker (-1)
          const oldc = parentMap.pack.cells.g[oldpc];
          const targetCells = forwardGridMap[oldc];
          if (!targetCells) throw "目标单元格不应该是空的.";
          targetCells.forEach(c => {
            if (grid.cells.h[c] < 20) return;
            rbeds[c] = 1;
          });
        })
      );
      // raise every land cell a bit except riverbeds
      grid.cells.h.forEach((h, i) => {
        if (rbeds[i] || h < 20) return;
        grid.cells.h[i] = Math.min(h + 2, 100);
      });
    }

    stage("探测文化、海洋和形成的湖泊.");
    markFeatures();
    markupGridOcean();

    // Warning: addLakesInDeepDepressions can be very slow!
    if (options.addLakesInDepressions) {
      addLakesInDeepDepressions();
      openNearSeaLakes();
    }

    OceanLayers();

    calculateMapCoordinates();
    // calculateTemperatures();
    // generatePrecipitation();
    stage("清理单元格.");
    reGraph();

    // remove misclassified cells
    stage("定义海岸线.");
    drawCoastline();

    /****************************************************/
    /* Packed Graph */
    /****************************************************/
    const oldCells = parentMap.pack.cells;
    // const reverseMap = new Map(); // cellmap from new -> oldcell
    const forwardMap = parentMap.pack.cells.p.map(_ => []); // old -> [newcelllist]

    const pn = pack.cells.i.length;
    const cells = pack.cells;
    cells.culture = new Uint16Array(pn);
    cells.state = new Uint16Array(pn);
    cells.burg = new Uint16Array(pn);
    cells.religion = new Uint16Array(pn);
    cells.road = new Uint16Array(pn);
    cells.crossroad = new Uint16Array(pn);
    cells.province = new Uint16Array(pn);

    stage("重新抽样文化、国家和宗教地图.");
    for (const [id, gridCellId] of cells.g.entries()) {
      const oldGridId = reverseGridMap[gridCellId];
      if (oldGridId === undefined) {
        console.error("找不到旧的单元格号码", reverseGridMap, "in", gridCellId);
        continue;
      }
      // find old parent's children
      const oldChildren = oldCells.i.filter(oid => oldCells.g[oid] == oldGridId);
      let oldid; // matching cell on the original map

      if (!oldChildren.length) {
        // it *must* be a (deleted) deep ocean cell
        if (!oldGrid.cells.h[oldGridId] < 20) {
          console.error(`警告, ${gridCellId} 应该是水单元格, 而不是 ${oldGrid.cells.h[oldGridId]}`);
          continue;
        }
        // find replacement: closest water cell
        const [ox, oy] = cells.p[id];
        const [tx, ty] = inverse(x, y);
        oldid = oldCells.q.find(tx, ty, Infinity)[2];
        if (!oldid) {
          console.warn("警告，四周找不到身份信息", id, "parent", gridCellId);
          continue;
        }
      } else {
        // find closest children (packcell) on the parent map
        const distance = x => (x[0] - cells.p[id][0]) ** 2 + (x[1] - cells.p[id][1]) ** 2;
        let d = Infinity;
        oldChildren.forEach(oid => {
          // this should be always true, unless some algo modded the height!
          if (isWater(parentMap.pack, oid) !== isWater(pack, id)) {
            console.warn(`单元格沉没是因为 addLakesInDepressions: ${oid}`);
          }
          const [oldpx, oldpy] = oldCells.p[oid];
          const nd = distance(projection(oldpx, oldpy));
          if (isNaN(nd)) {
            console.error("距离不是数字!", "Old point:", oldpx, oldpy);
          }
          if (nd < d) [d, oldid] = [nd, oid];
        });
        if (oldid === undefined) {
          console.warn("警告，无法匹配", id, "(parent:", gridCellId, ")");
          continue;
        }
      }

      if (isWater(pack, id) !== isWater(parentMap.pack, oldid)) {
        WARN && console.warn("检测到类型差异:", id, oldid, `${pack.cells.t[id]} != ${oldCells.t[oldid]}`);
      }

      cells.culture[id] = oldCells.culture[oldid];
      cells.state[id] = oldCells.state[oldid];
      cells.religion[id] = oldCells.religion[oldid];
      cells.province[id] = oldCells.province[oldid];
      // reverseMap.set(id, oldid)
      forwardMap[oldid].push(id);
    }

    stage("重建河网.");
    Rivers.generate();
    drawRivers();
    Lakes.defineGroup();

    // biome calculation based on (resampled) grid.cells.temp and prec
    // it's safe to recalculate.
    stage("重建生物群落.");
    defineBiomes();
    // recalculate suitability and population
    // TODO: normalize according to the base-map
    rankCells();

    stage("移植文化");
    pack.cultures = parentMap.pack.cultures;
    // fix culture centers
    const validCultures = new Set(pack.cells.culture);
    pack.cultures.forEach((c, i) => {
      if (!i) return; // ignore wildlands
      if (!validCultures.has(i)) {
        c.removed = true;
        c.center = null;
        return;
      }
      const newCenters = forwardMap[c.center];
      c.center = newCenters.length ? newCenters[0] : pack.cells.culture.findIndex(x => x === i);
    });

    stage("移植和锁定城市.");
    copyBurgs(parentMap, projection, options);

    // transfer states, mark states without land as removed.
    stage("移植国家.");
    const validStates = new Set(pack.cells.state);
    pack.states = parentMap.pack.states;
    // keep valid states and neighbors only
    pack.states.forEach((s, i) => {
      if (!s.i || s.removed) return; // ignore removed and neutrals
      if (!validStates.has(i)) s.removed = true;
      s.neighbors = s.neighbors.filter(n => validStates.has(n));

      // find center
      s.center = pack.burgs[s.capital].cell
        ? pack.burgs[s.capital].cell // capital is the best bet
        : pack.cells.state.findIndex(x => x === i); // otherwise use the first valid cell
    });

    // transfer provinces, mark provinces without land as removed.
    stage("移植省份.");
    const validProvinces = new Set(pack.cells.province);
    pack.provinces = parentMap.pack.provinces;
    // mark uneccesary provinces
    pack.provinces.forEach((p, i) => {
      if (!p || p.removed) return;
      if (!validProvinces.has(i)) {
        p.removed = true;
        return;
      }
      const newCenters = forwardMap[p.center];
      p.center = newCenters.length ? newCenters[0] : pack.cells.province.findIndex(x => x === i);
    });

    BurgsAndStates.drawBurgs();

    stage("重建道路网络.");
    Routes.regenerate();

    drawStates();
    drawBorders();
    BurgsAndStates.drawStateLabels();

    Rivers.specify();
    Lakes.generateName();

    stage("转移军队.");
    for (const s of pack.states) {
      if (!s.military) continue;
      for (const m of s.military) {
        [m.x, m.y] = projection(m.x, m.y);
        [m.bx, m.by] = projection(m.bx, m.by);
        const cc = forwardMap[m.cell];
        m.cell = cc && cc.length ? cc[0] : null;
      }
      s.military = s.military.filter(m => m.cell).map((m, i) => ({...m, i}));
    }
    Military.redraw();

    stage("复制记号.");
    for (const m of pack.markers) {
      const [x, y] = projection(m.x, m.y);
      if (!inMap(x, y)) {
        Markers.deleteMarker(m.i);
      } else {
        m.x = x;
        m.y = y;
        m.cell = findCell(x, y);
        if (options.lockMarkers) m.lock = true;
      }
    }
    if (layerIsOn("toggleMarkers")) drawMarkers();

    stage("重画徽章.");
    drawEmblems();
    stage("再生区域.");
    addZones();
    Names.getMapName();
    stage("还原笔记.");
    notes = parentMap.notes;
    stage("子地图完成.");

    WARN && console.warn(`总计: ${rn((performance.now() - timeStart) / 1000, 2)}s`);
    showStatistics();
    INFO && console.groupEnd("生成地图 " + seed);
  }

  /* find the nearest cell accepted by filter f *and* having at
   *  least one *neighbor* fulfilling filter g, up to cell-distance `max`
   *  returns [cellid, neighbor] tuple or undefined if no such cell.
   *  accepts coordinates (x, y)
   */
  const findNearest =
    (f, g, max = 3) =>
    (px, py) => {
      const d2 = c => (px - pack.cells.p[c][0]) ** 2 + (py - pack.cells.p[c][0]) ** 2;
      const startCell = findCell(px, py);
      const tested = new Set([startCell]); // ignore analyzed cells
      const kernel = (cs, level) => {
        const [bestf, bestg] = cs.filter(f).reduce(
          ([cf, cg], c) => {
            const neighbors = pack.cells.c[c];
            const betterg = neighbors.filter(g).reduce((u, x) => (d2(x) < d2(u) ? x : u));
            if (cf === undefined) return [c, betterg];
            return betterg && d2(cf) < d2(c) ? [c, betterg] : [cf, cg];
          },
          [undefined, undefined]
        );
        if (bestf && bestg) return [bestf, bestg];

        // no suitable pair found, retry with next ring
        const targets = new Set(cs.map(c => pack.cells.c[c]).flat());
        const ring = Array.from(targets).filter(nc => !tested.has(nc));
        if (level >= max || !ring.length) return [undefined, undefined];
        ring.forEach(c => tested.add(c));
        return kernel(ring, level + 1);
      };
      const pair = kernel([startCell], 1);
      return pair;
    };

  function copyBurgs(parentMap, projection, options) {
    const cells = pack.cells;
    pack.burgs = parentMap.pack.burgs;

    // remap burgs to the best new cell
    pack.burgs.forEach((b, id) => {
      if (id == 0) return; // skip empty city of neturals
      [b.x, b.y] = projection(b.x, b.y);
      b.population = b.population * options.scale; // adjust for populationRate change

      // disable out-of-map (removed) burgs
      if (!inMap(b.x, b.y)) {
        b.removed = true;
        b.cell = null;
        return;
      }

      const cityCell = findCell(b.x, b.y);
      let searchFunc;
      const isFreeLand = c => cells.t[c] === 1 && !cells.burg[c];
      const nearCoast = c => cells.t[c] === -1;

      // check if we need to relocate the burg
      if (cells.burg[cityCell])
        // already occupied
        searchFunc = findNearest(isFreeLand, _ => true, 3);

      if (isWater(pack, cityCell) || b.port)
        // burg is in water or port
        searchFunc = findNearest(isFreeLand, nearCoast, 6);

      if (searchFunc) {
        const [newCell, neighbor] = searchFunc(b.x, b.y);
        if (!newCell) {
          WARN && console.warn(`无法重新安置城市: ${b.name} 已沉没毁灭. :-(`);
          b.cell = null;
          b.removed = true;
          return;
        }
        DEBUG && console.log(`移动 ${b.name} 从 ${cityCell} 到 ${newCell} 邻近 ${neighbor}.`);
        [b.x, b.y] = b.port ? getMiddlePoint(newCell, neighbor) : cells.p[newCell];
        if (b.port) b.port = cells.f[neighbor]; // copy feature number
        b.cell = newCell;
        if (b.port && !isWater(pack, neighbor)) console.error("冲突！邻近一定要是水!", b);
      } else {
        b.cell = cityCell;
      }
      if (b.i && !b.lock) b.lock = options.lockBurgs;
      cells.burg[b.cell] = id;
    });
  }

  // export
  return {resample, findNearest};
})();
