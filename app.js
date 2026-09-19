/* ============================================================
   FORGE STUDIO — 3D Game Editor (MVP)
   Engine: Three.js r128. Single-file app logic.
   ============================================================ */
(function(){
'use strict';

/* ---------------- UTIL ---------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
let uidCounter = 1;
const uid = () => 'obj_' + (uidCounter++) + '_' + Math.random().toString(36).slice(2,7);

function toast(msg, kind){
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .2s'; setTimeout(()=>el.remove(),200); }, 1800);
}

/* ---------------- SCENE DATA MODEL ----------------
   Each node: { id, name, type, position, rotation, scale,
     color, material, transparency, anchored, collision, visible,
     size, script (id ref), children: [], parentId }
   type in: World, Camera, Spawn, Folder, Model, Part, Light, NPC, Script
------------------------------------------------------------- */
let sceneRoot = null;
let nodesById = new Map();
let selectedIds = new Set();
let scripts = {}; // scriptId -> {id,name,code}
let projectName = 'Untitled Project';
let dirty = false;

function markDirty(){ dirty = true; updateProjectTag(); }
function updateProjectTag(){
  const txt = projectName + (dirty ? ' *' : '');
  const a = $('#projectNameTag'); if(a) a.textContent = txt;
  const b = $('#ribbon-toolbar-tag'); if(b) b.textContent = txt;
}

function newNode(type, name, overrides){
  const n = Object.assign({
    id: uid(), name: name || type, type,
    position:{x:0,y: type==='Part'?1:0,z:0},
    rotation:{x:0,y:0,z:0},
    scale:{x:1,y:1,z:1},
    size:{x:2,y:2,z:2},
    color:'#5b8cff',
    material:'Plastic',
    transparency:0,
    anchored:true,
    collision:true,
    visible:true,
    scriptId:null,
    children:[],
    parentId:null
  }, overrides||{});
  nodesById.set(n.id, n);
  return n;
}

function addChild(parent, child){
  child.parentId = parent.id;
  parent.children.push(child);
}

function removeNode(node, opts){
  opts = opts || {};
  if(!node || node.type==='World') return;
  const parent = nodesById.get(node.parentId);
  if(parent) parent.children = parent.children.filter(c=>c.id!==node.id);
  // remove three object
  const obj3d = threeObjects.get(node.id);
  if(obj3d){ scene.remove(obj3d); threeObjects.delete(node.id); }
  (node.children||[]).slice().forEach(c=>removeNode(c,{silent:true}));
  nodesById.delete(node.id);
  selectedIds.delete(node.id);
  if(!opts.silent){ rebuildHierarchy(); refreshProperties(); markDirty(); }
}

function initEmptyProject(name, template){
  sceneRoot = newNode('World','World');
  scripts = {};
  const cam = newNode('Camera','MainCamera',{position:{x:0,y:5,z:10}});
  addChild(sceneRoot, cam);
  if(template === 'basic'){
    const baseplate = newNode('Part','Baseplate',{
      position:{x:0,y:-0.5,z:0}, size:{x:50,y:1,z:50}, color:'#3a3f4a', anchored:true
    });
    addChild(sceneRoot, baseplate);
    const spawn = newNode('Spawn','SpawnPoint',{position:{x:0,y:0.5,z:0}, size:{x:2,y:0.2,z:2}, color:'#3ddc84'});
    addChild(sceneRoot, spawn);
    const light = newNode('Light','SunLight',{position:{x:10,y:20,z:10}});
    addChild(sceneRoot, light);
  }
  projectName = name || 'Untitled Project';
  dirty = false;
  selectedIds.clear();
  rebuildScene3D();
  rebuildHierarchy();
  refreshProperties();
  rebuildScriptTabs();
  updateProjectTag();
  history = []; historyIndex = -1;
  pushHistory('Init Project');
}

/* ---------------- THREE.JS SETUP ---------------- */
let renderer, scene, camera, gridHelper, axesHelper;
let raycaster, mouse;
const threeObjects = new Map(); // nodeId -> THREE.Object3D
const viewportWrap = $('#viewport-wrap');

function initThree(){
  renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.shadowMap.enabled = true;
  viewportWrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0f13);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  camera.position.set(14,12,18);

  const hemi = new THREE.HemisphereLight(0xbdd4ff, 0x1a1c22, 0.6);
  scene.add(hemi);
  ambientRef = hemi;

  gridHelper = new THREE.GridHelper(100, 100, 0x3a3f4a, 0x24272f);
  scene.add(gridHelper);
  axesHelper = new THREE.AxesHelper(3);
  axesHelper.position.set(0.01,0.01,0.01);
  scene.add(axesHelper);

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  resizeRenderer();
  updateCameraFromOrbit();
  window.addEventListener('resize', resizeRenderer);
  animate();
}
let ambientRef;

function resizeRenderer(){
  const w = viewportWrap.clientWidth, h = viewportWrap.clientHeight;
  renderer.setSize(w,h,false);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

/* ---- Orbit camera (manual, no external dep) ---- */
const orbit = { target:new THREE.Vector3(0,1,0), radius:22, theta:0.9, phi:1.0, panSpeed:0.0016 };
function updateCameraFromOrbit(){
  const p = orbit;
  camera.position.set(
    p.target.x + p.radius*Math.sin(p.phi)*Math.sin(p.theta),
    p.target.y + p.radius*Math.cos(p.phi),
    p.target.z + p.radius*Math.sin(p.phi)*Math.cos(p.theta)
  );
  camera.lookAt(p.target);
}

let dragMode = null; // 'orbit' | 'pan' | 'gizmo'
let lastX=0, lastY=0;
let mouseDownX=0, mouseDownY=0, mouseMoved=false;
viewportWrap.addEventListener('mousedown', (e)=>{
  if(playMode) return;
  lastX = e.clientX; lastY = e.clientY;
  mouseDownX = e.clientX; mouseDownY = e.clientY; mouseMoved = false;
  if(e.button === 1 || (e.button===0 && e.shiftKey)){ dragMode='pan'; e.preventDefault(); }
  else if(e.button === 2){ dragMode='orbit'; }
  else if(e.button === 0){
    const hit = tryGizmoDrag(e);
    if(hit) { dragMode = 'gizmo'; }
    else { dragMode = 'orbit-or-select'; }
  }
});
window.addEventListener('mousemove', (e)=>{
  const dx = e.clientX-lastX, dy = e.clientY-lastY;
  lastX=e.clientX; lastY=e.clientY;
  if(Math.abs(e.clientX-mouseDownX)>3 || Math.abs(e.clientY-mouseDownY)>3) mouseMoved = true;
  if(playMode) return;
  if(dragMode==='orbit' || (dragMode==='orbit-or-select' && mouseMoved)){
    if(dragMode==='orbit-or-select') dragMode='orbit';
    orbit.theta -= dx*0.006;
    orbit.phi = Math.min(Math.PI-0.05, Math.max(0.05, orbit.phi - dy*0.006));
    updateCameraFromOrbit();
  } else if(dragMode==='pan'){
    const right = new THREE.Vector3(); camera.getWorldDirection(right);
    const camRight = new THREE.Vector3().crossVectors(camera.up, right).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, camRight).normalize();
    orbit.target.addScaledVector(camRight, dx*orbit.panSpeed*orbit.radius);
    orbit.target.addScaledVector(camUp, -dy*orbit.panSpeed*orbit.radius);
    updateCameraFromOrbit();
  } else if(dragMode==='gizmo'){
    updateGizmoDrag(e, dx, dy);
  }
});
window.addEventListener('mouseup', (e)=>{
  if(dragMode==='gizmo') endGizmoDrag();
  if(dragMode==='orbit-or-select' && !mouseMoved){
    pickAtMouse(e);
  }
  dragMode = null;
});
viewportWrap.addEventListener('contextmenu', e=>e.preventDefault());
viewportWrap.addEventListener('wheel', (e)=>{
  if(playMode) return;
  e.preventDefault();
  orbit.radius = Math.min(200, Math.max(2, orbit.radius * (1 + e.deltaY*0.001)));
  updateCameraFromOrbit();
}, {passive:false});

function pickAtMouse(e){
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX-rect.left)/rect.width)*2-1;
  mouse.y = -((e.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(mouse, camera);
  const meshes = [];
  threeObjects.forEach((obj,id)=>{ obj.traverse(c=>{ if(c.isMesh) meshes.push(c); }); });
  const hits = raycaster.intersectObjects(meshes, false);
  if(hits.length){
    let obj = hits[0].object;
    while(obj && !obj.userData.nodeId) obj = obj.parent;
    if(obj){
      const nodeId = obj.userData.nodeId;
      if(e.shiftKey){ toggleSelect(nodeId); } else { selectOnly(nodeId); }
      return;
    }
  }
  if(!e.shiftKey) selectOnly(null);
}

/* ---------------- BUILD THREE OBJECT FROM NODE ---------------- */
function materialForNode(node){
  const opacity = 1 - (node.transparency||0);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(node.color||'#5b8cff'),
    transparent: opacity < 1,
    opacity,
    roughness: node.material==='Metal'?0.35:node.material==='Glass'?0.05:0.85,
    metalness: node.material==='Metal'?0.8:0
  });
  return mat;
}

function buildThreeForNode(node){
  let obj;
  if(node.type==='Part' || node.type==='Spawn' || node.type==='Model' || node.type==='NPC'){
    const geo = new THREE.BoxGeometry(node.size.x, node.size.y, node.size.z);
    const mesh = new THREE.Mesh(geo, materialForNode(node));
    mesh.castShadow = true; mesh.receiveShadow = true;
    if(node.type==='NPC'){ mesh.geometry = new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(node.size.x*0.4, node.size.y*0.8, 4, 8) : geo; }
    obj = mesh;
  } else if(node.type==='Light'){
    const light = new THREE.PointLight(new THREE.Color(node.color||'#ffffff'), 1.2, 40);
    light.castShadow = true;
    const helper = new THREE.Mesh(new THREE.SphereGeometry(0.25,10,10), new THREE.MeshBasicMaterial({color:0xffe58a, wireframe:true}));
    light.add(helper);
    obj = light;
  } else if(node.type==='Camera'){
    const helper = new THREE.Mesh(new THREE.ConeGeometry(0.3,0.6,8), new THREE.MeshBasicMaterial({color:0x5b8cff, wireframe:true}));
    helper.rotation.x = Math.PI/2;
    obj = helper;
  } else if(node.type==='Folder' || node.type==='World' || node.type==='Script'){
    obj = new THREE.Group();
  } else {
    obj = new THREE.Group();
  }
  obj.userData.nodeId = node.id;
  applyTransform(obj, node);
  obj.visible = node.visible!==false;
  return obj;
}

function applyTransform(obj, node){
  obj.position.set(node.position.x, node.position.y, node.position.z);
  obj.rotation.set(THREE.MathUtils.degToRad(node.rotation.x), THREE.MathUtils.degToRad(node.rotation.y), THREE.MathUtils.degToRad(node.rotation.z));
  if(obj.isMesh){
    // scale represents multiplier on top of size baked into geometry
    obj.scale.set(node.scale.x, node.scale.y, node.scale.z);
  }
}

function rebuildScene3D(){
  threeObjects.forEach(o=>scene.remove(o));
  threeObjects.clear();
  function walk(node){
    if(node.type!=='World' && node.type!=='Script'){
      const obj = buildThreeForNode(node);
      threeObjects.set(node.id, obj);
      scene.add(obj);
    }
    (node.children||[]).forEach(walk);
  }
  walk(sceneRoot);
  updateObjCount();
}

function refreshThreeObject(node){
  const obj = threeObjects.get(node.id);
  if(!obj) return;
  applyTransform(obj, node);
  obj.visible = node.visible!==false;
  if(obj.isMesh){
    if(obj.geometry.parameters && (obj.geometry.parameters.width!==node.size.x || obj.geometry.parameters.height!==node.size.y || obj.geometry.parameters.depth!==node.size.z)){
      obj.geometry.dispose();
      obj.geometry = new THREE.BoxGeometry(node.size.x, node.size.y, node.size.z);
    }
    obj.material.color.set(node.color);
    obj.material.opacity = 1-(node.transparency||0);
    obj.material.transparent = obj.material.opacity < 1;
    obj.material.roughness = node.material==='Metal'?0.35:node.material==='Glass'?0.05:0.85;
    obj.material.metalness = node.material==='Metal'?0.8:0;
  } else if(obj.isLight){
    obj.color.set(node.color);
  }
  updateGizmoPosition();
}

function updateObjCount(){
  $('#objCountStat').textContent = nodesById.size + ' objects';
}

/* ---------------- SELECTION ---------------- */
let selectionOutlines = new Map();
function selectOnly(id){
  selectedIds.clear();
  if(id) selectedIds.add(id);
  onSelectionChanged();
}
function toggleSelect(id){
  if(selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  onSelectionChanged();
}
function onSelectionChanged(){
  selectionOutlines.forEach(m=>{ if(m.parent) m.parent.remove(m); });
  selectionOutlines.clear();
  selectedIds.forEach(id=>{
    const obj = threeObjects.get(id);
    if(obj && obj.isMesh){
      const edges = new THREE.EdgesGeometry(obj.geometry);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({color:0x5b8cff, linewidth:2}));
      line.position.copy(obj.position); line.rotation.copy(obj.rotation); line.scale.copy(obj.scale);
      scene.add(line);
      selectionOutlines.set(id, line);
    }
  });
  rebuildHierarchy();
  refreshProperties();
  updateGizmoPosition();
}

/* ---------------- HIERARCHY PANEL ---------------- */
const hierarchyEl = $('#hierarchy');
let collapsedIds = new Set();
let draggingNodeId = null;

const iconFor = type => ({
  World:'🌐',Camera:'🎥',Spawn:'🚩',Folder:'📁',Model:'🧩',Part:'🧱',Light:'💡',NPC:'🧍',Script:'📜'
}[type] || '◻️');

function rebuildHierarchy(){
  hierarchyEl.innerHTML = '';
  if(sceneRoot) renderNode(sceneRoot, hierarchyEl, 0);
}
function renderNode(node, container, depth){
  const row = document.createElement('div');
  row.className = 'hnode' + (selectedIds.has(node.id) ? ' selected':'');
  row.dataset.id = node.id;
  row.draggable = node.type!=='World';

  const caret = document.createElement('div');
  caret.className = 'caret' + (node.children.length? '' : ' empty');
  caret.textContent = node.children.length ? (collapsedIds.has(node.id)?'▶':'▼') : '';
  caret.onclick = (e)=>{ e.stopPropagation(); if(collapsedIds.has(node.id)) collapsedIds.delete(node.id); else collapsedIds.add(node.id); rebuildHierarchy(); };
  row.appendChild(caret);

  const icon = document.createElement('div');
  icon.className = 'hicon'; icon.textContent = iconFor(node.type);
  row.appendChild(icon);

  const label = document.createElement('div');
  label.className = 'hlabel'; label.textContent = node.name;
  row.appendChild(label);

  row.onclick = (e)=>{ e.stopPropagation(); if(e.shiftKey) toggleSelect(node.id); else selectOnly(node.id); };
  row.ondblclick = (e)=>{ e.stopPropagation(); startRename(node, row, label); };
  row.oncontextmenu = (e)=>{ e.preventDefault(); e.stopPropagation(); selectOnly(node.id); showNodeContextMenu(e, node); };

  if(node.type!=='World'){
    row.addEventListener('dragstart', (e)=>{ draggingNodeId = node.id; e.dataTransfer.effectAllowed='move'; });
    row.addEventListener('dragend', ()=>{ draggingNodeId=null; });
  }
  row.addEventListener('dragover', (e)=>{
    if(!draggingNodeId || draggingNodeId===node.id) return;
    e.preventDefault(); row.classList.add('dragover');
  });
  row.addEventListener('dragleave', ()=> row.classList.remove('dragover'));
  row.addEventListener('drop', (e)=>{
    e.preventDefault(); row.classList.remove('dragover');
    if(!draggingNodeId || draggingNodeId===node.id) return;
    reparentNode(draggingNodeId, node.id);
  });

  container.appendChild(row);

  if(node.children.length && !collapsedIds.has(node.id)){
    const childWrap = document.createElement('div');
    childWrap.className = 'hchildren';
    node.children.forEach(c=>renderNode(c, childWrap, depth+1));
    container.appendChild(childWrap);
  }
}

function startRename(node, row, labelEl){
  const input = document.createElement('input');
  input.className='rename-input'; input.value = node.name;
  row.replaceChild(input, labelEl);
  input.focus(); input.select();
  const commit = ()=>{ node.name = input.value.trim()||node.type; markDirty(); rebuildHierarchy(); };
  input.onblur = commit;
  input.onkeydown = (e)=>{ if(e.key==='Enter') input.blur(); if(e.key==='Escape'){ input.value=node.name; input.blur(); } };
}

function reparentNode(childId, newParentId){
  const child = nodesById.get(childId);
  const newParent = nodesById.get(newParentId);
  if(!child || !newParent) return;
  // prevent cycles
  let p = newParent;
  while(p){ if(p.id===child.id) { toast('Tidak bisa memindahkan ke dalam dirinya sendiri','err'); return; } p = nodesById.get(p.parentId); }
  const oldParent = nodesById.get(child.parentId);
  if(oldParent) oldParent.children = oldParent.children.filter(c=>c.id!==childId);
  newParent.children.push(child);
  child.parentId = newParent.id;
  rebuildHierarchy(); markDirty(); pushHistory('Reparent');
}

/* Add object buttons */
$$('#hierarchy-toolbar .add-btn').forEach(btn=>{
  btn.onclick = ()=> addObject(btn.dataset.add);
});
function addObject(type, parentOverride){
  const parent = parentOverride || (getSingleSelected() && ['Folder','World'].includes(getSingleSelected().type) ? getSingleSelected() : sceneRoot);
  let overrides = {};
  if(type==='Part') overrides = { position:{x:0,y:1,z:0} };
  if(type==='Light') overrides = { position:{x:0,y:5,z:0}, color:'#ffe58a' };
  if(type==='Camera') overrides = { position:{x:0,y:4,z:8} };
  if(type==='Spawn') overrides = { size:{x:2,y:0.2,z:2}, color:'#3ddc84', position:{x:0,y:0.1,z:0} };
  if(type==='NPC') overrides = { size:{x:1,y:2,z:1}, color:'#ffb454', position:{x:2,y:1,z:0} };
  if(type==='Model') overrides = { position:{x:0,y:1,z:0}, color:'#a06bff' };

  if(type==='Script'){
    const scr = { id: uid(), name:'Script'+Object.keys(scripts).length, code: defaultScriptTemplate() };
    scripts[scr.id] = scr;
    const node = newNode('Script', scr.name, { scriptId: scr.id });
    addChild(parent, node);
    rebuildHierarchy(); rebuildScriptTabs(); openScriptTab(scr.id);
    switchCenterTab('script');
    markDirty(); pushHistory('Add Script');
    return;
  }

  const node = newNode(type, type, overrides);
  addChild(parent, node);
  const obj = buildThreeForNode(node);
  threeObjects.set(node.id, obj);
  scene.add(obj);
  rebuildHierarchy();
  selectOnly(node.id);
  updateObjCount();
  markDirty();
  pushHistory('Add '+type);
  toast(type+' ditambahkan');
}

function getSingleSelected(){
  if(selectedIds.size!==1) return null;
  return nodesById.get(Array.from(selectedIds)[0]);
}

function duplicateNode(node){
  if(!node || node.type==='World') return;
  const clone = JSON.parse(JSON.stringify(node));
  reassignIds(clone);
  clone.position.x += 1; clone.position.z += 1;
  const parent = nodesById.get(node.parentId) || sceneRoot;
  addChild(parent, clone);
  registerCloneRecursive(clone);
  rebuildScene3D();
  rebuildHierarchy();
  selectOnly(clone.id);
  markDirty(); pushHistory('Duplicate');
  toast('Objek diduplikasi');
}
function reassignIds(node){
  node.id = uid();
  node.parentId = null;
  (node.children||[]).forEach(c=>reassignIds(c));
}
function registerCloneRecursive(node){
  nodesById.set(node.id, node);
  (node.children||[]).forEach(c=>{ c.parentId = node.id; registerCloneRecursive(c); });
}

function deleteSelected(){
  if(!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  ids.forEach(id=>{ const n = nodesById.get(id); if(n) removeNode(n, {silent:true}); });
  selectedIds.clear();
  rebuildHierarchy(); refreshProperties(); updateObjCount();
  markDirty(); pushHistory('Delete');
  toast('Objek dihapus');
}

/* Context menu for hierarchy nodes */
const ctxMenu = $('#ctxMenu');
function showNodeContextMenu(e, node){
  ctxMenu.innerHTML = '';
  const items = [
    ['Rename','F2', ()=>{ const row = hierarchyEl.querySelector(`[data-id="${node.id}"]`); const label = row.querySelector('.hlabel'); startRename(node,row,label); }],
    ['Duplicate','Ctrl+D', ()=>duplicateNode(node)],
    ['Delete','Del', ()=>{ selectOnly(node.id); deleteSelected(); }],
    null,
    ['Focus','F', ()=>focusOnNode(node)],
  ];
  items.forEach(it=>{
    if(it===null){ const sep=document.createElement('div'); sep.className='ctx-sep'; ctxMenu.appendChild(sep); return; }
    const div = document.createElement('div');
    div.className='ctx-item';
    div.innerHTML = `<span>${it[0]}</span><span class="kbd">${it[1]}</span>`;
    div.onclick = ()=>{ it[2](); hideCtx(); };
    ctxMenu.appendChild(div);
  });
  ctxMenu.style.left = e.clientX+'px';
  ctxMenu.style.top = e.clientY+'px';
  ctxMenu.style.display='block';
}
function hideCtx(){ ctxMenu.style.display='none'; }
window.addEventListener('click', hideCtx);

function focusOnNode(node){
  const obj = threeObjects.get(node.id);
  if(!obj) return;
  orbit.target.copy(obj.position);
  updateCameraFromOrbit();
}

/* ---------------- PROPERTIES PANEL ---------------- */
const propertiesEl = $('#properties');
function refreshProperties(){
  const node = getSingleSelected();
  if(!node){
    propertiesEl.innerHTML = '<div class="no-selection">Tidak ada objek yang dipilih.<br>Pilih objek di Hierarchy atau klik objek di viewport.</div>';
    return;
  }
  propertiesEl.innerHTML = '';
  propertiesEl.appendChild(makeGroup('Umum', [
    ['Name', textField(node.name, v=>{ node.name=v; rebuildHierarchy(); markDirty(); })]
  ]));

  if(['Part','Model','Spawn','NPC','Light','Camera'].includes(node.type)){
    propertiesEl.appendChild(makeGroup('Transform', [
      ['Position', vec3Field(node.position, ()=>{ refreshThreeObject(node); markDirty(); })],
      ['Rotation', vec3Field(node.rotation, ()=>{ refreshThreeObject(node); markDirty(); })],
      ['Scale', vec3Field(node.scale, ()=>{ refreshThreeObject(node); markDirty(); }, 0.05)],
    ]));
  }

  if(['Part','Model','Spawn','NPC'].includes(node.type)){
    propertiesEl.appendChild(makeGroup('Ukuran & Tampilan', [
      ['Size', vec3Field(node.size, ()=>{ refreshThreeObject(node); markDirty(); }, 0.1)],
      ['Color', colorField(node.color, v=>{ node.color=v; refreshThreeObject(node); markDirty(); })],
      ['Material', selectField(node.material, ['Plastic','Metal','Wood','Glass','Neon'], v=>{ node.material=v; refreshThreeObject(node); markDirty(); })],
      ['Transparency', rangeField(node.transparency, 0,1,0.05, v=>{ node.transparency=v; refreshThreeObject(node); markDirty(); })],
    ]));
    propertiesEl.appendChild(makeGroup('Fisika', [
      ['Anchored', toggleField(node.anchored, v=>{ node.anchored=v; markDirty(); })],
      ['Collision', toggleField(node.collision, v=>{ node.collision=v; markDirty(); })],
      ['Visible', toggleField(node.visible, v=>{ node.visible=v; refreshThreeObject(node); markDirty(); })],
    ]));
  }

  if(node.type==='Light'){
    propertiesEl.appendChild(makeGroup('Cahaya', [
      ['Color', colorField(node.color, v=>{ node.color=v; refreshThreeObject(node); markDirty(); })],
    ]));
  }

  if(node.type==='Script'){
    const scr = scripts[node.scriptId];
    propertiesEl.appendChild(makeGroup('Script', [
      ['Nama Script', textField(scr?scr.name:'', v=>{ if(scr){ scr.name=v; node.name=v; rebuildHierarchy(); rebuildScriptTabs(); markDirty(); } })],
    ]));
    const openBtn = document.createElement('button');
    openBtn.className='btn primary'; openBtn.style.width='100%'; openBtn.textContent='Buka di Script Editor';
    openBtn.onclick = ()=>{ openScriptTab(node.scriptId); switchCenterTab('script'); };
    propertiesEl.appendChild(openBtn);
  }
}

function makeGroup(title, rows){
  const g = document.createElement('div'); g.className='prop-group';
  const t = document.createElement('div'); t.className='prop-group-title'; t.textContent=title;
  g.appendChild(t);
  rows.forEach(([label, fieldEl])=>{
    const row = document.createElement('div'); row.className='prop-row';
    const l = document.createElement('div'); l.className='prop-label'; l.textContent=label;
    row.appendChild(l); row.appendChild(fieldEl);
    g.appendChild(row);
  });
  return g;
}
function textField(value, onChange){
  const input = document.createElement('input'); input.className='prop-input'; input.type='text'; input.value=value;
  input.onchange = ()=>onChange(input.value);
  return input;
}
function selectField(value, options, onChange){
  const sel = document.createElement('select'); sel.className='prop-input';
  options.forEach(o=>{ const op=document.createElement('option'); op.value=o; op.textContent=o; if(o===value) op.selected=true; sel.appendChild(op); });
  sel.onchange = ()=>onChange(sel.value);
  return sel;
}
function colorField(value, onChange){
  const wrap = document.createElement('div'); wrap.className='color-input-row';
  const sw = document.createElement('input'); sw.type='color'; sw.className='color-swatch'; sw.value = value;
  const txt = document.createElement('input'); txt.className='prop-input'; txt.value = value; txt.style.fontFamily='monospace'; txt.style.fontSize='11px';
  sw.oninput = ()=>{ txt.value = sw.value; onChange(sw.value); };
  txt.onchange = ()=>{ sw.value = txt.value; onChange(txt.value); };
  wrap.appendChild(sw); wrap.appendChild(txt);
  return wrap;
}
function rangeField(value, min, max, step, onChange){
  const wrap = document.createElement('div'); wrap.className='range-row';
  const input = document.createElement('input'); input.type='range'; input.min=min; input.max=max; input.step=step; input.value=value;
  const val = document.createElement('div'); val.className='range-val'; val.textContent = value;
  input.oninput = ()=>{ val.textContent = input.value; onChange(parseFloat(input.value)); };
  wrap.appendChild(input); wrap.appendChild(val);
  return wrap;
}
function toggleField(value, onChange){
  const t = document.createElement('div'); t.className='toggle'+(value?' on':'');
  const knob = document.createElement('div'); knob.className='knob'; t.appendChild(knob);
  t.onclick = ()=>{ const nv = !t.classList.contains('on'); t.classList.toggle('on', nv); onChange(nv); };
  const row = document.createElement('div'); row.style.display='flex'; row.style.flex='1'; row.style.justifyContent='flex-end';
  row.appendChild(t);
  return row;
}
function vec3Field(vecObj, onChange, step){
  const wrap = document.createElement('div'); wrap.className='vec3';
  ['x','y','z'].forEach(axis=>{
    const w = document.createElement('div'); w.className='axis-input-wrap';
    const tag = document.createElement('span'); tag.className='axis-tag '+axis; tag.textContent=axis.toUpperCase();
    const input = document.createElement('input'); input.type='number'; input.step = step||0.5; input.value = round2(vecObj[axis]);
    input.onchange = ()=>{ vecObj[axis] = parseFloat(input.value)||0; onChange(); };
    w.appendChild(tag); w.appendChild(input);
    wrap.appendChild(w);
  });
  return wrap;
}
function round2(n){ return Math.round(n*100)/100; }

/* ---------------- TRANSFORM GIZMO (manual, world-space arrows) ---------------- */
let currentTool = 'select';
let gizmoGroup = null;
let gizmoAxisHit = null;
let gizmoDragStart = null;

function buildGizmo(){
  gizmoGroup = new THREE.Group();
  gizmoGroup.visible = false;
  gizmoGroup.renderOrder = 999;
  const mkArrow = (color, dir)=>{
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,1.4,8), new THREE.MeshBasicMaterial({color, depthTest:false}));
    shaft.position.copy(dir.clone().multiplyScalar(0.7));
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.14,0.35,8), new THREE.MeshBasicMaterial({color, depthTest:false}));
    head.position.copy(dir.clone().multiplyScalar(1.55));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
    g.add(shaft, head);
    g.userData.axis = dir.clone();
    g.children.forEach(c=>c.renderOrder=999);
    return g;
  };
  const x = mkArrow(0xff6b6b, new THREE.Vector3(1,0,0));
  const y = mkArrow(0x6bff8f, new THREE.Vector3(0,1,0));
  const z = mkArrow(0x6ba8ff, new THREE.Vector3(0,0,1));
  gizmoGroup.add(x,y,z);
  gizmoGroup.userData.axes = [x,y,z];
  scene.add(gizmoGroup);
}

function updateGizmoPosition(){
  if(!gizmoGroup) return;
  const node = getSingleSelected();
  if(!node || currentTool==='select' || playMode){ gizmoGroup.visible = false; return; }
  const obj = threeObjects.get(node.id);
  if(!obj){ gizmoGroup.visible = false; return; }
  gizmoGroup.visible = true;
  gizmoGroup.position.copy(obj.position);
  const dist = camera.position.distanceTo(obj.position);
  gizmoGroup.scale.setScalar(Math.max(0.5, dist*0.06));
}

function tryGizmoDrag(e){
  if(!gizmoGroup.visible) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX-rect.left)/rect.width)*2-1;
  mouse.y = -((e.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(mouse, camera);
  const meshes = [];
  gizmoGroup.userData.axes.forEach(a=>a.traverse(c=>{ if(c.isMesh) meshes.push(c); }));
  const hits = raycaster.intersectObjects(meshes, false);
  if(!hits.length) return false;
  let axisGroup = hits[0].object.parent;
  gizmoAxisHit = axisGroup.userData.axis.clone();
  const node = getSingleSelected();
  gizmoDragStart = {
    node,
    pos: {...node.position}, rot:{...node.rotation}, scale:{...node.scale},
    mouseX: e.clientX, mouseY: e.clientY
  };
  return true;
}
function updateGizmoDrag(e, dx, dy){
  if(!gizmoDragStart) return;
  const node = gizmoDragStart.node;
  const totalDx = e.clientX - gizmoDragStart.mouseX;
  const totalDy = e.clientY - gizmoDragStart.mouseY;
  const sensitivity = 0.03;
  const axis = gizmoAxisHit;
  if(currentTool==='translate'){
    const delta = -totalDy*sensitivity + totalDx*sensitivity*(axis.x||axis.z?1:0)*0;
    const amount = (Math.abs(dx)>Math.abs(dy)? totalDx : -totalDy) * sensitivity;
    node.position.x = gizmoDragStart.pos.x + axis.x*amount;
    node.position.y = gizmoDragStart.pos.y + axis.y*amount;
    node.position.z = gizmoDragStart.pos.z + axis.z*amount;
    if(snapEnabled){
      node.position.x = Math.round(node.position.x);
      node.position.y = Math.round(node.position.y);
      node.position.z = Math.round(node.position.z);
    }
  } else if(currentTool==='rotate'){
    const amount = (totalDx - totalDy) * 0.6;
    node.rotation.x = gizmoDragStart.rot.x + axis.x*amount;
    node.rotation.y = gizmoDragStart.rot.y + axis.y*amount;
    node.rotation.z = gizmoDragStart.rot.z + axis.z*amount;
  } else if(currentTool==='scale'){
    const amount = (totalDx - totalDy) * 0.01;
    node.scale.x = Math.max(0.05, gizmoDragStart.scale.x + axis.x*amount);
    node.scale.y = Math.max(0.05, gizmoDragStart.scale.y + axis.y*amount);
    node.scale.z = Math.max(0.05, gizmoDragStart.scale.z + axis.z*amount);
  }
  refreshThreeObject(node);
  refreshProperties();
}
function endGizmoDrag(){
  if(gizmoDragStart){ markDirty(); pushHistory('Transform'); }
  gizmoDragStart = null; gizmoAxisHit = null;
}

let snapEnabled = false;
$('#snapToggle').onchange = (e)=>{ snapEnabled = e.target.checked; };

/* Tool buttons */
const TOOL_LABELS = {select:'Select', translate:'Move', rotate:'Rotate', scale:'Scale'};
function setTool(tool){
  currentTool = tool;
  $$('#toolSelect,#toolMove,#toolRotate,#toolScale').forEach(b=>b.classList.remove('active'));
  ({select:'#toolSelect',translate:'#toolMove',rotate:'#toolRotate',scale:'#toolScale'})[tool] &&
    $(({select:'#toolSelect',translate:'#toolMove',rotate:'#toolRotate',scale:'#toolScale'})[tool]).classList.add('active');
  updateGizmoPosition();
  const lbl = $('#sbToolName'); if(lbl) lbl.textContent = TOOL_LABELS[tool] || tool;
}
$('#toolSelect').onclick = ()=>setTool('select');
$('#toolMove').onclick = ()=>setTool('translate');
$('#toolRotate').onclick = ()=>setTool('rotate');
$('#toolScale').onclick = ()=>setTool('scale');

/* ---------------- ANIMATE LOOP ---------------- */
let lastFrame = performance.now(), frameCount=0, fpsAccum=0;
function animate(){
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05,(now-lastFrame)/1000);
  lastFrame = now;
  frameCount++; fpsAccum += dt;
  if(fpsAccum>=0.5){ $('#fpsStat').textContent = Math.round(frameCount/fpsAccum)+' fps'; frameCount=0; fpsAccum=0; }

  selectionOutlines.forEach((line,id)=>{
    const obj = threeObjects.get(id);
    if(obj){ line.position.copy(obj.position); line.rotation.copy(obj.rotation); line.scale.copy(obj.scale); }
  });
  updateGizmoPosition();
  if(playMode) stepPlayMode(dt);
  renderer.render(scene, camera);
}

/* ---------------- SCRIPT EDITOR ---------------- */
function defaultScriptTemplate(){
  return `-- Script baru
-- API tersedia: object.Position, object.Rotation, object.Scale, object.Color
-- object.OnClick(), object.OnTouch(), object.Destroy()

object.OnClick(function()
  print("Objek diklik!")
  object.Color = "#ff6b6b"
end)

object.OnTouch(function()
  print("Ada yang menyentuh objek ini")
end)
`;
}

let openScriptTabs = []; // ids
let activeScriptId = null;
const scriptTabbar = $('#script-tabbar');
const codeArea = $('#codeArea');
const lineNumbers = $('#lineNumbers');

function rebuildScriptTabs(){
  scriptTabbar.innerHTML = '';
  openScriptTabs.forEach(id=>{
    const scr = scripts[id];
    if(!scr) return;
    const tab = document.createElement('div');
    tab.className = 'script-tab'+(id===activeScriptId?' active':'');
    tab.innerHTML = `<span>📜 ${scr.name}</span><span class="close-x">✕</span>`;
    tab.onclick = ()=>openScriptTab(id);
    tab.querySelector('.close-x').onclick = (e)=>{ e.stopPropagation(); closeScriptTab(id); };
    scriptTabbar.appendChild(tab);
  });
}
function openScriptTab(id){
  if(!openScriptTabs.includes(id)) openScriptTabs.push(id);
  activeScriptId = id;
  const scr = scripts[id];
  codeArea.value = scr ? scr.code : '';
  updateLineNumbers();
  rebuildScriptTabs();
}
function closeScriptTab(id){
  openScriptTabs = openScriptTabs.filter(x=>x!==id);
  if(activeScriptId===id) activeScriptId = openScriptTabs[0] || null;
  if(activeScriptId) openScriptTab(activeScriptId);
  else { codeArea.value=''; updateLineNumbers(); }
  rebuildScriptTabs();
}
codeArea.addEventListener('input', ()=>{
  if(activeScriptId && scripts[activeScriptId]){ scripts[activeScriptId].code = codeArea.value; markDirty(); }
  updateLineNumbers();
});
codeArea.addEventListener('scroll', ()=>{ lineNumbers.scrollTop = codeArea.scrollTop; });
codeArea.addEventListener('keydown', (e)=>{
  if(e.key==='Tab'){ e.preventDefault(); const s=codeArea.selectionStart,en=codeArea.selectionEnd; codeArea.value = codeArea.value.slice(0,s)+'  '+codeArea.value.slice(en); codeArea.selectionStart=codeArea.selectionEnd=s+2; codeArea.dispatchEvent(new Event('input')); }
});
function updateLineNumbers(){
  const lines = codeArea.value.split('\n').length;
  let html='';
  for(let i=1;i<=lines;i++) html+=i+'\n';
  lineNumbers.textContent = html;
}

/* Simplified script "runner" — interprets our tiny pseudo-API safely (no eval of arbitrary JS engine access) */
function logToConsole(msg, kind){
  const out = $('#consoleOutput');
  const line = document.createElement('div');
  line.className = 'log-line'+(kind?' log-'+kind:'');
  line.textContent = msg;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}
function runScript(scriptId, node){
  const scr = scripts[scriptId];
  if(!scr) return;
  logToConsole('▶ Menjalankan '+scr.name+'...', 'info');
  try{
    const api = makeObjectAPI(node);
    const printFn = (...args)=>logToConsole(args.map(a=>typeof a==='object'?JSON.stringify(a):String(a)).join(' '));
    const fn = new Function('object','print', scr.code.replace(/^--.*$/gm,'') /* strip lua-style comments lightly */);
    fn(api, printFn);
    logToConsole('✓ Script selesai dijalankan', 'ok');
  }catch(err){
    logToConsole('✗ Error: '+err.message, 'error');
  }
}
function makeObjectAPI(node){
  const parent = nodesById.get(node && node.parentId);
  const target = parent && parent.type!=='World' ? parent : (parent||sceneRoot);
  const handlers = { click:[], touch:[] };
  scriptHandlers.set(node?node.id:'global', handlers);
  return {
    get Position(){ return target?{...target.position}:null; },
    set Position(v){ if(target){ Object.assign(target.position, v); refreshThreeObject(target); } },
    get Rotation(){ return target?{...target.rotation}:null; },
    set Rotation(v){ if(target){ Object.assign(target.rotation, v); refreshThreeObject(target); } },
    get Scale(){ return target?{...target.scale}:null; },
    set Scale(v){ if(target){ Object.assign(target.scale, v); refreshThreeObject(target); } },
    get Color(){ return target?target.color:null; },
    set Color(v){ if(target){ target.color=v; refreshThreeObject(target); } },
    OnClick(cb){ handlers.click.push(cb); },
    OnTouch(cb){ handlers.touch.push(cb); },
    Destroy(){ if(target) removeNode(target); }
  };
}
const scriptHandlers = new Map();

$('#btnRunScript').onclick = ()=>{
  if(!activeScriptId) { toast('Tidak ada script aktif','err'); return; }
  // find node owning this script
  let owner = null;
  nodesById.forEach(n=>{ if(n.scriptId===activeScriptId) owner=n; });
  runScript(activeScriptId, owner);
};
$('#btnFormatScript').onclick = ()=>{
  if(!activeScriptId) return;
  codeArea.value = codeArea.value.split('\n').map(l=>l.trimEnd()).join('\n');
  scripts[activeScriptId].code = codeArea.value;
  updateLineNumbers();
  toast('Script diformat');
};

/* ---------------- CENTER TABS (Asset Browser / Script Editor) ---------------- */
const bottomArea = $('#bottom-area');
$$('.ctab').forEach(tab=>{
  tab.onclick = ()=>{
    const panel = tab.dataset.panel;
    if(bottomArea.classList.contains('open') && tab.classList.contains('active')){
      bottomArea.classList.remove('open');
      tab.classList.remove('active');
      return;
    }
    switchCenterTab(panel);
  };
});
function switchCenterTab(panel){
  bottomArea.classList.add('open');
  $$('.ctab').forEach(t=>t.classList.toggle('active', t.dataset.panel===panel));
  $('#assets-view').style.display = panel==='assets' ? 'flex':'none';
  $('#script-view').style.display = panel==='script' ? 'flex':'none';
}

/* Bottom resizer */
let resizingBottom=false;
$('#bottom-resizer').addEventListener('mousedown', ()=>{ resizingBottom=true; });
window.addEventListener('mousemove', (e)=>{
  if(!resizingBottom) return;
  const rect = $('#center-panel').getBoundingClientRect();
  const h = Math.min(500, Math.max(120, rect.bottom - e.clientY - 30));
  bottomArea.style.height = h+'px';
});
window.addEventListener('mouseup', ()=> resizingBottom=false);

/* ---------------- ASSET BROWSER ---------------- */
const ASSETS = [
  {name:'Cube Block', cat:'Blocks', icon:'🧱', type:'Part'},
  {name:'Ramp Block', cat:'Blocks', icon:'🔺', type:'Part'},
  {name:'Cylinder Block', cat:'Blocks', icon:'🛢️', type:'Part'},
  {name:'Sphere Block', cat:'Blocks', icon:'⚪', type:'Part'},
  {name:'Tree Model', cat:'Models', icon:'🌳', type:'Model'},
  {name:'House Model', cat:'Models', icon:'🏠', type:'Model'},
  {name:'Rock Model', cat:'Models', icon:'🪨', type:'Model'},
  {name:'Plastic Mat', cat:'Materials', icon:'🎨', type:'material', material:'Plastic'},
  {name:'Metal Mat', cat:'Materials', icon:'⚙️', type:'material', material:'Metal'},
  {name:'Wood Mat', cat:'Materials', icon:'🪵', type:'material', material:'Wood'},
  {name:'Glass Mat', cat:'Materials', icon:'🪟', type:'material', material:'Glass'},
  {name:'Brick Texture', cat:'Textures', icon:'🧱', type:'texture'},
  {name:'Grass Texture', cat:'Textures', icon:'🌱', type:'texture'},
  {name:'Metal Texture', cat:'Textures', icon:'🔩', type:'texture'},
  {name:'Footstep Sfx', cat:'Sounds', icon:'🔊', type:'sound'},
  {name:'Jump Sfx', cat:'Sounds', icon:'🔊', type:'sound'},
  {name:'Ambient Music', cat:'Sounds', icon:'🎵', type:'sound'},
  {name:'Hero Character', cat:'Characters', icon:'🧍', type:'NPC'},
  {name:'Enemy Character', cat:'Characters', icon:'👹', type:'NPC'},
  {name:'Villager', cat:'Characters', icon:'🧑', type:'NPC'},
  {name:'Explosion FX', cat:'Effects', icon:'💥', type:'effect'},
  {name:'Sparkle FX', cat:'Effects', icon:'✨', type:'effect'},
  {name:'Smoke FX', cat:'Effects', icon:'💨', type:'effect'},
];
let assetFilter = 'all';
function rebuildAssetGrid(){
  const grid = $('#assetGrid'); grid.innerHTML='';
  ASSETS.filter(a=>assetFilter==='all'||a.cat===assetFilter).forEach(a=>{
    const tile = document.createElement('div'); tile.className='asset-tile'; tile.draggable=true;
    tile.innerHTML = `<div class="a-icon" style="font-size:26px;">${a.icon}</div><div class="a-label">${a.name}</div>`;
    tile.onclick = ()=>placeAsset(a);
    tile.ondragstart = (e)=> e.dataTransfer.setData('text/plain', a.name);
    grid.appendChild(tile);
  });
}
function placeAsset(a){
  if(a.type==='Part' || a.type==='Model' || a.type==='NPC'){
    addObject(a.type);
    const node = getSingleSelected();
    if(node) node.name = a.name;
    rebuildHierarchy();
  } else if(a.type==='material'){
    const node = getSingleSelected();
    if(node){ node.material = a.material; refreshThreeObject(node); refreshProperties(); markDirty(); toast('Material diterapkan'); }
    else toast('Pilih objek dulu untuk menerapkan material','err');
  } else {
    toast(a.name+' (placeholder) ditambahkan ke Asset — belum ada representasi visual di MVP ini');
  }
}
$$('.asset-cat').forEach(c=>{
  c.onclick = ()=>{ $$('.asset-cat').forEach(x=>x.classList.remove('active')); c.classList.add('active'); assetFilter=c.dataset.cat; rebuildAssetGrid(); };
});

/* ---------------- PLAY MODE ---------------- */
let playMode = false;
let playState = null;
function enterPlayMode(){
  playMode = true;
  document.body.classList.add('play-active');
  syncPlayButtonsVisibility();
  selectOnly(null);
  // snapshot for restore
  playState = { camPos: camera.position.clone(), orbit:{...orbit, target:orbit.target.clone()} };
  const velocities = new Map();
  const spawn = findFirstOfType(sceneRoot,'Spawn');
  const playerStart = spawn ? {x:spawn.position.x, y:spawn.position.y+2, z:spawn.position.z} : {x:0,y:5,z:0};
  playRuntime = {
    velocities, gravity: parseFloat($('#settingGravity').value||18),
    player: { pos:{...playerStart}, vy:0 }
  };
  orbit.target = new THREE.Vector3(playRuntime.player.pos.x, playRuntime.player.pos.y, playRuntime.player.pos.z);
  orbit.radius = 10;
  updateCameraFromOrbit();
  logToConsole('=== PLAY MODE dimulai ===','info');
  // run all scripts once (bind handlers)
  scriptHandlers.clear();
  nodesById.forEach(node=>{
    if(node.type==='Script' && node.scriptId && scripts[node.scriptId]){
      runScript(node.scriptId, node);
    }
  });
  toast('Play mode aktif','ok');
}
function exitPlayMode(){
  playMode = false;
  document.body.classList.remove('play-active');
  syncPlayButtonsVisibility();
  if(playState){
    orbit.theta = playState.orbit.theta; orbit.phi = playState.orbit.phi;
    orbit.target = playState.orbit.target; orbit.radius = playState.orbit.radius;
    updateCameraFromOrbit();
  }
  rebuildScene3D();
  onSelectionChanged();
  logToConsole('=== PLAY MODE dihentikan ===','info');
  toast('Kembali ke Editor');
}
function findFirstOfType(node, type){
  if(node.type===type) return node;
  for(const c of node.children||[]){ const r = findFirstOfType(c,type); if(r) return r; }
  return null;
}
let playRuntime = null;
const keysDown = new Set();
window.addEventListener('keydown', e=>{ keysDown.add(e.key.toLowerCase()); });
window.addEventListener('keyup', e=>{ keysDown.delete(e.key.toLowerCase()); });

function stepPlayMode(dt){
  if(!playRuntime) return;
  const speed = 6;
  let mx=0, mz=0;
  if(keysDown.has('w')||keysDown.has('arrowup')) mz -= 1;
  if(keysDown.has('s')||keysDown.has('arrowdown')) mz += 1;
  if(keysDown.has('a')||keysDown.has('arrowleft')) mx -= 1;
  if(keysDown.has('d')||keysDown.has('arrowright')) mx += 1;
  const len = Math.hypot(mx,mz) || 1;
  const p = playRuntime.player;
  p.pos.x += (mx/len)*speed*dt;
  p.pos.z += (mz/len)*speed*dt;

  // simple gravity + ground collision against anchored parts with collision on
  p.vy -= playRuntime.gravity*dt;
  p.pos.y += p.vy*dt;
  let grounded = false;
  nodesById.forEach(node=>{
    if((node.type==='Part'||node.type==='Spawn') && node.collision!==false){
      const top = node.position.y + node.size.y/2;
      const halfX = node.size.x/2, halfZ = node.size.z/2;
      if(Math.abs(p.pos.x-node.position.x)<halfX+0.4 && Math.abs(p.pos.z-node.position.z)<halfZ+0.4){
        if(p.pos.y <= top+1 && p.pos.y >= top-1 && p.vy<=0){
          p.pos.y = top+1; p.vy=0; grounded=true;
        }
      }
    }
  });
  if(keysDown.has(' ') && grounded){ p.vy = 8; }

  orbit.target.set(p.pos.x, p.pos.y, p.pos.z);
  updateCameraFromOrbit();

  // touch detection (very simplified) -> fire OnTouch when player within part bounds
  nodesById.forEach(node=>{
    if(node.type==='Part' && node.collision!==false){
      const halfX=node.size.x/2, halfY=node.size.y/2, halfZ=node.size.z/2;
      const within = Math.abs(p.pos.x-node.position.x)<halfX+0.5 && Math.abs(p.pos.y-node.position.y)<halfY+1 && Math.abs(p.pos.z-node.position.z)<halfZ+0.5;
      if(within){
        const h = scriptHandlers.get(node.id);
        if(h && h.touch.length && !node._touchedThisFrame){
          node._touchedThisFrame = true;
          h.touch.forEach(cb=>{ try{cb();}catch(e){logToConsole('Error OnTouch: '+e.message,'error');} });
        }
      } else { node._touchedThisFrame = false; }
    }
  });
}

// click-to-trigger OnClick during play mode
viewportWrap.addEventListener('click', (e)=>{
  if(!playMode) return;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX-rect.left)/rect.width)*2-1;
  mouse.y = -((e.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(mouse, camera);
  const meshes = [];
  threeObjects.forEach(obj=>obj.traverse(c=>{ if(c.isMesh) meshes.push(c); }));
  const hits = raycaster.intersectObjects(meshes,false);
  if(hits.length){
    let obj = hits[0].object;
    while(obj && !obj.userData.nodeId) obj = obj.parent;
    if(obj){
      const h = scriptHandlers.get(obj.userData.nodeId);
      if(h) h.click.forEach(cb=>{ try{cb();}catch(err){logToConsole('Error OnClick: '+err.message,'error');} });
    }
  }
});

bindPlayStopButtons();

/* ---------------- HISTORY (Undo/Redo) ---------------- */
let history = [];
let historyIndex = -1;
function snapshotState(){
  return JSON.stringify({ tree: sceneRoot, scripts, name: projectName });
}
function pushHistory(label){
  const snap = snapshotState();
  history = history.slice(0, historyIndex+1);
  history.push(snap);
  if(history.length>50) history.shift();
  historyIndex = history.length-1;
}
function restoreSnapshot(snap){
  const data = JSON.parse(snap);
  sceneRoot = data.tree;
  scripts = data.scripts;
  projectName = data.name;
  nodesById.clear();
  registerCloneRecursive(sceneRoot);
  selectedIds.clear();
  rebuildScene3D(); rebuildHierarchy(); refreshProperties(); rebuildScriptTabs(); updateProjectTag();
}
function undo(){
  if(historyIndex<=0){ toast('Tidak ada lagi yang bisa di-undo'); return; }
  historyIndex--;
  restoreSnapshot(history[historyIndex]);
  toast('Undo');
}
function redo(){
  if(historyIndex>=history.length-1){ toast('Tidak ada lagi yang bisa di-redo'); return; }
  historyIndex++;
  restoreSnapshot(history[historyIndex]);
  toast('Redo');
}
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;

/* ---------------- SAVE / LOAD / EXPORT (localStorage) ---------------- */
const STORAGE_KEY = 'forge_studio_projects_v1';
function getStoredProjects(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); }catch(e){ return {}; }
}
function saveProject(){
  const all = getStoredProjects();
  all[projectName] = { tree: sceneRoot, scripts, savedAt: Date.now() };
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    dirty = false; updateProjectTag();
    toast('Project disimpan','ok');
  }catch(e){ toast('Gagal menyimpan: '+e.message,'err'); }
}
function loadProjectByName(name){
  const all = getStoredProjects();
  const data = all[name];
  if(!data){ toast('Project tidak ditemukan','err'); return; }
  sceneRoot = data.tree;
  scripts = data.scripts || {};
  projectName = name;
  nodesById.clear();
  registerCloneRecursive(sceneRoot);
  selectedIds.clear();
  dirty = false;
  rebuildScene3D(); rebuildHierarchy(); refreshProperties(); rebuildScriptTabs(); updateProjectTag();
  history=[]; historyIndex=-1; pushHistory('Load');
  toast('Project dimuat: '+name,'ok');
}
function exportProject(){
  const data = JSON.stringify({ name:projectName, tree:sceneRoot, scripts }, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = projectName.replace(/\s+/g,'_')+'.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Project diekspor','ok');
}

$('#btnSaveProject').onclick = saveProject;
$('#btnExportProject').onclick = exportProject;
$('#btnOpenProject').onclick = ()=>{
  const all = getStoredProjects();
  const list = $('#projList'); list.innerHTML='';
  const names = Object.keys(all);
  if(!names.length){ list.innerHTML = '<div style="color:var(--text-2);padding:10px;font-size:12px;">Belum ada project tersimpan.</div>'; }
  names.forEach(name=>{
    const item = document.createElement('div'); item.className='proj-item';
    const d = new Date(all[name].savedAt);
    item.innerHTML = `<span>${name}<br><span style="font-size:10px;color:var(--text-2);">${d.toLocaleString('id-ID')}</span></span><span class="proj-del">Hapus</span>`;
    item.querySelector('span').onclick = ()=>{ loadProjectByName(name); $('#modalOpenProject').classList.remove('open'); };
    item.querySelector('.proj-del').onclick = (e)=>{
      e.stopPropagation();
      delete all[name]; localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      $('#btnOpenProject').onclick();
    };
    list.appendChild(item);
  });
  $('#modalOpenProject').classList.add('open');
};
$('#btnCancelOpenProject').onclick = ()=> $('#modalOpenProject').classList.remove('open');

$('#btnNewProject').onclick = ()=> $('#modalNewProject').classList.add('open');
$('#btnCancelNewProject').onclick = ()=> $('#modalNewProject').classList.remove('open');
$('#btnCreateProject').onclick = ()=>{
  const name = $('#inputProjectName').value.trim() || 'Untitled Project';
  const template = $('#inputTemplate').value;
  initEmptyProject(name, template);
  $('#modalNewProject').classList.remove('open');
  toast('Project "'+name+'" dibuat','ok');
};

/* Settings modal */
$('#btnSettings').onclick = ()=> $('#modalSettings').classList.add('open');
$('#btnCloseSettings').onclick = ()=> $('#modalSettings').classList.remove('open');
$('#settingSkyColor').oninput = (e)=>{ scene.background = new THREE.Color(e.target.value); };
$('#settingAmbient').oninput = (e)=>{ ambientRef.intensity = parseFloat(e.target.value); };
$('#settingGrid').onchange = (e)=>{ gridHelper.visible = e.target.value==='1'; };
$('#settingGravity').oninput = (e)=>{ if(playRuntime) playRuntime.gravity = parseFloat(e.target.value); };

/* ---------------- KEYBOARD SHORTCUTS ---------------- */
window.addEventListener('keydown', (e)=>{
  const inInput = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
  if(inInput) {
    if(e.ctrlKey && e.key==='s'){ e.preventDefault(); saveProject(); }
    return;
  }
  if(e.ctrlKey && e.key==='z'){ e.preventDefault(); undo(); }
  else if(e.ctrlKey && (e.key==='y' || (e.shiftKey && e.key==='Z'))){ e.preventDefault(); redo(); }
  else if(e.ctrlKey && e.key==='s'){ e.preventDefault(); saveProject(); }
  else if(e.ctrlKey && e.key==='d'){ e.preventDefault(); const n=getSingleSelected(); if(n) duplicateNode(n); }
  else if(e.ctrlKey && e.key==='n'){ e.preventDefault(); $('#modalNewProject').classList.add('open'); }
  else if(e.key==='Delete' || e.key==='Backspace'){ if(selectedIds.size){ e.preventDefault(); deleteSelected(); } }
  else if(e.key.toLowerCase()==='f'){ const n=getSingleSelected(); if(n) focusOnNode(n); }
  else if(e.key.toLowerCase()==='q'){ setTool('select'); }
  else if(e.key.toLowerCase()==='w'){ setTool('translate'); }
  else if(e.key.toLowerCase()==='e'){ setTool('rotate'); }
  else if(e.key.toLowerCase()==='r'){ setTool('scale'); }
  else if(e.key==='F5'){ e.preventDefault(); playMode?exitPlayMode():enterPlayMode(); }
  else if(e.key==='Escape'){ if(playMode) exitPlayMode(); }
});

/* ---------------- RIBBON WIRING ---------------- */
$$('.ribbon-tab').forEach(tab=>{
  tab.onclick = ()=>{
    $$('.ribbon-tab').forEach(t=>t.classList.remove('active'));
    $$('.ribbon-page').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    $(`.ribbon-page[data-page="${tab.dataset.page}"]`).classList.add('active');
  };
});

// Mirror all Play/Stop buttons (toolbar had multiple copies across ribbon pages)
function bindPlayStopButtons(){
  ['#playBtnR','#playBtnR2'].forEach(sel=>{ const b=$(sel); if(b) b.onclick = enterPlayMode; });
  ['#stopBtnR','#stopBtnR2'].forEach(sel=>{ const b=$(sel); if(b) b.onclick = exitPlayMode; });
}
const _origEnterPlayMode = enterPlayMode;
const _origExitPlayMode = exitPlayMode;
function syncPlayButtonsVisibility(){
  const show = playMode;
  ['#stopBtnR','#stopBtnR2'].forEach(sel=>{ const b=$(sel); if(b) b.style.display = show?'flex':'none'; });
  ['#playBtnR','#playBtnR2'].forEach(sel=>{ const b=$(sel); if(b) b.style.display = show?'none':'flex'; });
}

// Insert dropdown (Home tab "Place: ___" + Insert button)
$('#btnInsertPlace') && ($('#btnInsertPlace').onclick = ()=>{
  const type = $('#insertPlaceSelect').value;
  addObject(type);
});

// Duplicate / Delete / Anchor / Material quick actions in ribbon
$('#btnDuplicateR') && ($('#btnDuplicateR').onclick = ()=>{ const n=getSingleSelected(); if(n) duplicateNode(n); else toast('Pilih objek dulu','err'); });
$('#btnDeleteR') && ($('#btnDeleteR').onclick = ()=>{ if(selectedIds.size) deleteSelected(); else toast('Pilih objek dulu','err'); });
$('#btnAnchorToggle') && ($('#btnAnchorToggle').onclick = ()=>{
  const n = getSingleSelected();
  if(!n){ toast('Pilih objek dulu','err'); return; }
  n.anchored = !n.anchored; refreshProperties(); markDirty(); pushHistory('Toggle Anchor');
  toast('Anchored: '+n.anchored);
});
const MATERIAL_CYCLE = ['Plastic','Metal','Wood','Glass','Neon'];
$('#btnMaterialQuick') && ($('#btnMaterialQuick').onclick = ()=>{
  const n = getSingleSelected();
  if(!n){ toast('Pilih objek dulu','err'); return; }
  const idx = MATERIAL_CYCLE.indexOf(n.material);
  n.material = MATERIAL_CYCLE[(idx+1)%MATERIAL_CYCLE.length];
  refreshThreeObject(n); refreshProperties(); markDirty();
  toast('Material: '+n.material);
});

// Run Script (Test tab)
$('#btnRunScriptR') && ($('#btnRunScriptR').onclick = ()=>{ $('#btnRunScript').click(); });

// View tab toggles
$('#viewToggleAssets') && ($('#viewToggleAssets').onclick = ()=>switchCenterTab('assets'));
$('#viewToggleScript') && ($('#viewToggleScript').onclick = ()=>switchCenterTab('script'));

bindPlayStopButtons();

/* ---------------- INIT ---------------- */
function boot(){
  initThree();
  buildGizmo();
  rebuildAssetGrid();
  initEmptyProject('Untitled Project', 'basic');
  switchCenterTab('assets');
  toast('Selamat datang di Forge Studio!','ok');
}
boot();

})();
