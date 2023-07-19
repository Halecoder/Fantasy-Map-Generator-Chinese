"use strict";
function editCoastline(node = d3.event.target) {
  if (customization) return;
  closeDialogs(".stable");
  if (layerIsOn("toggleCells")) toggleCells();

  $("#coastlineEditor").dialog({
    title: "编辑海岸线",
    resizable: false,
    position: {my: "center top+20", at: "top", of: d3.event, collision: "fit"},
    close: closeCoastlineEditor
  });

  debug.append("g").attr("id", "vertices");
  elSelected = d3.select(node);
  selectCoastlineGroup(node);
  drawCoastlineVertices();
  viewbox.on("touchmove mousemove", null);

  if (modules.editCoastline) return;
  modules.editCoastline = true;

  // add listeners
  document.getElementById("coastlineGroupsShow").addEventListener("click", showGroupSection);
  document.getElementById("coastlineGroup").addEventListener("change", changeCoastlineGroup);
  document.getElementById("coastlineGroupAdd").addEventListener("click", toggleNewGroupInput);
  document.getElementById("coastlineGroupName").addEventListener("change", createNewGroup);
  document.getElementById("coastlineGroupRemove").addEventListener("click", removeCoastlineGroup);
  document.getElementById("coastlineGroupsHide").addEventListener("click", hideGroupSection);
  document.getElementById("coastlineEditStyle").addEventListener("click", editGroupStyle);

  function drawCoastlineVertices() {
    const f = +elSelected.attr("data-f"); // feature id
    const v = pack.features[f].vertices; // coastline outer vertices

    const l = pack.cells.i.length;
    const c = [...new Set(v.map(v => pack.vertices.c[v]).flat())].filter(c => c < l);
    debug
      .select("#vertices")
      .selectAll("polygon")
      .data(c)
      .enter()
      .append("polygon")
      .attr("points", d => getPackPolygon(d))
      .attr("data-c", d => d);

    debug
      .select("#vertices")
      .selectAll("circle")
      .data(v)
      .enter()
      .append("circle")
      .attr("cx", d => pack.vertices.p[d][0])
      .attr("cy", d => pack.vertices.p[d][1])
      .attr("r", 0.4)
      .attr("data-v", d => d)
      .call(d3.drag().on("drag", dragVertex))
      .on("mousemove", () => tip("拖动可移动顶点，请仅用于微调。编辑高程图可更改实际单元格高度"));

    const area = pack.features[f].area;
    coastlineArea.innerHTML = si(getArea(area)) + " " + getAreaUnit();
  }

  function dragVertex() {
    const x = rn(d3.event.x, 2),
      y = rn(d3.event.y, 2);
    this.setAttribute("cx", x);
    this.setAttribute("cy", y);
    const v = +this.dataset.v;
    pack.vertices.p[v] = [x, y];
    debug
      .select("#vertices")
      .selectAll("polygon")
      .attr("points", d => getPackPolygon(d));
    redrawCoastline();
  }

  function redrawCoastline() {
    lineGen.curve(d3.curveBasisClosed);
    const f = +elSelected.attr("data-f");
    const vertices = pack.features[f].vertices;
    const points = clipPoly(
      vertices.map(v => pack.vertices.p[v]),
      1
    );
    const d = round(lineGen(points));
    elSelected.attr("d", d);
    defs.select("mask#land > path#land_" + f).attr("d", d); // update land mask
    defs.select("mask#water > path#water_" + f).attr("d", d); // update water mask

    const area = Math.abs(d3.polygonArea(points));
    coastlineArea.innerHTML = si(getArea(area)) + " " + getAreaUnit();
  }

  function showGroupSection() {
    document.querySelectorAll("#coastlineEditor > button").forEach(el => (el.style.display = "none"));
    document.getElementById("coastlineGroupsSelection").style.display = "inline-block";
  }

  function hideGroupSection() {
    document.querySelectorAll("#coastlineEditor > button").forEach(el => (el.style.display = "inline-block"));
    document.getElementById("coastlineGroupsSelection").style.display = "none";
    document.getElementById("coastlineGroupName").style.display = "none";
    document.getElementById("coastlineGroupName").value = "";
    document.getElementById("coastlineGroup").style.display = "inline-block";
  }

  function selectCoastlineGroup(node) {
    const group = node.parentNode.id;
    const select = document.getElementById("coastlineGroup");
    select.options.length = 0; // remove all options

    coastline.selectAll("g").each(function () {
      select.options.add(new Option(this.id, this.id, false, this.id === group));
    });
  }

  function changeCoastlineGroup() {
    document.getElementById(this.value).appendChild(elSelected.node());
  }

  function toggleNewGroupInput() {
    if (coastlineGroupName.style.display === "none") {
      coastlineGroupName.style.display = "inline-block";
      coastlineGroupName.focus();
      coastlineGroup.style.display = "none";
    } else {
      coastlineGroupName.style.display = "none";
      coastlineGroup.style.display = "inline-block";
    }
  }

  function createNewGroup() {
    if (!this.value) {
      tip("请提供一个有效的组名");
      return;
    }
    const group = this.value
      .toLowerCase()
      .replace(/ /g, "_")
      .replace(/[^\w\s]/gi, "");

    if (document.getElementById(group)) {
      tip("具有此 ID 的元素已经存在。请提供唯一的名称", false, "error");
      return;
    }

    if (Number.isFinite(+group.charAt(0))) {
      tip("组名应以字母开头", false, "error");
      return;
    }

    // just rename if only 1 element left
    const oldGroup = elSelected.node().parentNode;
    const basic = ["sea_island", "lake_island"].includes(oldGroup.id);
    if (!basic && oldGroup.childElementCount === 1) {
      document.getElementById("coastlineGroup").selectedOptions[0].remove();
      document.getElementById("coastlineGroup").options.add(new Option(group, group, false, true));
      oldGroup.id = group;
      toggleNewGroupInput();
      document.getElementById("coastlineGroupName").value = "";
      return;
    }

    // create a new group
    const newGroup = elSelected.node().parentNode.cloneNode(false);
    document.getElementById("coastline").appendChild(newGroup);
    newGroup.id = group;
    document.getElementById("coastlineGroup").options.add(new Option(group, group, false, true));
    document.getElementById(group).appendChild(elSelected.node());

    toggleNewGroupInput();
    document.getElementById("coastlineGroupName").value = "";
  }

  function removeCoastlineGroup() {
    const group = elSelected.node().parentNode.id;
    if (["sea_island", "lake_island"].includes(group)) {
      tip("这是默认组之一，无法删除", false, "error");
      return;
    }

    const count = elSelected.node().parentNode.childElementCount;
    alertMessage.innerHTML = /* html */ `确实要删除该组吗? 该组的所有海岸线元素 (${count}) 将被移到
      <i>sea_island</i> 组`;
    $("#alert").dialog({
      resizable: false,
      title: "删除海岸线组",
      width: "26em",
      buttons: {
        删除: function () {
          $(this).dialog("close");
          const sea = document.getElementById("sea_island");
          const groupEl = document.getElementById(group);
          while (groupEl.childNodes.length) {
            sea.appendChild(groupEl.childNodes[0]);
          }
          groupEl.remove();
          document.getElementById("coastlineGroup").selectedOptions[0].remove();
          document.getElementById("coastlineGroup").value = "sea_island";
        },
        取消: function () {
          $(this).dialog("close");
        }
      }
    });
  }

  function editGroupStyle() {
    const g = elSelected.node().parentNode.id;
    editStyle("coastline", g);
  }

  function closeCoastlineEditor() {
    debug.select("#vertices").remove();
    unselect();
  }
}
