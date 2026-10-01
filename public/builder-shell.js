/* View-only adapter: move existing controls; never rebuild designs or layouts. */
(function () {
  'use strict';
  var dock = document.querySelector('.col-left');
  if (!dock || document.getElementById('dock-tabs')) return;
  var grid = document.querySelector('.layout-grid');
  var byId = function(id) { return document.getElementById(id); };
  var machine = byId('machinePreset').closest('.card');
  var designs = byId('fileInput').closest('.card');
  var settings = byId('sheetWidth').closest('.card');
  var library = byId('openDesignLibrary');
  dock.setAttribute('aria-label', 'Builder controls');
  var heading = document.createElement('div');
  heading.className = 'dock-heading';
  heading.innerHTML = '<span>Workspace controls</span><button id="dock-collapse" type="button" aria-label="Collapse controls" aria-expanded="true" title="Collapse controls">‹</button>';
  dock.prepend(heading);
  var tabs = document.createElement('div');
  tabs.id = 'dock-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Builder controls');
  var panels = {}, names = ['designs', 'sheet', 'output'];
  names.forEach(function(name) {
    var tab = document.createElement('button');
    tab.id = 'dock-tab-' + name; tab.type = 'button'; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'dock-panel-' + name); tab.textContent = name[0].toUpperCase() + name.slice(1);
    tab.onclick = function() { select(name); };
    tabs.appendChild(tab);
    var panel = document.createElement('section');
    panel.id = 'dock-panel-' + name; panel.className = 'dock-panel'; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',tab.id);
    panels[name] = panel;
  });
  heading.after(tabs);
  names.forEach(function(name) { dock.appendChild(panels[name]); });
  if (library) panels.designs.appendChild(library);
  panels.designs.appendChild(designs);
  panels.sheet.append(machine, settings);
  var outputTitle = document.createElement('h2'); outputTitle.textContent = 'Output settings';
  panels.output.appendChild(outputTitle);
  panels.output.appendChild(byId('dpi').closest('.field'));
  panels.output.appendChild(byId('priceInput').closest('.row'));
  var outputCopy = document.createElement('p'); outputCopy.className = 'dock-help';
  outputCopy.textContent = 'Save each sheet using its PNG or TIFF controls below the canvas. Full sheet dimensions and source resolution are preserved.';
  panels.output.appendChild(outputCopy);
  var outputLinks = document.createElement('nav'); outputLinks.id = 'dock-output-links'; outputLinks.setAttribute('aria-label','Sheet output locations');
  panels.output.appendChild(outputLinks);
  var note = document.querySelector('#resultArea > .image-note');
  if (note) {
    var info = document.createElement('details'); info.className = 'dock-output-info';
    var summary = document.createElement('summary'); summary.textContent = 'Preview and source quality';
    info.append(summary, note); panels.output.appendChild(info);
  }
  var footer = document.createElement('footer'); footer.className = 'dock-footer';
  var arrangeControl = byId('packBtn').closest('.arrange-split') || byId('packBtn');
  footer.append(arrangeControl, byId('errorMsg')); dock.appendChild(footer);
  function select(name) {
    names.forEach(function(key) {
      var active = key === name, tab = byId('dock-tab-' + key);
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; panels[key].hidden = !active;
    });
  }
  tabs.addEventListener('keydown', function(event) {
    var index = names.indexOf(event.target.id.replace('dock-tab-', ''));
    if (index < 0) return;
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    var next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    select(names[next]); byId('dock-tab-' + names[next]).focus();
  });
  byId('dock-collapse').onclick = function() {
    var collapsed = grid.classList.toggle('dock-collapsed');
    this.setAttribute('aria-expanded', String(!collapsed)); this.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
    this.title = collapsed ? 'Expand controls' : 'Collapse controls'; this.textContent = collapsed ? '›' : '‹';
  };
  var toolbar = byId('resultArea').firstElementChild;
  toolbar.classList.add('builder-selection-toolbar');
  function selectionState() {
    [byId('rotateSelectedBtn'), byId('removeSelectedPieces')].forEach(function(button) { button.hidden = button.disabled; });
  }
  new MutationObserver(selectionState).observe(toolbar, { attributes:true, subtree:true, attributeFilter:['disabled'] });
  selectionState();
  function outputLocations() {
    outputLinks.replaceChildren();
    document.querySelectorAll('#sheetsContainer .sheet-block').forEach(function(block, index) {
      var link = document.createElement('button'); link.type = 'button'; link.className = 'secondary'; link.textContent = 'Sheet ' + (index + 1) + ' · PNG / TIFF';
      link.onclick = function() {
        var output = block.querySelector('.download-row');
        if (output) { output.scrollIntoView({ block:'center', behavior:'auto' }); output.querySelector('button')?.focus({ preventScroll:true }); }
      };
      outputLinks.appendChild(link);
    });
    if (!outputLinks.children.length) outputLinks.textContent = 'Arrange your designs to make sheet outputs available.';
  }
  new MutationObserver(outputLocations).observe(byId('sheetsContainer'), {childList:true});
  outputLocations(); select('designs');
})();
